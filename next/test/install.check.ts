import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmod, lstat, readdir, readlink, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { findRepository, isTracked } from "../src/gitindex.js";
import { execute, plan, readManifest, unresolved, type Decisions } from "../src/install.js";
import { render, type AgentId } from "../src/render.js";
import { loadWorkspace } from "../src/workspace.js";
import { makeWorkspace, read, tempDir, writeTree } from "./fixtures.js";

async function setup(files: Record<string, string> = {}) {
  const wsRoot = await makeWorkspace();
  const target = await tempDir("target");
  await writeTree(target, files);
  return { wsRoot, target };
}

/** One install/update/remove pass, like the CLI: plan, check decisions, execute. */
async function run(
  wsRoot: string,
  target: string,
  profile: string | null,
  agents: AgentId[],
  decisions: Decisions = {},
) {
  const workspace = await loadWorkspace(wsRoot);
  const desired = profile === null ? null : render(workspace, profile, agents);
  const planned = await plan(target, desired, await readManifest(target));
  const open = unresolved(planned, decisions);
  if (open.length === 0) await execute(planned);
  return { planned, open };
}

const exists = (path: string) => lstat(path).then(() => true, () => false);
const kinds = (r: Awaited<ReturnType<typeof run>>) => r.open.map((i) => `${i.kind}:${i.path}`).sort();

describe("install", () => {
  test("a fresh folder needs consent to create AGENTS.md, and nothing is written without it", async () => {
    const { wsRoot, target } = await setup();
    const blocked = await run(wsRoot, target, "engineering", ["claude", "codex"]);
    expect(kinds(blocked)).toEqual(["consent:AGENTS.md"]);
    expect(await readdir(target)).toEqual([]);
  });

  test("installs Skills at each agent's native path and Context into one AGENTS.md block", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "engineering", ["claude", "codex", "grok"], { yes: true });
    for (const root of [".claude/skills", ".agents/skills", ".grok/skills"]) {
      expect(await read(target, `${root}/summarize/SKILL.md`)).toContain("name: summarize");
    }
    const agentsMd = await read(target, "AGENTS.md");
    expect(agentsMd).toStartWith("<!-- apkit:begin -->\n");
    expect(agentsMd).toContain("<!-- context: communication -->\n# Communication\n\nBe concise.\n");
    expect(agentsMd).toEndWith("<!-- apkit:end -->\n");
    expect(await exists(join(target, "CLAUDE.md"))).toBe(false);
    expect((await readManifest(target))?.agents).toEqual(["claude", "codex", "grok"]);
  });

  test("keeps the executable bit on Skill scripts", async () => {
    if (process.platform === "win32") return;
    const { wsRoot, target } = await setup();
    await chmod(join(wsRoot, "skills/summarize/scripts/run.sh"), 0o755);
    await run(wsRoot, target, "skills-only", ["codex"]);
    expect((await stat(join(target, ".agents/skills/summarize/scripts/run.sh"))).mode & 0o111).not.toBe(0);
  });

  test("a second run changes nothing", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "engineering", ["claude", "codex"], { yes: true });
    const again = await run(wsRoot, target, "engineering", ["claude", "codex"]);
    expect(again.planned.ops).toEqual([]);
    expect(again.planned.issues).toEqual([]);
  });

  test("Workspace edits flow to the folder without any decision", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "engineering", ["codex"], { yes: true });
    await writeTree(wsRoot, {
      "context/communication.md": "# Communication\n\nBe warm.\n",
      "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: New description.\n---\n",
    });
    const update = await run(wsRoot, target, "engineering", ["codex"]);
    expect(update.open).toEqual([]);
    expect(await read(target, "AGENTS.md")).toContain("Be warm.");
    expect(await read(target, ".agents/skills/summarize/SKILL.md")).toContain("New description.");
  });

  test("a hand-edited installed file is kept until --overwrite", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "skills-only", ["codex"]);
    await writeTree(target, { ".agents/skills/summarize/SKILL.md": "my edit\n" });
    await writeTree(wsRoot, { "skills/summarize/SKILL.md": "---\nname: summarize\ndescription: v2\n---\n" });
    const blocked = await run(wsRoot, target, "skills-only", ["codex"]);
    expect(kinds(blocked)).toEqual(["changed:.agents/skills/summarize/SKILL.md"]);
    expect(await read(target, ".agents/skills/summarize/SKILL.md")).toBe("my edit\n");
    await run(wsRoot, target, "skills-only", ["codex"], { overwrite: true });
    expect(await read(target, ".agents/skills/summarize/SKILL.md")).toContain("v2");
  });

  test("a file apkit did not write is never replaced without --overwrite", async () => {
    const { wsRoot, target } = await setup({ ".claude/skills/summarize/SKILL.md": "someone else's skill\n" });
    const blocked = await run(wsRoot, target, "skills-only", ["claude"]);
    expect(kinds(blocked)).toEqual(["unowned:.claude/skills/summarize/SKILL.md"]);
    expect(await read(target, ".claude/skills/summarize/SKILL.md")).toBe("someone else's skill\n");
  });

  test("an identical file already in place is adopted silently", async () => {
    const { wsRoot, target } = await setup();
    await writeTree(target, { ".agents/skills/summarize/SKILL.md": await read(wsRoot, "skills/summarize/SKILL.md") });
    const result = await run(wsRoot, target, "skills-only", ["codex"]);
    expect(result.open).toEqual([]);
  });

  test("Skills-only Profiles never touch AGENTS.md", async () => {
    const { wsRoot, target } = await setup({ "AGENTS.md": "# Mine\n" });
    const result = await run(wsRoot, target, "skills-only", ["claude", "codex"]);
    expect(result.open).toEqual([]);
    expect(await read(target, "AGENTS.md")).toBe("# Mine\n");
  });

  test("a Skill that disables model invocation gets the Codex policy file in the shared path only", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "engineering", ["claude", "codex"], { yes: true });
    expect(await read(target, ".agents/skills/review/agents/openai.yaml")).toContain("allow_implicit_invocation: false");
    expect(await exists(join(target, ".claude/skills/review/agents/openai.yaml"))).toBe(false);
    expect(await read(target, ".claude/skills/review/SKILL.md")).toContain("disable-model-invocation: true");
  });

  test("changing the agents removes the dropped agent's files", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "skills-only", ["claude", "codex"]);
    await run(wsRoot, target, "skills-only", ["codex"]);
    expect(await exists(join(target, ".claude"))).toBe(false);
    expect(await exists(join(target, ".agents/skills/summarize/SKILL.md"))).toBe(true);
  });
});

