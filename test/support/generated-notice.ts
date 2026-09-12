import { generatedMarkdownNotice } from "../../adapters/generated-notice.js";

/**
 * Compose the projected SKILL.md an install writes for one canonical source:
 * the generated-source notice becomes the first body line after frontmatter,
 * and every other byte keeps its authored form. Mirrors the one placement the
 * Adapter projection applies, so lifecycle tests can simulate installed bytes.
 */
export function projectedSkillDocument(source: string): string {
  const closing = source.indexOf("---\n", "---\n".length);
  if (closing === -1) throw new Error("canonical SKILL.md must close its frontmatter");
  const bodyOffset = closing + "---\n".length;
  return `${source.slice(0, bodyOffset)}${generatedMarkdownNotice()}\n${source.slice(bodyOffset)}`;
}

/**
 * Read one generated JSONC document as strict JSON. Generated notices are
 * leading `//` comment lines, so removing comments must leave a document that
 * the Host's JSON parser still accepts unchanged.
 */
export function parseGeneratedJsonc(source: string): unknown {
  const body = source
    .split("\n")
    .filter((line) => !line.startsWith("//"))
    .join("\n");
  return JSON.parse(body);
}
