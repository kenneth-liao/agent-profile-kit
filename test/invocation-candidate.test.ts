import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveInvocationPackageNeed,
  deriveInvocationSelectionScope,
  focusedPositionalArguments,
  type InvocationNeedInput,
  type InvocationSelectionScope,
} from "./support/invocation-candidate.js";

/**
 * Pure need-derivation proofs: need comes from the consumer capability
 * declarations carried by the files that may execute (the marker module each
 * consumer imports), intersected with the invocation's provable selection
 * scope — never an import-graph inference and never a maintained registry.
 * The real-runner proofs that preparation follows this derivation live in
 * test/invocation-preparation.test.ts.
 */

const MARKER = "invocation-package-consumer";

interface CorpusFile {
  readonly path: string;
  /** A body importing the marker module declares the capability. */
  readonly declares?: boolean;
}

const CORPUS: readonly CorpusFile[] = [
  { path: "test/cli.test.ts", declares: true },
  { path: "test/package-archive.test.ts" },
  { path: "test/pure.test.ts" },
];

function writeCorpus(root: string, files: readonly CorpusFile[]): void {
  mkdirSync(join(root, "test"), { recursive: true });
  for (const file of files) {
    writeFileSync(
      join(root, file.path),
      file.declares === true
        ? `import "./support/${MARKER}";\n`
        : `import { test } from "bun:test";\n`,
    );
  }
}

const need = (
  overrides: Partial<InvocationNeedInput> & { scope: InvocationSelectionScope },
): ReturnType<typeof deriveInvocationPackageNeed> => {
  const root = mkdtempSync(join(tmpdir(), "apkit-need-"));
  try {
    writeCorpus(root, CORPUS);
    return deriveInvocationPackageNeed({
      mode: "full",
      base: root,
      executableFiles: overrides.executableFiles ?? CORPUS.map((file) => file.path),
      ...overrides,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("invocation package need derivation", () => {
  test("full and stress selections scan the executable files' capability declarations", () => {
    for (const mode of ["full", "stress"] as const) {
      const derived = need({
        mode,
        scope: "whole-corpus",
        executableFiles: ["test/cli.test.ts", "test/pure.test.ts"],
      });
      if (derived.kind !== "package") {
        throw new Error(`expected package need, got ${derived.kind}: ${derived.evidence}`);
      }
      expect(derived.declared).toEqual(["test/cli.test.ts"]);
      expect(derived.evidence).toContain(mode);
      expect(derived.evidence).toContain("declaring the invocation-package consumer capability");
    }
  });

  test("a selection over files that declare nothing needs no candidate", () => {
    // The seam's own test file imports the seam to test it with injected
    // commands but carries no capability declaration, so it is not a consumer.
    const derived = need({
      mode: "focused",
      scope: "exact-files",
      executableFiles: ["test/package-archive.test.ts", "test/pure.test.ts"],
    });
    expect(derived).toEqual({
      kind: "none",
      evidence:
        "focused selection executes no file declaring the invocation-package consumer capability",
    });
  });

  test("an unknowable selection scope never prepares and states the limit", () => {
    // A name filter or a partial path filter reaches a statically unknown file
    // set; no candidate is prepared and a consumer that executes fails closed.
    const derived = need({ mode: "focused", scope: "unknown", executableFiles: [] });
    expect(derived).toEqual({
      kind: "none",
      evidence:
        "selection scope cannot be proven (a name or partial path filter reaches an unknown file set); no candidate is prepared, and a consumer that executes fails closed with a typed remedy instead of building silently",
    });
  });

  test("a fixture file declaring the capability through an absolute import counts", () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-need-"));
    try {
      writeFileSync(
        join(root, "fixture-consumer.test.ts"),
        `import "${join(root, "..", "test", "support", "invocation-package-consumer")}";\n`,
      );
      const derived = deriveInvocationPackageNeed({
        mode: "full",
        scope: "exact-files",
        executableFiles: ["fixture-consumer.test.ts"],
        base: root,
      });
      if (derived.kind !== "package") {
        throw new Error(`expected package need, got ${derived.kind}: ${derived.evidence}`);
      }
      expect(derived.declared).toEqual(["fixture-consumer.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("invocation selection scope derivation", () => {
  test("positional arguments collapse `-t <value>` pairs and skip flags", () => {
    expect(
      focusedPositionalArguments(["-t", "pattern", "--update-snapshots", "a.test.ts"]),
    ).toEqual(["a.test.ts"]);
  });

  test("existing file paths for every positional argument prove an exact-file scope", () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-scope-"));
    try {
      writeFileSync(join(root, "fixture.test.ts"), "");
      expect(deriveInvocationSelectionScope(root, ["fixture.test.ts"])).toBe("exact-files");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a name filter without file paths, or a partial filter, is unknowable", () => {
    expect(deriveInvocationSelectionScope("/base", ["-t", "pattern"], () => true)).toBe("unknown");
    expect(deriveInvocationSelectionScope("/base", ["--test-name-pattern=x"], () => true)).toBe(
      "unknown",
    );
    // A positional argument naming nothing that exists is a partial path
    // filter with unknowable reach, not a missing file.
    expect(deriveInvocationSelectionScope("/base", ["missing.test.ts"], () => false)).toBe(
      "unknown",
    );
  });

  test("a flag-only focused selection executes the whole corpus", () => {
    expect(deriveInvocationSelectionScope("/base", ["--update-snapshots"], () => true)).toBe(
      "whole-corpus",
    );
  });
});
