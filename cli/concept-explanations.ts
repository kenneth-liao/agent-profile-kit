/**
 * The one home for brief kit-concept explanations shown at the action that
 * first needs them (US-001, DEC-003). Meanings stay faithful to CONTEXT.md;
 * Skill is deliberately never defined for the Skills-aware newcomer audience.
 * No screen stores seen-terms state: each action explains what it needs even
 * when that repeats across commands.
 */

/** What a Workspace holds, that it serves several Projects, and that setup may add files. */
export const WORKSPACE_EXPLANATION_SENTENCE =
  "Your Workspace folder holds your Context, Skills, and Profiles. You only need one Workspace for all of your Projects.";

/**
 * Profile concept paragraph for the setup receipt (spec #672, #676).
 * Explains grouping and multi-project reuse without technical jargon.
 */
export const PROFILE_EXPLANATION_PARAGRAPH =
  "Profiles group Context and Skills for one kind of work. You can reuse them across Projects.";

/**
 * Skill concept paragraph for the setup receipt (spec #672, #676).
 * Names the open standard and points to the actual Workspace skills folder.
 */
export function skillExplanationParagraph(skillsFolder: string): string {
  return `Skills are the skills you already use (open standard). Drop skill folders into ${skillsFolder} to use them in a Profile.`;
}

/**
 * Context concept paragraph for the setup receipt (spec #672, #676).
 * Explains Markdown format and session loading, pointing to the actual context folder.
 */
export function contextExplanationParagraph(contextFolder: string): string {
  return `Context is plain Markdown in ${contextFolder}. Every agent session loads the Context in its Profile.`;
}

/** The multi-Project and setup-write facets of a Workspace (US-001). */
export const WORKSPACE_SCOPE_EXPLANATION_SENTENCE =
  "One Workspace can serve several Projects, and setup may add those folders and files.";

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
