import { expect } from "bun:test";

/**
 * Assert the typed Project identity line contract (DEC-004): the atomic path
 * node elides in the middle, so the rendered `Project:` line always fits the
 * measure, keeps the unique tail visible, and never exposes the full
 * over-width path. Independent of the machine's temporary-directory layout.
 */
export function expectElidedProjectLine(
  output: string,
  projectPath: string,
  measure = 80,
): void {
  const tail = projectPath.split("/").at(-1)!;
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith("Project: ") && candidate.endsWith(tail));
  expect(line, `expected a Project: line ending in ${tail}`).toBeDefined();
  expect(line!.length, `line exceeds measure: ${line}`).toBeLessThanOrEqual(measure);
  if (projectPath.length + "Project: ".length > measure) {
    expect(line!, `over-width path must be elided: ${line}`).not.toContain(projectPath);
  }
}