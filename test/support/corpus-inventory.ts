import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * One concern: the repository test-corpus policy. The canonical corpus is the
 * current set of test files at the existing test root (`<base>/test`); this
 * module derives it from the filesystem on every invocation and applies the
 * fast-suite exclusion policy, so full-mode selection and execution evidence
 * share this one inventory — no maintained fixed test count, and no
 * second discovery mechanism.
 *
 * The suffix set below is the runner-proven set: every form was verified as
 * discovered by the qualified Bun runner (and the conformance check in
 * `test/corpus-inventory.test.ts` keeps the inventory in agreement with the
 * real runner's own discovery). The corpus root owns repository test files:
 * a test file intentionally added outside the test root is outside the
 * canonical corpus policy, not silently excluded coverage.
 */

/** The repository's test root, relative to the invocation working directory. */
export const TEST_CORPUS_ROOT = "test";

/** Runner-proven test-file suffix forms. */
const TEST_FILE_SUFFIXES = [".test.", ".spec.", "_test.", "_spec."] as const;
/** Runner-proven test-file extensions for those suffix forms. */
const TEST_FILE_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"] as const;

export interface CorpusSelection {
  /** Test files at the test root included in required selection, POSIX-relative to `base`. */
  readonly selected: readonly string[];
  /** Test files removed by the exclusion policy, POSIX-relative to `base`. */
  readonly excluded: readonly string[];
}

function matchesExclusion(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern === relativePath);
}

/**
 * Derive the corpus selection from the current test root. Exclusion patterns
 * are exact POSIX-relative paths; a pattern that matches nothing is rejected
 * because a mistyped policy entry would otherwise remove nothing and silently
 * widen the fast suite. An empty test root is rejected: required selection
 * cannot be empty.
 */
export function enumerateTestCorpus(
  base: string,
  exclusionPatterns: readonly string[],
): CorpusSelection {
  const corpusRoot = join(base, TEST_CORPUS_ROOT);
  const selected: string[] = [];
  const walk = (directory: string, relative: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if (relative.length === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `corpus inventory: no test files under ${TEST_CORPUS_ROOT}/ in '${base}': required selection cannot be empty`,
        );
      }
      throw error;
    }
    for (const entry of entries) {
      const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), childRelative);
        continue;
      }
      if (!TEST_FILE_EXTENSIONS.some((extension) => entry.name.endsWith(`.${extension}`))) {
        continue;
      }
      if (TEST_FILE_SUFFIXES.some((suffix) => entry.name.includes(suffix))) {
        selected.push(`${TEST_CORPUS_ROOT}/${childRelative}`);
      }
    }
  };
  walk(corpusRoot, "");
  selected.sort((a, b) => a.localeCompare(b));
  if (selected.length === 0) {
    throw new Error(
      `corpus inventory: no test files under ${TEST_CORPUS_ROOT}/ in '${base}': required selection cannot be empty`,
    );
  }
  const selectedSet = new Set(selected);
  const unmatched: string[] = [];
  const excluded = exclusionPatterns.filter((pattern) => {
    if (!selectedSet.has(pattern)) {
      unmatched.push(pattern);
      return false;
    }
    return true;
  });
  if (unmatched.length > 0) {
    throw new Error(
      `corpus inventory: exclusion policy pattern(s) match nothing in the current corpus: ${unmatched.join(", ")}`,
    );
  }
  return { selected: selected.filter((path) => !excluded.includes(path)), excluded };
}