/** One composed Context Module retained with its source Artifact ID. */
export interface ContextModuleSource {
  readonly content: string;
  readonly id: string;
}

/**
 * Canonical Profile Context envelope shared by every Host Adapter.
 * Adapters deliver this semantic snapshot without Host-specific canonical models.
 */
/** The canonical Profile Context header shared by every Host Adapter. */
export function composeContextEnvelopeHeader(profileId: string): string {
  return [
    "# Agent Profile Kit Context",
    "",
    `Profile: ${profileId}`,
    "",
    "This Context is reusable Profile material. Repository-owned project instructions, including AGENTS.md, take precedence when they conflict with this material.",
  ].join("\n");
}

/** Preserve one complete Context Module and its canonical boundary markers. */
export function composeContextModuleBoundary(module: ContextModuleSource): string {
  const body = module.content.endsWith("\n") ? module.content : `${module.content}\n`;
  return `<!-- Context Module: ${module.id} -->\n${body}<!-- End Context Module: ${module.id} -->`;
}

export function composeContextEnvelope(
  profileId: string,
  modules: readonly ContextModuleSource[],
): string {
  return [
    composeContextEnvelopeHeader(profileId),
    "",
    ...modules.map(composeContextModuleBoundary),
  ].join("\n").replace(/\n?$/, "\n");
}
