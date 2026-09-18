import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTHORING_EXAMPLES,
  newContextModuleScaffold,
  newProfileScaffold,
  newSkillScaffold,
} from "../installer/authoring-examples.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { ingestSelectedWorkspace } from "../installer/local-configuration.js";
import { createProfile } from "../installer/create-profile.js";
import { createContextModule } from "../installer/create-context-module.js";
import { parseContextModule, parseProfile } from "../schemas/context-profile.js";
import { parseSkill } from "../schemas/skill.js";

/**
 * One YAML formatting authority for new Workspace files (#514, US-019).
 *
 * The example bytes that init scaffolds and the guides render, and the
 * preflight bytes configure-profile validates against, must be produced by
 * the same writer functions the `apkit new` commands use. Divergence between
 * the two was real: the examples were unquoted (`id: example`) while the
 * created scaffolds were quoted (`id: "example"`). Quoting is load-bearing,
 * not cosmetic: artifact IDs match /^[a-z0-9]+(-[a-z0-9]+)*$/, so `true` and
 * `123` are legal IDs, and unquoted YAML parses them as boolean and number
 * before the canonical schema ever sees them. These tests pin the single
 * authority so a second way to emit scaffold YAML cannot exist.
 */
describe("authoring example/scaffold YAML consistency", () => {
  test("the example Profile bytes are the Profile writer's output", () => {
    expect(AUTHORING_EXAMPLES.profile.contents).toBe(
      newProfileScaffold([AUTHORING_EXAMPLES.context.id], []),
    );
  });

  test("the example Context Module bytes are plain Markdown from the Context writer", () => {
    // A Context Module carries no frontmatter: its ID is its path and its
    // bytes are delivered as written (spec #593 DEC-004/005, #600). The
    // example shares the writer's frontmatter-free shape with a teaching body.
    const contents: string = AUTHORING_EXAMPLES.context.contents;
    expect(contents).not.toContain("---");
    const scaffold = newContextModuleScaffold(AUTHORING_EXAMPLES.context.id);
    expect(contents).toBe(
      scaffold
        .replace(/^\n/, "")
        .replace(
          `# ${AUTHORING_EXAMPLES.context.id}\n\nDescribe what this Context Module covers and when a Profile should include it.\n`,
          "Keep project-specific instructions in the project repository.\n",
        ),
    );
  });

  test("the example Skill frontmatter is the Skill writer's output", () => {
    const scaffold = newSkillScaffold(AUTHORING_EXAMPLES.skill.id);
    const frontmatter = scaffold.slice(0, scaffold.indexOf("---\n", 4) + 4);
    const exampleFrontmatter = AUTHORING_EXAMPLES.skill.contents.slice(
      0,
      AUTHORING_EXAMPLES.skill.contents.indexOf("---\n", 4) + 4,
    );
    // The description is teaching content, not style (US-019/DEC-011), so the
    // example keeps its own value; the emitted style must be identical.
    const withoutDescription = (frontmatter: string): string =>
      frontmatter.replace(/description: .*\n/, "description: <value>\n");
    expect(withoutDescription(exampleFrontmatter)).toBe(withoutDescription(frontmatter));
  });

  test("example bytes round-trip meaning through the canonical schemas", () => {
    const profile = parseProfile(
      AUTHORING_EXAMPLES.profile.contents,
      "profiles/example.yaml",
    );
    expect(profile.id).toBe("example");
    expect(profile.context).toEqual(["example-context"]);
    expect(profile.skills).toEqual([]);

    const contextModule = parseContextModule(
      AUTHORING_EXAMPLES.context.contents,
      "context/example-context.md",
    );
    expect(contextModule.id).toBe("example-context");

    const skill = parseSkill(
      AUTHORING_EXAMPLES.skill.contents,
      "skills/example-skill/SKILL.md",
      join(mkdtempSync(join(tmpdir(), "apkit-yaml-")), "skills/example-skill"),
    );
    expect(skill.id).toBe("example-skill");
    // parseSkill validated the example description (non-empty, ≤ 1024) by not
    // rejecting; the Skill record itself does not retain it.
  });

  test("scalar-looking artifact IDs survive the writer round-trip as strings (CRAFT-2)", () => {
    // `true` and `123` are legal artifact IDs; unquoted YAML would coerce
    // them to boolean and number and the canonical schema would reject or
    // coerce them.
    const scaffold = newProfileScaffold(["123"], []);
    // The scaffold carries no `id` field: a Profile's ID is its file name
    // (spec #593 DEC-014, #598), and the parser derives it from the path.
    expect(scaffold.startsWith('context:\n')).toBe(true);
    expect(scaffold).not.toContain("id");
    const profile = parseProfile(
      scaffold,
      "profiles/true.yaml",
    );
    expect(profile.id).toBe("true");
    expect(profile.context).toEqual(["123"]);

    const contextModule = parseContextModule(
      newContextModuleScaffold("true"),
      "context/true.md",
    );
    expect(contextModule.id).toBe("true");

    const skill = parseSkill(
      newSkillScaffold("true"),
      "skills/true/SKILL.md",
      join(mkdtempSync(join(tmpdir(), "apkit-yaml-")), "skills/true"),
    );
    expect(skill.id).toBe("true");
  });

  test("created scalar-named material re-ingests with preserved meaning", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-yaml-ingest-"));
    try {
      await initializeWorkspace(home, { workspace: "~/apkit-workspace" });
      await createContextModule({ home, name: "123" });
      await createProfile({ home, name: "true", contexts: ["123"], skills: [] });
      const workspace = await ingestSelectedWorkspace(home);
      const profile = workspace.profiles.get("true");
      expect(profile).toBeDefined();
      expect(profile?.context).toEqual(["123"]);
      expect(profile?.skills).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
