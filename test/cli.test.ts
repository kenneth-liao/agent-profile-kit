import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { OPTIONS } from "../src/command.js";
import { COMMAND, GUIDE, HELP } from "../src/guide.js";
import { hash } from "../src/install.js";
import { AGENTS } from "../src/render.js";
import { loadWorkspace, type Violation } from "../src/workspace.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { CASE_SENSITIVE_CONTEXT, ERROR_KINDS } from "./validation-cases.js";
import { makeWorkspace, read, SKILL, snapshot, tempDir, writeTree } from "./fixtures.js";
import { materializeMachine, materializeMigration, type MigrationFixture } from "./migration.js";

// Journeys run several commands, each a new process: on Node one took 7.4 s, past Bun's 5 s default.
// A bounded budget for every journey here, wherever the suite runs (CI included).
setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
/** Set APKIT_CLI to a built bundle (relative to the repository root, e.g. `dist/cli.js`) to run the journey on Node. */
const BUILT = process.env.APKIT_CLI;
const RUNTIME = BUILT ? ["node", resolve(import.meta.dir, "..", BUILT)] : [process.execPath, CLI];

/** Runs the CLI with `home` as both the apkit home and the user's home, so nothing real is touched. */
function cli(home: string, cwd: string, ...args: string[]) {
  return cliWithEnv({}, home, cwd, ...args);
}

function cliEnv(home: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, APKIT_HOME: home, HOME: home, USERPROFILE: home };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "GROK_HOME"]) delete env[name];
  Object.assign(env, extra);
  return env;
}

/** Like `cli`, with agent folder variables (such as `CLAUDE_CONFIG_DIR`) set in `extra`. */
function cliWithEnv(extra: Record<string, string>, home: string, cwd: string, ...args: string[]) {
  const [exe, ...pre] = RUNTIME as [string, ...string[]];
  const env = cliEnv(home, extra);
  const result = spawnSync(exe, [...pre, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Like `cli`, but returns at once, so several runs can overlap. */
function cliAsync(home: string, cwd: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const [exe, ...pre] = RUNTIME as [string, ...string[]];
  const env = cliEnv(home);
  return new Promise((done, fail) => {
    const child = spawn(exe, [...pre, ...args], { cwd, env });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (err += chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code, out, err }));
  });
}

/** Every file under `folder` that is not the manifest or an instruction file, as POSIX paths. */
async function generatedFiles(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((path) => !["AGENTS.md", "CLAUDE.md", ".agents/apkit.json"].includes(path))
    .sort();
}

/** Every file the manifest records exists with its hash, and no generated file is on disk without a record. */
async function expectManifestMatchesDisk(folder: string): Promise<void> {
  const manifest = JSON.parse(await read(folder, ".agents/apkit.json")) as { files: Record<string, string> };
  for (const [path, recorded] of Object.entries(manifest.files)) {
    expect(hash(await readFile(join(folder, ...path.split("/"))))).toBe(recorded);
  }
  expect(await generatedFiles(folder)).toEqual(Object.keys(manifest.files).sort());
}

/** Each agent's user-level instruction file in a fresh home folder. */
const USER_FILES = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".config/opencode/AGENTS.md",
  ".pi/agent/AGENTS.md",
  ".grok/rules/apkit.md",
  ".gemini/AGENTS.md",
];

/** Every file (POSIX path → exact bytes) and folder (path ending in `/`) under home, without apkit's own config files (APKIT_HOME is home here). */
async function homeSnapshot(home: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
    const path = relative(home, join(entry.parentPath, entry.name)).split(sep).join("/");
    // Folders count too: a removal must not leave behind a folder it created.
    if (entry.isDirectory()) files[`${path}/`] = "";
    if (!entry.isFile()) continue;
    if (path === "config.json" || path === "global.json") continue;
    files[path] = (await readFile(join(home, path))).toString("latin1");
  }
  return files;
}

