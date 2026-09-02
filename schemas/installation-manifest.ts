/** Stable byte-order comparator shared by canonical state and on-disk unions. */
export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function parseFileMode(value: unknown, description: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0o777) {
    throw new Error(`${description} must be an integer permission mode between 0 and 0777`);
  }
  return value as number;
}
