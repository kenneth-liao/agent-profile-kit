import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { InstallerToolError, type InstallerToolErrorFact } from "../installer/tool-errors.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import { obtainPackageArchive, extractPackageArchive } from "./support/package-archive.js";
import { controlledEnvironment, controlledPath, controlledToolPath } from "./support/controlled-environment.js";
import { expectExitCode, runProcess, TEST_CHILD_DEADLINE_MS } from "../process/process-executor.js";

const FIXTURES = join(import.meta.dir, "support", "fixtures", "compat-0.204.0");
const HOME_TOKEN = "__FIXTURE_HOME__";
const PROJECT_TOKEN = "__FIXTURE_PROJECT__";

let cliPath = "";
let packageArchiveCleanup: () => void = () => {};
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  const archive = await obtainPackageArchive(
    join(import.meta.dir, ".."),
    "agent-profile-kit-compat-pack-",
  );
  packageArchiveCleanup = archive.cleanup;
  const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-compat-packed-"));
  temporaryDirectories.push(extracted);
  await extractPackageArchive(archive.path, extracted);
  cliPath = join(extracted, "package", "dist", "cli.js");
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  packageArchiveCleanup();
});

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-compat-home-"));
  temporaryDirectories.push(home);
  return home;
}

/** Install the same Codex stub the fixture journey used, as one bin directory. */
function installCodexStub(home: string): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "codex"), '#!/bin/sh\necho "codex-cli 0.145.0"\n');
  chmodSync(join(bin, "codex"), 0o755);
  return bin;
}

/** Copy one fixture tree, substituting both stage-path placeholders in text records. */
function copyWithToken(source: string, destination: string, tokens: Readonly<Record<string, string>>): void {
  cpSync(source, destination, { recursive: true });
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      const text = readFileSync(path).toString("utf8");
      let next = text;
      for (const [token, value] of Object.entries(tokens)) {
        next = next.split(token).join(value);
      }
      if (next !== text) writeFileSync(path, next);
    }
  };
  visit(destination);
}

function statePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state", "manifest.json");
}

async function runCli(home: string, ...arguments_: string[]) {
  return runProcess({
    executable: controlledToolPath("node"),
    arguments_: [cliPath, ...arguments_],
    environment: controlledEnvironment({ home, path: controlledPath(home, { stubBins: [installCodexStub(home)] }) }),
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI",
  });
}

/**
 * Materialize one isolated machine from the fixture: Local Configuration and
 * Installation State (the fixture's `home/` tree is the machine home), plus
 * the installed project tree at the bound project path.
 */
function materializeMachine(home: string): string {
  // The fixture records canonical (realpath) identities; substitute canonical
  // spellings everywhere so receipts match the freshly planned state.
  const project = join(home, "project");
  mkdirSync(project);
  const tokens = { [HOME_TOKEN]: realpathSync(home), [PROJECT_TOKEN]: realpathSync(project) };
  copyWithToken(join(FIXTURES, "project"), project, tokens);
  copyWithToken(join(FIXTURES, "home"), home, tokens);
  return project;
}

/**
 * Repair the copied 0.204.0 Workspace into current format: remove the
 * retired Skill sidecar, list every needed artifact in the Profile's
 * explicit `context` and `skills` lists, remove the authored Profile `id`
 * fields, and rename the Context file whose frontmatter `id` differed from
 * its file name so the path-derived ID keeps the ID the Profile references
 * (spec #593 DEC-004, #600). Context frontmatter is never removed: apkit
 * reads none, so the 0.204.0 bytes stay in place and are delivered as
 * written (DEC-005) — the delivered output proves it.
 */
function repairWorkspace(home: string): void {
  // The fixture's config selects the 0.204.0-era Workspace path, so the
  // repaired source is placed exactly where that authored selection points.
  const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
  cpSync(join(FIXTURES, "workspace-source"), workspace, { recursive: true });
  rmSync(join(workspace, "skills", "review-pr", "agent-profile-kit.yaml"));
  renameSync(
    join(workspace, "context", "legacy-name.md"),
    join(workspace, "context", "legacy-rules.md"),
  );
  // Repair to the current Profile shape: a Profile's ID is its file name
  // (spec #593 DEC-014), so the authored `id` fields are removed. Both files
  // matched their authored IDs, so every Project Binding and receipt keeps
  // resolving to the same Profile identity.
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "context: [team-rules, extra-rules]\nskills: [review-pr, base-skill]\n",
  );
  writeFileSync(
    join(workspace, "profiles", "example.yaml"),
    'context:\n  - "legacy-rules"\nskills: []\n',
  );
}

