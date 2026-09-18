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
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { InstallerToolError, type InstallerToolErrorFact } from "../installer/tool-errors.js";
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
  const project = join(home, "project");
  copyWithToken(join(FIXTURES, "project"), project, { [HOME_TOKEN]: home, [PROJECT_TOKEN]: join(home, "project") });
  // The fixture records canonical (realpath) identities; substitute the
  // canonical spellings so receipts match the freshly planned state.
  const homeReal = realpathSync(home);
  const projectReal = realpathSync(project);
  copyWithToken(join(FIXTURES, "home"), home, { [HOME_TOKEN]: homeReal, [PROJECT_TOKEN]: projectReal });
  return project;
}

/**
 * Repair the copied 0.204.0 Workspace into current format: remove the
 * retired Skill sidecar and list every needed artifact in the Profile's
 * explicit `context` and `skills` lists. The Context Module frontmatter
 * `dependencies` key is tolerated and unread, so it stays as written.
 */
function repairWorkspace(home: string): void {
  const workspace = join(home, ".agents", "agent-profile-kit", "workspace");
  cpSync(join(FIXTURES, "workspace-source"), workspace, { recursive: true });
  rmSync(join(workspace, "skills", "review-pr", "agent-profile-kit.yaml"));
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext: [team-rules, extra-rules]\nskills: [review-pr, base-skill]\n",
  );
}

interface ReceiptRecord {
  readonly receipts: readonly {
    readonly desired_input_digest: string;
    readonly project: string;
    readonly outputs: readonly { readonly path: string }[];
  }[];
}

async function ingestionFact(workspace: string): Promise<InstallerToolErrorFact> {
  try {
    await ingestWorkspace(workspace);
  } catch (error) {
    if (error instanceof InstallerToolError) return error.fact;
    throw error;
  }
  throw new Error("expected ingestWorkspace to reject the 0.204.0 Workspace");
}

describe("0.204.0 compatibility (issue #596, TEST-010)", () => {
  test("the 0.204.0 Workspace fixture reports the leftover Skill sidecar with its path and fix", async () => {
    const home = isolatedHome();
    const workspace = join(home, "workspace");
    copyWithToken(join(FIXTURES, "workspace-source"), workspace, {});
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

  test("update completes safely on 0.204.0 Installation State and installed output", async () => {
    const home = isolatedHome();
    const project = materializeMachine(home);
    writeFileSync(join(project, "keep.txt"), "unrelated project file\n");
    const before = JSON.parse(readFileSync(statePath(home), "utf8")) as ReceiptRecord;
    expect(before.receipts).toHaveLength(1);
    const recorded = before.receipts[0]!;
    expect(recorded.project).toBe(realpathSync(project));
    const outputPaths = recorded.outputs.map((output) => output.path).sort();

    repairWorkspace(home);
    const update = await runCli(home, "update", "--all");
    expectExitCode(update, 0);

    const after = JSON.parse(readFileSync(statePath(home), "utf8")) as ReceiptRecord;
    expect(after.receipts).toHaveLength(1);
    expect(after.receipts[0]!.project).toBe(realpathSync(project));
    // The digest the 0.204.0 code computed (with dependency and
    // inclusion-reason semantics) is refreshed under the current rules.
    expect(after.receipts[0]!.desired_input_digest).not.toBe(recorded.desired_input_digest);
    expect(after.receipts[0]!.outputs.map((output) => output.path).sort()).toEqual(outputPaths);

    // Every owned output path stays owned by the same installation, in the
    // same locations; no output is orphaned or adopted.
    expect(existsSync(join(project, ".agents", "skills", "base-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(project, ".agents", "skills", "review-pr", "SKILL.md"))).toBe(true);
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