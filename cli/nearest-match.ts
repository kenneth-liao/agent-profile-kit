/**
 * The single nearest-name selection shared by command suggestions and
 * artifact-name suggestions (DEC-017): smallest edit distance within a
 * threshold, distance ties broken lexicographically. Case-sensitive, matching
 * the unknown-command suggestion precedent.
 */
export const MAX_NAME_SUGGESTION_DISTANCE = 2;

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

/** The nearest candidate within the suggestion threshold, or undefined. */
export function nearestName(unknown: string, names: readonly string[]): string | undefined {
  return names
    .map((name) => ({ distance: editDistance(unknown, name), name }))
    .filter(({ distance }) => distance <= MAX_NAME_SUGGESTION_DISTANCE)
    .sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
    })[0]
    ?.name;
}