interface ReceiptRecord {
  readonly receipts: readonly {
    readonly desired_input_digest: string;
    readonly profile_id: string;
    readonly project: string;
    readonly outputs: readonly { readonly path: string }[];
  }[];
}

async function ingestionFact(workspace: string): Promise<InstallerToolErrorFact | { schema: string; detail: Record<string, unknown> }> {
  try {
    await ingestWorkspace(workspace);
  } catch (error) {
    if (error instanceof InstallerToolError) return error.fact;
    if (error instanceof SchemaRejectionError) {
      return { schema: error.reason.schema, detail: error.reason.detail as Record<string, unknown> };
    }
    throw error;
  }
  throw new Error("expected ingestWorkspace to reject the 0.204.0 Workspace");
}

describe("0.204.0 compatibility (issues #596, #598, #600; TEST-010, DEC-013)", () => {
  test("the untouched 0.204.0 Workspace fixture first reports the Profile id field with its path and fix", async () => {
    // Profiles ingest before Skills, so the first reported violation of the
    // raw fixture is the authored `id` field (spec #593 DEC-014, #598).
    const home = isolatedHome();
    const workspace = join(home, "workspace");
    copyWithToken(join(FIXTURES, "workspace-source"), workspace, {});
    expect(await ingestionFact(workspace)).toEqual({
      schema: "workspace-artifact",
      detail: { case: "profile-id-field", path: "profiles/coding.yaml", id: "coding" },
    });
  });

  test("after removing the Profile id fields, the fixture reports the leftover Skill sidecar with its path and fix", async () => {
    const home = isolatedHome();
    const workspace = join(home, "workspace");
    copyWithToken(join(FIXTURES, "workspace-source"), workspace, {});
    // Apply only the Profile fix: the authored ids matched the file names, so
    // removal alone keeps every Profile ID that bindings reference.
    for (const profile of ["coding.yaml", "example.yaml"]) {
      const file = join(workspace, "profiles", profile);
      writeFileSync(file, readFileSync(file, "utf8").replace(/^id:.*\n/m, ""));
    }
    expect(await ingestionFact(workspace)).toEqual({
      kind: "leftover-skill-sidecar",
      file: "skills/review-pr/agent-profile-kit.yaml",
    });

    const validate = await runCli(home, "validate", workspace);
    expectExitCode(validate, 1);
    const output = validate.stderr + validate.stdout;
    const normalized = output.replace(/\s+/g, " ");
    expect(normalized).toContain("skills/review-pr/agent-profile-kit.yaml");
    expect(normalized).toContain("'context' and 'skills'");
    expect(normalized).toContain("delete the file");
  });

  test("after the Profile and sidecar fixes, the divergent frontmatter id is the only remaining change, naming the file rename", async () => {
    const home = isolatedHome();
    const workspace = join(home, "workspace");
    copyWithToken(join(FIXTURES, "workspace-source"), workspace, {});
    for (const profile of ["coding.yaml", "example.yaml"]) {
      const file = join(workspace, "profiles", profile);
      writeFileSync(file, readFileSync(file, "utf8").replace(/^id:.*\n/m, ""));
    }
    rmSync(join(workspace, "skills", "review-pr", "agent-profile-kit.yaml"));
    // The Profile references the authored frontmatter id, which no longer
    // exists: the fix is the file rename that keeps that ID (path identity,
    // spec #593 DEC-004, #600), never a silent rebinding.
    expect(await ingestionFact(workspace)).toEqual({
      kind: "missing-context-reference",
      profile: "example",
      contextId: "legacy-rules",
      file: "profiles/example.yaml",
      available: ["example-context", "extra-rules", "legacy-name", "team-rules"],
    });

    renameSync(join(workspace, "context", "legacy-name.md"), join(workspace, "context", "legacy-rules.md"));
    const ingested = await ingestWorkspace(workspace);
    // The renamed file's ID is its path; the frontmatter it carried in
    // 0.204.0 is inert, delivered-as-written content.
    expect([...ingested.contexts.keys()].sort()).toEqual([
      "example-context",
      "extra-rules",
      "legacy-rules",
      "team-rules",
    ]);
    expect(ingested.contexts.get("legacy-rules")!.content).toBe(
      "---\nid: legacy-rules\n---\nLegacy rules body.\n",
    );
  });

  test("update completes safely on 0.204.0 Installation State and installed output", async () => {
    const home = isolatedHome();
    const project = materializeMachine(home);
    writeFileSync(join(project, "keep.txt"), "unrelated project file\n");
    const before = JSON.parse(readFileSync(statePath(home), "utf8")) as ReceiptRecord;
    expect(before.receipts).toHaveLength(1);
    const recorded = before.receipts[0]!;
    expect(recorded.project).toBe(realpathSync(project));
    // The binding and receipt name the Profile whose authored id matched its
    // file name; that identity survives the repair unchanged (#598).
    expect(recorded.profile_id).toBe("coding");
    const outputPaths = recorded.outputs.map((output) => output.path).sort();

    repairWorkspace(home);
    const update = await runCli(home, "update", "--all");
    expectExitCode(update, 0);

    const after = JSON.parse(readFileSync(statePath(home), "utf8")) as ReceiptRecord;
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0]!.project).toBe(recorded.project);
    // The digest the 0.204.0 code computed (with dependency and
    // inclusion-reason semantics) is refreshed under the current rules.
    expect(after.receipts[0]!.desired_input_digest).not.toBe(recorded.desired_input_digest);
    expect(after.receipts[0]!.outputs.map((output) => output.path).sort()).toEqual(outputPaths);

    // The refresh is idempotent: a second update recomputes the same digest.
    expectExitCode(await runCli(home, "update", "--all"), 0);
    const settled = JSON.parse(readFileSync(statePath(home), "utf8")) as ReceiptRecord;
    expect(settled.receipts[0]!.desired_input_digest).toBe(after.receipts[0]!.desired_input_digest);

    // Every owned output path stays owned by the same installation, in the
    // same locations; no output is orphaned or adopted. The refreshed Codex
    // Context delivers the 0.204.0 Context files as written: their
    // frontmatter bytes now travel after the generated envelope header
    // (spec #593 DEC-005, #600) instead of being stripped.
    expect(existsSync(join(project, ".agents", "skills", "base-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
    const codexContext = readFileSync(join(project, ".agent-profile-kit", "codex", "context.md"), "utf8");
    expect(codexContext.indexOf("---\nid: team-rules")).toBeGreaterThan(
      codexContext.indexOf("# Agent Profile Kit Context"),
    );
    expect(codexContext).toContain("Team rules body.");
    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(true);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(true);
    expect(readFileSync(join(project, "keep.txt"), "utf8")).toBe("unrelated project file\n");

    const status = await runCli(home, "status", "--all");
    expectExitCode(status, 0);
    expect(status.stdout).toContain("All Projects are up to date");
  });

  test("uninstall completes safely on 0.204.0 Installation State and installed output", async () => {
    const home = isolatedHome();
    const project = materializeMachine(home);
    writeFileSync(join(project, "keep.txt"), "unrelated project file\n");
    repairWorkspace(home);

    const uninstall = await runCli(home, "uninstall", "--project", project, "--auto-confirm");
    expectExitCode(uninstall, 0);

    expect(existsSync(join(project, ".agent-profile-kit", "codex", "context.md"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "base-skill"))).toBe(false);
    expect(existsSync(join(project, ".agents", "skills", "review-pr"))).toBe(false);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(join(project, "keep.txt"), "utf8")).toBe("unrelated project file\n");

    const after = JSON.parse(readFileSync(statePath(home), "utf8")) as {
      readonly receipts: readonly unknown[];
    };
    expect(after.receipts).toHaveLength(0);
  });
});