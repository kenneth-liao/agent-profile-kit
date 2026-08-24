import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const PREPARED_PACKAGE_ARCHIVE_ENV = "APKIT_TEST_PACKAGE_ARCHIVE";

export interface PackageArchive {
  readonly path: string;
  readonly cleanup: () => void;
}

export interface PackageArchiveCommands {
  readonly build: (repositoryRoot: string) => void;
  readonly createScriptDisabledArchive: (repositoryRoot: string, destination: string) => string;
}

export interface PackageArchiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly commands?: PackageArchiveCommands;
}

const systemPackageArchiveCommands: PackageArchiveCommands = {
  build: (repositoryRoot) => {
    execFileSync("bun", ["run", "build"], { cwd: repositoryRoot, stdio: "inherit" });
  },
  createScriptDisabledArchive: (repositoryRoot, destination) => {
    const output = execFileSync(
      "npm",
      ["pack", "--silent", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    const metadata = JSON.parse(output.slice(output.indexOf("["))) as readonly [
      { readonly filename: string },
    ];
    return metadata[0]!.filename;
  },
};

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

export function ensureProductionBundle(
  repositoryRoot: string,
  options: PackageArchiveOptions = {},
): void {
  const environment = options.environment ?? process.env;
  const commands = options.commands ?? systemPackageArchiveCommands;
  if (preparedPackageArchive(environment) === null) commands.build(repositoryRoot);
}

export function obtainPackageArchive(
  repositoryRoot: string,
  prefix: string,
  options: PackageArchiveOptions = {},
): PackageArchive {
  const environment = options.environment ?? process.env;
  const commands = options.commands ?? systemPackageArchiveCommands;
  const prepared = preparedPackageArchive(environment);
  if (prepared !== null) {
    return { path: prepared, cleanup: () => undefined };
  }

  const packageDirectory = mkdtempSync(join(tmpdir(), prefix));
  try {
    commands.build(repositoryRoot);
    const filename = commands.createScriptDisabledArchive(repositoryRoot, packageDirectory);
    const path = realpathSync(join(packageDirectory, filename));
    return {
      path,
      cleanup: () => rmSync(packageDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(packageDirectory, { recursive: true, force: true });
    throw error;
  }
}
