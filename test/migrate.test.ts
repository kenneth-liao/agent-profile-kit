import { describe, expect, test } from "bun:test";
import { chmod, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hash } from "../src/install.js";
import { inspectOldOutput, oldBlockEntries, readOldState, rewriteOldExclude, takenOver, type OldOutput } from "../src/migrate.js";
import { materializeMigration } from "./migration.js";
import { tempDir, writeTree } from "./fixtures.js";

const BEGIN = "# BEGIN Agent Profile Kit generated paths";
const END = "# END Agent Profile Kit generated paths";

describe("old state", () => {
  test("reads the Workspace and each receipt that 0.238.0 wrote", async () => {
    const fixture = await materializeMigration();
    const state = await readOldState(fixture.home);
    expect(state?.workspace).toBe(fixture.workspace);
    expect(state?.receipts).toHaveLength(1);
    const receipt = state!.receipts[0]!;
    expect(receipt.project).toBe(fixture.project);
    expect(receipt.profile).toBe("engineering");
    expect(receipt.agents).toEqual(["antigravity", "claude", "codex", "grok", "opencode", "pi"]);
    expect(receipt.retired).toBe(false);
    expect(receipt.outputs.map((o) => o.path)).toContain(".codex/hooks.json");
  });

  test("no old state is null", async () => {
    expect(await readOldState(await tempDir("old-none"))).toBeNull();
  });

  test("a newer state schema is refused", async () => {
    const home = await tempDir("old-newer");
    await writeTree(home, {
      ".agents/agent-profile-kit/config.yaml": "schema_version: 2\nworkspace: /w\nbindings: []\n",
      ".agents/agent-profile-kit/state/manifest.json": JSON.stringify({ schema_version: 10, receipts: [] }),
    });
    await expect(readOldState(home)).rejects.toThrow(/newer apkit/);
  });

  test("an output path that leaves the Project is refused", async () => {
    const home = await tempDir("old-escape");
    const receipt = {
      installation_id: "x",
      lifetime: "ordinary",
      project: "/p",
      profile_id: "engineering",
      desired_input_digest: `sha256:${"0".repeat(64)}`,
      hosts: { claude: { adapter_version: "a", capability_contract: "b" } },
      outputs: [{ path: "../outside", type: "file", mode: 420, hash: `sha256:${"0".repeat(64)}` }],
    };
    await writeTree(home, {
      ".agents/agent-profile-kit/config.yaml": "schema_version: 2\nworkspace: /w\nbindings: []\n",
      ".agents/agent-profile-kit/state/manifest.json": JSON.stringify({ schema_version: 9, receipts: [receipt], removed_temporary_installation_ids: [] }),
    });
    await expect(readOldState(home)).rejects.toThrow(/not old apkit state this version understands/);
  });
});

describe("old output matching", () => {
  async function outputs() {
    const fixture = await materializeMigration();
    const state = await readOldState(fixture.home);
    const byPath = new Map(state!.receipts[0]!.outputs.map((o) => [o.path, o]));
    return { fixture, get: (path: string) => byPath.get(path) as OldOutput };
  }

  test("every output 0.238.0 wrote matches its receipt", async () => {
    const fixture = await materializeMigration();
    const state = await readOldState(fixture.home);
    for (const output of state!.receipts[0]!.outputs) {
      expect({ path: output.path, result: (await inspectOldOutput(fixture.project, output)).result }).toEqual({ path: output.path, result: "unchanged" });
    }
  });

  test("an unchanged directory lists each file it holds", async () => {
    const { fixture, get } = await outputs();
    const found = await inspectOldOutput(fixture.project, get(".claude/skills/review-pr"));
    expect(Object.keys(found.files ?? {}).sort()).toEqual([".claude/skills/review-pr/SKILL.md", ".claude/skills/review-pr/references/checklist.md"]);
  });

  test("a changed byte, an extra member, or a symlink member is a change", async () => {
    const { fixture, get } = await outputs();
    await writeFile(join(fixture.project, ".codex", "hooks.json"), "{}\n");
    expect((await inspectOldOutput(fixture.project, get(".codex/hooks.json"))).result).toBe("changed");
    await writeFile(join(fixture.project, ".claude", "skills", "summarize", "mine.md"), "mine\n");
    expect((await inspectOldOutput(fixture.project, get(".claude/skills/summarize"))).result).toBe("changed");
    await symlink(join(fixture.project, "README.md"), join(fixture.project, ".grok", "skills", "summarize", "link.md"));
    expect((await inspectOldOutput(fixture.project, get(".grok/skills/summarize"))).result).toBe("changed");
  });

  test.skipIf(process.platform === "win32")("a changed mode is a change", async () => {
    const { fixture, get } = await outputs();
    await chmod(join(fixture.project, ".pi", "APPEND_SYSTEM.md"), 0o600);
    expect((await inspectOldOutput(fixture.project, get(".pi/APPEND_SYSTEM.md"))).result).toBe("changed");
  });

  test("a deleted output is missing, and a file where a folder was is a change", async () => {
    const { fixture, get } = await outputs();
    await rm(join(fixture.project, ".opencode", "opencode.jsonc"));
    expect((await inspectOldOutput(fixture.project, get(".opencode/opencode.jsonc"))).result).toBe("missing");
    await rm(join(fixture.project, ".agents", "skills", "summarize"), { recursive: true });
    await writeFile(join(fixture.project, ".agents", "skills", "summarize"), "x");
    expect((await inspectOldOutput(fixture.project, get(".agents/skills/summarize"))).result).toBe("changed");
  });
});