describe("apkit CLI", () => {
  test("the daily loop: select, check, install, edit, update everywhere, remove", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const one = await tempDir("one");
    const two = await tempDir("two");
    await writeTree(two, { "CLAUDE.md": "# Two\n" });

    expect(cli(home, one, "status").code).toBe(2);
    expect(cli(home, one, "workspace", ws).code).toBe(0);
    const check = cli(home, one, "check", "--json");
    expect(check.code).toBe(0);
    expect(JSON.parse(check.out).profiles.map((p: { id: string }) => p.id).sort()).toEqual(["engineering", "skills-only", "writing"]);

    // A fresh folder needs a decision; nothing is written until the caller says yes.
    const blocked = cli(home, one, "install", "engineering", "--agents", "claude,codex");
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain("Create AGENTS.md");
    expect(await readdir(one)).toEqual([]);
    expect(cli(home, one, "install", "engineering", "--agents", "claude,codex", "--yes").code).toBe(0);
    const json = JSON.parse(cli(home, one, "install", "engineering", two, "--agents", "claude", "--yes", "--json").out);
    expect(json.result).toBe("installed");
    expect(await read(two, "CLAUDE.md")).toBe("# Two\n\n@AGENTS.md\n");

    expect(cli(home, one, "status", "--all").out).toContain("up to date");

    // Edit the Workspace once; status sees it everywhere; update --all applies it.
    await writeTree(ws, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    const stale = cli(home, one, "status", "--all", "--json");
    expect(JSON.parse(stale.out).results.map((o: { result: string }) => o.result)).toEqual(["updated", "updated"]);
    expect(cli(home, one, "update", "--all").code).toBe(0);
    expect(await read(one, "AGENTS.md")).toContain("Be warm.");
    expect(await read(two, "AGENTS.md")).toContain("Be warm.");

    // A hand edit blocks only that folder's update.
    await writeTree(one, { ".claude/skills/summarize/SKILL.md": "mine\n" });
    await writeTree(ws, { "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: v2\n---\n" });
    const update = cli(home, one, "update", "--all");
    expect(update.code).toBe(3);
    expect(update.out).toContain("was changed after apkit wrote it");
    expect(await read(two, ".claude/skills/summarize/SKILL.md")).toContain("v2");
    expect(cli(home, one, "update", "--overwrite").code).toBe(0);

    // Removal leaves each folder as it was; a deleted folder is forgotten.
    expect(cli(home, one, "remove").code).toBe(0);
    expect(await readdir(one)).toEqual([]);
    await rm(two, { recursive: true });
    expect(cli(home, one, "update", "--all").out).toContain("no longer exists");
    expect(cli(home, one, "remove", two).code).toBe(0);
    expect(cli(home, one, "status", "--all").out).toContain("Nothing is installed yet.");
  });

  test("any .md Context name installs, and an encoded ID keeps the marked section intact", async () => {
    const home = await tempDir("home");
    const ws = await tempDir("ws");
    const project = await tempDir("project");
    await writeTree(ws, {
      "apkit-workspace.yaml": "",
      "context/CLAUDE.md": "# Copied CLAUDE.md\n\nUse tabs.\n",
      "context/My Notes.md": "Keep notes short.\n",
      "profiles/mine.yaml": "context:\n  - CLAUDE\n  - My Notes\nskills: []\n",
    });
    // `>` is not allowed in Windows file names; elsewhere a name with `-->` must not end apkit's comment.
    const arrow = await writeTree(ws, { "context/a-->b.md": "Arrow text.\n" }).then(
      () => true,
      () => false,
    );
    if (arrow) await writeTree(ws, { "profiles/mine.yaml": "context:\n  - CLAUDE\n  - My Notes\n  - a-->b\nskills: []\n" });

    const check = cli(home, project, "check", "--workspace", ws, "--json");
    expect(check.code).toBe(0);
    expect(JSON.parse(check.out).context.sort()).toEqual(arrow ? ["CLAUDE", "My Notes", "a-->b"] : ["CLAUDE", "My Notes"]);

    expect(cli(home, project, "workspace", ws).code).toBe(0);
    expect(cli(home, project, "install", "mine", "--agents", "claude,codex", "--yes").code).toBe(0);
    const agents = await read(project, "AGENTS.md");
    expect(agents).toContain("<!-- context: CLAUDE -->\n# Copied CLAUDE.md");
    expect(agents).toContain("<!-- context: My Notes -->\nKeep notes short.");
    if (arrow) {
      expect(agents).toContain("<!-- context: a--%3Eb -->\n");
      expect(agents).not.toContain("a-->b");
    }
    expect(cli(home, project, "status").out).toContain("up to date");

    await writeTree(ws, { "context/My Notes.md": "Keep notes shorter.\n" });
    expect(cli(home, project, "update").code).toBe(0);
    expect(await read(project, "AGENTS.md")).toContain("Keep notes shorter.");
    expect(cli(home, project, "status").out).toContain("up to date");

    expect(cli(home, project, "remove").code).toBe(0);
    expect(await readdir(project)).toEqual([]);
  });

  test("a symlink that leads outside the Project needs a decision before any write there", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const project = await tempDir("project");
    const outside = await tempDir("dotfiles");
    // A junction on Windows needs no privilege; elsewhere it is a plain folder symlink.
    await symlink(outside, join(project, ".claude"), "junction");
    cli(home, project, "workspace", ws);

    const blocked = cli(home, project, "install", "skills-only", "--agents", "claude");
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain(`.claude is a symlink to ${outside}, outside this folder`);
    expect(blocked.out).toContain("--yes");
    expect(await readdir(project)).toEqual([".claude"]);
    expect(await readdir(outside)).toEqual([]);
    expect(cli(home, project, "status", "--all").out).toContain("Nothing is installed yet.");

    expect(cli(home, project, "install", "skills-only", "--agents", "claude", "--yes").code).toBe(0);
    expect(await read(outside, "skills/summarize/SKILL.md")).toContain("name: summarize");
    const manifest = JSON.parse(await read(project, ".agents/apkit.json"));
    expect(Object.keys(manifest.files)).toContain(".claude/skills/summarize/SKILL.md");
    expect(cli(home, project, "update").code).toBe(0);

    const remove = cli(home, project, "remove");
    expect(remove.code).toBe(3);
    expect(remove.out).toContain(`.claude is a symlink to ${outside}, outside this folder`);
    expect(await read(outside, "skills/summarize/SKILL.md")).toContain("name: summarize");
    expect(cli(home, project, "remove", "--yes").code).toBe(0);
    expect(await readdir(outside)).toEqual([]);
    expect(await readdir(project)).toEqual([".claude"]);
  });

  test("a symlink that stays inside the Project needs no decision", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const project = await tempDir("project");
    await mkdir(join(project, "shared"));
    await symlink(join(project, "shared"), join(project, ".claude"), "junction");
    cli(home, project, "workspace", ws);
    expect(cli(home, project, "install", "skills-only", "--agents", "claude").code).toBe(0);
    expect(await read(project, "shared/skills/summarize/SKILL.md")).toContain("name: summarize");
    expect(cli(home, project, "remove").code).toBe(0);
  });

  test("init creates only the missing Workspace parts and selects it", async () => {
    const home = await tempDir("home");
    const root = await tempDir("new-ws");
    await writeTree(root, { "context/existing.md": "Hi.\n" });
    const result = cli(home, root, "init", root, "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).added).toEqual(["apkit-workspace.yaml", "skills/", "profiles/"]);
    expect(JSON.parse(result.out).next).toContain(`${COMMAND} setup`);
    expect(cli(home, root, "workspace").out.trim()).not.toBe("No Workspace selected.");
    expect((await readdir(root)).sort()).toEqual(["apkit-workspace.yaml", "context", "profiles", "skills"]);
  });

  test("apkit-workspace.yaml marks a Workspace; the old workspace.yaml names the rename", async () => {
    const home = await tempDir("home");
    const empty = await tempDir("ws");
    await writeTree(empty, { "apkit-workspace.yaml": "" });
    expect(cli(home, home, "check", "--workspace", empty).code).toBe(0);

    const future = await tempDir("ws");
    await writeTree(future, { "apkit-workspace.yaml": "schema_version: 2\n" });
    const unsupported = cli(home, home, "check", "--workspace", future);
    expect(unsupported.code).toBe(1);
    expect(unsupported.out).toContain("newer apkit");

    const old = await tempDir("ws");
    await writeTree(old, { "workspace.yaml": "schema_version: 1\n" });
    const check = cli(home, home, "check", "--workspace", old);
    expect(check.code).toBe(1);
    expect(check.out).toContain("Rename workspace.yaml to apkit-workspace.yaml");
    const select = cli(home, home, "workspace", old);
    expect(select.code).toBe(1);
    expect(select.err).toContain("Rename workspace.yaml to apkit-workspace.yaml");

    const plain = await tempDir("plain");
    const refused = cli(home, home, "workspace", plain);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`${COMMAND} init`);
    expect(cli(home, home, "workspace").out.trim()).toEndWith("No Workspace selected.");
  });

  test("lenient Profiles: a missing list is empty, .yml is a Profile, and skills: all follows the Workspace", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    await writeTree(ws, {
      "profiles/only-skills.yaml": "skills:\n  - summarize\n",
      "profiles/light.yml": "context:\n  - communication\n",
      "profiles/everything.yaml": "skills: all\n",
    });
    const folder = await tempDir("f");
    expect(cli(home, folder, "workspace", ws).code).toBe(0);
    const check = cli(home, folder, "check", "--json");
    expect(check.code).toBe(0);
    const ids = JSON.parse(check.out).profiles.map((p: { id: string }) => p.id);
    expect(ids).toContain("only-skills");
    expect(ids).toContain("light");

    const one = await tempDir("one");
    expect(cli(home, one, "install", "only-skills", "--agents", "claude", "--yes").code).toBe(0);
    expect(await read(one, ".claude/skills/summarize/SKILL.md")).toContain("name: summarize");
    const two = await tempDir("two");
    expect(cli(home, two, "install", "light", "--agents", "codex", "--yes").code).toBe(0);
    expect(await read(two, "AGENTS.md")).toContain("Be concise.");

    // skills: all picks up a Skill added later, with no Profile edit.
    const all = await tempDir("all");
    expect(cli(home, all, "install", "everything", "--agents", "claude", "--yes").code).toBe(0);
    expect((await readdir(join(all, ".claude", "skills"))).sort()).toEqual(["review", "summarize"]);
    await writeTree(ws, { "skills/later/SKILL.md": SKILL("later") });
    expect(cli(home, all, "update").code).toBe(0);
    expect((await readdir(join(all, ".claude", "skills"))).sort()).toEqual(["later", "review", "summarize"]);
    expect(await read(ws, "profiles/everything.yaml")).toBe("skills: all\n");

    // Context is joined in list order, so it has no `all`.
    await writeTree(ws, { "profiles/bad.yaml": "context: all\n" });
    const bad = cli(home, folder, "check");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("Context must be listed");
  });

  test("a skipped file is a warning: check and install show it, and it never blocks an install", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const outside = await tempDir("outside");
    await writeTree(outside, { "linked/SKILL.md": SKILL("linked") });
    await writeTree(ws, {
      "context/notes.txt": "x",
      "context/empty.md": "",
      "skills/README.md": "x",
      "profiles/notes.txt": "x",
      "profiles/team/nested.yaml": "skills: [summarize]\n",
      "profiles/draft.yaml": "",
      // A Skill package with a leftover sidecar and the retired model-invocation key.
      "skills/old/SKILL.md": SKILL("old", "metadata:\n  agent-profile-kit:\n    model-invocation: explicit\n"),
      "skills/old/agent-profile-kit.yaml": "dependencies: []\n",
      "profiles/old.yaml": "skills: [old]\n",
    });
    // A junction on Windows needs no privilege; elsewhere it is a plain folder symlink.
    await symlink(join(outside, "linked"), join(ws, "skills", "linked"), "junction");
    const skipped = ["context/empty.md", "context/notes.txt", "skills/README.md", "profiles/notes.txt", "profiles/team/nested.yaml", "skills/linked"];

    const check = cli(home, home, "check", "--workspace", ws);
    expect(check.code).toBe(0);
    expect(check.out).toContain("is valid");
    for (const path of [...skipped, "profiles/draft.yaml"]) expect(check.out).toContain(path);
    const json = JSON.parse(cli(home, home, "check", "--workspace", ws, "--json").out);
    expect(json.valid).toBe(true);
    expect(json.violations).toEqual([]);
    expect(json.warnings.map((w: { path: string }) => w.path).sort()).toEqual([...skipped, "profiles/draft.yaml"].sort());
    const warnings = [
      ["empty-content", "context/empty.md"],
      ["stray-context-file", "context/notes.txt"],
      ["stray-skill-file", "skills/README.md"],
      ["stray-profile-file", "profiles/notes.txt"],
      ["profile-in-subfolder", "profiles/team/nested.yaml"],
      ["symlink", "skills/linked"],
      ["profile-without-artifacts", "profiles/draft.yaml"],
    ].sort();
    expect(json.warnings.map((w: Violation) => [w.code, w.path]).sort()).toEqual(warnings);

    const folder = await tempDir("f");
    const install = cli(home, folder, "install", "old", "--workspace", ws, "--agents", "claude", "--yes");
    expect(install.code).toBe(0);
    for (const path of skipped) expect(install.out).toContain(path);
    expect(await read(folder, ".claude/skills/old/agent-profile-kit.yaml")).toBe("dependencies: []\n");
    const again = JSON.parse(cli(home, folder, "install", "old", "--workspace", ws, "--agents", "claude", "--json").out);
    expect(again.result).toBe("unchanged");
    expect(again.warnings.map((w: Violation) => [w.code, w.path]).sort()).toEqual(warnings);

    for (const command of ["update", "status"]) {
      const result = cli(home, folder, command, "--all", "--workspace", ws);
      expect(result.code).toBe(0);
      for (const path of skipped) expect(result.out).toContain(join(ws, ...path.split("/")));
      const records = JSON.parse(cli(home, folder, command, "--all", "--workspace", ws, "--json").out).results;
      expect(records[0].warnings.map((w: { path: string }) => w.path)).toContain("skills/README.md");
    }

    // An error still blocks the install, and the warnings are listed with it.
    await writeTree(ws, { "profiles/old.yaml": "skills: [old, gone]\n" });
    const blocked = cli(home, folder, "install", "old", "--workspace", ws, "--agents", "claude", "--yes");
    expect(blocked.code).toBe(1);
    expect(blocked.err).toContain("'gone'");
    expect(blocked.err).toContain("skills/README.md");
  });

  test("a Workspace with errors can be selected and shows every error; installs and updates wait until it is fixed", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const one = await tempDir("one");
    const two = await tempDir("two");
    cli(home, one, "workspace", ws);
    expect(cli(home, one, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
    expect(cli(home, two, "install", "writing", "--agents", "codex", "--yes").code).toBe(0);

    // Manifest, Skill, and Profile errors, including all references in a Profile with another error.
    await writeTree(ws, {
      "apkit-workspace.yaml": "schema_version: abc\n",
      "profiles/engineering.yaml": "id: engineering\ncontext:\n  - communication\n  - absent\nskills:\n  - summarize\n  - gone\n",
      "profiles/broken.yaml": "skills: [\n",
      "profiles/Bad_Name.yaml": "skills: []\n",
      "skills/group/review/SKILL.md": "no frontmatter\n",
      "skills/README.md": "x",
    });
    const check = JSON.parse(cli(home, one, "check", "--json").out);
    expect(check.violations.map((v: Violation) => [v.code, v.path]).sort()).toEqual([
      ["workspace-manifest", "apkit-workspace.yaml"],
      ["invalid-frontmatter", "skills/group/review/SKILL.md"],
      ["profile-file-name", "profiles/Bad_Name.yaml"],
      ["invalid-yaml", "profiles/broken.yaml"],
      ["invalid-profile", "profiles/engineering.yaml"],
      ["missing-context-reference", "profiles/engineering.yaml"],
      ["missing-skill-reference", "profiles/engineering.yaml"],
    ].sort());

    const select = cli(home, one, "workspace", ws);
    expect(select.code).toBe(0);
    for (const v of check.violations) expect(select.out).toContain(v.message);
    expect(select.out).toContain("skills/README.md");
    expect(select.out).toContain(`${COMMAND} check`);
    const json = JSON.parse(cli(home, one, "workspace", ws, "--json").out);
    expect(json.valid).toBe(false);
    expect(json.violations).toEqual(check.violations);
    expect(json.warnings).toEqual(check.warnings);

    // Neither install nor update writes anything while the errors remain.
    const before = [await snapshot(one), await snapshot(two), await snapshot(home)];
    const install = cli(home, one, "install", "writing", "--agents", "claude", "--yes");
    expect(install.code).toBe(1);
    expect(install.err).toContain("'gone'");
    const update = cli(home, one, "update", "--all", "--yes");
    expect(update.code).toBe(1);
    expect(update.err).toContain("'gone'");
    expect(update.err).toContain(`${COMMAND} check`);
    expect([await snapshot(one), await snapshot(two), await snapshot(home)]).toEqual(before);

    // Once the errors are fixed, the warning alone blocks nothing.
    await writeTree(ws, {
      "apkit-workspace.yaml": "schema_version: 1\n",
      "profiles/engineering.yaml": "context:\n  - communication\nskills:\n  - summarize\n",
      "profiles/broken.yaml": "skills: []\n",
      "skills/group/review/SKILL.md": SKILL("review"),
    });
    await rm(join(ws, "profiles", "Bad_Name.yaml"));
    expect(cli(home, one, "update", "--all").code).toBe(0);
    expect(cli(home, one, "install", "writing", "--agents", "claude", "--yes").code).toBe(0);
  });

  test("init and workspace select Workspaces with errors and show the complete check report (ISC-48)", async () => {
    for (const missing of ["gone", "another-missing"]) {
      const ws = await makeWorkspace();
      await writeTree(ws, {
        "profiles/engineering.yaml": `context: [${missing}]\nskills: [${missing}]\n`,
        "profiles/broken.yaml": "skills: [\n",
        "skills/README.md": "This file is skipped.\n",
      });
      const check = cli(await tempDir("check-home"), ws, "check", "--workspace", ws, "--json");
      expect(check.code).toBe(1);
      const report = JSON.parse(check.out);
      expect(report.violations.length).toBeGreaterThanOrEqual(3);
      expect(report.violations).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "missing-context-reference" }),
        expect.objectContaining({ code: "missing-skill-reference" }),
      ]));
      expect(report.warnings.length).toBeGreaterThan(0);

      let selectionOutput: string | undefined;
      for (const command of ["workspace", "init"]) {
        const home = await tempDir(`${command}-home`);
        const select = cli(home, home, command, ws);
        expect(select.code).toBe(0);
        expect(select.err).toBe("");
        for (const finding of [...report.violations, ...report.warnings]) expect(select.out).toContain(finding.message);
        expect(select.out).toContain("Selected the Workspace at");
        expect(select.out).toContain("It has problems:");
        expect(select.out).toContain(`Installs and updates wait until \`${COMMAND} check\` reports no problems.`);
        expect(select.out).toContain(`${COMMAND} contract`);
        if (selectionOutput !== undefined) expect(select.out).toBe(selectionOutput);
        selectionOutput = select.out;

        const selectedCheck = cli(home, home, "check", "--json");
        expect(selectedCheck.code).toBe(1);
        expect(JSON.parse(selectedCheck.out)).toEqual(report);
        const jsonSelect = cli(home, home, command, ws, "--json");
        expect(jsonSelect.code).toBe(0);
        expect(JSON.parse(jsonSelect.out)).toMatchObject({
          workspace: ws,
          valid: false,
          violations: report.violations,
          warnings: report.warnings,
          contract: `${COMMAND} contract`,
        });
      }
    }
  });

  test("selecting a Workspace that lacks an installed Profile names each affected folder", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const one = await tempDir("one");
    const two = await tempDir("two");
    const three = await tempDir("three");
    cli(home, one, "workspace", ws);
    for (const folder of [one, two]) expect(cli(home, folder, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
    expect(cli(home, three, "install", "writing", "--agents", "claude", "--yes").code).toBe(0);
    expect(cli(home, home, "install", "skills-only", "--global", "--agents", "claude", "--yes").code).toBe(0);

    const other = await tempDir("ws");
    await writeTree(other, { "apkit-workspace.yaml": "", "context/voice.md": "Plain.\n", "profiles/writing.yaml": "context: [voice]\n" });
    const before = [await snapshot(other), await snapshot(one), await snapshot(two), await snapshot(three)];
    const select = cli(home, home, "workspace", other);
    expect(select.code).toBe(0);
    expect(select.out).toContain(`${one}: 'engineering'`);
    expect(select.out).toContain(`${two}: 'engineering'`);
    expect(select.out).toContain("User level: 'skills-only'");
    expect(select.out).not.toContain(three);
    const json = JSON.parse(cli(home, home, "workspace", other, "--json").out);
    expect(json.missing).toEqual([
      ...[one, two].sort().map((folder) => ({ folder, profile: "engineering" })),
      { folder: home, global: true, profile: "skills-only" },
    ]);
    expect([await snapshot(other), await snapshot(one), await snapshot(two), await snapshot(three)]).toEqual(before);

    // The first Workspace has every Profile again: nothing to report.
    expect(cli(home, home, "workspace", ws).out).not.toContain("lacks");
  });

  test("setup tells detected agents about apkit, after consent, and --remove undoes it", async () => {
    const home = await tempDir("home");
    expect(cli(home, home, "setup").code).toBe(1);
    await writeTree(home, { ".claude/CLAUDE.md": "# Mine\n", ".codex/config.toml": "" });
    const blocked = cli(home, home, "setup");
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain("Add a short marked note about apkit");
    expect(cli(home, home, "setup", "--yes").code).toBe(0);
    expect(await read(home, ".claude/CLAUDE.md")).toContain(`run \`${COMMAND} guide\``);
    expect(await read(home, ".codex/AGENTS.md")).toContain(`run \`${COMMAND} guide\``);
    expect(cli(home, home, "setup").out).toContain("already know about apkit");
    const ws = await makeWorkspace();
    expect(cli(home, home, "workspace", ws).out).not.toContain("Next:");
    expect(cli(home, home, "setup", "--remove").code).toBe(0);
    expect(await read(home, ".claude/CLAUDE.md")).toBe("# Mine\n");
    expect(await readdir(join(home, ".codex"))).toEqual(["config.toml"]);
  });

  test("in a Git repository, installed files stay out of git status, and removal cleans up", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    await writeTree(repo, { "CLAUDE.md": "# Repo\n" });
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" }).stdout;
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    cli(home, repo, "workspace", ws);
    expect(cli(home, repo, "install", "engineering", "--agents", "claude,codex", "--yes").code).toBe(0);
    // Only the instruction files show: the import line in the user's file, and the AGENTS.md apkit created.
    expect(git("status", "--porcelain").trimEnd().split("\n").sort()).toEqual([" M CLAUDE.md", "?? AGENTS.md"]);
    expect(await read(repo, ".git/info/exclude")).toContain("/.claude/skills/summarize/\n");
    // A linked worktree shares the exclude file with its own block.
    const tree = join(await tempDir("wt"), "tree");
    git("worktree", "add", "-q", tree);
    expect(cli(home, tree, "install", "skills-only", "--agents", "codex").code).toBe(0);
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: tree, encoding: "utf8" }).stdout).toBe("");
    expect(cli(home, repo, "remove").code).toBe(0);
    expect(git("status", "--porcelain")).toBe("");
    const exclude = await read(repo, ".git/info/exclude");
    expect(exclude).not.toContain(`apkit:begin ${repo}\n`);
    expect(exclude).toContain(`apkit:begin ${tree}`);
  });

  test("installs into subfolders stay out of git status, each with its own block", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    await writeTree(repo, { "a/CLAUDE.md": "# A\n", "b/README.md": "# B\n" });
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" }).stdout;
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    cli(home, repo, "workspace", ws);
    expect(cli(home, repo, "install", "engineering", "a", "--agents", "claude,codex", "--yes").code).toBe(0);
    expect(cli(home, repo, "install", "skills-only", "b", "--agents", "claude").code).toBe(0);
    // Only the instruction files show: the import line in a/CLAUDE.md, and the AGENTS.md apkit created.
    expect(git("status", "--porcelain").trimEnd().split("\n").sort()).toEqual([" M a/CLAUDE.md", "?? a/AGENTS.md"]);
    const exclude = await read(repo, ".git/info/exclude");
    expect(exclude).toContain(`# apkit:begin ${join(repo, "a")}\n`);
    expect(exclude).toContain("/a/.claude/skills/summarize/\n");
    expect(exclude).toContain("/b/.agents/apkit.json\n");
    // Removing one subfolder's install leaves the other's block.
    expect(cli(home, repo, "remove", "a").code).toBe(0);
    const after = await read(repo, ".git/info/exclude");
    expect(after).not.toContain(`apkit:begin ${join(repo, "a")}`);
    expect(after).not.toContain("/a/");
    expect(after).toContain(`# apkit:begin ${join(repo, "b")}\n`);
    expect(git("status", "--porcelain")).toBe("");
  });

  test("remove forgets a deleted linked worktree and drops its block", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    await writeTree(repo, { "README.md": "# Repo\n" });
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" }).stdout;
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    cli(home, repo, "workspace", ws);
    const tree = join(await tempDir("wt"), "tree");
    git("worktree", "add", "-q", tree);
    expect(cli(home, tree, "install", "skills-only", "--agents", "claude,codex").code).toBe(0);
    expect(await read(repo, ".git/info/exclude")).toContain(`apkit:begin ${tree}`);
    git("worktree", "remove", "--force", tree);
    expect(cli(home, repo, "remove", tree).code).toBe(0);
    expect(JSON.parse(cli(home, repo, "status", "--all", "--json").out).results).toEqual([]);
    expect(await read(repo, ".git/info/exclude")).not.toContain(tree);
  });

  test("the decision output names each instruction file, the change, and whether Git tracks it", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" }).stdout;
    git("init", "-q");
    await writeTree(repo, { "CLAUDE.md": "# Repo\n" });
    cli(home, repo, "workspace", ws);

    const fresh = cli(home, repo, "install", "engineering", "--agents", "claude");
    expect(fresh.code).toBe(3);
    expect(fresh.out).toContain("AGENTS.md: will be created; not tracked by Git.");
    expect(fresh.out).toContain("CLAUDE.md: will be changed; not tracked by Git.");
    const json = JSON.parse(cli(home, repo, "install", "engineering", "--agents", "claude", "--json").out);
    expect(json.instructions).toEqual([
      { path: "AGENTS.md", action: "create", tracked: false },
      { path: "CLAUDE.md", action: "change", tracked: false },
    ]);

    await writeTree(repo, { "AGENTS.md": "# Agents\n" });
    git("add", "AGENTS.md");
    git("commit", "-qm", "agents");
    expect(cli(home, repo, "install", "engineering", "--agents", "claude").out).toContain(
      "AGENTS.md: will be changed; tracked by Git.",
    );
  });

  test("after a change, the output names each instruction file changed and whether Git tracks it", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    const git = (...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" }).stdout;
    git("init", "-q");
    await writeTree(repo, { "CLAUDE.md": "# Repo\n" });
    git("add", "CLAUDE.md");
    git("commit", "-qm", "claude");
    cli(home, repo, "workspace", ws);

    const install = cli(home, repo, "install", "engineering", "--agents", "claude", "--yes");
    expect(install.code).toBe(0);
    expect(install.out).toContain("  Instruction files:\n    - AGENTS.md: created; not tracked by Git.\n    - CLAUDE.md: changed; tracked by Git.");
    // A run that changes no instruction file lists none.
    const update = cli(home, repo, "update");
    expect(update.out).not.toContain("Instruction files");

    const remove = cli(home, repo, "remove");
    expect(remove.code).toBe(0);
    expect(remove.out).toContain("  Instruction files:\n    - AGENTS.md: deleted; not tracked by Git.\n    - CLAUDE.md: changed; tracked by Git.");
  });

  test("an AGENTS.md apkit creates is never hidden from Git", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    spawnSync("git", ["init", "-q"], { cwd: repo });
    await writeTree(repo, { "CLAUDE.md": "# Repo\n" });
    cli(home, repo, "workspace", ws);
    expect(cli(home, repo, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
    const exclude = (await read(repo, ".git/info/exclude")).split("\n");
    expect(exclude.filter((line) => /AGENTS\.md|CLAUDE\.md/.test(line))).toEqual([]);
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).stdout).toContain("?? AGENTS.md");
  });

  test("install --global puts a Skills-only Profile in each agent's user-level Skills folder", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    const install = cli(home, home, "install", "skills-only", "--global", "--agents", "claude,codex,grok,antigravity");
    expect(install.code).toBe(0);
    expect(install.out).toContain("Installed 'skills-only' for Antigravity, Claude Code, Codex, Grok at user level.");
    for (const path of [".claude/skills", ".agents/skills", ".grok/skills", ".gemini/config/skills"]) {
      expect(await read(home, `${path}/summarize/SKILL.md`)).toContain("name: summarize");
    }
    await writeTree(ws, { "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: v2\n---\n" });
    expect(cli(home, home, "update", "--all").code).toBe(0);
    expect(await read(home, ".gemini/config/skills/summarize/SKILL.md")).toContain("v2");
    // status --global shows the user-level install alone, from any folder.
    const project = await tempDir("p");
    expect(cli(home, project, "status", "--global").out).toBe("User level: 'skills-only' for Antigravity, Claude Code, Codex, Grok is up to date.\n");
    const remove = cli(home, home, "remove", "--global");
    expect(remove.code).toBe(0);
    expect(remove.out).toContain("Removed 'skills-only' for Antigravity, Claude Code, Codex, Grok from user level.");
    expect(cli(home, project, "status", "--global").out).toBe("User level: nothing installed.\n");
    const left = await readdir(home);
    for (const dir of [".claude", ".agents", ".grok", ".gemini"]) expect(left).not.toContain(dir);
  });

  test("install --global takes over an identical Skill the user put there only after a decision", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    await writeTree(home, { ".claude/skills/summarize/SKILL.md": await read(ws, "skills/summarize/SKILL.md") });
    const blocked = cli(home, home, "install", "skills-only", "--global", "--agents", "claude");
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain(".claude/skills/summarize/SKILL.md has the same content but was not written by apkit. apkit manages it from now on, and remove deletes it.");
    expect(blocked.out).toContain("--yes");
    expect(cli(home, home, "install", "--help").out.replace(/\s+/g, " ")).toContain("taking over a file apkit did not write that has the same content (remove then deletes it)");
    expect(cli(home, home, "status", "--global").out).toBe("User level: nothing installed.\n");
    expect(cli(home, home, "install", "skills-only", "--global", "--agents", "claude", "--yes").code).toBe(0);
    expect(cli(home, home, "remove", "--global").code).toBe(0);
    expect(await readdir(home)).not.toContain(".claude");
  });

  test("a Skill both the home folder's install and the global install wrote needs no decision", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    expect(cli(home, home, "install", "skills-only", "--agents", "claude").code).toBe(0);
    expect(cli(home, home, "install", "skills-only", "--global", "--agents", "claude").code).toBe(0);
    // And the other way round: the global install first, then the home folder's.
    expect(cli(home, home, "remove").code).toBe(0);
    expect(cli(home, home, "install", "skills-only", "--agents", "claude").code).toBe(0);
  });

  test("install --global puts a Profile's Context in each agent's user-level file, after consent", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    const before = await homeSnapshot(home);
    const all = "antigravity,claude,codex,grok,opencode,pi";
    const blocked = cli(home, home, "install", "engineering", "--global", "--agents", all);
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain(join(home, ".codex", "AGENTS.md"));
    expect(await homeSnapshot(home)).toEqual(before);

    expect(cli(home, home, "install", "engineering", "--global", "--agents", all, "--yes").code).toBe(0);
    for (const path of USER_FILES) {
      const text = await read(home, path);
      expect(text).toContain("<!-- apkit:global:begin -->");
      expect(text).toContain("Be concise.");
      expect(text).toContain(`${COMMAND} update --all`);
      expect(text).not.toContain("This project's own instructions");
    }
    for (const path of [".claude/skills", ".agents/skills", ".grok/skills", ".gemini/config/skills"]) {
      expect(await read(home, `${path}/review/SKILL.md`)).toContain("name: review");
    }
    // The home folder has no project install: the global manifest lives apart from it.
    expect(await readdir(join(home, ".agents"))).not.toContain("apkit.json");
    expect(cli(home, home, "status", "--all").out).toContain("User level: 'engineering'");
    expect(cli(home, home, "status", "--all").out).toContain("is up to date");

    // A Workspace edit reaches every user-level file through update --all.
    await writeTree(ws, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    expect(JSON.parse(cli(home, home, "status", "--all", "--json").out).results[0].result).toBe("updated");
    expect(cli(home, home, "update", "--all").code).toBe(0);
    for (const path of USER_FILES) expect(await read(home, path)).toContain("Be warm.");

    expect(cli(home, home, "remove", "--global").code).toBe(0);
    expect(await homeSnapshot(home)).toEqual(before);
  });

  test("a global install never hides an existing user-level file", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    await writeTree(home, { ".claude/CLAUDE.md": "# Mine\n", ".config/opencode/opencode.json": "{}\n" });
    expect(cli(home, home, "install", "engineering", "--global", "--agents", "opencode", "--yes").code).toBe(0);
    expect(await read(home, ".claude/CLAUDE.md")).toContain("Be concise.");
    expect(await readdir(join(home, ".config", "opencode"))).toEqual(["opencode.json"]);
  });

  test("a global install writes through a user-level folder linked into dotfiles without an outside-link decision", async () => {
    const home = await tempDir("home");
    const dotfiles = await tempDir("dotfiles");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    await writeTree(dotfiles, { "claude/CLAUDE.md": "# Dotfiles\n" });
    await symlink(join(dotfiles, "claude"), join(home, ".claude"), "junction");
    const result = cli(home, home, "install", "engineering", "--global", "--agents", "claude", "--yes");
    expect(result.code).toBe(0);
    expect(await read(dotfiles, "claude/CLAUDE.md")).toContain("Be concise.");
    expect(await read(dotfiles, "claude/skills/summarize/SKILL.md")).toContain("name: summarize");
    expect(cli(home, home, "remove", "--global").code).toBe(0);
    expect(await readdir(join(dotfiles, "claude"))).toEqual(["CLAUDE.md"]);
    expect(await read(dotfiles, "claude/CLAUDE.md")).toBe("# Dotfiles\n");
  });

  test("remove --global restores each user-level file byte for byte", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    await writeTree(home, {
      ".claude/CLAUDE.md": "# Mine\r\n\r\nBe brief.\r\n",
      ".codex/AGENTS.override.md": "# Override\n",
      ".gemini/AGENTS.md": "",
    });
    const before = await homeSnapshot(home);
    expect(cli(home, home, "install", "engineering", "--global", "--agents", "claude,codex,antigravity,grok", "--yes").code).toBe(0);
    expect(await read(home, ".codex/AGENTS.override.md")).toContain("Be concise.");
    expect(await read(home, ".claude/CLAUDE.md")).toContain("\r\n<!-- apkit:global:begin -->\r\n");
    expect(cli(home, home, "remove", "--global").code).toBe(0);
    expect(await homeSnapshot(home)).toEqual(before);
  });

  test("setup --yes gives every detected agent's user-level file a note that points to guide (all six agents)", async () => {
    const home = await tempDir("home");
    // Only each agent's own folder, empty: setup detects the agent and creates the file it reads.
    for (const dir of [".claude", ".codex", ".config/opencode", ".pi/agent", ".grok", ".gemini/antigravity"]) {
      await mkdir(join(home, ...dir.split("/")), { recursive: true });
    }
    // A first run lets Bun write its own cache under this home before the snapshot (--help writes nothing of apkit's).
    expect(cli(home, home, "--help").code).toBe(0);
    const before = await homeSnapshot(home);
    const setup = cli(home, home, "setup", "--yes", "--json");
    expect(setup.code).toBe(0);
    const files = JSON.parse(setup.out).files as { agents: string[] }[];
    expect(files.flatMap((file) => file.agents).sort()).toEqual(Object.keys(AGENTS).sort());
    for (const path of USER_FILES) expect({ path, text: await read(home, path) }).toEqual({ path, text: expect.stringContaining(`run \`${COMMAND} guide\``) });
    expect(cli(home, home, "setup", "--remove").code).toBe(0);
    expect(await homeSnapshot(home)).toEqual(before);
  });

  test("setup and a global install for OpenCode never create a file earlier in its lookup order than ~/.claude/CLAUDE.md", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    await writeTree(home, { ".claude/CLAUDE.md": "# Mine\n", ".config/opencode/opencode.json": "{}\n" });
    const before = await homeSnapshot(home);
    const changedPaths = async () => {
      const now = await homeSnapshot(home);
      return [...new Set([...Object.keys(before), ...Object.keys(now)])].filter((path) => before[path] !== now[path]).sort();
    };

    expect(cli(home, home, "setup", "--agents", "opencode", "--yes").code).toBe(0);
    expect(await changedPaths()).toEqual([".claude/CLAUDE.md"]);
    expect(await read(home, ".claude/CLAUDE.md")).toContain(`run \`${COMMAND} guide\``);

    expect(cli(home, home, "install", "engineering", "--global", "--agents", "opencode", "--yes").code).toBe(0);
    // OpenCode's user-level Skills go to ~/.agents/skills; its instruction file is still only CLAUDE.md.
    expect((await changedPaths()).filter((path) => !path.startsWith(".agents/"))).toEqual([".claude/CLAUDE.md"]);
    expect(await read(home, ".claude/CLAUDE.md")).toContain("Be concise.");
    expect(existsSync(join(home, ".config", "opencode", "AGENTS.md"))).toBe(false);
  });

  test("setup --remove and remove --global restore each agent's user-level file byte for byte, with CRLF and no final newline", async () => {
    const userFiles = {
      ".claude/CLAUDE.md": "# Mine\r\n\r\nBe brief.\r\n",
      ".codex/AGENTS.md": "# Codex\n\nNo final newline.",
      ".config/opencode/AGENTS.md": "# OpenCode\r\n\r\nCRLF, no final newline.",
      ".pi/agent/AGENTS.md": "# Pi\n\nKeep it short.\n",
      ".grok/rules/mine.md": "# Rules\n",
      ".gemini/AGENTS.md": "",
      ".gemini/antigravity/settings.json": "{}\n",
    };
    const all = Object.keys(AGENTS).join(",");
    const steps = {
      setup: ["setup", "--yes"],
      global: ["install", "engineering", "--global", "--agents", all, "--yes"],
      "remove setup": ["setup", "--remove"],
      "remove global": ["remove", "--global"],
    } as const;
    const sequences: (keyof typeof steps)[][] = [
      ["setup", "remove setup"],
      ["global", "remove global"],
      ["setup", "global", "remove setup", "remove global"],
      ["setup", "global", "remove global", "remove setup"],
    ];
    const userPaths = [".claude/CLAUDE.md", ".codex/AGENTS.md", ".config/opencode/AGENTS.md", ".pi/agent/AGENTS.md", ".grok/rules/apkit.md", ".gemini/AGENTS.md"];
    for (const sequence of sequences) {
      const home = await tempDir("home");
      const ws = await makeWorkspace();
      cli(home, home, "workspace", ws);
      await writeTree(home, userFiles);
      const before = await homeSnapshot(home);
      for (const step of sequence) {
        const result = cli(home, home, ...steps[step]);
        expect({ sequence, step, code: result.code, err: result.err }).toEqual({ sequence, step, code: 0, err: "" });
        // Each install step really wrote every agent's file.
        const marker = step === "setup" ? `run \`${COMMAND} guide\`` : step === "global" ? "Be concise." : null;
        if (marker !== null) {
          for (const path of userPaths) expect({ sequence, path, text: await read(home, path) }).toEqual({ sequence, path, text: expect.stringContaining(marker) });
        }
      }
      expect({ sequence, home: await homeSnapshot(home) }).toEqual({ sequence, home: before });
    }
  });

  test("a global install into agent folders outside the home is updated and removed like any other", async () => {
    const base = await tempDir("outside");
    const home = join(base, "home");
    const extra = { CLAUDE_CONFIG_DIR: join(base, "claude-config"), GROK_HOME: join(base, "grok-home") };
    await mkdir(home);
    await writeTree(base, {
      "claude-config/CLAUDE.md": "# Mine\n",
      "grok-home/rules/mine.md": "# Rules\n",
    });
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    const folders = [home, extra.CLAUDE_CONFIG_DIR, extra.GROK_HOME];
    const before = await Promise.all(folders.map(homeSnapshot));
    const run = (...args: string[]) => cliWithEnv(extra, home, home, ...args);
    expect(run("install", "engineering", "--global", "--agents", "claude,grok", "--yes").code).toBe(0);
    expect(await read(extra.CLAUDE_CONFIG_DIR, "skills/summarize/SKILL.md")).toContain("name: summarize");
    expect(await read(extra.GROK_HOME, "skills/summarize/SKILL.md")).toContain("name: summarize");
    const global = JSON.parse(await readFile(join(home, "global.json"), "utf8")) as { files: Record<string, string> };
    expect(Object.keys(global.files)).toContain("../claude-config/skills/summarize/SKILL.md");
    for (const args of [["status", "--all"], ["update", "--all"], ["remove", "--global"]]) {
      const result = run(...args);
      expect({ args, code: result.code, err: result.err }).toEqual({ args, code: 0, err: "" });
    }
    expect(await Promise.all(folders.map(homeSnapshot))).toEqual(before);
  });

  test("removing a global install keeps an empty agent folder set outside the home, however deep it sits", async () => {
    const base = await tempDir("outside");
    const home = join(base, "home");
    const agentFolder = join(base, "opt", "cfg", "claude");
    await mkdir(home);
    await mkdir(agentFolder, { recursive: true });
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    const run = (...args: string[]) => cliWithEnv({ CLAUDE_CONFIG_DIR: agentFolder }, home, home, ...args);
    expect(run("install", "skills-only", "--global", "--agents", "claude", "--yes").code).toBe(0);
    expect(await read(agentFolder, "skills/summarize/SKILL.md")).toContain("name: summarize");
    expect(run("remove", "--global").code).toBe(0);
    expect(await readdir(agentFolder)).toEqual([]);
  });

  test("a config record that names a folder outside its own file's path stops setup before anything is removed", async () => {
    const home = await tempDir("home");
    const keep = join(home, "keep");
    await mkdir(keep);
    expect(cli(home, home, "setup", "--agents", "codex", "--yes").code).toBe(0);
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    const path = Object.keys(config.notes)[0] as string;
    config.notes[path].createdDirs = [keep];
    await writeFile(join(home, "config.json"), JSON.stringify(config));
    const result = cli(home, home, "setup", "--remove");
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("config.json");
    expect(await read(home, ".codex/AGENTS.md")).toContain(COMMAND);
    expect(await readdir(keep)).toEqual([]);
  });

  for (const order of [["setup", "global"], ["global", "setup"]]) {
    test(`setup and a global install share a file, and removal (${order.join(" first, then ")}) restores it`, async () => {
      const home = await tempDir("home");
      const ws = await makeWorkspace();
      cli(home, home, "workspace", ws);
      // No ~/.codex yet: whichever install runs first creates it, and the last removal deletes it.
      const before = await homeSnapshot(home);
      const install = { setup: ["setup", "--agents", "codex", "--yes"], global: ["install", "engineering", "--global", "--agents", "codex", "--yes"] };
      const remove = { setup: ["setup", "--remove"], global: ["remove", "--global"] };
      for (const step of order) expect(cli(home, home, ...install[step as "setup"]).code).toBe(0);
      const both = await read(home, ".codex/AGENTS.md");
      expect(both).toContain(`run \`${COMMAND} guide\``);
      expect(both).toContain("Be concise.");
      for (const step of order) expect(cli(home, home, ...remove[step as "setup"]).code).toBe(0);
      expect(await homeSnapshot(home)).toEqual(before);
    });
  }

  test("a project install in the home folder and a global install live side by side", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    const project = ["install", "engineering", home, "--agents", "claude,codex", "--yes"];
    const global = ["install", "engineering", "--global", "--agents", "claude,codex", "--yes"];
    expect(cli(home, home, ...project).code).toBe(0);
    const projectOnly = await homeSnapshot(home);
    expect(cli(home, home, ...global).code).toBe(0);
    expect(cli(home, home, "status", "--all").out.match(/is up to date/g)?.length).toBe(2);

    // Removing the global install leaves the project install exactly as it was.
    expect(cli(home, home, "remove", "--global").code).toBe(0);
    expect(await homeSnapshot(home)).toEqual(projectOnly);
    expect(cli(home, home, "status").out).toContain("is up to date");

    // Removing the project install leaves the global install intact.
    expect(cli(home, home, ...global).code).toBe(0);
    expect(cli(home, home, "remove", home).code).toBe(0);
    expect(await read(home, ".claude/skills/summarize/SKILL.md")).toContain("name: summarize");
    expect(await read(home, ".agents/skills/summarize/SKILL.md")).toContain("name: summarize");
    const status = JSON.parse(cli(home, home, "status", "--all", "--json").out).results;
    expect(status.map((o: { result: string }) => o.result)).toEqual(["unchanged"]);
  });

  test("status names Context installed both at user level and in the Project, and never blocks", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const both = await tempDir("both");
    const other = await tempDir("other");
    cli(home, both, "workspace", ws);
    expect(cli(home, home, "install", "engineering", "--global", "--agents", "claude", "--yes").code).toBe(0);
    // The overlap never blocks an install or an update.
    expect(cli(home, both, "install", "engineering", "--agents", "codex", "--yes").code).toBe(0);
    expect(cli(home, other, "install", "writing", "--agents", "codex", "--yes").code).toBe(0);
    await writeTree(ws, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    expect(cli(home, both, "update").code).toBe(0);

    const status = cli(home, both, "status");
    expect(status.code).toBe(0);
    expect(status.out).toContain("Context 'communication' is also installed at user level; an agent selected in both places reads it twice.");
    expect(JSON.parse(cli(home, both, "status", "--json").out).results[0].overlap).toEqual(["communication"]);

    expect(cli(home, other, "status").out).not.toContain("also installed at user level");
    expect(JSON.parse(cli(home, other, "status", "--json").out).results[0].overlap).toEqual([]);
  });

  test("a manifest from a newer apkit is left as it is and names the update", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const newer = await tempDir("newer");
    const current = await tempDir("current");
    cli(home, newer, "workspace", ws);
    expect(cli(home, newer, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
    expect(cli(home, current, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
    const manifest = JSON.parse(await read(newer, ".agents/apkit.json"));
    await writeTree(newer, { ".agents/apkit.json": JSON.stringify({ ...manifest, schema: 2, future: true }) });
    await writeTree(ws, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    const before = await snapshot(newer);
    const config = await read(home, "config.json");

    for (const args of [
      ["install", "engineering", "--agents", "codex", "--yes", "--overwrite"],
      ["update", "--yes", "--overwrite"],
      ["remove", "--yes", "--overwrite"],
      ["status"],
    ]) {
      const result = cli(home, newer, ...args);
      expect(`${result.out}${result.err}`).toContain("written by a newer apkit");
      expect(`${result.out}${result.err}`).toContain("Update apkit");
      expect(`${result.out}${result.err}`).toContain("Next: `npm install --global agent-profile-kit`");
      expect(await snapshot(newer)).toEqual(before);
      expect(await read(home, "config.json")).toBe(config);
    }

    // --all reports the newer folder and still processes the others.
    const status = JSON.parse(cli(home, current, "status", "--all", "--json").out).results;
    expect(status.map((o: { result: string }) => o.result).sort()).toEqual(["error", "updated"]);
    const update = cli(home, current, "update", "--all");
    expect(update.code).toBe(1);
    expect(update.out).toContain("written by a newer apkit");
    expect(await read(current, "AGENTS.md")).toContain("Be warm.");
    expect(await snapshot(newer)).toEqual(before);
  });

  test("a global manifest from a newer apkit is left as it is and names the update", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const project = await tempDir("project");
    cli(home, home, "workspace", ws);
    expect(cli(home, home, "install", "engineering", "--global", "--agents", "codex", "--yes").code).toBe(0);
    expect(cli(home, project, "install", "engineering", "--agents", "codex", "--yes").code).toBe(0);
    const manifest = JSON.parse(await read(home, "global.json"));
    await writeTree(home, { "global.json": JSON.stringify({ ...manifest, schema: 2, future: true }) });
    await writeTree(ws, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    const before = await homeSnapshot(home);
    const global = await read(home, "global.json");

    for (const args of [
      ["install", "engineering", "--global", "--agents", "claude", "--yes", "--overwrite"],
      ["remove", "--global", "--yes", "--overwrite"],
      ["install", "engineering", home, "--agents", "codex", "--yes"],
    ]) {
      const result = cli(home, home, ...args);
      expect(result.code).toBe(1);
      expect(`${result.out}${result.err}`).toContain("global.json was written by a newer apkit");
      expect(await homeSnapshot(home)).toEqual(before);
      expect(await read(home, "global.json")).toBe(global);
    }

    // --all reports the global install and still updates the project.
    const update = cli(home, project, "update", "--all");
    expect(update.code).toBe(1);
    expect(update.out).toContain("User level: ");
    expect(update.out).toContain("written by a newer apkit");
    expect(await read(project, "AGENTS.md")).toContain("Be warm.");
    expect(await homeSnapshot(home)).toEqual(before);
  });

  test("machine configuration from a newer apkit stops every command before it writes", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("f");
    // A configuration from before the schema field still works, and is written with one.
    await writeTree(home, { "config.json": JSON.stringify({ workspace: ws, installs: [] }) });
    expect(cli(home, folder, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
    const written = JSON.parse(await read(home, "config.json"));
    expect(written.schema).toBe(1);

    const config = JSON.stringify({ ...written, schema: 2, future: true });
    await writeTree(home, { "config.json": config });
    await writeTree(ws, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    const other = await tempDir("other");
    const before = await snapshot(folder);
    for (const [cwd, args] of [
      [other, ["install", "engineering", "--agents", "claude", "--yes"]],
      [folder, ["update", "--yes"]],
      [folder, ["remove", "--yes"]],
      [folder, ["status"]],
      [folder, ["workspace", ws]],
    ] as const) {
      const result = cli(home, cwd, ...args);
      expect(result.code).toBe(1);
      expect(result.err).toContain("written by a newer apkit");
      expect(result.err).toContain("Update apkit");
      expect(await read(home, "config.json")).toBe(config);
      expect(await snapshot(folder)).toEqual(before);
      expect(await readdir(other)).toEqual([]);
    }
  });

  test("an install names each selected agent that needs the folder trusted, and what waits for it", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    const install = async (profile: string, agents: string) =>
      cli(home, await tempDir("project"), "install", profile, "--agents", agents, "--yes").out;

    const skills = await install("engineering", "codex,pi");
    expect(skills).toMatch(/Codex and Pi load Skills from .+ only after you trust that Project\./);
    const everything = await install("skills-only", "grok,antigravity");
    expect(everything).toMatch(/Antigravity and Grok load nothing from .+ until you trust that Project\./);
    // Grok holds back Context too; Codex loads Context without trust, so a Profile with no Skills needs no line for it.
    expect(await install("writing", "codex,grok")).toMatch(/\nGrok loads nothing from .+ until you trust that Project\.\n$/);
    expect(await install("engineering", "claude,opencode")).not.toContain("trust");
    for (const out of [skills, everything]) expect(out).not.toMatch(/\bloaded\b/);
  });

  test("install --json lists the same trust needs, and a user-level install has none", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    const install = async (agents: string) =>
      JSON.parse(cli(home, await tempDir("project"), "install", "engineering", "--agents", agents, "--yes", "--json").out);

    expect((await install("claude,codex,grok")).trust).toEqual([
      { agent: "codex", untilTrusted: "skills" },
      { agent: "grok", untilTrusted: "everything" },
    ]);
    expect((await install("claude")).trust).toEqual([]);
    const global = cli(home, home, "install", "skills-only", "--global", "--agents", "codex,grok", "--json");
    expect(JSON.parse(global.out).trust).toEqual([]);
  });

  test("a Workspace selection remedy quotes the complete init command", async () => {
    const home = await tempDir("home");
    const folder = join(await tempDir("sources"), "empty Workspace");
    await mkdir(folder);
    const result = cli(home, home, "workspace", folder);
    expect(result.code).toBe(1);
    expect(result.err).toContain(`Next: \`apkit init '${folder}'\``);
  });

  test("remove and setup removal decisions give complete commands without losing existing flags", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("project");
    expect(cli(home, folder, "install", "engineering", "--agents", "claude", "--workspace", ws, "--yes").code).toBe(0);
    await writeTree(folder, { ".claude/skills/summarize/SKILL.md": "Keep my edit" });
    const before = await snapshot(folder);
    const remove = cli(home, home, "remove", folder, "--yes");
    expect(remove.code).toBe(3);
    expect(remove.out).toContain("Next: `apkit remove ");
    expect(remove.out).toContain(folder);
    expect(remove.out).toContain(" --yes --overwrite`");
    expect(await snapshot(folder)).toEqual(before);
    await writeTree(home, { ".claude/CLAUDE.md": "# My instructions\n" });
    expect(cli(home, home, "setup", "--agents", "claude", "--yes").code).toBe(0);
    await writeTree(home, { ".claude/CLAUDE.md": (await read(home, ".claude/CLAUDE.md")).replace("apkit guide", "apkit guide (edited)") });
    const setup = cli(home, home, "setup", "--remove", "--yes");
    expect(setup.code).toBe(3);
    expect(setup.out).toContain("Next: `apkit setup --remove --yes --overwrite`");
    expect(setup.out).toContain(join(home, ".claude", "CLAUDE.md"));
  });

  test("status next commands update the named Project and user-level install from another folder", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("project");
    expect(cli(home, folder, "install", "engineering", "--agents", "claude", "--workspace", ws, "--yes").code).toBe(0);
    expect(cli(home, home, "install", "engineering", "--global", "--agents", "claude", "--workspace", ws, "--yes").code).toBe(0);
    await writeTree(ws, { "context/communication.md": "# Changed guidance\n" });
    const status = cli(home, home, "status", "--all", "--workspace", ws);
    expect(status.code).toBe(0);
    expect(status.out).toContain("AGENTS.md");
    expect(status.out).toContain(join(home, ".claude", "CLAUDE.md"));
    const commands = [...status.out.matchAll(/Next: `([^`]+)`/g)].map((m) => m[1]!);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toStartWith("apkit update ");
    expect(commands[0]).toContain(folder);
    expect(commands[0]).toContain(" --workspace ");
    expect(commands[0]).toContain(ws);
    expect(commands[1]).toContain("apkit install engineering --global");
    expect(commands[1]).toContain("--agents claude");
    for (const command of commands) {
      if (process.platform === "win32") continue;
      const env = cliEnv(home);
      const result = spawnSync("sh", ["-c", 'exec "$@" ' + command.slice("apkit ".length), "apkit", ...RUNTIME], { cwd: home, env, encoding: "utf8" });
      expect([result.status, result.stderr]).toEqual([0, ""]);
    }
    if (process.platform !== "win32") {
      const after = JSON.parse(cli(home, home, "status", "--all", "--workspace", ws, "--json").out).results;
      expect(after.map((o: { result: string }) => o.result)).toEqual(["unchanged", "unchanged"]);
    }
  });

  test("trust warnings name the affected Project path", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("project");
    const result = cli(home, folder, "install", "engineering", "--agents", "codex,grok", "--workspace", ws, "--yes");
    expect(result.code).toBe(0);
    const warnings = result.out.split("\n").filter((line) => line.includes("trust"));
    expect(warnings).toHaveLength(2);
    for (const line of warnings) expect(line).toContain(folder);
  });

  test("shared warnings list every Project once and keep different Context warnings separate", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const projects = await tempDir("projects");
    const first = join(projects, "one", "same name");
    const second = join(projects, "two", "same name");
    const different = join(projects, "three", "same name");
    const unrelated = join(projects, "four", "same name");
    await writeTree(ws, { "profiles/global.yaml": "context: [communication, writing/voice]\n" });
    expect(cli(home, home, "workspace", ws).code).toBe(0);
    expect(cli(home, home, "install", "global", "--global", "--agents", "claude", "--yes").code).toBe(0);
    for (const [folder, profile] of [[first, "engineering"], [second, "engineering"], [different, "writing"], [unrelated, "skills-only"]]) {
      await mkdir(folder!, { recursive: true });
      expect(cli(home, folder!, "install", profile!, "--agents", "claude", "--yes").code).toBe(0);
    }
    const status = cli(home, home, "status", "--all");
    expect(status.code).toBe(0);
    expect(status.out.split("Context 'communication' is also installed")).toHaveLength(2);
    expect(status.out.split("Context 'writing/voice' is also installed")).toHaveLength(2);
    const warnings = status.out.slice(status.out.indexOf("Warning:"));
    for (const path of [first, second, different]) expect(warnings.split(path)).toHaveLength(2);
    expect(warnings).not.toContain(unrelated);
    const json = JSON.parse(cli(home, home, "status", "--all", "--json").out).results;
    expect(json.find((o: { folder: string }) => o.folder === second).overlap).toEqual(["communication"]);
  });

  test("decision next commands preserve the operation, target, and Workspace and run from elsewhere", async () => {
    const home = await tempDir("home");
    const source = await makeWorkspace();
    const ws = join(await tempDir("sources"), "user's Workspace $safe");
    await cp(source, ws, { recursive: true });
    const folder = join(await tempDir("projects"), "user's Project $safe");
    await mkdir(folder);
    await writeTree(folder, { ".claude/skills/summarize/SKILL.md": "user's content" });
    const before = await snapshot(folder);
    const result = cli(home, home, "install", "engineering", folder, "--agents", "claude", "--workspace", relative(home, ws));
    expect(result.code).toBe(3);
    expect(await snapshot(folder)).toEqual(before);
    const command = result.out.match(/Next: `([^`]+)`/)?.[1];
    expect(command).toBeDefined();
    expect(command).toContain("--yes");
    expect(command).toContain("--overwrite");
    expect(command).toContain("--agents claude");
    expect(command).toContain("'\"'\"'");
    // The displayed POSIX command can be copied to a shell, with a test runtime standing in for apkit.
    if (process.platform !== "win32") {
      const env = cliEnv(home);
      const retry = spawnSync("sh", ["-c", 'exec "$@" ' + command!.slice("apkit ".length), "apkit", ...RUNTIME], { cwd: home, env, encoding: "utf8" });
      expect([retry.status, retry.stderr]).toEqual([0, ""]);
      expect(JSON.parse(cli(home, folder, "status", "--workspace", ws, "--json").out).results[0].profile).toBe("engineering");
    }
  });

  test("first output explains Workspace, Profile, and Context in three plain lines", async () => {
    const home = await tempDir("home");
    const ws = join(home, "workspace");
    const introduction = [
      "Workspace: your source folder for Context and Skills.",
      "Profile: a named selection of Context and Skills to install.",
      "Context: guidance your agents load for every session.",
    ].join("\n");
    for (const args of [["workspace"], ["init", ws], ["workspace", ws], ["workspace"], ["guide"]]) {
      const result = cli(home, home, ...args);
      expect(result.code).toBe(0);
      expect(result.out).toContain(introduction);
      expect(result.out.split("Workspace: your source folder")).toHaveLength(2);
    }
    expect(JSON.parse(cli(home, home, "workspace", "--json").out).workspace).toBe(ws);
  });

  test("public help teaches the installed apkit command", async () => {
    const home = await tempDir("home");
    const help = cli(home, home, "--help");
    expect(help.code).toBe(0);
    expect(help.out).toStartWith("apkit —");
    expect(help.out).toContain("apkit install <profile>");
  });

  test("`init` and `workspace` without a path, and `--help`, write nothing in a fresh home (ISC-25.1)", async () => {
    const home = await tempDir("home");
    const apkitHome = join(home, "apkit");
    // The runtime may add its own cache folder to the home; apkit adds nothing.
    const before = await readdir(home);
    const init = cliWithEnv({ APKIT_HOME: apkitHome }, home, home, "init");
    expect(init.code).toBe(2);
    expect(init.err).toContain(`${COMMAND} init <path>`);
    const workspace = cliWithEnv({ APKIT_HOME: apkitHome }, home, home, "workspace");
    expect(workspace.code).toBe(0);
    expect(workspace.out).toContain("No Workspace selected.");
    for (const command of ["init", "install"]) expect(cliWithEnv({ APKIT_HOME: apkitHome }, home, home, command, "--help").code).toBe(0);
    expect(existsSync(apkitHome)).toBe(false);
    const caches = ["Library", "AppData", ".cache", ".bun"];
    expect((await readdir(home)).filter((name) => !before.includes(name) && !caches.includes(name))).toEqual([]);
  });

  test("bare invocation points agents at the guide", async () => {
    const home = await tempDir("home");
    const bare = cli(home, home);
    expect(bare.code).toBe(2);
    expect(bare.out).toContain(`${COMMAND} guide`);
    expect(cli(home, home, "--help").code).toBe(0);
  });

  test("the guide covers every command, flag, and agent the CLI accepts", async () => {
    const home = await tempDir("home");
    const guide = cli(home, home, "guide");
    expect(guide.code).toBe(0);
    expect(guide.out).toBe(`${GUIDE}\n`);
    const commands = Object.keys(OPTIONS);
    for (const command of commands) {
      expect(guide.out).toContain(`${COMMAND} ${command}`);
      const help = cli(home, home, command, "--help");
      expect([help.code, help.out, help.err]).toEqual([0, `${HELP}\n`, ""]);
    }
    const flags = new Set(["--help", "--json", ...Object.values(OPTIONS).flat()]);
    for (const flag of flags) expect(guide.out).toContain(flag);
    for (const agent of Object.keys(AGENTS)) expect(guide.out).toContain(agent);
  });

  test("`contract` prints the Workspace contract byte for byte, without a lock or a Workspace", async () => {
    const home = await tempDir("home");
    expect(HELP).toMatch(new RegExp(`^  ${COMMAND} contract `, "m"));
    const printed = cli(home, home, "contract");
    expect([printed.code, printed.err]).toEqual([0, ""]);
    expect(printed.out).toBe(await readFile(join(import.meta.dir, "..", "docs", "guides", "workspace-contract.md"), "utf8"));
    // No lock, no config: apkit wrote nothing (the runtime may add its own cache folder).
    expect((await readdir(home)).filter((name) => name.startsWith("lock") || name.endsWith(".json"))).toEqual([]);
  });

  test("failed validation names how to read the contract", async () => {
    const home = await tempDir("home");
    const ws = await tempDir("ws");
    const folder = await tempDir("f");
    await writeTree(ws, { "apkit-workspace.yaml": "", "profiles/p.yaml": "skills: [gone]\n" });
    const pointer = `Next: \`${COMMAND} contract\``;
    const check = cli(home, folder, "check", "--workspace", ws);
    expect(check.code).toBe(1);
    expect(check.out).toContain(pointer);
    expect(JSON.parse(cli(home, folder, "check", "--workspace", ws, "--json").out).contract).toBe(`${COMMAND} contract`);
    const selected = cli(home, folder, "workspace", ws);
    expect(selected.out).toContain(pointer);
    expect(JSON.parse(cli(home, folder, "workspace", ws, "--json").out).contract).toBe(`${COMMAND} contract`);
    const install = cli(home, folder, "install", "p", "--workspace", ws, "--agents", "codex");
    expect(install.code).toBe(1);
    expect(install.err).toContain(pointer);
    const valid = cli(home, folder, "check", "--workspace", await makeWorkspace(), "--json");
    expect(JSON.parse(valid.out).contract).toBeUndefined();
  });

  test("the guide asks first, leaves commits to the user, and starts with setup", () => {
    const decisions = GUIDE.slice(GUIDE.indexOf("## Decisions"), GUIDE.indexOf("## After installing"));
    expect(decisions).toContain("whether Git tracks it");
    expect(decisions).toContain("Add --yes only after the user agrees");
    expect(GUIDE).toContain("Committing is the user's decision");
    const firstTime = GUIDE.slice(GUIDE.indexOf("## First-time setup"), GUIDE.indexOf("## What gets installed"));
    expect(firstTime).toContain("before any install");
    expect(firstTime.indexOf(`${COMMAND} setup`)).toBeGreaterThan(-1);
    expect(firstTime.indexOf(`${COMMAND} setup`)).toBeLessThan(firstTime.indexOf("install a Profile"));
  });

  test("the guide's closing summary keeps tracked files, commits, and trust lines", () => {
    const finish = GUIDE.slice(GUIDE.indexOf("## When you finish"));
    expect(finish).toContain("short summary in plain words");
    expect(finish).toContain("Each instruction file created or changed");
    expect(finish).toContain("whether Git\n  tracks it");
    expect(finish).toContain("committing it is the user's call");
    expect(finish).toContain("trusting a folder");
  });

  test("the guide has the agent work for the user: it offers what it can do and never hands over commands", () => {
    // Phrases are matched across the guide's line wrapping.
    const finish = GUIDE.slice(GUIDE.indexOf("## When you finish")).replace(/\s+/g, " ");
    expect(finish).toContain("what you can do for them next");
    expect(finish).toContain("bring in Skills and instructions they already have");
    expect(finish).toContain("Do not give the user commands to run");
    expect(finish).not.toContain("Next line in the same format");
    // apkit's Next lines are the agent's to run.
    expect(GUIDE).toContain("Next lines are for you to run, not for the user to type.");
  });

  test("the guide explains how to bring the user's existing Skills and instructions into the Workspace", () => {
    const start = GUIDE.indexOf("## Bring in the user's existing material");
    expect(start).toBeGreaterThan(GUIDE.indexOf("## First-time setup"));
    const section = GUIDE.slice(start, GUIDE.indexOf("\n## ", start + 1)).replace(/\s+/g, " ");
    for (const phrase of ["user-level Skills folder", "a Skill whose name the Workspace already has", "Ask which to bring in", "Copy each one", "Do not delete or change the originals", `${COMMAND} check`, "propose a Profile", "installing is a decision"]) {
      expect(section).toContain(phrase);
    }
  });

  test("usage errors explain themselves", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("f");
    cli(home, folder, "workspace", ws);
    const missing = cli(home, folder, "install", "engineering");
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("--agents");
    expect(cli(home, folder, "install", "engineering", "--agents", "vim").err).toContain("Unknown agent: vim");
    expect(cli(home, folder, "install", "nope", "--agents", "codex").err).toContain("No Profile named 'nope'");
  });

  test("an option the command does not take is a usage error, and nothing changes", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("f");
    cli(home, folder, "workspace", ws);
    const before = await snapshot(folder);

    const global = cli(home, folder, "update", "--global");
    expect([global.code, global.out]).toEqual([2, ""]);
    expect(global.err).toContain("`update` does not take --global. It takes --all, --yes, --overwrite, --workspace, --json.");
    expect(global.err).toContain(`${COMMAND} help`);
    const unknown = cli(home, folder, "install", "engineering", "--agents", "codex", "--yse");
    expect([unknown.code, unknown.out]).toEqual([2, ""]);
    expect(unknown.err).toContain("Unknown option --yse.");
    expect(cli(home, folder, "guide", "--all").err).toContain("`guide` does not take --all. It takes no options.");
    expect(cli(home, folder, "--version").err).toContain("Unknown option --version.");
    expect(await snapshot(folder)).toEqual(before);

    // --help works with any command.
    const help = cli(home, folder, "install", "--help");
    expect([help.code, help.out]).toEqual([0, `${HELP}\n`]);
  });

  test.skipIf(!BUILT)("the bundle imports only node: built-ins and never checks the operating system", async () => {
    const bundle = await readFile(resolve(import.meta.dir, "..", BUILT ?? ""), "utf8");
    const specifiers = [...bundle.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|require\s*\(\s*|^import\s*)["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s?.startsWith("node:"))).toEqual([]);
    expect(bundle.includes("process.platform")).toBe(false);
  });
});

// Runs that write wait for each other through one lock in the apkit home. Each
// check below holds for every order the runs can take, so none depends on timing.
describe("ownership records and restoration", () => {
  const git = (repo: string) => (...args: string[]) =>
    spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" }).stdout;

  test("the manifest alone through a symlink outside the Project needs a decision", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    await writeTree(ws, { "profiles/empty.yaml": "context: []\nskills: []\n" });
    cli(home, home, "workspace", ws);
    // An empty Profile writes only the manifest.
    const empty = await tempDir("project");
    const emptyOut = await tempDir("outside");
    await symlink(emptyOut, join(empty, ".agents"), "junction");
    const blocked = cli(home, empty, "install", "empty", "--agents", "codex");
    expect(blocked.code).toBe(3);
    expect(blocked.out).toContain(`.agents is a symlink to ${emptyOut}, outside this folder`);
    expect(await readdir(emptyOut)).toEqual([]);
    // Skill files already on disk as apkit would write them: again only the manifest is new.
    const same = await tempDir("project");
    const sameOut = await tempDir("outside");
    await cp(join(ws, "skills", "summarize"), join(sameOut, "skills", "summarize"), { recursive: true });
    await symlink(sameOut, join(same, ".agents"), "junction");
    expect(cli(home, same, "install", "skills-only", "--agents", "codex").code).toBe(3);
    expect(await readdir(sameOut)).toEqual(["skills"]);
  });

  test("a new selection is recorded even when no installed file changes", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    await writeTree(ws, { "profiles/twin.yaml": "context: []\nskills:\n  - summarize\n" });
    const project = await tempDir("project");
    cli(home, project, "workspace", ws);
    expect(cli(home, project, "install", "skills-only", "--agents", "codex").code).toBe(0);
    // Pi reads the same Skills folder as Codex, so no file changes.
    const twin = JSON.parse(cli(home, project, "install", "twin", "--agents", "pi", "--json").out);
    expect([twin.result, twin.profile, twin.agents]).toEqual(["updated", "twin", ["pi"]]);
    const manifest = JSON.parse(await read(project, ".agents/apkit.json"));
    expect([manifest.profile, manifest.agents]).toEqual(["twin", ["pi"]]);
    const status = JSON.parse(cli(home, project, "status", "--json").out).results[0];
    expect([status.profile, status.agents, status.result]).toEqual(["twin", ["pi"], "unchanged"]);

    // An install the registry lost is registered again by reinstalling it.
    await writeFile(join(home, "config.json"), JSON.stringify({ schema: 1, workspace: ws, installs: [] }));
    expect(cli(home, project, "install", "twin", "--agents", "pi").code).toBe(0);
    expect(JSON.parse(cli(home, project, "status", "--all", "--json").out).results.map((o: { folder: string }) => o.folder)).toEqual([project]);
  });

  test("a global install sharing Skills with a home-folder install keeps its own records current", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    expect(cli(home, home, "install", "skills-only", home, "--agents", "codex").code).toBe(0);
    expect(cli(home, home, "install", "skills-only", "--global", "--agents", "codex").code).toBe(0);
    await writeTree(ws, { "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: v2\n---\n" });
    expect(cli(home, home, "update", "--all").code).toBe(0);
    // Without the project install, the global install alone owns the Skill: it must know v2 is its own.
    expect(cli(home, home, "remove", home).code).toBe(0);
    await writeTree(ws, { "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: v3\n---\n" });
    const update = cli(home, home, "update", "--all");
    expect([update.code, update.out]).toEqual([0, expect.not.stringContaining("changed after apkit wrote it")]);
    expect(await read(home, ".agents/skills/summarize/SKILL.md")).toContain("v3");
  });

  test("project install and removal restore instruction files byte for byte", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    for (const original of ["# Mine", "# Mine\n\n\n", "  \n", "# Mine\r\n", ""]) {
      const project = await tempDir("project");
      await writeTree(project, { "AGENTS.md": original, "CLAUDE.md": original });
      expect(cli(home, project, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
      expect(await read(project, "CLAUDE.md")).toContain("@AGENTS.md");
      expect(cli(home, project, "remove").code).toBe(0);
      expect([await read(project, "AGENTS.md"), await read(project, "CLAUDE.md")]).toEqual([original, original]);
    }
  });

  test("remove --global restores files with any ending byte for byte", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    cli(home, home, "workspace", ws);
    await writeTree(home, {
      ".claude/CLAUDE.md": "# Mine",
      ".codex/AGENTS.md": "# Mine\n\n\n",
      ".config/opencode/AGENTS.md": "  \n",
    });
    const before = await homeSnapshot(home);
    expect(cli(home, home, "install", "engineering", "--global", "--agents", "claude,codex,opencode", "--yes").code).toBe(0);
    expect(cli(home, home, "remove", "--global").code).toBe(0);
    expect(await homeSnapshot(home)).toEqual(before);
  });

  test("Context that contains apkit's own end marker stays inside its section", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    await writeTree(ws, {
      "context/markers.md": "Example:\n<!-- apkit:end -->\n<!-- apkit:global:end -->\nMore Context.\n",
      "profiles/markers.yaml": "context:\n  - markers\nskills: []\n",
    });
    cli(home, home, "workspace", ws);
    const project = await tempDir("project");
    await writeTree(project, { "AGENTS.md": "# Mine\n" });
    expect(cli(home, project, "install", "markers", "--agents", "codex", "--yes").code).toBe(0);
    expect(JSON.parse(cli(home, project, "status", "--json").out).results[0].result).toBe("unchanged");
    expect(cli(home, project, "update").code).toBe(0);
    expect(cli(home, project, "remove").code).toBe(0);
    expect(await read(project, "AGENTS.md")).toBe("# Mine\n");

    await writeTree(home, { ".codex/AGENTS.md": "# Mine\n" });
    expect(cli(home, home, "install", "markers", "--global", "--agents", "codex", "--yes").code).toBe(0);
    expect(JSON.parse(cli(home, home, "status", "--all", "--json").out).results[0].result).toBe("unchanged");
    expect(cli(home, home, "remove", "--global").code).toBe(0);
    expect(await read(home, ".codex/AGENTS.md")).toBe("# Mine\n");
  });

  test("update --all forgets a deleted folder and drops its exclusion block", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    await writeTree(repo, { "README.md": "# Repo\n", "sub/README.md": "# Sub\n" });
    git(repo)("init", "-q");
    git(repo)("add", "-A");
    git(repo)("commit", "-qm", "init");
    cli(home, repo, "workspace", ws);
    expect(cli(home, repo, "install", "skills-only", "sub", "--agents", "codex").code).toBe(0);
    await rm(join(repo, "sub"), { recursive: true });
    const update = cli(home, repo, "update", "--all");
    expect([update.code, update.out]).toEqual([0, expect.stringContaining("no longer exists")]);
    expect(await read(repo, ".git/info/exclude")).not.toContain(join(repo, "sub"));
    expect(JSON.parse(await read(home, "config.json")).installs).toEqual([]);
  });

  test("a folder name with Git pattern characters is excluded literally", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    await writeTree(repo, { "README.md": "# Repo\n", "project[1]/README.md": "# P\n" });
    git(repo)("init", "-q");
    git(repo)("add", "-A");
    git(repo)("commit", "-qm", "init");
    // A sibling that `[1]` as a pattern would match.
    await writeTree(repo, { "project1/.agents/apkit.json": "{}\n" });
    cli(home, repo, "workspace", ws);
    expect(cli(home, repo, "install", "skills-only", "project[1]", "--agents", "codex").code).toBe(0);
    expect(git(repo)("status", "--porcelain", "--untracked-files=all")).toBe("?? project1/.agents/apkit.json\n");
  });

  test("unreadable machine configuration stops the command before it writes", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const project = await tempDir("project");
    cli(home, project, "workspace", ws);
    const broken = `{"schema": 1, "workspace": ${JSON.stringify(ws)}, "installs": ["/old/project"`;
    await writeFile(join(home, "config.json"), broken);
    const run = cli(home, project, "install", "skills-only", "--agents", "codex");
    expect(run.code).toBe(1);
    expect(run.err).toContain(join(home, "config.json"));
    expect(await read(home, "config.json")).toBe(broken);
    expect(await readdir(project)).toEqual([]);
  });

  test("a manifest that names a path outside its folder is refused before anything is deleted", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const base = await tempDir("base");
    const project = join(base, "project");
    await writeTree(base, {
      "outside.txt": "mine\n",
      "project/.agents/apkit.json": JSON.stringify({
        schema: 1,
        profile: "skills-only",
        agents: ["codex"],
        files: { "../outside.txt": hash("mine\n") },
        block: null,
        createdAgentsMd: false,
        claudeImport: false,
      }),
    });
    cli(home, project, "workspace", ws);
    const run = cli(home, project, "remove");
    expect(run.code).toBe(1);
    expect(run.err).toContain(".agents/apkit.json");
    expect(await read(base, "outside.txt")).toBe("mine\n");
  });
});

