/** Compare human output facts without coupling tests to wrapping whitespace
 * or styling: ANSI paints the same content the plain text states, so
 * settled glyphs and sentences are read from the stripped form. */
export function humanText(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
