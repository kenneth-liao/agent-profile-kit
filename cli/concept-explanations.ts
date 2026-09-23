/**
 * The one home for brief kit-concept explanations shown at the action that
 * first needs them (US-001, DEC-003). Meanings stay faithful to CONTEXT.md;
 * Skill is deliberately never defined for the Skills-aware newcomer audience.
 * No screen stores seen-terms state: each action explains what it needs even
 * when that repeats across commands.
 */

/** What a Workspace holds, that it serves several Projects, and that setup may add files. */
export const WORKSPACE_EXPLANATION_SENTENCE =
  "Your Workspace is one folder that holds your Profiles, Context, and Skills.";

/** The multi-Project and setup-write facets of a Workspace (US-001). */
export const WORKSPACE_SCOPE_EXPLANATION_SENTENCE =
  "One Workspace can serve several Projects, and setup may add those folders and files.";

/** The Project concept: the working folder that receives installed material. */
export const PROJECT_EXPLANATION_SENTENCE =
  "A Project is one working folder that receives the installed material.";

/**
 * The Profile concept, named so it cannot drift between the initialization
 * receipt and the interactive Profile choices. Names Context and Skills as
 * selection categories without defining either (US-001).
 */
export const PROFILE_EXPLANATION_SENTENCE =
  "A Profile is a named selection of Context and Skills suited to a kind of work and reusable across projects.";

/**
 * The Context concept (US-001). Explained on the initialization receipt,
 * where authoring starts — not on the install Profile note, so a direct
 * install's pre-picker screen stays within the two-concept budget.
 */
export const CONTEXT_EXPLANATION_SENTENCE =
  "Context is always-loaded facts, preferences, and standing rules a Profile selects.";

/**
 * The Agent Host concept (US-001). Never claims every Host loads every
 * Workspace artifact: a Host can use the material installed into a Project.
 */
export const AGENT_HOST_EXPLANATION_SENTENCE =
  "An Agent Host is a tool such as Claude Code or Codex that can use the material you install into a Project.";
