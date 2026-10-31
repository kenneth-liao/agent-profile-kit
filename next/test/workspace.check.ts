import { describe, expect, test } from "bun:test";
import { loadWorkspace } from "../src/workspace.js";
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

  test("reports invalid files under each artifact folder", async () => {
    expect(
      await codes({
        "apkit-workspace.yaml": "schema_version: 1\n",
        "context/notes.txt": "x",
        "context/Bad Name.md": "x",
        "context/empty.md": "",
        "skills/README.md": "x",
        "skills/a/SKILL.md": SKILL("same"),
        "skills/b/SKILL.md": SKILL("same"),
        "skills/c/SKILL.md": "---\nname: c\n---\n",
        "profiles/p.yml": "context: []\nskills: []\n",
        "profiles/extra.yaml": "id: extra\ncontext: []\nskills: []\n",
        "profiles/empty.yaml": "context: []\nskills: []\n",
      }),
    ).toEqual([
      "context-module-file-name",
      "duplicate-artifact-name",
      "empty-content",
      "invalid-field",
      "invalid-profile",
      "profile-without-artifacts",
      "stray-context-file",
      "stray-profile-file",
      "stray-skill-file",
    ]);
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
