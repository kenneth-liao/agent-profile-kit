import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readInstallationState, writeInstallationState } from "../installer/installation-state.js";
import { parseOwnershipState } from "../schemas/ownership-state.js";
import { stateManifestPath } from "../installer/project-plan.js";

const hash = `sha256:${"0".repeat(64)}`;
const cleanup: string[] = [];

function writeStateFile(home: string, source: string): void {
  mkdirSync(join(stateManifestPath(home), ".."), { recursive: true });
  writeFileSync(stateManifestPath(home), source);
}

function temporaryHome(): string {
  const home = mkdtempSync(join(tmpdir(), "apkit-state-migration-"));
  cleanup.push(home);
  return home;
}

afterEach(() => {
  for (const home of cleanup.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

/** An Installation State document exactly as the previous product version wrote it. */
function previousVersionStateSource(home: string): string {
  const project = join(home, "project");
  return JSON.stringify({
    schema_version: 6,
    receipts: [{
      installation_id: "installation-a",
      lifetime: "ordinary",
      project,
      profile_id: "engineering",
      desired_input_digest: hash,
      hosts: {
        codex: {
          adapter_version: "codex-project-v3",
          capability_contract: "native-project-sessionstart-complete-context-v1",
        },
      },
      outputs: [
        {
          path: ".agent-profile-kit/installation.json",
          type: "file",
          mode: 0o644,
          hash,
        },
        {
          path: ".codex/hooks.json",
          type: "file",
          mode: 0o644,
          hash,
        },
      ],
      repository_exclusion: {
        target: join(project, ".git", "info", "exclude"),
        entries: ["/.codex/hooks.json"],
      },
    }],
    removed_temporary_installation_ids: [],
  }, null, 2);
}

test("reads the previous schema version and ignores recorded Marker output entries", async () => {
  const home = temporaryHome();
  writeStateFile(home, previousVersionStateSource(home));

  const state = await readInstallationState(home);

  expect(state.schemaVersion).toBe(7);
  expect(state.receipts).toHaveLength(1);
  expect(state.receipts[0]!.outputs.map((output) => output.path)).toEqual([".codex/hooks.json"]);
  expect(state.receipts[0]!.installationId).toBe("installation-a");
});

test("the next successful write publishes the current schema version without re-binding", async () => {
  const home = temporaryHome();
  writeStateFile(home, previousVersionStateSource(home));

  const state = await readInstallationState(home);
  await writeInstallationState(home, state);

  const raw = JSON.parse(readFileSync(stateManifestPath(home), "utf8")) as Record<string, unknown>;
  expect(raw.schema_version).toBe(7);
  expect(JSON.stringify(raw)).not.toContain("installation.json");
  const reread = await readInstallationState(home);
  expect(reread.schemaVersion).toBe(7);
  expect(reread.receipts[0]!.installationId).toBe("installation-a");
});

test("reading the current schema version is unchanged", async () => {
  const home = temporaryHome();
  writeStateFile(home, previousVersionStateSource(home));
  await writeInstallationState(home, await readInstallationState(home));
  const republished = readFileSync(stateManifestPath(home), "utf8");

  const state = await readInstallationState(home);
  expect(state.schemaVersion).toBe(7);
  // The republished bytes are strict current-version documents.
  expect(parseOwnershipState(republished).receipts).toEqual(state.receipts);
});
