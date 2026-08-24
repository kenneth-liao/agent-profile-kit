import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const PREPARED_PACKAGE_ARCHIVE_ENV = "APKIT_TEST_PACKAGE_ARCHIVE";

export interface PackageArchive {
  readonly path: string;
  readonly cleanup: () => void;
}

export function preparedPackageArchive(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const authoredPath = environment[PREPARED_PACKAGE_ARCHIVE_ENV];
  if (authoredPath === undefined) return null;
  if (!isAbsolute(authoredPath)) {
    throw new Error(`${PREPARED_PACKAGE_ARCHIVE_ENV} must be an absolute path`);
  }

  const canonicalPath = realpathSync(authoredPath);
  if (!lstatSync(canonicalPath).isFile()) {
    throw new Error(`${PREPARED_PACKAGE_ARCHIVE_ENV} must identify a package archive file`);
  }
  return canonicalPath;
}

function buildProductionBundle(repositoryRoot: string): void {
  execFileSync("bun", ["run", "build"], { cwd: repositoryRoot, stdio: "inherit" });
}

export function ensureProductionBundle(repositoryRoot: string): void {
  if (preparedPackageArchive() === null) buildProductionBundle(repositoryRoot);
}

export function obtainPackageArchive(repositoryRoot: string, prefix: string): PackageArchive {
  const prepared = preparedPackageArchive();
  if (prepared !== null) {
    return { path: prepared, cleanup: () => undefined };
  }

  const packageDirectory = mkdtempSync(join(tmpdir(), prefix));
  try {
    buildProductionBundle(repositoryRoot);
    const output = execFileSync(
      "npm",
      ["pack", "--silent", "--ignore-scripts", "--json", "--pack-destination", packageDirectory],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const metadata = JSON.parse(output.slice(output.indexOf("["))) as readonly [
      { readonly filename: string },
    ];
    const path = realpathSync(join(packageDirectory, metadata[0]!.filename));
    return {
      path,
      cleanup: () => rmSync(packageDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(packageDirectory, { recursive: true, force: true });
    throw error;
  }
}
