function coreParts(version: string): readonly [number, number, number] {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Core semantic version '${version}' must be MAJOR.MINOR.PATCH`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Normalize three decimal components into one core MAJOR.MINOR.PATCH value. */
export function normalizeCoreSemanticVersion(
  major: string,
  minor: string,
  patch: string,
): string {
  return `${Number(major)}.${Number(minor)}.${Number(patch)}`;
}

/** Compare two normalized core semantic versions. */
export function compareCoreSemanticVersions(left: string, right: string): -1 | 0 | 1 {
  const leftParts = coreParts(left);
  const rightParts = coreParts(right);
  for (let index = 0; index < 3; index += 1) {
    const delta = leftParts[index]! - rightParts[index]!;
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}
