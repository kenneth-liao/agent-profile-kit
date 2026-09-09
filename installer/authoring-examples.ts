const profile = "example";
const skill = "example-skill";

/** One canonical authoring-example set for CLI guidance and init scaffolding. */
export const AUTHORING_EXAMPLES = {
  profile: {
    id: profile,
    path: `profiles/${profile}.yaml`,
    contents:
      `id: ${profile}\n` +
      "context:\n" +
      "  - example-context\n" +
      "skills: []\n",
  },
  context: {
    id: "example-context",
    path: "context/example-context.md",
    contents:
      "---\n" +
      "id: example-context\n" +
      "dependencies: []\n" +
      "---\n" +
      "Keep project-specific instructions in the project repository.\n",
  },
  skill: {
    id: skill,
    path: `skills/${skill}/SKILL.md`,
    contents:
      "---\n" +
      `name: ${skill}\n` +
      "description: Summarize a change. Use when asked for a concise change summary.\n" +
      "---\n\n" +
      "# Summarize a change\n\n" +
      "Describe what changed, how it was verified, and any follow-up work.\n",
  },
} as const;

/**
 * The canonical scaffold for one newly created Profile, shaped like
 * AUTHORING_EXAMPLES.profile so created and example material share one form.
 */
export function newProfileScaffold(
  id: string,
  contexts: readonly string[],
  skills: readonly string[],
): string {
  // requireArtifactId and the Workspace boundary run before scaffolding, so
  // every name is [a-z0-9-] only and the double-quoted YAML scalars are safe;
  // quoting keeps scalar-looking names (true, 123) strings rather than YAML
  // booleans and numbers (CRAFT-2).
  const field = (label: string, names: readonly string[]): string =>
    names.length === 0
      ? `${label}: []\n`
      : `${label}:\n${names.map((name) => `  - "${name}"\n`).join("")}`;
  return `id: "${id}"\n${field("context", contexts)}${field("skills", skills)}`;
}

/**
 * The canonical scaffold for one newly created Context Module, shaped like
 * AUTHORING_EXAMPLES.context so created and example material share one form.
 */
export function newContextModuleScaffold(id: string): string {
  // requireArtifactId runs before scaffolding, so id is [a-z0-9-] only and the
  // double-quoted YAML scalar is safe; quoting keeps scalar-looking names
  // (true, 123) strings rather than YAML booleans and numbers (CRAFT-2).
  return (
    "---\n" +
    `id: "${id}"\n` +
    "dependencies: []\n" +
    "---\n\n" +
    `# ${id}\n\n` +
    "Describe what this Context Module covers and when a Profile should include it.\n"
  );
}

/**
 * The canonical scaffold for one newly created Skill, shaped like
 * AUTHORING_EXAMPLES.skill so created and example material share one form.
 */
export function newSkillScaffold(id: string): string {
  // requireArtifactId runs before scaffolding, so id is [a-z0-9-] only and the
  // double-quoted YAML scalar is safe; quoting keeps scalar-looking names
  // (true, 123) strings rather than YAML booleans and numbers (CRAFT-2).
  return (
    "---\n" +
    `name: "${id}"\n` +
    "description: Describe what this Skill does and when an agent should use it.\n" +
    "---\n\n" +
    `# ${id}\n\n` +
    "Describe what this Skill does, how to use it, and any follow-up work.\n"
  );
}