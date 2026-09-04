import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findFormerCommandInvocations } from "./support/current-command-guidance.js";
import { obtainPackageArchive } from "./support/package-archive.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function filesUnder(root: string): readonly string[] {
  const files: string[] = [];

  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(root, path));
    }
  }

  visit(root);
  return files.sort();
}

function packedFiles(): {
  readonly root: string;
  readonly files: readonly string[];
  readonly cleanup: () => void;
} {
  const archive = obtainPackageArchive(repositoryRoot, "agent-profile-kit-boundary-pack-");
  const extractedDirectory = mkdtempSync(join(tmpdir(), "agent-profile-kit-boundary-extracted-"));

  try {
    execFileSync("tar", ["-xzf", archive.path, "-C", extractedDirectory]);
    const root = join(extractedDirectory, "package");
    return {
      root,
      files: filesUnder(root),
      cleanup: () => {
        rmSync(extractedDirectory, { recursive: true, force: true });
        archive.cleanup();
      },
    };
  } catch (error) {
    rmSync(extractedDirectory, { recursive: true, force: true });
    archive.cleanup();
    throw error;
  }
}

test("living engine guidance does not describe removed legacy content as repository structure", () => {
  const agents = readFileSync(join(repositoryRoot, "AGENTS.md"), "utf8");

  expect(agents).toMatch(/personal material belongs in the user's Workspace/i);
  expect(agents).not.toContain("legacy migration input");
  expect(agents).not.toContain("`commands/`, `context/`, and `skills/`");
});

test("current user guidance invokes the published apkit command", () => {
  const markdownPaths = execFileSync("git", ["ls-files", "--", "*.md"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
  const documents = markdownPaths.map((path) => ({
    path,
    source: readFileSync(join(repositoryRoot, path), "utf8"),
  }));

  expect(findFormerCommandInvocations(documents)).toEqual([]);
});

test("package identity has one lower-layer manifest reader", () => {
  const paths = execFileSync(
    "git",
    ["ls-files", "--", "cli/*.ts", "installer/*.ts", "schemas/*.ts"],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim().split("\n").filter(
    (path) => path !== "" && existsSync(join(repositoryRoot, path)),
  );
  const sources = paths.map((path) => ({
    path,
    source: readFileSync(join(repositoryRoot, path), "utf8"),
  }));

  expect(
    sources.filter(({ source }) => /from ["']\.\.\/package\.json["']/.test(source))
      .map(({ path }) => path),
  ).toEqual(["installer/version.ts"]);
  expect(
    sources.filter(({ path, source }) =>
      (path.startsWith("installer/") || path.startsWith("schemas/")) &&
      /from ["'][^"']*cli\//.test(source)
    ).map(({ path }) => path),
  ).toEqual([]);
});

test("legacy Installation State readers and retired receipt projections stay absent", () => {
  const ownershipBoundaryPaths = [
    "installer/installation-state.ts",
    "installer/ownership-state.ts",
    "schemas/canonical.ts",
    "schemas/ownership-state.ts",
  ];
  const productionSource = ownershipBoundaryPaths
    .map((path) => readFileSync(join(repositoryRoot, path), "utf8"))
    .join("\n");

  expect(existsSync(join(repositoryRoot, "installer/ownership-state-normalization.ts"))).toBe(false);
  expect(productionSource).not.toMatch(/from ["']yaml["']/);
  for (const retiredSymbol of [
    "normalizeLegacyOwnershipState",
    "parseLegacyInstallationState",
    "parsePreviousInstallationState",
    "parseV4InstallationState",
    "parseInstallationState",
    "formatInstallationState",
    "ProjectInstallationManifest",
    "TemporaryProfileInstallation",
    "IntendedTeardown",
    "ResolvedArtifactRecord",
  ]) {
    expect(productionSource).not.toMatch(new RegExp(`\\b${retiredSymbol}\\b`));
  }
  for (const retiredField of [
    "intended_teardowns",
    "repository_exclusions",
    "temporary_installations",
    "selected_context",
    "resolved_artifacts",
    "output_origins",
  ]) {
    expect(productionSource).not.toContain(retiredField);
  }
});

test("legacy artifact roots stay absent from the engine source tree", () => {
  for (const directory of ["commands", "context", "skills", "tools"]) {
    expect(existsSync(join(repositoryRoot, directory))).toBe(false);
  }
});

test("private release artifact cannot publish to npm", () => {
  const manifest = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  ) as Record<string, unknown>;

  expect(manifest.private).toBe(true);
  expect(manifest.publishConfig).toBeUndefined();
});

test("packed npm artifacts exclude personal, legacy, and generated content", () => {
  const packed = packedFiles();

  try {
    // Keep this allowlist exact: intentional package growth must update this gate with the release boundary.
    expect(packed.files).toEqual([
      "README.md",
      "dist/cli.js",
      "docs/guides/agent-workflow.md",
      "docs/guides/workspace.md",
      "package.json",
    ]);

    const packageText = packed.files
      .map((path) => readFileSync(join(packed.root, path), "utf8"))
      .join("\n");
    // Path names can be valid in public Workspace guidance; these markers identify removed personal material.
    expect(packageText).not.toMatch(/The AI Launchpad|Personal Assistant Context/);
  } finally {
    packed.cleanup();
  }
});
