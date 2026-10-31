import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { COMMAND, GUIDE, HELP } from "../src/guide.js";
import { hash } from "../src/install.js";
import { AGENTS } from "../src/render.js";
import { loadWorkspace, type Violation } from "../src/workspace.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { makeWorkspace, read, SKILL, snapshot, tempDir, writeTree } from "./fixtures.js";

// Journeys run several commands, each a new process: on Node one took 7.4 s, past Bun's 5 s default.
// A bounded budget for every journey here, wherever the suite runs (CI included).
setDefaultTimeout(30_000);

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
/** Set APKIT_NEXT_CLI to a built bundle (relative to next/, e.g. `dist/cli.js`) to run the journey on Node. */
const BUILT = process.env.APKIT_NEXT_CLI;
const RUNTIME = BUILT ? ["node", resolve(import.meta.dir, "..", BUILT)] : [process.execPath, CLI];

/** Runs the CLI with `home` as both the apkit home and the user's home, so nothing real is touched. */
function cli(home: string, cwd: string, ...args: string[]) {
  return cliWithEnv({}, home, cwd, ...args);
}

/** Like `cli`, with agent folder variables (such as `CLAUDE_CONFIG_DIR`) set in `extra`. */
function cliWithEnv(extra: Record<string, string>, home: string, cwd: string, ...args: string[]) {
  const [exe, ...pre] = RUNTIME as [string, ...string[]];
  const env: Record<string, string | undefined> = { ...process.env, APKIT_HOME: home, HOME: home, USERPROFILE: home };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "GROK_HOME"]) delete env[name];
  Object.assign(env, extra);
  const result = spawnSync(exe, [...pre, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Like `cli`, but returns at once, so several runs can overlap. */
function cliAsync(home: string, cwd: string, ...args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const [exe, ...pre] = RUNTIME as [string, ...string[]];
  const env: Record<string, string | undefined> = { ...process.env, APKIT_HOME: home, HOME: home, USERPROFILE: home };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "GROK_HOME"]) delete env[name];
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

/** Every file under home (POSIX path → exact bytes), without apkit's own config files (APKIT_HOME is home here). */
async function homeSnapshot(home: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(home, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(home, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (path === "config.json" || path === "global.json") continue;
    files[path] = (await readFile(join(home, path))).toString("latin1");
  }
  return files;
}

describe("apkit-next CLI", () => {
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
    expect(JSON.parse(stale.out).map((o: { result: string }) => o.result)).toEqual(["updated", "updated"]);
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
    expect(cli(home, home, "workspace").out.trim()).toBe("No Workspace selected.");
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
    const skipped = ["context/notes.txt", "skills/README.md", "profiles/notes.txt", "profiles/team/nested.yaml", "skills/linked"];

    const check = cli(home, home, "check", "--workspace", ws);
    expect(check.code).toBe(0);
    expect(check.out).toContain("is valid");
    for (const path of [...skipped, "profiles/draft.yaml"]) expect(check.out).toContain(path);
    const json = JSON.parse(cli(home, home, "check", "--workspace", ws, "--json").out);
    expect(json.valid).toBe(true);
    expect(json.violations).toEqual([]);
    expect(json.warnings.map((w: { path: string }) => w.path).sort()).toEqual([...skipped, "profiles/draft.yaml"].sort());

    const folder = await tempDir("f");
    const install = cli(home, folder, "install", "old", "--workspace", ws, "--agents", "claude", "--yes");
    expect(install.code).toBe(0);
    for (const path of skipped) expect(install.out).toContain(path);
    expect(await read(folder, ".claude/skills/old/agent-profile-kit.yaml")).toBe("dependencies: []\n");
    const again = JSON.parse(cli(home, folder, "install", "old", "--workspace", ws, "--agents", "claude", "--json").out);
    expect(again.result).toBe("unchanged");
    expect(again.warnings.length).toBe(skipped.length + 1);

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

    // Several error kinds at once, and one warning.
    await writeTree(ws, {
      "profiles/engineering.yaml": "context:\n  - communication\nskills:\n  - summarize\n  - gone\n",
      "profiles/broken.yaml": "skills: [\n",
      "profiles/Bad_Name.yaml": "skills: []\n",
      "skills/group/review/SKILL.md": "no frontmatter\n",
      "skills/README.md": "x",
    });
    const check = JSON.parse(cli(home, one, "check", "--json").out);
    expect(check.violations.length).toBeGreaterThanOrEqual(4);

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
      "profiles/engineering.yaml": "context:\n  - communication\nskills:\n  - summarize\n",
      "profiles/broken.yaml": "skills: []\n",
      "skills/group/review/SKILL.md": SKILL("review"),
    });
    await rm(join(ws, "profiles", "Bad_Name.yaml"));
    expect(cli(home, one, "update", "--all").code).toBe(0);
    expect(cli(home, one, "install", "writing", "--agents", "claude", "--yes").code).toBe(0);
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
    expect(JSON.parse(cli(home, repo, "status", "--all", "--json").out)).toEqual([]);
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
    expect(cli(home, home, "install", "skills-only", "--global", "--agents", "claude,codex,grok,antigravity").code).toBe(0);
    for (const path of [".claude/skills", ".agents/skills", ".grok/skills", ".gemini/config/skills"]) {
      expect(await read(home, `${path}/summarize/SKILL.md`)).toContain("name: summarize");
    }
    await writeTree(ws, { "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: v2\n---\n" });
    expect(cli(home, home, "update", "--all").code).toBe(0);
    expect(await read(home, ".gemini/config/skills/summarize/SKILL.md")).toContain("v2");
    expect(cli(home, home, "remove", "--global").code).toBe(0);
    const left = await readdir(home);
    for (const dir of [".claude", ".agents", ".grok", ".gemini"]) expect(left).not.toContain(dir);
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
    expect(JSON.parse(cli(home, home, "status", "--all", "--json").out)[0].result).toBe("updated");
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

  for (const order of [["setup", "global"], ["global", "setup"]]) {
    test(`setup and a global install share a file, and removal (${order.join(" first, then ")}) restores it`, async () => {
      const home = await tempDir("home");
      const ws = await makeWorkspace();
      cli(home, home, "workspace", ws);
      await writeTree(home, { ".codex/config.toml": "" });
      const before = await homeSnapshot(home);
      const install = { setup: ["setup", "--yes"], global: ["install", "engineering", "--global", "--agents", "codex", "--yes"] };
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
    const status = JSON.parse(cli(home, home, "status", "--all", "--json").out);
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
    expect(JSON.parse(cli(home, both, "status", "--json").out)[0].overlap).toEqual(["communication"]);

    expect(cli(home, other, "status").out).not.toContain("also installed at user level");
    expect(JSON.parse(cli(home, other, "status", "--json").out)[0].overlap).toEqual([]);
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
      expect(await snapshot(newer)).toEqual(before);
      expect(await read(home, "config.json")).toBe(config);
    }

    // --all reports the newer folder and still processes the others.
    const status = JSON.parse(cli(home, current, "status", "--all", "--json").out);
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
    expect(skills).toContain("Codex and Pi load this folder's Skills only after you trust the folder.");
    const everything = await install("skills-only", "grok,antigravity");
    expect(everything).toContain("Antigravity and Grok load nothing from this folder until you trust it.");
    // Grok holds back Context too; Codex loads Context without trust, so a Profile with no Skills needs no line for it.
    expect(await install("writing", "codex,grok")).toEndWith("\nGrok loads nothing from this folder until you trust it.\n");
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
    const commands = [...HELP.matchAll(new RegExp(`^  ${COMMAND} (\\w+)`, "gm"))].map((m) => m[1] as string);
    expect(commands.length).toBeGreaterThan(5);
    for (const command of commands) {
      if (command !== "guide") expect(GUIDE).toContain(`${COMMAND} ${command}`);
      expect(cli(home, home, command, "--json").err).not.toContain("Unknown command");
    }
    for (const flag of [...HELP.matchAll(/^  (--[a-z]+)/gm)].map((m) => m[1] as string)) {
      if (flag !== "--workspace") expect(GUIDE).toContain(flag);
    }
    for (const agent of Object.keys(AGENTS)) expect(GUIDE).toContain(agent);
  });

  test("`contract` prints the Workspace contract byte for byte, without a lock or a Workspace", async () => {
    const home = await tempDir("home");
    expect(HELP).toMatch(new RegExp(`^  ${COMMAND} contract `, "m"));
    const printed = cli(home, home, "contract");
    expect([printed.code, printed.err]).toEqual([0, ""]);
    expect(printed.out).toBe(await readFile(join(import.meta.dir, "..", "docs", "workspace-contract.md"), "utf8"));
    // No lock, no config: apkit wrote nothing (the runtime may add its own cache folder).
    expect((await readdir(home)).filter((name) => name.startsWith("lock") || name.endsWith(".json"))).toEqual([]);
  });

  test("failed validation names how to read the contract", async () => {
    const home = await tempDir("home");
    const ws = await tempDir("ws");
    const folder = await tempDir("f");
    await writeTree(ws, { "apkit-workspace.yaml": "", "profiles/p.yaml": "skills: [gone]\n" });
    const pointer = `Read the Workspace contract: \`${COMMAND} contract\``;
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
    const status = JSON.parse(cli(home, project, "status", "--json").out)[0];
    expect([status.profile, status.agents, status.result]).toEqual(["twin", ["pi"], "unchanged"]);

    // An install the registry lost is registered again by reinstalling it.
    await writeFile(join(home, "config.json"), JSON.stringify({ schema: 1, workspace: ws, installs: [] }));
    expect(cli(home, project, "install", "twin", "--agents", "pi").code).toBe(0);
    expect(JSON.parse(cli(home, project, "status", "--all", "--json").out).map((o: { folder: string }) => o.folder)).toEqual([project]);
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
    expect(JSON.parse(cli(home, project, "status", "--json").out)[0].result).toBe("unchanged");
    expect(cli(home, project, "update").code).toBe(0);
    expect(cli(home, project, "remove").code).toBe(0);
    expect(await read(project, "AGENTS.md")).toBe("# Mine\n");

    await writeTree(home, { ".codex/AGENTS.md": "# Mine\n" });
    expect(cli(home, home, "install", "markers", "--global", "--agents", "codex", "--yes").code).toBe(0);
    expect(JSON.parse(cli(home, home, "status", "--all", "--json").out)[0].result).toBe("unchanged");
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
      const status = JSON.parse(cli(home, folders[0]!, "status", "--all", "--json").out) as { folder: string; result: string }[];
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
    expect(JSON.parse(cli(home, folder, "status", "--json").out)[0].result).toBe("unchanged");
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
    const status = JSON.parse(cli(home, folders[0]!, "status", "--all", "--json").out) as { folder: string; result: string }[];
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

/** The Workspaces kept from earlier releases that changed the contract (test/retained/README.md). */
const RETAINED = {
  "0.204.0 source": join(import.meta.dir, "..", "..", "test", "support", "fixtures", "compat-0.204.0", "workspace-source"),
  "0.204.0 realistic": join(import.meta.dir, "..", "..", "test", "support", "fixtures", "compat-0.204.0", "workspace-realistic"),
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
