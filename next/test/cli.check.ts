import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { COMMAND, GUIDE, HELP } from "../src/guide.js";
import { AGENTS } from "../src/render.js";
import { makeWorkspace, read, SKILL, tempDir, writeTree } from "./fixtures.js";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
/** Set APKIT_NEXT_CLI to a built bundle (relative to next/, e.g. `dist/cli.js`) to run the journey on Node. */
const BUILT = process.env.APKIT_NEXT_CLI;
const RUNTIME = BUILT ? ["node", resolve(import.meta.dir, "..", BUILT)] : [process.execPath, CLI];

/** Runs the CLI with `home` as both the apkit home and the user's home, so nothing real is touched. */
function cli(home: string, cwd: string, ...args: string[]) {
  const [exe, ...pre] = RUNTIME as [string, ...string[]];
  const env: Record<string, string | undefined> = { ...process.env, APKIT_HOME: home, HOME: home, USERPROFILE: home };
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "GROK_HOME"]) delete env[name];
  const result = spawnSync(exe, [...pre, ...args], { cwd, env, encoding: "utf8" });
  return { code: result.status, out: result.stdout, err: result.stderr };
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
    const refused = cli(home, home, "install", "engineering", "--global", "--agents", "claude");
    expect(refused.code).toBe(2);
    expect(refused.err).toContain("installed per project");
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