describe("concurrent runs", () => {
  const SLOW = 60_000;
  const MANY = "claude,codex,grok";

  test("four installs into four folders at once all succeed and are all listed", async () => {
    for (let round = 0; round < 3; round++) {
      const home = await tempDir("home");
      const ws = await makeWorkspace();
      const folders = await Promise.all([0, 1, 2, 3].map((i) => tempDir(`f${i}`)));
      expect(cli(home, folders[0]!, "workspace", ws).code).toBe(0);
      const runs = await Promise.all(folders.map((folder) => cliAsync(home, folder, "install", "engineering", "--agents", MANY, "--yes")));
      expect(runs.map((run) => [run.code, run.err])).toEqual(folders.map(() => [0, ""]));
      const status = JSON.parse(cli(home, folders[0]!, "status", "--all", "--json").out).results as { folder: string; result: string }[];
      expect(status.map((o) => [o.folder, o.result]).sort()).toEqual([...folders].sort().map((f) => [f, "unchanged"]));
      expect(await readdir(home)).not.toContain("lock");
    }
  }, SLOW * 3);

  test("two installs into one folder at once leave one manifest that matches the disk", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("f");
    cli(home, folder, "workspace", ws);
    const runs = await Promise.all(
      ["claude", "codex"].map((agents) => cliAsync(home, folder, "install", "engineering", "--agents", agents, "--yes")),
    );
    expect(runs.map((run) => [run.code, run.err])).toEqual([[0, ""], [0, ""]]);
    await expectManifestMatchesDisk(folder);
    expect(JSON.parse(cli(home, folder, "status", "--json").out).results[0].result).toBe("unchanged");
  }, SLOW);

  test("update --all during an install loses no record", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folders = await Promise.all([0, 1, 2, 3].map((i) => tempDir(`f${i}`)));
    cli(home, folders[0]!, "workspace", ws);
    for (const folder of folders.slice(0, 3)) {
      expect(cli(home, folder, "install", "engineering", "--agents", MANY, "--yes").code).toBe(0);
    }
    await writeTree(ws, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    const runs = await Promise.all([
      cliAsync(home, folders[0]!, "update", "--all", "--yes"),
      cliAsync(home, folders[3]!, "install", "engineering", "--agents", MANY, "--yes"),
    ]);
    expect(runs.map((run) => [run.code, run.err])).toEqual([[0, ""], [0, ""]]);
    const status = JSON.parse(cli(home, folders[0]!, "status", "--all", "--json").out).results as { folder: string; result: string }[];
    expect(status.map((o) => [o.folder, o.result]).sort()).toEqual([...folders].sort().map((f) => [f, "unchanged"]));
    for (const folder of folders) {
      expect(await read(folder, "AGENTS.md")).toContain("Be warm.");
      await expectManifestMatchesDisk(folder);
    }
  }, SLOW);

  test("installs into two worktrees of one repository at once keep both exclusion blocks", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const repo = await tempDir("repo");
    await writeTree(repo, { "README.md": "# Repo\n" });
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).stdout;
    git(repo, "init", "-q");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "init");
    const tree = join(await tempDir("wt"), "tree");
    git(repo, "worktree", "add", "-q", tree);
    cli(home, repo, "workspace", ws);
    const runs = await Promise.all([repo, tree].map((folder) => cliAsync(home, folder, "install", "skills-only", "--agents", MANY)));
    expect(runs.map((run) => [run.code, run.err])).toEqual([[0, ""], [0, ""]]);
    const exclude = await read(repo, ".git/info/exclude");
    expect(exclude).toContain(`# apkit:begin ${repo}\n`);
    expect(exclude).toContain(`# apkit:begin ${tree}\n`);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(tree, "status", "--porcelain")).toBe("");
  }, SLOW);

  test("no run overwrites a file that the user changed", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("f");
    const other = await tempDir("other");
    cli(home, folder, "workspace", ws);
    expect(cli(home, folder, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
    await writeTree(folder, { ".claude/skills/summarize/SKILL.md": "mine\n" });
    const runs = await Promise.all([
      cliAsync(home, folder, "update"),
      cliAsync(home, folder, "update", "--yes"),
      cliAsync(home, folder, "install", "engineering", "--agents", "claude", "--yes"),
      cliAsync(home, other, "install", "engineering", "--agents", "claude", "--yes"),
    ]);
    expect(runs.map((run) => run.code)).toEqual([3, 3, 3, 0]);
    expect(await read(folder, ".claude/skills/summarize/SKILL.md")).toBe("mine\n");
  }, SLOW);

  test("a run waits for the run that holds the lock", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("f");
    cli(home, folder, "workspace", ws);
    // This test process is running, so its lock is live until the test removes it.
    await writeFile(join(home, "lock"), JSON.stringify({ pid: process.pid, token: "held-by-test" }));
    const waiting = cliAsync(home, folder, "install", "skills-only", "--agents", "codex");
    await new Promise((done) => setTimeout(done, 1_000));
    expect(await readdir(folder)).toEqual([]);
    await rm(join(home, "lock"));
    const run = await waiting;
    expect([run.code, run.err]).toEqual([0, ""]);
    expect(await readdir(home)).not.toContain("lock");
  }, SLOW);

  test("a lock left by a run that stopped is taken over", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    const folder = await tempDir("f");
    cli(home, folder, "workspace", ws);
    // A process that has exited: its pid no longer runs.
    const gone = spawnSync(process.execPath, ["-e", ""]).pid;
    await writeFile(join(home, "lock"), JSON.stringify({ pid: gone, token: "stopped" }));
    const run = cli(home, folder, "install", "skills-only", "--agents", "codex");
    expect([run.code, run.err]).toEqual([0, ""]);
    expect((await readdir(home)).filter((name) => name.startsWith("lock"))).toEqual([]);
  }, SLOW);
});