describe("old outputs this engine took over", () => {
  test("an old output whose files this engine's manifest owns, unchanged, is taken over; one more file is not", async () => {
    const fixture = await materializeMigration();
    const state = await readOldState(fixture.home);
    const output = state!.receipts[0]!.outputs.find((o) => o.path === ".claude/skills/review-pr")!;
    const files = (await inspectOldOutput(fixture.project, output)).files!;
    await writeFile(join(fixture.project, ".claude", "skills", "review-pr", "SKILL.md"), "new engine copy\n");
    const owned = { ...files, ".claude/skills/review-pr/SKILL.md": hash("new engine copy\n") };
    expect((await inspectOldOutput(fixture.project, output)).result).toBe("changed");
    expect(await takenOver(fixture.project, output, owned)).toBe(true);
    expect(await takenOver(fixture.project, output, files)).toBe(false);
    await writeFile(join(fixture.project, ".claude", "skills", "review-pr", "mine.md"), "mine\n");
    expect(await takenOver(fixture.project, output, owned)).toBe(false);
  });
});

describe("old exclusion block", () => {
  const rewrite = (text: string, entries: string[] = []) => rewriteOldExclude(Buffer.from(text), entries, "exclude").toString("utf8");

  test("removing the block restores the rest byte for byte", () => {
    expect(rewrite(`# mine\n*.log\n${BEGIN}\n/.codex/hooks.json\n${END}\n`)).toBe("# mine\n*.log\n");
    expect(rewrite(`# mine\n${BEGIN}\n/a\n${END}\n/after\n`)).toBe("# mine\n/after\n");
    expect(rewrite(`${BEGIN}\n/a\n${END}\n`)).toBe("");
  });

  test("the separator it added to a file without a final newline is removed with it", () => {
    expect(rewrite(`# mine\n# Agent Profile Kit generated paths separator\n${BEGIN} (separator owned)\n/a\n${END}\n`)).toBe("# mine");
  });

  test("CRLF lines keep CRLF", () => {
    expect(rewrite(`# mine\r\n${BEGIN}\r\n/a\r\n${END}\r\n`)).toBe("# mine\r\n");
    expect(rewrite(`# mine\r\n${BEGIN}\r\n/a\r\n/b\r\n${END}\r\n`, ["/b"])).toBe(`# mine\r\n${BEGIN}\r\n/b\r\n${END}\r\n`);
  });

  test("entries of another old Project stay in the block", () => {
    expect(rewrite(`# mine\n${BEGIN}\n/a\n/sub/b\n${END}\n`, ["/sub/b"])).toBe(`# mine\n${BEGIN}\n/sub/b\n${END}\n`);
  });

  test("a file without the block is unchanged", () => {
    expect(rewrite("# mine\n/x\n")).toBe("# mine\n/x\n");
  });

  test("the entries the block holds now", async () => {
    const committed = await readFile(join(import.meta.dir, "migration", "0.238.0", "git-info-exclude"));
    expect(oldBlockEntries(committed)).toHaveLength(15);
    expect(oldBlockEntries(committed)).toContain("/.codex/hooks.json");
    expect(oldBlockEntries(Buffer.from(`# mine\r\n${BEGIN} (separator owned)\r\n/a\r\n/sub/é\r\n${END}\r\n`))).toEqual(["/a", "/sub/é"]);
    expect(oldBlockEntries(Buffer.from("# mine\n/x\n"))).toEqual([]);
  });

  test("a malformed block is refused", () => {
    expect(() => rewrite(`${BEGIN}\n/a\n`)).toThrow(/malformed/);
    expect(() => rewrite(`${BEGIN}\n${END}\n${BEGIN}\n${END}\n`)).toThrow(/malformed/);
  });
});

test("the fixture helper keeps the user's own folders", async () => {
  const fixture = await materializeMigration();
  expect(await readFile(join(fixture.project, ".claude", "settings.json"), "utf8")).toContain("permissions");
});
