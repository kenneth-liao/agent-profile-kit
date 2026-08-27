/** One composed Context Module retained with its source Artifact ID. */
export interface ContextModuleSource {
  readonly content: string;
  readonly id: string;
}

/** The compact Profile Context metadata shared by every complete-envelope Host Adapter. */
export function composeContextEnvelopeHeader(profileId: string): string {
  return [
    `# Agent Profile Kit Context — Profile: ${profileId}`,
    "Repository-owned project instructions, including AGENTS.md, take precedence when they conflict with this material.",
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
  return `${composeContextEnvelopeHeader(profileId)}\n\n${
    modules.map((module) => module.content).join("")
  }`.replace(/\n*$/, "\n");
}