describe("edit consent and instruction-file ownership", () => {
  /** Exact file bytes and directory entries, including empty folders. */
  async function tree(root: string): Promise<Record<string, string>> {
    const entries: Record<string, string> = {};
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      const path = relative(root, full).split(sep).join("/");
      if (entry.isDirectory()) entries[`${path}/`] = "";
      else if (entry.isFile()) entries[path] = (await readFile(full)).toString("latin1");
    }
    return entries;
  }

  test("install, update, and remove preserve changed generated files until --overwrite", async () => {
    for (const operation of ["install", "update", "remove"] as const) {
      const home = await tempDir("home");
      const ws = await makeWorkspace();
      const project = await tempDir("project");
      await mkdir(join(project, "user-empty"));
      await writeTree(project, { "notes.txt": "Keep my notes.\n" });
      const original = await tree(project);
      expect(cli(home, project, "workspace", ws).code).toBe(0);
      expect(cli(home, project, "install", "skills-only", "--agents", "claude").code).toBe(0);
      await writeTree(project, { ".claude/skills/summarize/SKILL.md": "My independent edit.\n" });
      await writeTree(ws, { "skills/summarize/SKILL.md": SKILL("summarize", "license: MIT\n") });
      const changed = await tree(project);
      const config = await tree(home);
      const args = operation === "install" ? ["install", "skills-only", "--agents", "claude"] : [operation];
      for (const flags of [[], ["--yes"]]) {
        const blocked = cli(home, project, ...args, ...flags);
        expect([blocked.code, blocked.err]).toEqual([3, ""]);
        expect(blocked.out).toContain(".claude/skills/summarize/SKILL.md was changed after apkit wrote it");
        expect(await tree(project)).toEqual(changed);
        expect(await tree(home)).toEqual(config);
      }
      const consented = cli(home, project, ...args, "--overwrite");
      expect([consented.code, consented.err]).toEqual([0, ""]);
      if (operation !== "remove") {
        expect(await read(project, ".claude/skills/summarize/SKILL.md")).toBe(SKILL("summarize", "license: MIT\n"));
        expect(cli(home, project, "remove").code).toBe(0);
      }
      expect(await tree(project)).toEqual(original);
      expect(JSON.parse(cli(home, project, "status", "--all", "--json").out).results).toEqual([]);
    }
  });
  test("user text before and after instruction sections survives install, update, and remove with LF and CRLF", async () => {
    for (const eol of ["\n", "\r\n"]) {
      const home = await tempDir("home");
      const ws = await makeWorkspace();
      const project = await tempDir("project");
      await writeTree(project, { "AGENTS.md": `# Original agents${eol}`, "CLAUDE.md": `# Original Claude${eol}` });
      expect(cli(home, project, "workspace", ws).code).toBe(0);
      expect(cli(home, project, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
      const installed = await read(project, "AGENTS.md");
      const section = installed.slice(installed.indexOf("<!-- apkit:begin -->"));
      expect(section).toContain("Be concise.");
      const before = `# Edited before${eol}Keep this spacing.  ${eol}`;
      const after = `${eol}# Edited after${eol}Keep ünicode.${eol}`;
      const claudeBefore = `# Edited Claude before${eol}`;
      const claudeAfter = `${eol}# Edited Claude after${eol}`;
      await writeTree(project, {
        "AGENTS.md": before + eol + section + after,
        "CLAUDE.md": claudeBefore + eol + `@AGENTS.md${eol}` + claudeAfter,
      });
      const claude = await read(project, "CLAUDE.md");
      for (const [operation, text] of [["install", "Reinstalled Context."], ["update", "Updated Context."]] as const) {
        await writeTree(ws, { "context/communication.md": `# Communication\n\n${text}\n` });
        const args = operation === "install" ? ["install", "engineering", "--agents", "claude"] : ["update"];
        const result = cli(home, project, ...args);
        expect([result.code, result.err]).toEqual([0, ""]);
        const agents = await read(project, "AGENTS.md");
        expect(agents.startsWith(before + eol + `<!-- apkit:begin -->${eol}`)).toBe(true);
        expect(agents.endsWith(`<!-- apkit:end -->${eol}` + after)).toBe(true);
        expect(agents).toContain(`${text}${eol}`);
        expect(agents).not.toContain("Be concise.");
        if (operation === "update") expect(agents).not.toContain("Reinstalled Context.");
        expect(await read(project, "CLAUDE.md")).toBe(claude);
      }
      expect(cli(home, project, "remove").code).toBe(0);
      expect(await read(project, "AGENTS.md")).toBe(before + after);
      expect(await read(project, "CLAUDE.md")).toBe(claudeBefore + claudeAfter);
      expect(await tree(project)).toEqual({
        "AGENTS.md": Buffer.from(before + after).toString("latin1"),
        "CLAUDE.md": Buffer.from(claudeBefore + claudeAfter).toString("latin1"),
      });
    }
  });
  test("instruction-file decisions cover absent, untracked, and tracked AGENTS.md and CLAUDE.md", async () => {
    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      for (const state of ["absent", "untracked", "tracked"]) {
        const home = await tempDir("home");
        const ws = await makeWorkspace();
        const repo = await tempDir("repo");
        const git = (...args: string[]) => {
          const result = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
          expect([result.status, result.stderr]).toEqual([0, ""]);
        };
        git("init", "-q");
        await mkdir(join(repo, "user-empty"));
        if (state !== "absent") await writeTree(repo, { [file]: `# User's ${file}\n` });
        if (state === "tracked") {
          git("add", file);
          git("commit", "-qm", "Track instruction file");
        }
        expect(cli(home, repo, "workspace", ws).code).toBe(0);
        const original = await tree(repo);
        const config = await tree(home);
        const human = cli(home, repo, "install", "engineering", "--agents", "claude");
        expect([human.code, human.err]).toEqual([3, ""]);
        expect(await tree(repo)).toEqual(original);
        expect(await tree(home)).toEqual(config);
        const json = cli(home, repo, "install", "engineering", "--agents", "claude", "--json");
        expect([json.code, json.err]).toEqual([3, ""]);
        const expected = [
          { path: "AGENTS.md", action: file === "AGENTS.md" && state !== "absent" ? "change" : "create", tracked: file === "AGENTS.md" && state === "tracked" },
          ...(file === "CLAUDE.md" && state !== "absent" ? [{ path: "CLAUDE.md", action: "change", tracked: state === "tracked" }] : []),
        ];
        expect(JSON.parse(json.out).instructions).toEqual(expected);
        for (const instruction of expected) {
          expect(human.out).toContain(`${instruction.path}: will be ${instruction.action === "create" ? "created" : "changed"}; ${instruction.tracked ? "tracked" : "not tracked"} by Git.`);
        }
        expect(await tree(repo)).toEqual(original);
        expect(await tree(home)).toEqual(config);
        if (file === "CLAUDE.md" && state === "absent") {
          // Claude reads AGENTS.md directly when CLAUDE.md is absent; apkit does not create it.
          expect(human.out).not.toContain("CLAUDE.md:");
          expect(cli(home, repo, "install", "engineering", "--agents", "claude", "--yes").code).toBe(0);
          expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
        }
      }
    }
  });
});

