/** One composed Context Module retained with its source Artifact ID. */
export interface ContextModuleSource {
  readonly content: string;
  readonly id: string;
}

/**
 * Canonical Profile Context envelope shared by every Host Adapter.
 * Adapters deliver this semantic snapshot without Host-specific canonical models.
 */
export function composeContextEnvelope(
  profileId: string,
  modules: readonly ContextModuleSource[],
): string {
  const sections = modules.map((module) => {
    const body = module.content.endsWith("\n") ? module.content : `${module.content}\n`;
    return `<!-- Context Module: ${module.id} -->\n${body}<!-- End Context Module: ${module.id} -->`;
  });
  return [
    "# Agent Profile Kit Context",
    "",
    `Profile: ${profileId}`,
    "",
    "This Context is reusable Profile material. Repository-owned project instructions, including AGENTS.md, take precedence when they conflict with this material.",
    "",
    ...sections,
  ].join("\n").replace(/\n?$/, "\n");
}