describe("AGENTS.md and CLAUDE.md", () => {
  const original = "# Project rules\n\nUse tabs.\n";

  test("an existing AGENTS.md gets a marked section after asking, and removal restores it exactly", async () => {
    const { wsRoot, target } = await setup({ "AGENTS.md": original });
    expect(kinds(await run(wsRoot, target, "engineering", ["codex"]))).toEqual(["consent:AGENTS.md"]);
    await run(wsRoot, target, "engineering", ["codex"], { yes: true });
    const installed = await read(target, "AGENTS.md");
    expect(installed).toStartWith(`${original}\n<!-- apkit:begin -->\n`);
    await run(wsRoot, target, null, []);
    expect(await read(target, "AGENTS.md")).toBe(original);
  });

  test("an AGENTS.md apkit created is deleted on removal, along with every installed folder", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "engineering", ["claude", "codex"], { yes: true });
    await run(wsRoot, target, null, []);
    expect(await readdir(target)).toEqual([]);
  });

  test("edits inside the apkit section are kept until --overwrite", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "engineering", ["codex"], { yes: true });
    const text = await read(target, "AGENTS.md");
    await writeTree(target, { "AGENTS.md": text.replace("Be concise.", "Be verbose.") });
    await writeTree(wsRoot, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    expect(kinds(await run(wsRoot, target, "engineering", ["codex"]))).toEqual(["changed:AGENTS.md"]);
    expect(await read(target, "AGENTS.md")).toContain("Be verbose.");
  });

  test("user edits outside the section are kept through updates", async () => {
    const { wsRoot, target } = await setup();
    await run(wsRoot, target, "engineering", ["codex"], { yes: true });
    await writeTree(target, { "AGENTS.md": `${await read(target, "AGENTS.md")}\n## Notes\n\nMine.\n` });
    await writeTree(wsRoot, { "context/communication.md": "# Communication\n\nBe warm.\n" });
    expect((await run(wsRoot, target, "engineering", ["codex"])).open).toEqual([]);
    const text = await read(target, "AGENTS.md");
    expect(text).toContain("Be warm.");
    expect(text).toEndWith("## Notes\n\nMine.\n");
  });

  test("an existing CLAUDE.md gets `@AGENTS.md` for Claude Code, and removal takes it back out", async () => {
    const { wsRoot, target } = await setup({ "CLAUDE.md": original });
    expect(kinds(await run(wsRoot, target, "engineering", ["claude"]))).toEqual(["consent:AGENTS.md", "consent:CLAUDE.md"]);
    await run(wsRoot, target, "engineering", ["claude"], { yes: true });
    expect(await read(target, "CLAUDE.md")).toBe(`${original}\n@AGENTS.md\n`);
    expect(await read(target, "CLAUDE.md")).not.toContain("apkit:begin");
    await run(wsRoot, target, null, []);
    expect(await read(target, "CLAUDE.md")).toBe(original);
    expect(await exists(join(target, "AGENTS.md"))).toBe(false);
  });

  test("CLAUDE.md is left alone when Claude Code is not selected", async () => {
    const { wsRoot, target } = await setup({ "CLAUDE.md": original });
    await run(wsRoot, target, "engineering", ["codex"], { yes: true });
    expect(await read(target, "CLAUDE.md")).toBe(original);
  });

  test("an existing `@AGENTS.md` import is reused and kept on removal", async () => {
    const { wsRoot, target } = await setup({ "CLAUDE.md": "@AGENTS.md\n", "AGENTS.md": original });
    expect(kinds(await run(wsRoot, target, "engineering", ["claude"]))).toEqual(["consent:AGENTS.md"]);
    await run(wsRoot, target, "engineering", ["claude"], { yes: true });
    await run(wsRoot, target, null, []);
    expect(await read(target, "CLAUDE.md")).toBe("@AGENTS.md\n");
    expect(await read(target, "AGENTS.md")).toBe(original);
  });

  test("a symlinked CLAUDE.md -> AGENTS.md is written through, never replaced, and gets no import", async () => {
    if (process.platform === "win32") return;
    const { wsRoot, target } = await setup({ "AGENTS.md": original });
    await symlink("AGENTS.md", join(target, "CLAUDE.md"));
    expect(kinds(await run(wsRoot, target, "engineering", ["claude"]))).toEqual(["consent:AGENTS.md"]);
    await run(wsRoot, target, "engineering", ["claude"], { yes: true });
    expect(await readlink(join(target, "CLAUDE.md"))).toBe("AGENTS.md");
    expect((await read(target, "AGENTS.md")).match(/apkit:begin/g)).toHaveLength(1);
    expect(await read(target, "AGENTS.md")).not.toContain("@AGENTS.md");
  });

  test("CRLF files stay CRLF, and a Git line-ending conversion is not mistaken for an edit", async () => {
    const { wsRoot, target } = await setup({ "AGENTS.md": "# Rules\r\n\r\nUse tabs.\r\n" });
    await run(wsRoot, target, "engineering", ["codex"], { yes: true });
    const text = await read(target, "AGENTS.md");
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    await writeTree(target, { ".agents/skills/summarize/SKILL.md": (await read(target, ".agents/skills/summarize/SKILL.md")).replace(/\n/g, "\r\n") });
    const again = await run(wsRoot, target, "engineering", ["codex"]);
    expect(again.planned.issues).toEqual([]);
  });
});