/** The Workspaces kept from earlier releases that changed the contract (test/retained/README.md). */
const RETAINED = {
  "0.204.0 source": join(import.meta.dir, "retained", "compat-0.204.0", "workspace-source"),
  "0.204.0 realistic": join(import.meta.dir, "retained", "compat-0.204.0", "workspace-realistic"),
  "0.237.0": join(import.meta.dir, "retained", "compat-0.237.0"),
};

/** Makes exactly the change each error names, reading it only from the error's path and message. */
async function applyNamedChanges(root: string, errors: readonly Violation[]): Promise<void> {
  const editProfile = async (path: string, edit: (data: Record<string, unknown>) => void) => {
    const file = join(root, ...path.split("/"));
    const data = parseYaml(await readFile(file, "utf8")) as Record<string, unknown>;
    edit(data);
    await writeFile(file, stringifyYaml(data));
  };
  for (const error of errors) {
    const rename_ = /Rename (\S+) to (\S+?);/.exec(error.message) ?? /rename (\S+) to (\S+?\.md)/.exec(error.message);
    const remove = /remove ((?:`[^`]+`(?:, )?)+);/.exec(error.message);
    const use = /use '([^']+)'/.exec(error.message);
    const missing = /names Context '([^']+)'/.exec(error.message);
    if (remove) {
      const keys = [...(remove[1] as string).matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
      await editProfile(error.path, (data) => keys.forEach((key) => delete data[key]));
    } else if (use && missing) {
      await editProfile(error.path, (data) => {
        data.context = (data.context as string[]).map((id) => (id === missing[1] ? (use[1] as string) : id));
      });
    } else if (rename_) {
      await rename(join(root, ...(rename_[1] as string).split("/")), join(root, ...(rename_[2] as string).split("/")));
    } else {
      throw new Error(`No change named: ${error.message}`);
    }
  }
}

describe("Workspaces valid in an earlier release", () => {
  const SLOW = 60_000;
  const count = (errors: readonly Violation[]) =>
    Object.fromEntries([...new Set(errors.map((e) => e.code))].map((code) => [code, errors.filter((e) => e.code === code).length]));

  for (const [release, source] of Object.entries(RETAINED)) {
    test(`${release}: one check names every change, and making them leaves a valid Workspace`, async () => {
      const root = await tempDir("retained");
      await cp(source, root, { recursive: true });
      const errors = (await loadWorkspace(root)).violations;
      expect(errors.length).toBeGreaterThan(0);
      await applyNamedChanges(root, errors);
      const after = await loadWorkspace(root);
      expect(after.violations).toEqual([]);
      expect(after.warnings).toEqual([]);
    });
  }

  test("0.204.0 source: the errors name the rename, the retired Profile key, and the Context file to rename", async () => {
    const root = await tempDir("retained");
    await cp(RETAINED["0.204.0 source"], root, { recursive: true });
    const errors = (await loadWorkspace(root)).violations;
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ["workspace-old-manifest", "workspace.yaml"],
      ["invalid-profile", "profiles/coding.yaml"],
      ["invalid-profile", "profiles/example.yaml"],
      ["missing-context-reference", "profiles/example.yaml"],
    ]);
    expect(errors[1]?.message).toContain("remove `id`;");
    expect(errors[3]?.message).toContain("rename context/legacy-name.md to context/legacy-rules.md");
  });

  test("0.204.0 realistic: one check names every change; after them, it passes check and installs", async () => {
    const home = await tempDir("home");
    const root = await tempDir("retained");
    const project = await tempDir("project");
    await cp(RETAINED["0.204.0 realistic"], root, { recursive: true });
    const errors = (await loadWorkspace(root)).violations;
    expect(count(errors)).toEqual({ "workspace-old-manifest": 1, "invalid-profile": 5, "missing-context-reference": 29 });
    for (const error of errors.filter((e) => e.code === "missing-context-reference")) expect(error.message).toMatch(/use 'area-[abc]\//);
    await applyNamedChanges(root, errors);

    expect(cli(home, project, "workspace", root).code).toBe(0);
    const check = cli(home, project, "check", "--json");
    expect(check.code).toBe(0);
    const data = JSON.parse(check.out);
    expect([data.profiles.length, data.context.length, data.skills.length]).toEqual([5, 20, 25]);
    const install = cli(home, project, "install", "profile-01", "--agents", "claude,codex", "--yes");
    expect([install.code, install.err]).toEqual([0, ""]);
    expect(await read(project, ".claude/skills/skill-19/SKILL.md")).toContain("name: skill-19");
    expect(await read(project, "AGENTS.md")).toContain("subject-03 guidance.");
  }, SLOW);
});

describe("migrate from the old engine (0.238.0 receipts)", () => {
  const ALL = "antigravity,claude,codex,grok,opencode,pi";
  /** The old state folder and its backup as text names them, with native separators. */
  const OLD = join("~", ".agents", "agent-profile-kit");
  const BACKUP = `${OLD}.migrated`;

  /** Runs with the new apkit home apart from the home folder, so the home folder holds only the user's and the old engine's files. */
  function migrateCli(fixture: MigrationFixture, cwd: string, ...args: string[]) {
    // Bun's transpiler cache would otherwise land in the home folder that these journeys compare.
    return cliWithEnv({ APKIT_HOME: join(fixture.root, "apkit"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, fixture.home, cwd, ...args);
  }

  /** Every file (with its text) and every empty folder under `folder`, skipping `.git` except its exclude file, with `folder` written as `<folder>`. */
  async function tree(folder: string): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      const path = relative(folder, full).split(sep).join("/");
      if (path === ".git" || (path.startsWith(".git/") && path !== ".git/info/exclude")) continue;
      if (entry.isDirectory()) {
        if ((await readdir(full)).length === 0) found[`${path}/`] = "(empty folder)";
      } else {
        found[path] = (await readFile(full, "utf8")).replaceAll(folder, "<folder>");
      }
    }
    return found;
  }

  test("deletes every unchanged old output and installs the same Profile, agents, and Workspace: the Project matches a fresh install", async () => {
    const fixture = await materializeMigration();
    const before = await readFile(join(fixture.state, "state", "manifest.json"), "utf8");
    const oldOutputs = (JSON.parse(before).receipts[0].outputs as { path: string }[]).map((o) => o.path);

    const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const data = JSON.parse(result.out);
    expect(data.workspace.path).toBe(fixture.workspace);
    expect(data.projects).toHaveLength(1);
    const project = data.projects[0];
    expect(project).toMatchObject({ folder: fixture.project, result: "migrated", profile: "engineering", agents: ALL.split(",") });
    expect(project.exclusion).toEqual({ file: join(fixture.project, ".git", "info", "exclude"), result: "removed" });
    // Each recorded output is accounted for, by name.
    expect(project.outputs.map((o: { path: string }) => o.path).sort()).toEqual([...oldOutputs].sort());
    const results = Object.fromEntries(project.outputs.map((o: { path: string; result: string }) => [o.path, o.result]));
    for (const path of [
      ".codex/hooks.json",
      ".agent-profile-kit/codex/context.md",
      ".opencode/opencode.jsonc",
      ".agent-profile-kit/opencode/context.md",
      ".pi/APPEND_SYSTEM.md",
      ".claude/rules/agent-profile-kit.md",
      ".agents/rules/agent-profile-kit-000-envelope.md",
    ]) {
      expect(results[path]).toBe("deleted");
      expect(await stat(join(fixture.project, ...path.split("/"))).then(() => true, () => false)).toBe(false);
    }
    for (const skill of [".claude/skills/review-pr", ".agents/skills/summarize", ".grok/skills/summarize"]) expect(results[skill]).toBe("replaced");
    expect([...project.folders].sort()).toEqual([".agent-profile-kit", ".agent-profile-kit/codex", ".agent-profile-kit/opencode", ".agents/rules", ".claude/rules", ".codex", ".opencode", ".pi"]);
    expect(await read(fixture.project, ".claude/settings.json")).toContain("permissions");

    const manifest = JSON.parse(await read(fixture.project, ".agents/apkit.json"));
    expect([manifest.profile, manifest.agents]).toEqual(["engineering", ALL.split(",")]);
    const config = JSON.parse(await readFile(join(fixture.root, "apkit", "config.json"), "utf8"));
    expect([config.workspace, config.installs]).toEqual([fixture.workspace, [fixture.project]]);

    // A fresh install of the same Profile into the same Project, by the new engine alone.
    const fresh = cliWithEnv({ APKIT_HOME: join(fixture.root, "fresh-apkit") }, fixture.home, fixture.pristine, "install", "engineering", "--agents", ALL, "--yes", "--workspace", fixture.workspace);
    expect([fresh.code, fresh.err]).toEqual([0, ""]);
    expect(await tree(fixture.project)).toEqual(await tree(fixture.pristine));
    // The old state is kept as a backup, as it was.
    expect(existsSync(fixture.state)).toBe(false);
    expect(await readFile(join(`${fixture.state}.migrated`, "state", "manifest.json"), "utf8")).toBe(before);
  });

  test("a Project the old engine installed is removed by the current apkit alone: after migrate and remove it matches the Project before the old install", async () => {
    const fixture = await materializeMigration();
    const migrated = migrateCli(fixture, fixture.project, "migrate", "--yes");
    expect([migrated.code, migrated.err]).toEqual([0, ""]);
    const removed = migrateCli(fixture, fixture.project, "remove", "--yes");
    expect([removed.code, removed.err]).toEqual([0, ""]);
    // Every file and empty folder, and the Git exclude file without the old block.
    expect(await tree(fixture.project)).toEqual(await tree(fixture.pristine));
    const config = JSON.parse(await readFile(join(fixture.root, "apkit", "config.json"), "utf8"));
    expect(config.installs ?? []).not.toContain(fixture.project);
  });

  test("a folder that holds only old output and a macOS .DS_Store file is removed", async () => {
    const fixture = await materializeMigration();
    await writeFile(join(fixture.project, ".agent-profile-kit", ".DS_Store"), "Finder");
    await writeFile(join(fixture.project, ".agents", "rules", ".DS_Store"), "Finder");
    const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const [project] = JSON.parse(result.out).projects;
    expect(project.folders).toContain(".agent-profile-kit");
    expect(project.folders).toContain(".agents/rules");
    expect(existsSync(join(fixture.project, ".agent-profile-kit"))).toBe(false);
    expect(existsSync(join(fixture.project, ".agents", "rules"))).toBe(false);
  });

  test("a folder with a file of the user's beside .DS_Store is kept", async () => {
    const fixture = await materializeMigration();
    await writeTree(fixture.project, { ".agent-profile-kit/.DS_Store": "Finder", ".agent-profile-kit/notes.md": "mine\n" });
    const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(JSON.parse(result.out).projects[0].folders).not.toContain(".agent-profile-kit");
    expect(await read(fixture.project, ".agent-profile-kit/.DS_Store")).toBe("Finder");
    expect(await read(fixture.project, ".agent-profile-kit/notes.md")).toBe("mine\n");
  });

  test("the migrated output names each instruction file changed and whether Git tracks it", async () => {
    const fixture = await materializeMigration();
    const result = migrateCli(fixture, fixture.project, "migrate", "--yes");
    expect([result.code, result.err]).toEqual([0, ""]);
    // The fixture Project has no AGENTS.md or CLAUDE.md, and no commit.
    expect(result.out).toContain("  Removed the old apkit lines from");
    expect(result.out).toContain(`${join(".git", "info", "exclude")}.\n  Instruction files:\n    - AGENTS.md: created; not tracked by Git.\n  Codex and Pi load Skills`);
  });

  test("names each old output and its outcome in text, by Project path", async () => {
    const fixture = await materializeMigration();
    const result = migrateCli(fixture, fixture.project, "migrate", "--yes");
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(result.out).toContain(fixture.project);
    expect(result.out).toContain("'engineering'");
    expect(result.out).toContain(".codex/hooks.json");
    expect(result.out).toContain(join(fixture.project, ".git", "info", "exclude"));
  });

  test("leaves the home folder alone, including the trust given to the old Codex hook", async () => {
    const fixture = await materializeMigration();
    await writeTree(fixture.home, {
      ".codex/config.toml": `[projects."${fixture.project}"]\ntrust_level = "trusted"\n\n[hooks.trusted]\n"${fixture.project}/.codex/hooks.json" = "sha256:abc"\n`,
    });
    const home = await snapshot(fixture.home);
    expect(migrateCli(fixture, fixture.project, "migrate", "--yes").code).toBe(0);
    // Only the old state moved, into its backup.
    const moved = Object.fromEntries(Object.entries(home).map(([path, text]) => [path.replace(/^\.agents\/agent-profile-kit\//, ".agents/agent-profile-kit.migrated/"), text]));
    expect(await snapshot(fixture.home)).toEqual(moved);
  });

  test("without --yes, creating AGENTS.md is a decision and nothing changes", async () => {
    const fixture = await materializeMigration();
    const project = await tree(fixture.project);
    const home = await snapshot(fixture.home);
    const result = migrateCli(fixture, fixture.project, "migrate", "--json");
    expect(result.code).toBe(3);
    const data = JSON.parse(result.out);
    expect(data.projects[0].result).toBe("needs-decision");
    expect(data.projects[0].issues.map((i: { path: string }) => i.path)).toContain("AGENTS.md");
    expect(await tree(fixture.project)).toEqual(project);
    expect(await snapshot(fixture.home)).toEqual(home);
    expect(existsSync(join(fixture.root, "apkit", "config.json"))).toBe(false);
    expect(migrateCli(fixture, fixture.project, "migrate").out).toContain("apkit migrate --yes");
  });

  /** Adds a user entry next to apkit's in the Codex hook and the OpenCode configuration. */
  async function editConfigurations(fixture: MigrationFixture): Promise<{ hooks: string; opencode: string }> {
    const hooksPath = join(fixture.project, ".codex", "hooks.json");
    const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
    hooks.hooks.SessionStart.push({ matcher: "startup", hooks: [{ command: "echo my-own-hook", type: "command" }] });
    const hooksText = `${JSON.stringify(hooks, null, 2)}\n`;
    await writeFile(hooksPath, hooksText);
    const opencodePath = join(fixture.project, ".opencode", "opencode.jsonc");
    const opencode = (await readFile(opencodePath, "utf8")).replace('"$schema": "https://opencode.ai/config.json",', '"$schema": "https://opencode.ai/config.json",\n  "model": "my-own/model",');
    await writeFile(opencodePath, opencode);
    return { hooks: hooksText, opencode };
  }

  const resultOf = (project: { outputs: { path: string; result: string }[] }, path: string) => project.outputs.find((o) => o.path === path)?.result;

  test("a changed Codex hook and OpenCode configuration are a decision that names apkit's part, and nothing changes", async () => {
    const fixture = await materializeMigration();
    await editConfigurations(fixture);
    const project = await tree(fixture.project);
    const home = await snapshot(fixture.home);

    const result = migrateCli(fixture, fixture.project, "migrate", "--json");
    expect(result.code).toBe(3);
    const data = JSON.parse(result.out).projects[0];
    expect(data.result).toBe("needs-decision");
    expect(data.issues.filter((i: { kind: string }) => i.kind === "changed").map((i: { path: string }) => i.path).sort()).toEqual([".codex/hooks.json", ".opencode/opencode.jsonc"]);
    // The other decisions are listed in the same run.
    expect(data.issues.map((i: { path: string }) => i.path)).toContain("AGENTS.md");
    const hooks = data.outputs.find((o: { path: string }) => o.path === ".codex/hooks.json");
    expect(hooks).toMatchObject({ result: "changed", origin: expect.stringContaining("Codex hook"), apkitPart: { present: "yes" } });
    expect(hooks.apkitPart.text).toContain(".agent-profile-kit/codex/context.md");
    expect(hooks.apkitPart.text).not.toContain("my-own-hook");
    const opencode = data.outputs.find((o: { path: string }) => o.path === ".opencode/opencode.jsonc");
    expect(opencode.apkitPart.text).toContain(".agent-profile-kit/opencode/context.md");
    expect(opencode.apkitPart.text).not.toContain("my-own/model");
    expect(await tree(fixture.project)).toEqual(project);
    expect(await snapshot(fixture.home)).toEqual(home);

    const text = migrateCli(fixture, fixture.project, "migrate");
    expect(text.code).toBe(3);
    expect(text.out).toContain(".codex/hooks.json was changed after the old apkit wrote it");
    expect(text.out).toContain('cat \\"$root/.agent-profile-kit/codex/context.md\\"');
    expect(text.out).not.toContain("my-own-hook");
    expect(text.out).toContain("--yes keeps .codex/hooks.json, .opencode/opencode.jsonc as your own");
    expect(text.out).toContain("--overwrite deletes .codex/hooks.json, .opencode/opencode.jsonc");
    expect(text.out).toContain("apkit migrate --yes");
    expect(text.out).toContain("apkit migrate --overwrite --yes");
    expect(await tree(fixture.project)).toEqual(project);
  });

  test("--overwrite deletes the changed files, and the Project matches a fresh install", async () => {
    const fixture = await materializeMigration();
    await editConfigurations(fixture);
    const result = migrateCli(fixture, fixture.project, "migrate", "--overwrite", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const data = JSON.parse(result.out).projects[0];
    expect(data.result).toBe("migrated");
    expect([resultOf(data, ".codex/hooks.json"), resultOf(data, ".opencode/opencode.jsonc")]).toEqual(["deleted", "deleted"]);
    const fresh = cliWithEnv({ APKIT_HOME: join(fixture.root, "fresh-apkit") }, fixture.home, fixture.pristine, "install", "engineering", "--agents", ALL, "--yes", "--workspace", fixture.workspace);
    expect(fresh.code).toBe(0);
    expect(await tree(fixture.project)).toEqual(await tree(fixture.pristine));
  });

  test("--yes keeps the changed files as the user's own, and a later migrate does not list them again", async () => {
    // A second Project with a decision that --yes cannot settle keeps the old state for the later runs.
    const fixture = await materializeMachine([{ name: "project" }, { name: "blocker" }]);
    await writeFile(join(fixture.projects.blocker!, ".claude", "skills", "review-pr", "SKILL.md"), "mine\n");
    // The user removed apkit's part first, as the decision asks.
    const hooksPath = join(fixture.project, ".codex", "hooks.json");
    const mine = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "echo my-own-hook", type: "command" }] }] } }, null, 2)}\n`;
    await writeFile(hooksPath, mine);
    const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([3, ""]);
    const data = JSON.parse(result.out).projects[0];
    expect(data.result).toBe("migrated");
    expect(resultOf(data, ".codex/hooks.json")).toBe("kept");
    expect(resultOf(data, ".opencode/opencode.jsonc")).toBe("deleted");
    expect(await readFile(hooksPath, "utf8")).toBe(mine);
    // The old block is gone, so Git sees the user's file again.
    expect(await readFile(join(fixture.project, ".git", "info", "exclude"), "utf8")).not.toContain("hooks.json");
    const kept = migrateCli(fixture, fixture.project, "migrate", "--yes");
    expect(kept.out).toContain("Kept as your own");
    expect(kept.out).not.toContain("Warning");

    const project = await tree(fixture.project);
    const again = migrateCli(fixture, fixture.project, "migrate", "--json");
    expect([again.code, again.err]).toEqual([3, ""]);
    const second = JSON.parse(again.out).projects[0];
    expect(second.result).toBe("unchanged");
    expect(second.issues).toEqual([]);
    expect(resultOf(second, ".codex/hooks.json")).toBe("kept");
    expect(await tree(fixture.project)).toEqual(project);
  });

  test("a kept file that still holds apkit's part is named in a warning", async () => {
    const fixture = await materializeMigration();
    await editConfigurations(fixture);
    const result = migrateCli(fixture, fixture.project, "migrate", "--yes");
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(result.out).toContain("Warning:");
    expect(result.out).toContain(join(fixture.project, ".codex", "hooks.json"));
    expect(result.out).toContain(join(fixture.project, ".opencode", "opencode.jsonc"));
  });

  test("a changed Skill folder and Markdown output are listed with their origin; --yes cannot keep a Skill this apkit installs again", async () => {
    const fixture = await materializeMigration();
    await writeFile(join(fixture.project, ".grok", "skills", "summarize", "mine.md"), "my notes\n");
    await writeFile(join(fixture.project, ".pi", "APPEND_SYSTEM.md"), "my own Pi text\n");
    const project = await tree(fixture.project);

    const result = migrateCli(fixture, fixture.project, "migrate", "--yes");
    expect(result.code).toBe(3);
    expect(result.out).toContain(".grok/skills/summarize was changed after the old apkit wrote it. It is the Skill 'summarize' for Grok, from the Profile 'engineering'.");
    expect(result.out).toContain(".pi/APPEND_SYSTEM.md was changed after the old apkit wrote it. It is the Context for Pi, from the Profile 'engineering'.");
    expect(result.out).toContain("--yes cannot keep .grok/skills/summarize");
    expect(result.out).toContain("apkit migrate --overwrite --yes");
    expect(await tree(fixture.project)).toEqual(project);

    const overwrite = migrateCli(fixture, fixture.project, "migrate", "--overwrite", "--yes", "--json");
    expect([overwrite.code, overwrite.err]).toEqual([0, ""]);
    const data = JSON.parse(overwrite.out).projects[0];
    expect([resultOf(data, ".grok/skills/summarize"), resultOf(data, ".pi/APPEND_SYSTEM.md")]).toEqual(["replaced", "deleted"]);
    const fresh = cliWithEnv({ APKIT_HOME: join(fixture.root, "fresh-apkit") }, fixture.home, fixture.pristine, "install", "engineering", "--agents", ALL, "--yes", "--workspace", fixture.workspace);
    expect(fresh.code).toBe(0);
    expect(await tree(fixture.project)).toEqual(await tree(fixture.pristine));
  });

  test("removing a folder forgets the old files kept there", async () => {
    const fixture = await materializeMigration();
    await editConfigurations(fixture);
    expect(migrateCli(fixture, fixture.project, "migrate", "--yes").code).toBe(0);
    const configPath = join(fixture.root, "apkit", "config.json");
    expect(JSON.parse(await readFile(configPath, "utf8")).kept).toEqual({ [fixture.project]: [".codex/hooks.json", ".opencode/opencode.jsonc"] });
    expect(migrateCli(fixture, fixture.project, "remove", "--yes").code).toBe(0);
    expect(JSON.parse(await readFile(configPath, "utf8")).kept).toBeUndefined();
  });

  test("a Project migrated by an earlier run that stopped for a decision is already migrated and does not change", async () => {
    const fixture = await materializeMachine([{ name: "done" }, { name: "open" }]);
    await writeFile(join(fixture.projects.open!, ".claude", "skills", "review-pr", "SKILL.md"), "mine\n");
    expect(migrateCli(fixture, fixture.root, "migrate", "--yes").code).toBe(3);
    const project = await tree(fixture.projects.done!);
    const again = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
    expect(again.code).toBe(3);
    const done = JSON.parse(again.out).projects[0];
    expect([done.folder, done.result]).toEqual([fixture.projects.done, "unchanged"]);
    expect(done.outputs.filter((o: { result: string }) => o.result === "already-replaced").map((o: { path: string }) => o.path)).toContain(".claude/skills/review-pr");
    expect(await tree(fixture.projects.done!)).toEqual(project);
  });

  test("a retired receipt's unchanged outputs and old exclusion entries are deleted, and nothing is installed", async () => {
    const fixture = await materializeMachine([{ name: "retired", retired: true }]);
    const folder = fixture.projects.retired!;
    const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const data = JSON.parse(result.out);
    expect(data.projects).toEqual([expect.objectContaining({ folder, result: "retired" })]);
    expect(new Set(data.projects[0].outputs.map((o: { result: string }) => o.result))).toEqual(new Set(["deleted"]));
    expect(data.projects[0].exclusion.result).toBe("removed");
    expect(existsSync(join(folder, ".agents", "apkit.json"))).toBe(false);
    // The complete run selects the Workspace; nothing is installed.
    const config = JSON.parse(await readFile(join(fixture.root, "apkit", "config.json"), "utf8"));
    expect([config.workspace, config.installs ?? []]).toEqual([fixture.workspace, []]);
    // Only the user's own files are left, as before the old install.
    expect(await tree(folder)).toEqual(await tree(fixture.pristine));
    expect(data.backup).toEqual({ path: `${fixture.state}.migrated`, result: "renamed" });
  });

  test("a retired receipt with a changed output is a decision: nothing changes and the old state stays", async () => {
    const fixture = await materializeMachine([{ name: "retired", retired: true }]);
    const folder = fixture.projects.retired!;
    await writeFile(join(folder, ".pi", "APPEND_SYSTEM.md"), "mine\n");
    const project = await tree(folder);
    const result = migrateCli(fixture, fixture.root, "migrate", "--json");
    expect(result.code).toBe(3);
    const data = JSON.parse(result.out);
    expect(data.projects[0]).toMatchObject({ result: "needs-decision", issues: [expect.objectContaining({ kind: "changed", path: ".pi/APPEND_SYSTEM.md" })] });
    expect(data.projects[0].outputs.find((o: { path: string }) => o.path === ".pi/APPEND_SYSTEM.md").choices).toEqual(["yes", "overwrite"]);
    expect(data.backup.result).toBe("kept");
    expect(await tree(folder)).toEqual(project);
    expect(existsSync(fixture.state)).toBe(true);
    const text = migrateCli(fixture, fixture.root, "migrate").out;
    expect(text).toContain("apkit migrate --yes");
    expect(text).toContain("apkit migrate --overwrite");
  });

  test("a retired receipt's changed output: --overwrite deletes it with the others", async () => {
    const fixture = await materializeMachine([{ name: "retired", retired: true }]);
    const folder = fixture.projects.retired!;
    await writeFile(join(folder, ".pi", "APPEND_SYSTEM.md"), "mine\n");
    const result = migrateCli(fixture, fixture.root, "migrate", "--overwrite", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const data = JSON.parse(result.out);
    expect(data.projects[0].result).toBe("retired");
    expect(data.projects[0].outputs.find((o: { path: string }) => o.path === ".pi/APPEND_SYSTEM.md").result).toBe("deleted");
    expect(await tree(folder)).toEqual(await tree(fixture.pristine));
    expect(data.backup.result).toBe("renamed");
  });

  test("a retired receipt's changed output: --yes keeps it as the user's own, and Git sees it again", async () => {
    const fixture = await materializeMachine([{ name: "retired", retired: true }]);
    const folder = fixture.projects.retired!;
    await writeFile(join(folder, ".pi", "APPEND_SYSTEM.md"), "mine\n");
    const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const data = JSON.parse(result.out);
    expect(data.projects[0].result).toBe("retired");
    const results = Object.fromEntries(data.projects[0].outputs.map((o: { path: string; result: string }) => [o.path, o.result]));
    expect(results[".pi/APPEND_SYSTEM.md"]).toBe("kept");
    expect(results[".codex/hooks.json"]).toBe("deleted");
    expect(await read(folder, ".pi/APPEND_SYSTEM.md")).toBe("mine\n");
    expect(await readFile(join(folder, ".git", "info", "exclude"), "utf8")).not.toContain("Agent Profile Kit");
    const config = JSON.parse(await readFile(join(fixture.root, "apkit", "config.json"), "utf8"));
    expect(config.kept).toEqual({ [folder]: [".pi/APPEND_SYSTEM.md"] });
    expect(existsSync(join(folder, ".agents", "apkit.json"))).toBe(false);
    expect(data.backup.result).toBe("renamed");
  });

  test("a malformed old exclusion block stops that Project before any change", async () => {
    const fixture = await materializeMigration();
    const exclude = join(fixture.project, ".git", "info", "exclude");
    await writeFile(exclude, `${await readFile(exclude, "utf8")}# END Agent Profile Kit generated paths\n`);
    const project = await tree(fixture.project);
    const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--json");
    expect(result.code).toBe(1);
    const data = JSON.parse(result.out).projects[0];
    expect([data.result, data.message]).toEqual(["error", expect.stringContaining("malformed old apkit exclusion block")]);
    expect(await tree(fixture.project)).toEqual(project);
  });

  test("entries of another old receipt in the same repository stay in the old block", async () => {
    const fixture = await materializeMigration();
    const path = join(fixture.state, "state", "manifest.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    const sub = join(fixture.project, "sub");
    await writeTree(sub, { ".pi/APPEND_SYSTEM.md": "old\n" });
    state.receipts.push({ ...state.receipts[0], installation_id: "other", project: sub, retired: true, outputs: [{ path: ".pi/APPEND_SYSTEM.md", type: "file", mode: 420, hash: `sha256:${"0".repeat(64)}` }] });
    await writeFile(path, JSON.stringify(state));
    const exclude = join(fixture.project, ".git", "info", "exclude");
    await writeFile(exclude, (await readFile(exclude, "utf8")).replace("/.pi/APPEND_SYSTEM.md\n", "/.pi/APPEND_SYSTEM.md\n/sub/.pi/APPEND_SYSTEM.md\n"));

    const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const projects = JSON.parse(result.out).projects;
    // The sub Project is still pending when the first is migrated, so its entry stays then;
    // its changed file is kept by --yes afterwards, and the block goes with it.
    expect(projects.map((p: { result: string }) => p.result)).toEqual(["migrated", "retired"]);
    expect(projects[0].exclusion.result).toBe("kept-for-others");
    expect(projects[1].exclusion.result).toBe("removed");
    expect(await readFile(exclude, "utf8")).not.toContain("Agent Profile Kit");
    expect(await read(sub, ".pi/APPEND_SYSTEM.md")).toBe("old\n");
  });

  /** The tree of a fresh new-engine install of `profile` for `agents` into a copy of the pristine Project. */
  async function freshInstall(fixture: MigrationFixture, name: string, profile: string, agents: readonly string[]) {
    const folder = join(fixture.root, `fresh-${name}`);
    await cp(fixture.pristine, folder, { recursive: true });
    const fresh = cliWithEnv({ APKIT_HOME: join(fixture.root, `fresh-apkit-${name}`) }, fixture.home, folder, "install", profile, "--agents", agents.join(","), "--yes", "--workspace", fixture.workspace);
    expect([fresh.code, fresh.err]).toEqual([0, ""]);
    return tree(folder);
  }

  test("one run migrates every Project with its own Profile and agents, then keeps the old state as a backup, unchanged", async () => {
    const machine = [
      { name: "engineering", profile: "engineering", agents: ALL.split(",") },
      { name: "writing", profile: "writing", agents: ["claude", "codex"] },
      { name: "skills", profile: "skills-only", agents: ["pi"] },
    ];
    const fixture = await materializeMachine(machine);
    const before = await snapshot(fixture.state);
    const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const data = JSON.parse(result.out);
    expect(data.projects.map((p: { folder: string; result: string; profile: string; agents: string[] }) => [p.folder, p.result, p.profile, p.agents])).toEqual(
      machine.map((p) => [fixture.projects[p.name], "migrated", p.profile, p.agents]),
    );
    for (const p of machine) {
      const manifest = JSON.parse(await read(fixture.projects[p.name]!, ".agents/apkit.json"));
      expect([manifest.profile, manifest.agents]).toEqual([p.profile, p.agents]);
      expect(await tree(fixture.projects[p.name]!)).toEqual(await freshInstall(fixture, p.name, p.profile, p.agents));
    }
    const config = JSON.parse(await readFile(join(fixture.root, "apkit", "config.json"), "utf8"));
    expect([config.workspace, [...config.installs].sort()]).toEqual([fixture.workspace, machine.map((p) => fixture.projects[p.name]).sort()]);
    expect(data.backup).toEqual({ path: `${fixture.state}.migrated`, result: "renamed" });
    expect(existsSync(fixture.state)).toBe(false);
    expect(await snapshot(`${fixture.state}.migrated`)).toEqual(before);
  });

  test("names each Project and the backup in text", async () => {
    const fixture = await materializeMachine([{ name: "one" }, { name: "two", profile: "writing", agents: ["claude"] }]);
    const result = migrateCli(fixture, fixture.root, "migrate", "--yes");
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(result.out).toContain(`${fixture.projects.one}: migrated`);
    expect(result.out).toContain(`${fixture.projects.two}: migrated`);
    expect(result.out).toContain(`Renamed ${OLD} to ${BACKUP}.`);
  });

  test("a recorded Project folder that no longer exists is named and skipped; the others migrate and the backup is made", async () => {
    const fixture = await materializeMachine([{ name: "gone", missing: true }, { name: "here" }, { name: "gone-too", missing: true, retired: true }]);
    const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const data = JSON.parse(result.out);
    expect(data.projects.map((p: { folder: string; result: string }) => [p.folder, p.result])).toEqual([
      [fixture.projects.gone, "missing"],
      [fixture.projects.here, "migrated"],
      [fixture.projects["gone-too"], "missing"],
    ]);
    expect(data.backup.result).toBe("renamed");
    expect(existsSync(fixture.projects.gone!)).toBe(false);
  });

  test("missing Project folders are listed by path in one warning", async () => {
    const fixture = await materializeMachine([{ name: "gone", missing: true }, { name: "gone-too", missing: true }]);
    const result = migrateCli(fixture, fixture.root, "migrate", "--yes");
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(result.out.match(/Warning:/g)).toHaveLength(1);
    expect(result.out).toContain(`  - ${fixture.projects.gone}\n  - ${fixture.projects["gone-too"]}`);
  });

  test("while a Project needs a decision, the old state folder is not renamed; a later complete run renames it", async () => {
    const fixture = await materializeMachine([{ name: "ok" }, { name: "edited" }]);
    const before = await snapshot(fixture.state);
    // A changed Skill folder that this apkit installs again: --yes cannot keep it.
    await writeFile(join(fixture.projects.edited!, ".claude", "skills", "review-pr", "SKILL.md"), "mine\n");
    const first = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
    expect(first.code).toBe(3);
    const data = JSON.parse(first.out);
    expect(data.projects.map((p: { result: string }) => p.result)).toEqual(["migrated", "needs-decision"]);
    expect(data.backup).toEqual({ path: `${fixture.state}.migrated`, result: "kept" });
    expect(await snapshot(fixture.state)).toEqual(before);
    expect(existsSync(`${fixture.state}.migrated`)).toBe(false);
    const text = migrateCli(fixture, fixture.root, "migrate", "--yes").out;
    expect(text).toContain(`Kept ${OLD} as it is. It is renamed to ${BACKUP} as a backup once these Projects are migrated:\n  - ${fixture.projects.edited}\n`);

    const second = migrateCli(fixture, fixture.root, "migrate", "--yes", "--overwrite", "--json");
    expect([second.code, second.err]).toEqual([0, ""]);
    expect(JSON.parse(second.out).projects.map((p: { result: string }) => p.result)).toEqual(["unchanged", "migrated"]);
    expect(await snapshot(`${fixture.state}.migrated`)).toEqual(before);
  });

  test("a Project that fails keeps the old state folder", async () => {
    const fixture = await materializeMachine([{ name: "ok" }, { name: "unknown", profile: "no-such-profile" }]);
    const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out).backup.result).toBe("kept");
    expect(existsSync(fixture.state)).toBe(true);
  });

  for (const order of ["outer first", "inner first"]) {
    test(`two Projects in one repository (${order}): the old block is removed and no entry comes back`, async () => {
      const fixture = await materializeMachine([{ name: "outer" }]);
      const outer = fixture.projects.outer!;
      const inner = join(outer, "inner");
      await cp(join(fixture.project, ".pi"), join(inner, ".pi"), { recursive: true });
      await cp(join(fixture.project, ".claude"), join(inner, ".claude"), { recursive: true });
      const path = join(fixture.state, "state", "manifest.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      const [receipt] = state.receipts;
      const keep = new Set([".pi/APPEND_SYSTEM.md", ".claude/rules/agent-profile-kit.md"]);
      const second = { ...receipt, installation_id: "inner", project: inner, retired: true, outputs: receipt.outputs.filter((o: { path: string }) => keep.has(o.path)) };
      state.receipts = order === "outer first" ? [receipt, second] : [second, receipt];
      await writeFile(path, JSON.stringify(state));
      const exclude = join(outer, ".git", "info", "exclude");
      await writeFile(exclude, (await readFile(exclude, "utf8")).replace("/.pi/APPEND_SYSTEM.md\n", "/.pi/APPEND_SYSTEM.md\n/inner/.claude/rules/agent-profile-kit.md\n/inner/.pi/APPEND_SYSTEM.md\n"));

      const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      expect(await readFile(exclude, "utf8")).not.toContain("Agent Profile Kit");
      expect(existsSync(join(inner, ".pi"))).toBe(false);
      expect(await read(inner, ".claude/settings.json")).toContain("permissions");
    });
  }

  test("a second run after a complete run changes nothing and says there is nothing to migrate", async () => {
    const fixture = await materializeMachine([{ name: "one" }, { name: "two", profile: "writing", agents: ["codex"] }]);
    expect(migrateCli(fixture, fixture.root, "migrate", "--yes").code).toBe(0);
    const trees = [await tree(fixture.projects.one!), await tree(fixture.projects.two!)];
    const home = await snapshot(fixture.home);
    const apkit = await snapshot(join(fixture.root, "apkit"));
    const again = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
    expect([again.code, again.err]).toEqual([0, ""]);
    expect(JSON.parse(again.out)).toEqual({ state: fixture.state, found: false, projects: [], backup: `${fixture.state}.migrated` });
    const text = migrateCli(fixture, fixture.root, "migrate", "--yes");
    expect(text.out).toContain("Nothing to migrate");
    expect(text.out).toContain(BACKUP);
    expect([await tree(fixture.projects.one!), await tree(fixture.projects.two!)]).toEqual(trees);
    expect(await snapshot(fixture.home)).toEqual(home);
    expect(await snapshot(join(fixture.root, "apkit"))).toEqual(apkit);
  });

  test("an existing backup folder stops migrate before any change", async () => {
    const fixture = await materializeMachine([{ name: "one" }]);
    await writeTree(`${fixture.state}.migrated`, { "config.yaml": "earlier\n" });
    const project = await tree(fixture.projects.one!);
    const home = await snapshot(fixture.home);
    const result = migrateCli(fixture, fixture.root, "migrate", "--yes");
    expect(result.code).toBe(1);
    expect(result.err).toContain(`${BACKUP} already exists`);
    expect(result.err).toContain("Next: `apkit migrate`");
    expect(await tree(fixture.projects.one!)).toEqual(project);
    expect(await snapshot(fixture.home)).toEqual(home);
  });

  describe("a Workspace marked only by workspace.yaml", () => {
    /** The shipped fixture has both marker files; these journeys keep only the old one. */
    async function oldMarkerOnly() {
      const fixture = await materializeMigration();
      await rm(join(fixture.workspace, "apkit-workspace.yaml"));
      return { ...fixture, from: join(fixture.workspace, "workspace.yaml"), to: join(fixture.workspace, "apkit-workspace.yaml") };
    }

    test("without --yes, the rename is a decision listed with every Project decision, and nothing changes", async () => {
      const fixture = await oldMarkerOnly();
      const workspace = await snapshot(fixture.workspace);
      const project = await tree(fixture.project);
      const home = await snapshot(fixture.home);

      const result = migrateCli(fixture, fixture.project, "migrate", "--json");
      expect([result.code, result.err]).toEqual([3, ""]);
      const data = JSON.parse(result.out);
      expect(data.workspace).toMatchObject({ path: fixture.workspace, rename: { from: fixture.from, to: fixture.to, result: "needs-decision" } });
      expect(data.projects).toHaveLength(1);
      expect(data.projects[0]).toMatchObject({ folder: fixture.project, result: "needs-decision", profile: "engineering" });
      expect(data.projects[0].issues.map((i: { path: string }) => i.path)).toContain("AGENTS.md");

      const text = migrateCli(fixture, fixture.project, "migrate");
      expect(text.code).toBe(3);
      expect(text.out).toContain(fixture.from);
      expect(text.out).toContain(fixture.to);
      expect(text.out).toContain(fixture.project);
      expect(text.out).toContain("AGENTS.md");
      expect(text.out).toContain("apkit migrate --yes");

      expect(await snapshot(fixture.workspace)).toEqual(workspace);
      expect(await tree(fixture.project)).toEqual(project);
      expect(await snapshot(fixture.home)).toEqual(home);
      expect(existsSync(join(fixture.root, "apkit", "config.json"))).toBe(false);
    });

    test("with --overwrite but not --yes, changed old outputs are listed with the rename, and nothing changes", async () => {
      const fixture = await oldMarkerOnly();
      await editConfigurations(fixture);
      const project = await tree(fixture.project);
      const result = migrateCli(fixture, fixture.project, "migrate", "--overwrite", "--json");
      expect(result.code).toBe(3);
      const data = JSON.parse(result.out);
      expect(data.workspace.rename.result).toBe("needs-decision");
      expect(data.projects[0].result).toBe("needs-decision");
      expect(data.projects[0].issues.filter((i: { kind: string }) => i.kind === "changed").map((i: { path: string }) => i.path).sort()).toEqual([".codex/hooks.json", ".opencode/opencode.jsonc"]);
      expect(data.projects[0].outputs.find((o: { path: string }) => o.path === ".codex/hooks.json").apkitPart.present).toBe("yes");
      expect(await tree(fixture.project)).toEqual(project);
    });

    test("without --yes, a Project with no decision of its own waits for the rename and is not changed", async () => {
      // Migrated once while both marker files existed, so the Project needs no decision of its own.
      // A second Project with a changed output keeps the old state from being renamed.
      const fixture = await materializeMachine([{ name: "done" }, { name: "open" }]);
      const done = fixture.projects.done!;
      await writeFile(join(fixture.projects.open!, ".claude", "skills", "review-pr", "SKILL.md"), "mine\n");
      expect(migrateCli(fixture, fixture.root, "migrate", "--yes").code).toBe(3);
      await rm(join(fixture.workspace, "apkit-workspace.yaml"));
      const project = await tree(done);
      const workspace = await snapshot(fixture.workspace);

      const result = migrateCli(fixture, fixture.root, "migrate", "--json");
      expect(result.code).toBe(3);
      const data = JSON.parse(result.out);
      expect(data.workspace.rename.result).toBe("needs-decision");
      expect(data.projects[0]).toEqual(expect.objectContaining({ folder: done, result: "waiting", issues: [] }));
      expect(data.backup.result).toBe("kept");
      const text = migrateCli(fixture, fixture.root, "migrate").out;
      expect(text).toContain(`${done}: nothing changed yet`);
      expect(await tree(done)).toEqual(project);
      expect(await snapshot(fixture.workspace)).toEqual(workspace);
      expect(existsSync(fixture.state)).toBe(true);
    });

    test("without --yes, a retired Project waits too: none of its old files are deleted and the old state stays", async () => {
      const fixture = await materializeMachine([{ name: "retired", retired: true }]);
      const folder = fixture.projects.retired!;
      await rm(join(fixture.workspace, "apkit-workspace.yaml"));
      const project = await tree(folder);
      const result = migrateCli(fixture, fixture.root, "migrate", "--json");
      expect(result.code).toBe(3);
      const data = JSON.parse(result.out);
      expect(data.projects).toEqual([expect.objectContaining({ folder, result: "waiting" })]);
      expect(data.backup.result).toBe("kept");
      expect(await tree(folder)).toEqual(project);
      expect(existsSync(fixture.state)).toBe(true);
    });

    test("with --yes, the file is renamed with its content unchanged, and the migration continues with that Workspace", async () => {
      const fixture = await oldMarkerOnly();
      const content = await readFile(fixture.from);
      const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      const data = JSON.parse(result.out);
      expect(data.workspace).toMatchObject({ path: fixture.workspace, rename: { from: fixture.from, to: fixture.to, result: "renamed" } });
      expect(data.projects[0]).toMatchObject({ folder: fixture.project, result: "migrated" });
      expect(existsSync(fixture.from)).toBe(false);
      expect((await readFile(fixture.to)).equals(content)).toBe(true);
      const config = JSON.parse(await readFile(join(fixture.root, "apkit", "config.json"), "utf8"));
      expect(config.workspace).toBe(fixture.workspace);
    });

    test("with --yes, text names the rename", async () => {
      const fixture = await oldMarkerOnly();
      const result = migrateCli(fixture, fixture.project, "migrate", "--yes");
      expect([result.code, result.err]).toEqual([0, ""]);
      expect(result.out).toContain(`Renamed ${fixture.from} to ${fixture.to}`);
    });

    test("another Workspace problem blocks the rename, and nothing changes", async () => {
      const fixture = await oldMarkerOnly();
      await writeFile(join(fixture.workspace, "profiles", "writing.yaml"), "context: []\nskills:\n  - missing-skill\n");
      const workspace = await snapshot(fixture.workspace);
      const project = await tree(fixture.project);
      const result = migrateCli(fixture, fixture.project, "migrate", "--yes");
      expect(result.code).toBe(1);
      expect(result.err).toContain("missing-skill");
      expect(await snapshot(fixture.workspace)).toEqual(workspace);
      expect(await tree(fixture.project)).toEqual(project);
    });
  });

  test("a Workspace that already has apkit-workspace.yaml gets no rename decision", async () => {
    const fixture = await materializeMigration();
    const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).workspace.rename).toBeUndefined();
    expect(existsSync(join(fixture.workspace, "workspace.yaml"))).toBe(true);
  });

  describe("the old Workspace (SRC-08a)", () => {
    /** The Workspace the new apkit has selected, if any. */
    async function selected(fixture: MigrationFixture): Promise<string | undefined> {
      const path = join(fixture.root, "apkit", "config.json");
      return existsSync(path) ? JSON.parse(await readFile(path, "utf8")).workspace : undefined;
    }

    test("with no Project to migrate, a complete run selects the old Workspace", async () => {
      const fixture = await materializeMachine([]);
      const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      const data = JSON.parse(result.out);
      expect(data.workspace).toMatchObject({ path: fixture.workspace, selected: true });
      expect(data.backup.result).toBe("renamed");
      expect(await selected(fixture)).toBe(fixture.workspace);
      expect(migrateCli(fixture, fixture.root, "workspace").out).toContain(fixture.workspace);
    });

    test("a missing old Workspace that no Project needs does not block migrate, and no notice follows", async () => {
      const fixture = await materializeMachine([{ name: "retired", retired: true }, { name: "gone", missing: true }]);
      await rm(fixture.workspace, { recursive: true });
      const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      const data = JSON.parse(result.out);
      expect(data.workspace).toMatchObject({ path: fixture.workspace, selected: false });
      expect(data.projects.map((p: { result: string }) => p.result)).toEqual(["retired", "missing"]);
      expect(data.backup.result).toBe("renamed");
      expect(await selected(fixture)).toBeUndefined();
      const after = migrateCli(fixture, fixture.root, "status", "--all");
      expect(after.out + after.err).not.toContain("Next: `apkit migrate`");
    });

    test("in text, a missing old Workspace that no Project needs is named, with the command that selects one", async () => {
      const fixture = await materializeMachine([{ name: "retired", retired: true }]);
      await rm(fixture.workspace, { recursive: true });
      const result = migrateCli(fixture, fixture.root, "migrate", "--yes");
      expect([result.code, result.err]).toEqual([0, ""]);
      expect(result.out).toContain(`${fixture.workspace} is not a Workspace, so it was not selected`);
      expect(result.out).toContain("apkit workspace <path>");
    });

    test("a missing old Workspace that a Project needs: the error names config.yaml and the Workspace, and --workspace settles it", async () => {
      const fixture = await materializeMigration();
      const moved = join(fixture.root, "moved-workspace");
      await rename(fixture.workspace, moved);
      const project = await tree(fixture.project);
      const failed = migrateCli(fixture, fixture.project, "migrate", "--yes");
      expect(failed.code).toBe(1);
      expect(failed.err).toContain(join(OLD, "config.yaml"));
      expect(failed.err).toContain(fixture.workspace);
      expect(failed.err).toContain("Nothing was changed");
      expect(failed.err).toContain("apkit migrate --workspace <path>");
      expect(await tree(fixture.project)).toEqual(project);
      expect(existsSync(fixture.state)).toBe(true);

      const result = migrateCli(fixture, fixture.project, "migrate", "--yes", "--workspace", moved, "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      const data = JSON.parse(result.out);
      expect(data.workspace).toMatchObject({ path: moved, selected: true });
      expect(data.projects[0].result).toBe("migrated");
      expect(await selected(fixture)).toBe(moved);
    });

    test("an old configuration that names no Workspace does not block migrate when no Project needs one", async () => {
      const fixture = await materializeMachine([{ name: "retired", retired: true }]);
      await writeFile(join(fixture.state, "config.yaml"), "schema_version: 2\n");
      const result = migrateCli(fixture, fixture.root, "migrate", "--yes", "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      expect(JSON.parse(result.out).workspace).toBeNull();
    });
  });

  test("a retired receipt whose outputs this apkit already installed again: --overwrite leaves them installed", async () => {
    const fixture = await materializeMachine([{ name: "retired", retired: true }]);
    const folder = fixture.projects.retired!;
    const install = migrateCli(fixture, folder, "install", "engineering", folder, "--agents", ALL, "--yes", "--overwrite", "--workspace", fixture.workspace);
    expect(install.code).toBe(0);
    const result = migrateCli(fixture, fixture.root, "migrate", "--overwrite", "--yes", "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const outputs = JSON.parse(result.out).projects[0].outputs as { path: string; result: string }[];
    expect(outputs.find((o) => o.path === ".claude/skills/review-pr")?.result).toBe("already-replaced");
    // Every file this apkit installed is still there, as installed.
    const manifest = JSON.parse(await read(folder, ".agents/apkit.json")) as { files: Record<string, string> };
    expect(Object.keys(manifest.files)).toContain(".claude/skills/review-pr/SKILL.md");
    for (const [path, recorded] of Object.entries(manifest.files)) expect(hash(await readFile(join(folder, ...path.split("/"))))).toBe(recorded);
  });

  test("with no old state, there is nothing to migrate", async () => {
    const home = await tempDir("home");
    const result = cli(home, home, "migrate", "--json");
    expect([result.code, JSON.parse(result.out)]).toEqual([0, { state: join(home, ".agents", "agent-profile-kit"), found: false, projects: [], backup: null }]);
    expect(cli(home, home, "migrate").out).toContain("Nothing to migrate");
  });
});

describe("the migration notice (SRC-10)", () => {
  const NOTICE = "Next: `apkit migrate`";

  /** A run of every command: reads, writes, a Decision (exit 3), usage errors, and help, guide, and contract. */
  async function everyCommand(run: (cwd: string, ...args: string[]) => { code: number | null; out: string; err: string }, json: boolean) {
    const ws = await makeWorkspace();
    const folder = await tempDir("project");
    const fresh = join(await tempDir("init"), "workspace");
    const flag = json ? ["--json"] : [];
    const commands = [
      ["init", fresh],
      ["workspace"],
      ["workspace", ws],
      ["check", "--workspace", ws],
      ["install", "engineering", folder, "--agents", "claude", "--workspace", ws],
      ["update", "--all", "--workspace", ws],
      ["status", "--workspace", ws],
      ["status", "--all", "--workspace", ws],
      ["remove", folder],
      ["remove", "--global"],
      ["setup", "--agents", "claude"],
      ["install"],
      ["no-such-command"],
    ];
    return commands.map((args) => ({ args, ...run(folder, ...args, ...flag) }));
  }

  /** Runs with the new apkit home apart from the home folder, as the migrate journeys do. */
  function runner(fixture: MigrationFixture) {
    return (cwd: string, ...args: string[]) =>
      cliWithEnv({ APKIT_HOME: join(fixture.root, "apkit"), BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, fixture.home, cwd, ...args);
  }

  test("with unmigrated old state, every command names `apkit migrate`, and none changes the old state", async () => {
    const fixture = await materializeMigration();
    const before = await snapshot(fixture.state);
    const run = runner(fixture);
    for (const result of await everyCommand(run, false)) {
      expect({ args: result.args, named: (result.out + result.err).includes(NOTICE) }).toEqual({ args: result.args, named: true });
    }
    for (const args of [[], ["help"], ["guide"], ["help", "--json"], ["guide", "--json"]]) {
      expect({ args, named: run(fixture.root, ...args).out.includes(NOTICE) }).toEqual({ args, named: true });
    }
    // The contract stays byte for byte on stdout; the notice goes to stderr.
    const contract = run(fixture.root, "contract");
    expect(contract.out).toBe(await readFile(join(import.meta.dir, "..", "docs", "guides", "workspace-contract.md"), "utf8"));
    expect(contract.err).toContain(NOTICE);
    expect(await snapshot(fixture.state)).toEqual(before);
  });

  test("with unmigrated old state, every --json record carries the migration field", async () => {
    const fixture = await materializeMigration();
    const migration = { command: "apkit migrate", state: fixture.state };
    for (const result of await everyCommand(runner(fixture), true)) {
      expect({ args: result.args, migration: JSON.parse(result.out).migration }).toEqual({ args: result.args, migration });
    }
  });

  test("`migrate` does not repeat the notice in its own output", async () => {
    const fixture = await materializeMigration();
    const run = runner(fixture);
    const planned = run(fixture.project, "migrate");
    expect(planned.code).toBe(3);
    expect(planned.out).not.toContain(NOTICE);
    expect(JSON.parse(run(fixture.project, "migrate", "--json").out).migration).toBeUndefined();
  });

  test("a failed `migrate` names `apkit migrate` once, and its --json error carries the migration field", async () => {
    const fixture = await materializeMigration();
    const run = runner(fixture);
    await mkdir(`${fixture.state}.migrated`);
    const failed = run(fixture.project, "migrate", "--yes");
    expect(failed.code).toBe(1);
    expect(failed.err.split(NOTICE).length - 1).toBe(1);
    const json = run(fixture.project, "migrate", "--yes", "--json");
    expect(JSON.parse(json.out).migration).toEqual({ command: "apkit migrate", state: fixture.state });
  });

  test("an old state folder with no old records: migrate renames it to the backup, and the notice disappears", async () => {
    const home = await tempDir("home");
    const state = join(home, ".agents", "agent-profile-kit");
    const backup = `${state}.migrated`;
    await writeTree(state, { "notes.txt": "left by the user\n" });
    const before = cli(home, home, "status", "--all");
    expect(before.out + before.err).toContain(NOTICE);

    // An existing backup is never replaced: nothing changes.
    await mkdir(backup);
    const refused = cli(home, home, "migrate");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("already exists");
    expect(await read(state, "notes.txt")).toBe("left by the user\n");
    await rm(backup, { recursive: true });

    const result = cli(home, home, "migrate");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Nothing to migrate");
    expect(result.out).toContain(join("~", ".agents", "agent-profile-kit.migrated"));
    expect(existsSync(state)).toBe(false);
    expect(await read(backup, "notes.txt")).toBe("left by the user\n");
    for (const args of [["status", "--all"], ["help"], ["migrate"]]) {
      const after = cli(home, home, ...args);
      expect(after.out + after.err).not.toContain(NOTICE);
    }
    expect(JSON.parse(cli(home, home, "status", "--all", "--json").out).migration).toBeUndefined();
  });

  test("an empty old state folder: migrate --json records the rename", async () => {
    const home = await tempDir("home");
    const state = join(home, ".agents", "agent-profile-kit");
    await mkdir(state, { recursive: true });
    const result = cli(home, home, "migrate", "--json");
    expect([result.code, JSON.parse(result.out)]).toEqual([0, { state, found: false, projects: [], backup: { path: `${state}.migrated`, result: "renamed" } }]);
    expect(existsSync(`${state}.migrated`)).toBe(true);
  });

  test("after a complete migration, no command shows the notice", async () => {
    const fixture = await materializeMigration();
    const run = runner(fixture);
    expect(run(fixture.project, "migrate", "--yes").code).toBe(0);
    expect(existsSync(fixture.state)).toBe(false);
    expect(existsSync(`${fixture.state}.migrated`)).toBe(true);
    for (const json of [false, true]) {
      for (const result of await everyCommand(run, json)) {
        expect({ args: result.args, named: (result.out + result.err).includes("apkit migrate") }).toEqual({ args: result.args, named: false });
        if (json) expect(JSON.parse(result.out).migration).toBeUndefined();
      }
    }
    expect(run(fixture.project, "contract").err).toBe("");
  });

  test("with no old state, no command shows the notice", async () => {
    const home = await tempDir("home");
    const run = (cwd: string, ...args: string[]) => cli(home, cwd, ...args);
    for (const json of [false, true]) {
      for (const result of await everyCommand(run, json)) {
        expect({ args: result.args, named: (result.out + result.err).includes(NOTICE) }).toEqual({ args: result.args, named: false });
        if (json) expect(JSON.parse(result.out).migration).toBeUndefined();
      }
    }
    for (const args of [["help"], ["guide"]]) expect(run(home, ...args).out).not.toContain(NOTICE);
    expect(run(home, "contract").err).toBe("");
  });

  test("status and update --json print an object with the results, also when there are none", async () => {
    const home = await tempDir("home");
    const ws = await makeWorkspace();
    expect(JSON.parse(cli(home, home, "status", "--all", "--workspace", ws, "--json").out)).toEqual({ results: [] });
    expect(JSON.parse(cli(home, home, "update", "--all", "--workspace", ws, "--json").out)).toEqual({ results: [] });
  });
});

/** Validation must preserve bytes, links, and even empty folders, including apkit's own state. */
async function validationTree(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name);
    const path = relative(root, full).split(sep).join("/");
    if (entry.isDirectory()) tree[`${path}/`] = "";
    else if (entry.isSymbolicLink()) tree[`${path}@`] = await readlink(full);
    else if (entry.isFile()) tree[path] = (await readFile(full)).toString("base64");
  }
  return tree;
}

