const profile = "example";
const skill = "example-skill";

/**
 * The single YAML formatting authority for newly created Workspace files
 * (#514, US-019). Every emitted byte for a new Profile, Context Module
 * frontmatter, or Skill frontmatter flows through one of the writers below;
 * the `apkit new` scaffolds, the init example set, and the configure-profile
 * preflight all compose from them, so a second, divergent emitter cannot
 * exist. Scalar values are double-quoted because artifact IDs match
 * /^[a-z0-9]+(-[a-z0-9]+)*$/, making `true` and `123` legal IDs; quoting
 * keeps scalar-looking names strings rather than YAML booleans and numbers
 * (CRAFT-2).
 */

/** Canonical YAML for one whole-file Profile. */
export function newProfileScaffold(
  contexts: readonly string[],
  skills: readonly string[],
): string {
  // requireArtifactId and the Workspace boundary run before scaffolding, so
  // every name is [a-z0-9-] only and the double-quoted YAML scalars are safe.
  // A Profile's ID is its file name (spec #593 DEC-014, #598), so the scaffold
  // carries no `id` field — the parser derives the ID from the written path.
  const field = (label: string, names: readonly string[]): string =>
    names.length === 0
      ? `${label}: []\n`
      : `${label}:\n${names.map((name) => `  - "${name}"\n`).join("")}`;
  return `${field("context", contexts)}${field("skills", skills)}`;
}

/** Canonical frontmatter YAML for one Context Module (the part before the body). */
function contextModuleFrontmatter(id: string): string {
  // requireArtifactId runs before scaffolding, so id is [a-z0-9-] only and the
  // double-quoted YAML scalar is safe; quoting keeps scalar-looking names
  // (true, 123) strings rather than YAML booleans and numbers (CRAFT-2).
  // The scaffold carries no dependency data: Profile lists are the only
  // source of what is installed (spec #593 DEC-006).
  return `---\nid: "${id}"\n---\n`;
}

/**
 * The canonical scaffold for one newly created Context Module, shaped like
 * AUTHORING_EXAMPLES.context so created and example material share one form.
 */
export function newContextModuleScaffold(id: string): string {
  return (
    contextModuleFrontmatter(id) +
    `\n# ${id}\n\n` +
    "Describe what this Context Module covers and when a Profile should include it.\n"
  );
}

/** Canonical frontmatter YAML for one Skill (the part before the body). */
function skillFrontmatter(id: string, description: string): string {
  // requireArtifactId runs before scaffolding, so id is [a-z0-9-] only and the
  // double-quoted YAML scalar is safe; quoting keeps scalar-looking names
  // (true, 123) strings rather than YAML booleans and numbers (CRAFT-2).
  // The description is content, not style: both scaffold and example values
  // are repo-controlled literals, so it stays an unquoted plain scalar.
  return `---\nname: "${id}"\ndescription: ${description}\n---\n`;
}

/**
 * The canonical scaffold for one newly created Skill, shaped like
 * AUTHORING_EXAMPLES.skill so created and example material share one form.
 */
export function newSkillScaffold(id: string): string {
  return (
    skillFrontmatter(id, "Describe what this Skill does and when an agent should use it.") +
    `\n# ${id}\n\n` +
    "Describe what this Skill does, how to use it, and any follow-up work.\n"
  );
}

/**
 * One canonical authoring-example set for CLI guidance and init scaffolding
 * (DEC-011). The YAML bytes derive from the same writers the `apkit new`
 * commands use, so examples cannot drift from created scaffolds; only the
 * teaching bodies differ, because body prose is content, not YAML style.
 */
export const AUTHORING_EXAMPLES = {
  profile: {
    id: profile,
    path: `profiles/${profile}.yaml`,
    contents: newProfileScaffold(["example-context"], []),
  },
  context: {
    id: "example-context",
    path: "context/example-context.md",
    contents:
      contextModuleFrontmatter("example-context") +
      "Keep project-specific instructions in the project repository.\n",
  },
  skill: {
    id: skill,
    path: `skills/${skill}/SKILL.md`,
    contents:
      skillFrontmatter(
        skill,
        "Summarize a change. Use when asked for a concise change summary.",
      ) +
      "\n# Summarize a change\n\n" +
      "Describe what changed, how it was verified, and any follow-up work.\n",
  },
} as const;
