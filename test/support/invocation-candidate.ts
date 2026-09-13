import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SuiteMode } from "./suite-supervisor.js";

import { INVOCATION_PACKAGE_CONSUMER_MARKER } from "./invocation-package-consumer.js";

/**
 * One concern: deriving whether a supervised invocation must prepare the
 * invocation package candidate. Need comes from the consumer capability
 * declarations carried by the files that may execute in the invocation
 * (`import ... support/invocation-package-consumer`), intersected with the
 * invocation's provable selection scope — never an import-graph inference and
 * never a maintained file registry, so the declaration lives in each consumer
 * file and no second home duplicates it. Preparation orchestration lives in
 * the suite supervisor; the consumer seam lives in `package-archive.ts`.
 */

/** How much of the corpus an invocation's selection provably executes. */
export type InvocationSelectionScope =
  /** Every positional argument is an existing file path: exactly those run. */
  | "exact-files"
  /** No positional argument: the runner executes the whole test root. */
  | "whole-corpus"
  /**
   * A name filter or a partial path filter makes the executed file set
   * unknowable statically; consumer execution fails closed in such runs.
   */
  | "unknown";

/**
 * Why an invocation must (or must not) prepare a candidate. `declared` lists
 * the files whose capability declaration drove a package need; `evidence` is
 * the truthful record of why preparation does or does not run, including the
 * unknowable-scope case's explicit limit.
 */
export type InvocationPackageNeed =
  | {
      readonly kind: "package";
      readonly declared: readonly string[];
      readonly evidence: string;
    }
  | {
      readonly kind: "none";
      readonly evidence: string;
    };

export interface InvocationNeedInput {
  readonly mode: SuiteMode;
  readonly scope: InvocationSelectionScope;
  /**
   * Files that may execute in this invocation: the named exact files for
   * exact-file scope, the derived required selection for full/stress scope,
   * or the whole inventory for a flag-only focused selection (the runner
   * searches the whole test root, so policy-excluded files run too).
   */
  readonly executableFiles: readonly string[];
  /** Corpus base the file paths resolve against. */
  readonly base: string;
  /** Reads one executable file's source; test injection only. */
  readonly readSource?: (path: string) => string;
}

function defaultReadSource(base: string, path: string): string {
  return readFileSync(resolve(base, path), "utf8");
}

/**
 * One structural import scanner for capability declarations: the runtime's own
 * transpiler parses the source, so only real import statements can declare —
 * a file that merely mentions the marker in a string (for example a test of
 * the derivation itself) cannot falsely declare. An import the transpiler
 * cannot resolve statically is the consumer's own risk: if it is a consumer
 * import that scans as nothing, the undeclared consumer fails closed at
 * runtime, never silently building or silently skipping preparation.
 */
const capabilityScanner = new Bun.Transpiler({ loader: "ts" });

function declaresInvocationPackageConsumer(source: string): boolean {
  return capabilityScanner
    .scanImports(source)
    .some((imported) => imported.path.includes(INVOCATION_PACKAGE_CONSUMER_MARKER));
}

/**
 * Derive one invocation's package need.
 *
 * - Unknown scope cannot prove which files execute, so it never prepares:
 *   pure selections run green without a candidate and a consumer that
 *   executes fails closed through the supervised tripwire, with the limit
 *   stated truthfully in the evidence.
 * - Whole-corpus scope (full/stress mode, or a focused selection without any
 *   positional argument, where the runner executes the whole test root) scans
 *   every executable file's capability declaration.
 * - Exact-file scope scans the named files; a non-corpus file named there
 *   (for example a support fixture) may declare the capability too, and the
 *   runner executes only the given files.
 *
 * The scan parses each executable file's real import statements for the
 * marker module (relative and absolute fixture import spellings both
 * declare); string mentions of the marker that are not import statements
 * cannot declare, and a consumer that omits the import fails closed at
 * runtime through the supervised tripwire.
 */
export function deriveInvocationPackageNeed(input: InvocationNeedInput): InvocationPackageNeed {
  if (input.scope === "unknown") {
    return {
      kind: "none",
      evidence:
        "selection scope cannot be proven (a name or partial path filter reaches an unknown file set); no candidate is prepared, and a consumer that executes fails closed with a typed remedy instead of building silently",
    };
  }
  const readSource = input.readSource ?? ((path: string) => defaultReadSource(input.base, path));
  const declared = input.executableFiles.filter((file) => {
    try {
      return declaresInvocationPackageConsumer(readSource(file));
    } catch {
      // A file that cannot be read cannot declare the capability; if it is a
      // consumer it fails closed at runtime, so an unreadable source never
      // silently hides a consumer behind a preparation.
      return false;
    }
  });
  if (declared.length > 0) {
    return {
      kind: "package",
      declared,
      evidence: `${input.mode} selection executes file(s) declaring the invocation-package consumer capability: ${declared.join(", ")}`,
    };
  }
  return {
    kind: "none",
    evidence: `${input.mode} selection executes no file declaring the invocation-package consumer capability`,
  };
}

/**
 * The positional arguments of a focused selection: every argument that is not
 * a flag, with a `-t <value>` pair collapsed to one flag. The runner treats
 * positional arguments as path filters; only existing file paths make the
 * executed set provable.
 */
export function focusedPositionalArguments(bunArguments: readonly string[]): readonly string[] {
  const positional: string[] = [];
  for (let index = 0; index < bunArguments.length; index += 1) {
    const argument = bunArguments[index]!;
    if (argument === "-t") {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    positional.push(argument);
  }
  return positional;
}

/**
 * Derive one focused invocation's provable selection scope from its
 * arguments. `bun test` executes the whole test root when no positional
 * argument is given (flags only); it executes exactly the named files when
 * every positional argument is an existing file path (a name filter beside
 * them selects within those files); any other argument shape — a name filter
 * without file paths, or a partial path filter — leaves the executed set
 * unknowable.
 */
export function deriveInvocationSelectionScope(
  base: string,
  bunArguments: readonly string[],
  exists: (path: string) => boolean = (path) => existsSync(resolve(base, path)),
): InvocationSelectionScope {
  const positional = focusedPositionalArguments(bunArguments);
  if (positional.length === 0) {
    return bunArguments.some(
      (argument) => argument === "-t" || argument.startsWith("--test-name-pattern"),
    )
      ? "unknown"
      : "whole-corpus";
  }
  return positional.every((argument) => exists(argument)) ? "exact-files" : "unknown";
}