describe("validation reports for every error kind", () => {
  for (const [code, { files, paths, fix, links = {} }] of Object.entries(ERROR_KINDS)) {
    describe(code, () => {
      test.skipIf(code === "context-id-case-collision" && !CASE_SENSITIVE_CONTEXT)("check names every offending path, its fix, and the contract", async () => {
        const home = await tempDir("home");
        const ws = await tempDir("ws");
        await writeTree(ws, files);
        for (const [link, to] of Object.entries(links)) {
          await symlink(join(ws, ...to.split("/")), join(ws, ...link.split("/")), "junction");
        }
        const check = cli(home, home, "check", "--workspace", ws);
        expect(check.code).toBe(1);
        for (const path of paths) expect(check.out).toContain(path);
        expect(check.out).toContain(fix);
        expect(check.out).toContain(`Next: \`${COMMAND} contract\``);
        const json = cli(home, home, "check", "--workspace", ws, "--json");
        expect(json.code).toBe(1);
        const report = JSON.parse(json.out);
        expect(report.valid).toBe(false);
        expect(report.violations.map((v: Violation) => [v.code, v.path])).toEqual(paths.map((path) => [code, path]));
        for (const violation of report.violations) expect(violation.message).toContain(fix);
        expect(report.contract).toBe(`${COMMAND} contract`);
      });

      test.skipIf(code === "context-id-case-collision" && !CASE_SENSITIVE_CONTEXT)("install and update leave every file and folder unchanged", async () => {
        const home = await tempDir("home");
        const ws = await makeWorkspace();
        const installed = await tempDir("installed");
        const fresh = await tempDir("fresh");
        for (const folder of [installed, fresh]) {
          expect(spawnSync("git", ["init", "-q"], { cwd: folder }).status).toBe(0);
          await mkdir(join(folder, "keep-empty"));
        }
        const agents = Object.keys(AGENTS).join(",");
        // Connect while valid: missing/old manifests are produced in an already connected Workspace.
        expect(cli(home, installed, "workspace", ws).code).toBe(0);
        expect(cli(home, installed, "install", "engineering", "--agents", agents, "--yes").code).toBe(0);
        expect(await read(installed, "AGENTS.md")).toContain("Be concise.");
        await writeTree(ws, { "context/communication.md": "Pending update that must not be installed.\n" });
        if (!("apkit-workspace.yaml" in files)) await rm(join(ws, "apkit-workspace.yaml"));
        await writeTree(ws, files);
        for (const [link, to] of Object.entries(links)) {
          await symlink(join(ws, ...to.split("/")), join(ws, ...link.split("/")), "junction");
        }
        const check = cli(home, installed, "check", "--json");
        expect(check.code).toBe(1);
        expect(JSON.parse(check.out).violations.map((v: Violation) => [v.code, v.path])).toEqual(paths.map((path) => [code, path]));
        const roots = [ws, installed, fresh, home];
        const before = await Promise.all(roots.map(validationTree));
        const install = cli(home, fresh, "install", "engineering", "--agents", agents, "--yes");
        expect(install.code).toBe(1);
        for (const path of paths) expect(install.err).toContain(path);
        expect(install.err).toContain(fix);
        expect(install.err).toContain(`Next: \`${COMMAND} contract\``);
        expect(await Promise.all(roots.map(validationTree))).toEqual(before);
        const update = cli(home, installed, "update", "--all", "--yes");
        expect(update.code).toBe(1);
        for (const path of paths) expect(update.err).toContain(path);
        expect(update.err).toContain(fix);
        expect(update.err).toContain(`Next: \`${COMMAND} contract\``);
        expect(await Promise.all(roots.map(validationTree))).toEqual(before);
      });
    });
  }
});