describe("Git index", () => {
  for (const version of ["2", "3", "4"]) {
    test(`reads tracked paths from an index at version ${version}, from the root and a subfolder`, async () => {
      const repo = await tempDir("repo");
      const git = (...args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      git("init", "-q");
      await writeTree(repo, { "AGENTS.md": "a\n", "docs/a.md": "a\n", "docs/ab.md": "b\n", "docs/sub/CLAUDE.md": "c\n" });
      git("add", "AGENTS.md", "docs/ab.md", "docs/sub/CLAUDE.md");
      if (version === "3") git("add", "--intent-to-add", "docs/a.md");
      git("update-index", "--index-version", version);
      expect(await findRepository(join(repo, "docs", "sub"))).toEqual({ root: repo, gitDir: join(repo, ".git"), commonDir: join(repo, ".git") });
      expect(await isTracked(repo, "AGENTS.md")).toBe(true);
      expect(await isTracked(repo, "CLAUDE.md")).toBe(false);
      expect(await isTracked(join(repo, "docs"), "ab.md")).toBe(true);
      expect(await isTracked(join(repo, "docs"), "a.md")).toBe(version === "3");
      expect(await isTracked(join(repo, "docs", "sub"), "CLAUDE.md")).toBe(true);
    });
  }

  test("a folder outside any repository tracks nothing", async () => {
    const folder = await tempDir("plain");
    await writeTree(folder, { "AGENTS.md": "a\n" });
    expect(await findRepository(folder)).toBeNull();
    expect(await isTracked(folder, "AGENTS.md")).toBe(false);
  });
});
