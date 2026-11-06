import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkspace, WARNINGS } from "../src/workspace.js";
import { CASE_SENSITIVE_CONTEXT, ERROR_KINDS } from "./validation-cases.js";
import { makeWorkspace, SKILL, tempDir, writeTree } from "./fixtures.js";

const codes = async (files: Record<string, string>) => {
  const root = await tempDir("ws");
  await writeTree(root, files);
  return (await loadWorkspace(root)).violations.map((v) => v.code).sort();
};

describe("loadWorkspace", () => {
  test("reads today's Workspace format", async () => {
    const workspace = await loadWorkspace(await makeWorkspace());
    expect(workspace.violations).toEqual([]);
    expect([...workspace.context.keys()].sort()).toEqual(["communication", "writing/voice"]);
    expect([...workspace.skills.keys()].sort()).toEqual(["review", "summarize"]);
    expect(workspace.skills.get("review")?.disableModelInvocation).toBe(true);
    expect(workspace.skills.get("summarize")?.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.sh"]); // code-point order: uppercase first
    expect(workspace.profiles.get("engineering")).toEqual({
      id: "engineering",
      context: ["communication"],
      skills: ["summarize", "review"],
    });
  });

  test("reports a missing manifest", async () => {
    expect(await codes({ "context/a.md": "x\n" })).toEqual(["workspace-missing-manifest"]);
  });

  test("an empty apkit-workspace.yaml, or schema_version 1, marks a Workspace", async () => {
    expect(await codes({ "apkit-workspace.yaml": "" })).toEqual([]);
    expect(await codes({ "apkit-workspace.yaml": "# my Workspace\n" })).toEqual([]);
    expect(await codes({ "apkit-workspace.yaml": "schema_version: 1\n" })).toEqual([]);
  });

  test("an unsupported schema_version names the need for a newer apkit", async () => {
    const root = await tempDir("ws");
    await writeTree(root, { "apkit-workspace.yaml": "schema_version: 2\n" });
    const [violation, ...rest] = (await loadWorkspace(root)).violations;
    expect(rest).toEqual([]);
    expect(violation?.code).toBe("workspace-unsupported-version");
    expect(violation?.message).toContain("schema_version 2");
    expect(violation?.message).toContain("newer apkit");
    expect(violation?.message).toContain("reads schema_version 1");
  });

  test("a schema_version that is not a version is an error", async () => {
    for (const value of ['"1"', "1.5", "0", "-1", "abc", "[1]"]) {
      expect(await codes({ "apkit-workspace.yaml": `schema_version: ${value}\n` })).toEqual(["workspace-manifest"]);
    }
    expect(await codes({ "apkit-workspace.yaml": "- a list\n" })).toEqual(["workspace-manifest"]);
    expect(await codes({ "apkit-workspace.yaml": "a: [\n" })).toEqual(["workspace-manifest"]);
  });

  test("a folder with only workspace.yaml names the rename", async () => {
    const root = await tempDir("ws");
    await writeTree(root, { "workspace.yaml": "schema_version: 1\n" });
    const violations = (await loadWorkspace(root)).violations;
    expect(violations.map((v) => v.code)).toEqual(["workspace-old-manifest"]);
    expect(violations[0]?.message).toContain("Rename workspace.yaml to apkit-workspace.yaml");
  });

  test("reports references to missing material", async () => {
    expect(
      await codes({
        "apkit-workspace.yaml": "schema_version: 1\n",
        "profiles/p.yaml": "context:\n  - nope\nskills:\n  - gone\n",
      }),
    ).toEqual(["missing-context-reference", "missing-skill-reference"]);
  });

  test("a skipped file is a warning, not an error", async () => {
    const root = await tempDir("ws");
    await writeTree(root, {
      "apkit-workspace.yaml": "schema_version: 1\n",
      "context/notes.txt": "x",
      "context/empty.md": "",
      "skills/README.md": "x",
      "skills/a/SKILL.md": SKILL("a"),
      "profiles/notes.txt": "x",
      "profiles/team/nested.yaml": "skills: [a]\n",
      "profiles/empty.yaml": "context: []\nskills: []\n",
    });
    const workspace = await loadWorkspace(root);
    expect(workspace.violations).toEqual([]);
    expect(workspace.warnings.map((w) => [w.code, w.path])).toEqual([
      ["empty-content", "context/empty.md"],
      ["stray-context-file", "context/notes.txt"],
      ["stray-skill-file", "skills/README.md"],
      ["profile-without-artifacts", "profiles/empty.yaml"],
      ["stray-profile-file", "profiles/notes.txt"],
      ["profile-in-subfolder", "profiles/team/nested.yaml"],
    ]);
    // An empty Profile is not wrong: installing it installs nothing.
    expect(workspace.profiles.get("empty")).toEqual({ id: "empty", context: [], skills: [] });
    expect(workspace.profiles.has("nested")).toBe(false);
  });

  test("a symlink outside a Skill package is a warning; inside one it is package content", async () => {
    const root = await tempDir("ws");
    const outside = await tempDir("outside");
    await writeTree(outside, { "linked/SKILL.md": SKILL("linked"), "note.md": "Shared.\n" });
    await writeTree(root, { "apkit-workspace.yaml": "", "skills/a/SKILL.md": SKILL("a") });
    await mkdir(join(root, "context"));
    // Junctions need no privilege on Windows; elsewhere they are plain folder symlinks.
    await symlink(join(outside, "linked"), join(root, "skills", "linked"), "junction");
    await symlink(join(outside, "linked"), join(root, "context", "shared"), "junction");
    await symlink(join(outside, "linked"), join(root, "skills", "a", "extra"), "junction");
    const workspace = await loadWorkspace(root);
    expect(workspace.violations).toEqual([]);
    expect(workspace.warnings.map((w) => [w.code, w.path])).toEqual([
      ["symlink", "context/shared"],
      ["symlink", "skills/linked"],
    ]);
    expect([...workspace.skills.keys()]).toEqual(["a"]);
    expect(workspace.skills.get("a")?.files.map((f) => f.path)).toEqual(["SKILL.md", "extra/SKILL.md"]);
  });

  test("a linked context, skills, or profiles folder is a skipped symlink like any other", async () => {
    const outside = await tempDir("outside");
    await writeTree(outside, {
      "context/stolen.md": "Not from this Workspace.\n",
      "skills/stolen/SKILL.md": SKILL("stolen"),
      "profiles/stolen.yaml": "context: []\nskills: []\n",
    });
    const root = await tempDir("ws");
    await writeTree(root, { "apkit-workspace.yaml": "" });
    for (const part of ["context", "skills", "profiles"]) await symlink(join(outside, part), join(root, part), "junction");
    const workspace = await loadWorkspace(root);
    expect(workspace.violations).toEqual([]);
    expect(workspace.warnings.map((w) => [w.code, w.path])).toEqual([
      ["symlink", "context"],
      ["symlink", "skills"],
      ["symlink", "profiles"],
    ]);
    expect([workspace.context.size, workspace.skills.size, workspace.profiles.size]).toEqual([0, 0, 0]);
  });

  test("frontmatter closes only on a whole `---` line", async () => {
    expect(
      await codes({
        "apkit-workspace.yaml": "",
        "skills/bad/SKILL.md": "---\nname: bad\ndescription: Example\n---oops\nBody\n",
        "skills/crlf/SKILL.md": "---\r\nname: crlf\r\ndescription: Example\r\n---\r\nBody\r\n",
        "skills/bare/SKILL.md": "---\nname: bare\ndescription: Example\n---",
      }),
    ).toEqual(["invalid-frontmatter"]);
  });

  test("Context frontmatter that YAML cannot convert is still opaque Context", async () => {
    const root = await tempDir("ws");
    await writeTree(root, {
      "apkit-workspace.yaml": "",
      "context/alias.md": "---\nx: *missing\n---\nOrdinary Context.\n",
      "skills/alias/SKILL.md": "---\nname: alias\ndescription: *missing\n---\n",
    });
    const workspace = await loadWorkspace(root);
    expect(workspace.context.get("alias")?.text).toBe("---\nx: *missing\n---\nOrdinary Context.\n");
    expect(workspace.violations.map((v) => [v.code, v.path])).toEqual([["invalid-frontmatter", "skills/alias/SKILL.md"]]);
  });

  test("a broken link or a link loop inside a Skill package is an error, not a crash", async () => {
    const root = await tempDir("ws");
    const outside = await tempDir("outside");
    await writeTree(outside, { "shared/notes.md": "Shared.\n" });
    await writeTree(root, {
      "apkit-workspace.yaml": "",
      "skills/dangling/SKILL.md": SKILL("dangling"),
      "skills/loop/SKILL.md": SKILL("loop"),
      "skills/fine/SKILL.md": SKILL("fine"),
    });
    await symlink(join(outside, "missing"), join(root, "skills", "dangling", "gone"), "junction");
    await symlink(join(root, "skills", "loop"), join(root, "skills", "loop", "again"), "junction");
    await symlink(join(outside, "shared"), join(root, "skills", "fine", "shared"), "junction");
    const workspace = await loadWorkspace(root);
    expect(workspace.violations.map((v) => [v.code, v.path])).toEqual([
      ["unreadable-skill-file", "skills/dangling/gone"],
      ["unreadable-skill-file", "skills/loop/again"],
    ]);
    expect([...workspace.skills.keys()]).toEqual(["fine"]);
    expect(workspace.skills.get("fine")?.files.map((f) => f.path)).toEqual(["SKILL.md", "shared/notes.md"]);
  });

  test("a leftover sidecar or the retired model-invocation key is ordinary package content", async () => {
    const root = await tempDir("ws");
    await writeTree(root, {
      "apkit-workspace.yaml": "",
      "skills/old/SKILL.md": SKILL("old", "metadata:\n  agent-profile-kit:\n    model-invocation: explicit\n"),
      "skills/old/agent-profile-kit.yaml": "dependencies: []\n",
    });
    const workspace = await loadWorkspace(root);
    expect([...workspace.violations, ...workspace.warnings]).toEqual([]);
    expect(workspace.skills.get("old")?.files.map((f) => f.path)).toEqual(["SKILL.md", "agent-profile-kit.yaml"]);
  });

  for (const [code, { prevents, files, paths, fix, links = {} }] of Object.entries(ERROR_KINDS)) {
    test.skipIf(code === "context-id-case-collision" && !CASE_SENSITIVE_CONTEXT)(`${code} is an error: it prevents ${prevents}`, async () => {
      const root = await tempDir("ws");
      await writeTree(root, files);
      for (const [link, to] of Object.entries(links)) {
        await symlink(join(root, ...to.split("/")), join(root, ...link.split("/")), "junction");
      }
      const found = (await loadWorkspace(root)).violations;
      expect(found.map((v) => [v.code, v.path])).toEqual(paths.map((path) => [code, path]));
      for (const violation of found) expect(violation.message).toContain(fix);
    });
  }

  test("every code the validator reports is a documented error kind or a warning", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "workspace.ts"), "utf8");
    const emitted = [...source.matchAll(/add\(\s*"([a-z-]+)"/g)].map((match) => match[1] as string);
    expect(emitted.length).toBeGreaterThan(10);
    const undocumented = [...new Set(emitted)].filter((code) => !(code in ERROR_KINDS) && !WARNINGS.has(code));
    expect(undocumented).toEqual([]);
    expect([...WARNINGS].filter((code) => code in ERROR_KINDS)).toEqual([]);
  });

  test("any .md name is a Context Module, and its ID is its path without .md", async () => {
    const root = await tempDir("ws");
    await writeTree(root, {
      "apkit-workspace.yaml": "",
      "context/CLAUDE.md": "# Claude\n",
      "context/AGENTS.md": "# Agents\n",
      "context/My Notes.md": "Notes.\n",
      "context/Team Docs/Read Me.md": "Read me.\n",
    });
    const workspace = await loadWorkspace(root);
    expect(workspace.violations).toEqual([]);
    expect([...workspace.context.keys()].sort()).toEqual(["AGENTS", "CLAUDE", "My Notes", "Team Docs/Read Me"]);
  });

  test("two Context IDs that differ only in case are an error", async () => {
    const root = await tempDir("ws");
    await writeTree(root, { "apkit-workspace.yaml": "", "context/Style.md": "Upper.\n", "context/style.md": "Lower.\n" });
    const workspace = await loadWorkspace(root);
    if ((await readdir(join(root, "context"))).length === 2) {
      // A case-sensitive file system keeps both files: the IDs are ambiguous.
      expect(workspace.violations.map((v) => [v.code, v.path])).toEqual([
        ["context-id-case-collision", "context/Style.md"],
        ["context-id-case-collision", "context/style.md"],
      ]);
      expect(workspace.context.size).toBe(0);
    } else {
      // A case-insensitive file system keeps one file, so no ambiguous pair can exist.
      expect(workspace.violations).toEqual([]);
      expect(workspace.context.size).toBe(1);
    }
  });

  test("a Profile named twice by .yaml and .yml is ambiguous", async () => {
    expect(
      await codes({
        "apkit-workspace.yaml": "schema_version: 1\n",
        "skills/a/SKILL.md": SKILL("a"),
        "profiles/x.yaml": "skills: [a]\n",
        "profiles/x.yml": "skills: all\n",
      }),
    ).toEqual(["duplicate-profile"]);
  });

  test("ignores hidden files", async () => {
    expect(
      await codes({
        "apkit-workspace.yaml": "schema_version: 1\n",
        "context/.DS_Store": "x",
        "profiles/.notes": "x",
        "skills/.git/config": "x",
      }),
    ).toEqual([]);
  });
});
