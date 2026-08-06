/** Compare human output facts without coupling tests to wrapping whitespace. */
export function humanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