describe("published standard Skill packages (ISC-38)", () => {
  test("published Skills validate unchanged, including allowed-tools, compatibility, metadata and Resources", async () => {
    const source = join(import.meta.dir, "retained", "standard-skills");
    const home = await tempDir("home");
    const root = await tempDir("published-skills");
    await writeTree(root, { "apkit-workspace.yaml": "schema_version: 1\n", "profiles/published.yaml": "skills: all\n" });
    const manifest = JSON.parse(await read(source, "sha256.json")) as Record<string, string>;
    for (const name of ["django-perf-review", "transformers-js"]) {
      await cp(join(source, name), join(root, "skills", name), { recursive: true });
    }
    const before = await retainedTree(root);
    const copied = await retainedTree(join(root, "skills"));
    expect(Object.fromEntries(Object.entries(copied).filter(([path]) => !path.endsWith("/")))).toEqual(manifest);
    const result = cli(home, root, "check", "--workspace", root, "--json");
    expect([result.code, result.err]).toEqual([0, ""]);
    const report = JSON.parse(result.out);
    expect(report.valid).toBe(true);
    expect(report.violations).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.skills).toEqual(["django-perf-review", "transformers-js"]);
    expect(await retainedTree(root)).toEqual(before);
  });
});

/** Exact file bytes (SHA-256) and every directory, including empty ones. */
async function retainedTree(root: string): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name);
    const path = relative(root, full).split(sep).join("/");
    if (entry.isDirectory()) tree[`${path}/`] = "";
    else if (entry.isFile()) tree[path] = hash(await readFile(full));
    else throw new Error(`Unexpected retained-fixture entry: ${path}`);
  }
  return tree;
}

