import { describe, expect, test } from "bun:test";
import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentId } from "../src/render.js";
import { detectAgents, executeNotes, NOTE, noteTargets, planNotes, type NoteRecords } from "../src/setup.js";
import { read, tempDir, writeTree } from "./fixtures.js";

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** One setup pass, like the CLI: plan, apply when no open issues, return the new records. */
async function setup(home: string, agents: AgentId[], recorded: NoteRecords, decisions = { yes: true, overwrite: false }, env = {}) {
  const planned = await planNotes(await noteTargets(agents, home, env), recorded);
  const open = planned.issues.filter((i) => (i.kind === "consent" ? !decisions.yes : !decisions.overwrite));
  if (open.length === 0) await executeNotes(planned);
  return { planned, open, records: open.length === 0 ? planned.records : recorded };
}

describe("setup", () => {
  test("detects agents by their user-level folders", async () => {
    const home = await tempDir("home");
    for (const dir of [".claude", ".codex", ".config/opencode", ".pi/agent", ".grok", ".gemini/antigravity"]) {
      await mkdir(join(home, ...dir.split("/")), { recursive: true });
    }
    expect(await detectAgents(home, {})).toEqual(["antigravity", "claude", "codex", "grok", "opencode", "pi"]);
    expect(await detectAgents(await tempDir("empty"), {})).toEqual([]);
  });

  test("writes the note to each agent's verified user-level file, after consent", async () => {
    const home = await tempDir("home");
    const agents: AgentId[] = ["antigravity", "claude", "codex", "grok", "opencode", "pi"];
    const blocked = await setup(home, agents, {}, { yes: false, overwrite: false });
    expect(blocked.open.every((i) => i.kind === "consent")).toBe(true);
    expect(await exists(join(home, ".claude"))).toBe(false);

    const { records } = await setup(home, agents, {});
    for (const path of [
      ".claude/CLAUDE.md",
      ".codex/AGENTS.md",
      ".config/opencode/AGENTS.md",
      ".pi/agent/AGENTS.md",
      ".grok/rules/apkit.md",
      ".gemini/AGENTS.md",
    ]) {
      expect(await read(home, path)).toContain(NOTE);
    }
    const again = await setup(home, agents, records);
    expect(again.planned.ops).toEqual([]);
    expect(again.planned.issues).toEqual([]);
  });

  test("OpenCode uses ~/.claude/CLAUDE.md when it has no AGENTS.md of its own, so that file is never hidden", async () => {
    const home = await tempDir("home");
    await writeTree(home, { ".claude/CLAUDE.md": "# Mine\n" });
    const targets = await noteTargets(["claude", "opencode"], home, {});
    expect(targets).toEqual([{ path: join(home, ".claude", "CLAUDE.md"), agents: ["claude", "opencode"] }]);
    await writeTree(home, { ".config/opencode/AGENTS.md": "# OpenCode\n" });
    expect((await noteTargets(["opencode"], home, {}))[0]?.path).toBe(join(home, ".config", "opencode", "AGENTS.md"));
  });

  test("respects agent override files and home folder variables", async () => {
    const home = await tempDir("home");
    const codexHome = await tempDir("codex-home");
    await writeTree(codexHome, { "AGENTS.override.md": "# Override\n" });
    const [target] = await noteTargets(["codex"], home, { CODEX_HOME: codexHome });
    expect(target?.path).toBe(join(codexHome, "AGENTS.override.md"));
  });

  test("removal restores the user's file exactly and deletes files setup created", async () => {
    const home = await tempDir("home");
    const original = "# My global rules\n\nBe brief.\n";
    await writeTree(home, { ".claude/CLAUDE.md": original });
    const { records } = await setup(home, ["claude", "grok"], {});
    expect(await read(home, ".claude/CLAUDE.md")).toStartWith(`${original}\n<!-- apkit:begin -->`);
    const removed = await setup(home, [], records);
    expect(removed.records).toEqual({});
    expect(await read(home, ".claude/CLAUDE.md")).toBe(original);
    expect(await exists(join(home, ".grok", "rules", "apkit.md"))).toBe(false);
  });

  test("an edited note is kept until --overwrite", async () => {
    const home = await tempDir("home");
    const { records } = await setup(home, ["codex"], {});
    await writeTree(home, { ".codex/AGENTS.md": (await read(home, ".codex/AGENTS.md")).replace("Agent Profile Kit", "APK") });
    const blocked = await setup(home, [], records);
    expect(blocked.open.map((i) => i.kind)).toEqual(["changed"]);
    expect(await read(home, ".codex/AGENTS.md")).toContain("APK");
  });

  test("a symlinked user-level file is written through, never replaced", async () => {
    if (process.platform === "win32") return;
    const home = await tempDir("home");
    const dotfiles = await tempDir("dotfiles");
    await writeTree(dotfiles, { "CLAUDE.md": "# Dotfiles\n" });
    await mkdir(join(home, ".claude"));
    await symlink(join(dotfiles, "CLAUDE.md"), join(home, ".claude", "CLAUDE.md"));
    await setup(home, ["claude"], {});
    expect(await readlink(join(home, ".claude", "CLAUDE.md"))).toBe(join(dotfiles, "CLAUDE.md"));
    expect(await read(dotfiles, "CLAUDE.md")).toContain(NOTE);
  });
});
