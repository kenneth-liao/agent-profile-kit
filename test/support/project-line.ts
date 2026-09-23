import { expect } from "bun:test";

/**
 * Assert the typed Project identity line contract (DEC-004): the atomic path
 * node elides in the middle, so the rendered `Project:` field always fits the
 * measure, keeps the unique tail visible, and never exposes the full
 * over-width path. Independent of the machine's temporary-directory layout.
 * Compact labeled records pack further fields onto the same line separated by
 * a double space (US-008), so the identity is the `Project:` field up to that
 * separator — never the first whitespace token, which would break on paths
 * containing spaces and could read a packed neighbor.
 */
export function expectElidedProjectLine(
  output: string,
  projectPath: string,
  measure = 80,
): void {
  const tail = projectPath.split("/").at(-1)!;
  const line = output
    .split("\n")
    .find((candidate) => {
      const field = candidate.match(/Project: (.+?)(?:  |$)/);
      return field !== null && field[1]!.endsWith(tail);
    });
  expect(line, `expected a Project: field ending in ${tail}`).toBeDefined();
  expect(line!.length, `line exceeds measure: ${line}`).toBeLessThanOrEqual(measure);
  if (projectPath.length + "Project: ".length > measure) {
    expect(line!, `over-width path must be elided: ${line}`).not.toContain(projectPath);
  }
}