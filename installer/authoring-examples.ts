const profile = "example";

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
    id: "example-skill",
    path: "skills/example-skill/SKILL.md",
    contents:
      "---\n" +
      "name: example-skill\n" +
      "description: Summarize a change. Use when asked for a concise change summary.\n" +
      "---\n\n" +
      "# Summarize a change\n\n" +
      "Describe what changed, how it was verified, and any follow-up work.\n",
  },
} as const;
