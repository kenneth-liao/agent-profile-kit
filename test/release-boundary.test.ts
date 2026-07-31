import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const packageDirectory = mkdtempSync(join(tmpdir(), "agent-profile-kit-boundary-pack-"));
  const extractedDirectory = mkdtempSync(join(tmpdir(), "agent-profile-kit-boundary-extracted-"));

  try {
    execFileSync("bun", ["run", "build"], { cwd: repositoryRoot, stdio: "inherit" });
    const output = execFileSync(
      "npm",
      ["pack", "--silent", "--ignore-scripts", "--json", "--pack-destination", packageDirectory],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const metadata = JSON.parse(output.slice(output.indexOf("["))) as readonly [{ readonly filename: string }];
    const archive = join(packageDirectory, metadata[0]!.filename);
    execFileSync("tar", ["-xzf", archive, "-C", extractedDirectory]);
    const root = join(extractedDirectory, "package");
    return {
      root,
      files: filesUnder(root),
      cleanup: () => {
        rmSync(packageDirectory, { recursive: true, force: true });
        rmSync(extractedDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(packageDirectory, { recursive: true, force: true });
    rmSync(extractedDirectory, { recursive: true, force: true });
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
  const guidance = new Map<string, readonly string[]>([
    ["AGENTS.md", []],
    ["README.md", []],
    ["docs/ARCHITECTURE.md", []],
    ["docs/guides/agent-workflow.md", []],
    ["docs/guides/workspace.md", ["agent-profile-kit validate"]],
    ["docs/runbooks/github-release.md", ["agent-profile-kit guide"]],
  ]);
  const formerCommand = /\bagent-profile-kit (?=(?:init|guide|bind|unbind|validate|preview|apply|status|uninstall|--help)\b)/;

  for (const [path, versionPinnedInvocations] of guidance) {
    let source = readFileSync(join(repositoryRoot, path), "utf8");
    if (path !== "docs/runbooks/github-release.md") expect(source).toContain("apkit");
    for (const invocation of versionPinnedInvocations) {
      expect(source.split(invocation)).toHaveLength(2);
      source = source.replace(invocation, "");
    }
    expect(source).not.toMatch(formerCommand);
  }

  const userJourney = readFileSync(join(repositoryRoot, "docs/USER-JOURNEY.md"), "utf8");
  expect(userJourney).toContain("| 1 | Discover | `apkit`, `--help`");
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
