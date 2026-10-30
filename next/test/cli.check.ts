import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { COMMAND, GUIDE, HELP } from "../src/guide.js";
import { AGENTS } from "../src/render.js";
import { makeWorkspace, read, tempDir, writeTree } from "./fixtures.js";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
/** Set APKIT_NEXT_CLI to a built bundle (relative to next/, e.g. `dist/cli.js`) to run the journey on Node. */
const BUILT = process.env.APKIT_NEXT_CLI;
const RUNTIME = BUILT ? ["node", resolve(import.meta.dir, "..", BUILT)] : [process.execPath, CLI];

function cli(home: string, cwd: string, ...args: string[]) {
  const [exe, ...pre] = RUNTIME as [string, ...string[]];
  const result = spawnSync(exe, [...pre, ...args], {
    cwd,
    env: { ...process.env, APKIT_HOME: home },
    encoding: "utf8",
  });
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

  test("init creates only the missing Workspace parts and selects it", async () => {
    const home = await tempDir("home");
    const root = await tempDir("new-ws");
    await writeTree(root, { "context/existing.md": "Hi.\n" });
    const result = cli(home, root, "init", root, "--json");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).added).toEqual(["workspace.yaml", "skills/", "profiles/"]);
    expect(cli(home, root, "workspace").out.trim()).not.toBe("No Workspace selected.");
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
});
