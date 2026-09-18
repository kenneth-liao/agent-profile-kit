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
import {
  InstallerToolError,
  type WorkspaceViolation,
  workspaceViolationPath,
  workspaceViolationToken,
} from "../installer/tool-errors.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import { collectViolations, violationTokens } from "./support/workspace-violations.js";
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

/**
 * Collect the 0.204.0 Workspace's violations in one run; the fixture tests
 * assert the complete collected list (spec #593 DEC-009, #604).
 */
function fixtureViolations(workspace: string): Promise<readonly WorkspaceViolation[]> {
  return collectViolations(workspace);
}

/** The workspace-relative rule+path identity of one collected violation, with the selected artifact for reference facts. */
function violationIdentity(violation: WorkspaceViolation): string {
  const fact = violation.via === "ingestion" ? violation.fact : violation.detail;
  const locator = workspaceViolationPath(violation);
  const subject = "contextId" in fact
    ? fact.contextId
    : "skillId" in fact
    ? fact.skillId
    : "";
  return subject === ""
    ? `${workspaceViolationToken(violation)} ${locator}`
    : `${workspaceViolationToken(violation)} ${locator} ${subject}`;
}

describe("0.204.0 compatibility (issues #596, #598, #600; TEST-010, DEC-013)", () => {
  test("the untouched 0.204.0 Workspace fixture reports every required change in one run", async () => {
    const home = isolatedHome();
    const workspace = join(home, "workspace");
    copyWithToken(join(FIXTURES, "workspace-source"), workspace, {});
    // One run names every required change (spec #593 DEC-013, DEC-009, AC 5):
    // both authored `id` fields, the leftover Skill sidecar, and the Profile
    // reference that must change — the id field is a field-level violation,
    // recorded while the Profile's lists stay readable and reference-checked.
    expect((await fixtureViolations(workspace)).map(violationIdentity).sort()).toEqual([
      "leftover-skill-sidecar skills/review-pr/agent-profile-kit.yaml",
      "missing-context-reference profiles/example.yaml legacy-rules",
      "workspace-artifact/profile-id-field profiles/coding.yaml",
      "workspace-artifact/profile-id-field profiles/example.yaml",
    ]);
  });

  test("after removing the Profile id fields, one run names the sidecar and the reference changes", async () => {
    const home = isolatedHome();
    const workspace = join(home, "workspace");
    copyWithToken(join(FIXTURES, "workspace-source"), workspace, {});
    // Apply only the Profile fix: the authored ids matched the file names, so
    // removal alone keeps every Profile ID that bindings reference.
    for (const profile of ["coding.yaml", "example.yaml"]) {
      const file = join(workspace, "profiles", profile);
      writeFileSync(file, readFileSync(file, "utf8").replace(/^id:.*\n/m, ""));
    }
    const violations = await fixtureViolations(workspace);
    expect(violations.map(violationIdentity).sort()).toEqual([
      "leftover-skill-sidecar skills/review-pr/agent-profile-kit.yaml",
      "missing-context-reference profiles/example.yaml legacy-rules",
    ]);

    const validate = await runCli(home, "validate", workspace);
    expectExitCode(validate, 1);
    const output = validate.stderr + validate.stdout;
    const normalized = output.replace(/\s+/g, " ");
    expect(normalized).toContain("2 violations found");
    expect(normalized).toContain("skills/review-pr/agent-profile-kit.yaml");
    expect(normalized).toContain("'context' and 'skills'");
    expect(normalized).toContain("delete the file");
    expect(normalized).toContain("apkit guide --contract");
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
    const violations = await fixtureViolations(workspace);
    expect(violations.map(violationIdentity)).toEqual(["missing-context-reference profiles/example.yaml legacy-rules"]);
    const fact = violations[0]!;
    if (fact.via !== "ingestion" || fact.fact.kind !== "missing-context-reference") {
      throw new Error("expected the missing-context-reference fact");
    }
    expect(fact.fact.profile).toBe("example");
    expect(fact.fact.contextId).toBe("legacy-rules");
    expect(fact.fact.available).toEqual(["example-context", "extra-rules", "legacy-name", "team-rules"]);

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

  test("the realistic-scale 0.204.0 fixture names every required change in one run (TEST-010, ISC-46)", async () => {
    const home = isolatedHome();
    const workspace = join(home, "workspace");
    copyWithToken(join(FIXTURES, "workspace-realistic"), workspace, {});

    // One run names all 45 required changes (spec #593 DEC-013, DEC-009,
    // AC 5): every Profile's authored `id` field, every leftover sidecar,
    // both leftover invocation-metadata keys, and every old Context ID that
    // must become its path ID — the id field is a field-level violation,
    // recorded while the Profile's lists stay readable and reference-checked.
    const engineeringSubjects = [
      "subject-03", "subject-06", "subject-05", "subject-08", "subject-11", "subject-04", "subject-02",
    ];
    const personalSubjects = [
      "subject-12", "subject-14", "subject-16", "subject-17", "subject-15", "subject-18", "subject-19",
    ];
    const violations = await fixtureViolations(workspace);
    expect(violations.map(violationIdentity).sort()).toEqual([
      "leftover-skill-sidecar skills/group-a/skill-03/agent-profile-kit.yaml",
      "leftover-skill-sidecar skills/group-a/skill-04/agent-profile-kit.yaml",
      "leftover-skill-sidecar skills/group-c/skill-11/agent-profile-kit.yaml",
      "leftover-skill-sidecar skills/group-c/skill-12/agent-profile-kit.yaml",
      "leftover-skill-sidecar skills/group-c/skill-13/agent-profile-kit.yaml",
      "leftover-skill-sidecar skills/group-c/skill-14/agent-profile-kit.yaml",
      "leftover-skill-sidecar skills/group-c/skill-15/agent-profile-kit.yaml",
      "leftover-skill-sidecar skills/group-c/skill-16/agent-profile-kit.yaml",
      "leftover-skill-sidecar skills/group-c/skill-17/agent-profile-kit.yaml",
      "workspace-artifact/leftover-model-invocation-metadata skills/group-c/skill-09/SKILL.md",
      "workspace-artifact/leftover-model-invocation-metadata skills/group-c/skill-20/SKILL.md",
      ...["profile-01", "profile-02", "profile-03", "profile-04", "profile-05"].map(
        (profile) => `workspace-artifact/profile-id-field profiles/${profile}.yaml`,
      ),
      ...["profile-01", "profile-02", "profile-03"].flatMap((profile) =>
        engineeringSubjects.map(
          (subject) => `missing-context-reference profiles/${profile}.yaml ${subject}`,
        ),
      ),
      "missing-context-reference profiles/profile-04.yaml subject-01",
      ...personalSubjects.map(
        (subject) => `missing-context-reference profiles/profile-05.yaml ${subject}`,
      ),
      ...["profile-01", "profile-02", "profile-03"].map(
        (profile) => `missing-skill-reference profiles/${profile}.yaml skill-20`,
      ),
    ].sort());

    // Every old Context ID gets the moved-file fix: the reference to the old
    // flat ID names the path-derived ID it must become (spec #593 US-006,
    // DEC-013).
    for (const violation of violations) {
      const evidence = violation.via === "ingestion" ? violation.fact : violation.detail;
      if (!("contextId" in evidence) || !("available" in evidence)) continue;
      const suggestion = evidence.available.find((id) =>
        id.slice(id.lastIndexOf("/") + 1) === evidence.contextId,
      );
      expect(suggestion, `${evidence.contextId} in ${evidence.file}`).toBeDefined();
    }

    // Applying the named fixes exactly — remove the id fields, path IDs into
    // the Profiles, delete the sidecars, move the invocation policy to the
    // standard field — leaves a valid Workspace, proving the one-run change
    // list was complete (ISC-46).
    for (const violation of violations) {
      const evidence = violation.via === "ingestion" ? violation.fact : violation.detail;
      if ("contextId" in evidence && "available" in evidence) {
        const suggested = evidence.available.find(
          (id) => id.slice(id.lastIndexOf("/") + 1) === evidence.contextId,
        )!;
        const file = join(workspace, evidence.file!);
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace(new RegExp(`^  - ${evidence.contextId}$`, "m"), `  - ${suggested}`),
        );
      } else if ("skillId" in evidence) {
        // The missing Skill is the metadata-key Skill; its named repair (the
        // standard-field replacement below) makes it readable, so the
        // reference resolves without a separate change.
      } else if ("case" in evidence && evidence.case === "profile-id-field") {
        const file = join(workspace, evidence.path);
        writeFileSync(file, readFileSync(file, "utf8").replace(/^id:.*\n/m, ""));
      } else if ("file" in evidence && evidence.file.endsWith("agent-profile-kit.yaml")) {
        rmSync(join(workspace, evidence.file));
      } else if ("case" in evidence && evidence.case === "leftover-model-invocation-metadata") {
        const file = join(workspace, evidence.path);
        writeFileSync(
          file,
          readFileSync(file, "utf8").replace(/^metadata:\n  agent-profile-kit\.model-invocation: disabled\n/m, ""),
        );
      }
    }
    await expect(ingestWorkspace(workspace)).resolves.toBeDefined();
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