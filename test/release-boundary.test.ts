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

test("legacy artifact roots stay absent from the engine source tree", () => {
  for (const directory of ["commands", "context", "skills"]) {
    expect(existsSync(join(repositoryRoot, directory))).toBe(false);
  }
});

test("packed npm artifacts exclude personal, legacy, and generated content", () => {
  const packed = packedFiles();

  try {
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
    expect(packageText).not.toMatch(/The AI Launchpad|Personal Assistant Context/);
    expect(packageText).not.toMatch(/~\/\.claude\/\.context|commands\/code-review/);
    expect(packageText).not.toMatch(/skills\/(?:agent|creator|engineering)\//);
  } finally {
    packed.cleanup();
  }
});