describe("retained Workspace CLI compatibility (ISC-46)", () => {
  test("every retained format names all needed changes in one CLI check, and those changes suffice", async () => {
    const fixtures: { source: string; counts: Record<string, number> }[] = [
      { source: "compat-0.16.0/minimal", counts: { "workspace-old-manifest": 1 } },
      { source: "compat-0.16.0/partial", counts: { "workspace-old-manifest": 1, "invalid-profile": 1 } },
      { source: "compat-0.84.0", counts: { "workspace-old-manifest": 1, "invalid-profile": 1, "missing-context-reference": 1 } },
      { source: "compat-0.204.0/workspace-source", counts: { "workspace-old-manifest": 1, "invalid-profile": 2, "missing-context-reference": 1 } },
      { source: "compat-0.204.0/workspace-realistic", counts: { "workspace-old-manifest": 1, "invalid-profile": 5, "missing-context-reference": 29 } },
      { source: "compat-0.237.0", counts: { "workspace-old-manifest": 1 } },
    ];
    for (const fixture of fixtures) {
      const home = await tempDir("home");
      const root = await tempDir("retained-cli");
      await cp(join(import.meta.dir, "retained", ...fixture.source.split("/")), root, { recursive: true });
      // An empty user-owned folder must survive validation and every named repair.
      await mkdir(join(root, "empty-folder"));
      const before = await retainedTree(root);
      const first = cli(home, root, "check", "--workspace", root, "--json");
      expect([fixture.source, first.code, first.err]).toEqual([fixture.source, 1, ""]);
      const report = JSON.parse(first.out) as { valid: boolean; violations: Violation[]; contract: string };
      expect(report.valid).toBe(false);
      expect(report.contract).toBe("apkit contract");
      const counts: Record<string, number> = {};
      for (const error of report.violations) {
        counts[error.code] = (counts[error.code] ?? 0) + 1;
        expect(Object.keys(before)).toContain(error.path);
      }
      expect([fixture.source, counts]).toEqual([fixture.source, fixture.counts]);
      expect(await retainedTree(root)).toEqual(before);
      await applyNamedChanges(root, report.violations);
      const repaired = await retainedTree(root);
      expect(repaired["empty-folder/"]).toBe("");
      const second = cli(home, root, "check", "--workspace", root, "--json");
      expect([fixture.source, second.code, second.err]).toEqual([fixture.source, 0, ""]);
      expect(JSON.parse(second.out).violations).toEqual([]);
      expect(JSON.parse(second.out).valid).toBe(true);
      expect(await retainedTree(root)).toEqual(repaired);
    }
  });
});

describe("Workspace folder states (ISC-23, ISC-26, ISC-27, ISC-28)", () => {
  function folderCli(home: string, cwd: string, ...args: string[]) {
    return cliWithEnv({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, home, cwd, ...args);
  }

  // Exact bytes and every directory, including empty ones; paths are portable across CI platforms.
  async function folderTree(root: string): Promise<Record<string, string>> {
    const entries: Record<string, string> = {};
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      const full = join(entry.parentPath, entry.name);
      const path = relative(root, full).split(sep).join("/");
      entries[entry.isDirectory() ? `${path}/` : path] = entry.isDirectory() ? "" : (await readFile(full)).toString("hex");
    }
    return entries;
  }

  test("only caller-supplied paths select a Workspace, including migration without a legacy selection", async () => {
    const home = await tempDir("selection-home");
    const cwd = await tempDir("selection-cwd");
    const one = await tempDir("selection-one");
    const two = await makeWorkspace();
    expect(folderCli(home, cwd, "init").code).toBe(2);
    expect(await folderTree(home)).toEqual({});
    expect(await folderTree(cwd)).toEqual({});
    for (const [command, path] of [["init", one], ["init", one], ["workspace", one], ["workspace", one], ["workspace", two]]) {
      const result = folderCli(home, cwd, command!, path!, "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      expect(JSON.parse(result.out).workspace).toBe(path);
      expect(JSON.parse(await read(home, "config.json")).workspace).toBe(path);
    }

    const legacyHome = await tempDir("unselected-home");
    const apkitHome = join(legacyHome, "apkit");
    await writeTree(legacyHome, {
      ".agents/agent-profile-kit/config.yaml": "schema_version: 1\n",
      "apkit/config.json": '{"installs": []}\n',
    });
    const run = (...args: string[]) => cliWithEnv({ APKIT_HOME: apkitHome, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, legacyHome, cwd, ...args);
    expect(JSON.parse(run("workspace", "--json").out).workspace).toBeNull();
    const migrated = run("migrate", "--json");
    expect([migrated.code, migrated.err]).toEqual([0, ""]);
    expect(JSON.parse(migrated.out).workspace).toBeNull();
    expect(JSON.parse(await read(apkitHome, "config.json"))).not.toHaveProperty("workspace");
    expect(JSON.parse(run("workspace", "--json").out).workspace).toBeNull();
    expect(await folderTree(legacyHome)).toEqual({
      ".agents/": "",
      ".agents/agent-profile-kit.migrated/": "",
      ".agents/agent-profile-kit.migrated/config.yaml": Buffer.from("schema_version: 1\n").toString("hex"),
      "apkit/": "",
      "apkit/config.json": Buffer.from('{"installs": []}\n').toString("hex"),
    });
    expect(await folderTree(cwd)).toEqual({});
  });

  for (const path of [".", "nested/my workspace"]) {
    test(`init ${path} selects that folder when check runs elsewhere`, async () => {
      const home = await tempDir("relative-home");
      const cwd = await tempDir("relative-cwd");
      const elsewhere = await tempDir("elsewhere");
      const expected = resolve(cwd, path);
      const initialized = folderCli(home, cwd, "init", path, "--json");
      expect([initialized.code, initialized.err]).toEqual([0, ""]);
      expect(JSON.parse(initialized.out).workspace).toBe(expected);
      const checked = folderCli(home, elsewhere, "check", "--json");
      expect([checked.code, checked.err]).toEqual([0, ""]);
      expect(JSON.parse(checked.out)).toMatchObject({ workspace: expected, valid: true });
      expect(JSON.parse(await read(home, "config.json")).workspace).toBe(expected);
    });
  }


  test("init completes empty, unrelated-file, and partial folders with only the contract structure", async () => {
    const home = await tempDir("structure-home");
    const structure = {
      "apkit-workspace.yaml": Buffer.from("schema_version: 1\n").toString("hex"),
      "context/": "", "skills/": "", "profiles/": "",
    };
    for (const state of ["empty", "unrelated", "partial"]) {
      const root = await tempDir(`structure-${state}`);
      if (state !== "empty") {
        await writeTree(root, { "notes/nested/readme.txt": "Keep me.\r\n" });
        await writeFile(join(root, "notes", "data.bin"), Buffer.from([0, 255, 13, 10, 128]));
        await mkdir(join(root, "notes", "empty"));
      }
      if (state === "partial") await writeTree(root, { "context/existing.md": "Existing Context.\n" });
      const before = await folderTree(root);
      const result = folderCli(home, home, "init", root, "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      expect(await folderTree(root)).toEqual({ ...structure, ...before });
      expect(JSON.parse(result.out).added.sort()).toEqual(Object.keys(structure).filter((path) => !(path in before)).sort());
      const checked = folderCli(home, home, "check", "--json");
      expect([checked.code, checked.err]).toEqual([0, ""]);
      expect(JSON.parse(checked.out)).toMatchObject({ workspace: root, valid: true });
    }
  });


  test("init preserves every existing entry in valid, incomplete, and invalid folders with unrelated files", async () => {
    const home = await tempDir("preserve-home");
    for (const state of ["valid", "incomplete", "invalid"]) {
      const root = state === "incomplete" ? await tempDir("incomplete") : await makeWorkspace();
      await writeTree(root, {
        "notes/nested/keep.txt": "Unrelated content.\r\n",
        ".hidden": "Keep hidden files too.\n",
      });
      await writeFile(join(root, "notes", "binary"), Buffer.from([255, 0, 254, 10, 13]));
      await mkdir(join(root, "notes", "empty"));
      if (state === "incomplete") await writeTree(root, { "context/existing.md": "Keep Context.\n" });
      if (state === "invalid") {
        await writeTree(root, {
          "apkit-workspace.yaml": "schema_version: 99\n",
          "profiles/broken.yaml": "context: [does-not-exist]\n",
        });
      }
      const before = await folderTree(root);
      const result = folderCli(home, home, "init", root, "--json");
      expect([result.code, result.err]).toEqual([0, ""]);
      const after = await folderTree(root);
      // Exact whole-tree equality catches changes, moves, deletions, and extra additions.
      expect(after).toEqual({
        "apkit-workspace.yaml": Buffer.from("schema_version: 1\n").toString("hex"),
        "context/": "", "skills/": "", "profiles/": "",
        ...before,
      });
      expect(JSON.parse(result.out).added.sort()).toEqual(
        ["apkit-workspace.yaml", "context/", "skills/", "profiles/"].filter((path) => !(path in before)).sort(),
      );
      const checked = folderCli(home, home, "check", "--json");
      expect(checked.code).toBe(state === "invalid" ? 1 : 0);
      expect(JSON.parse(checked.out)).toMatchObject({ workspace: root, valid: state !== "invalid" });
    }
  });

});
