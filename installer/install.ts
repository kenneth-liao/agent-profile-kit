import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { type Stats } from "node:fs";
import { dirname, join } from "node:path";

import {
  formatInstallationManifest,
  type InstallationManifest,
} from "../schemas/installation-manifest.js";
import { hashOutputDirectory } from "./hashes.js";
import { type ContextOnlyCodexPlan } from "./plan.js";

export interface InstallationFileSystem {
  readonly lstat: (path: string) => Promise<Stats>;
  readonly mkdir: (
    path: string,
    options: { readonly recursive: true },
  ) => Promise<string | undefined>;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly readFile: (path: string) => Promise<string>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (
    path: string,
    options: { readonly force: true; readonly recursive: true },
  ) => Promise<void>;
  readonly writeFile: (path: string, source: string) => Promise<void>;
}

export const nodeInstallationFileSystem: InstallationFileSystem = {
  lstat,
  mkdir,
  mkdtemp,
  readFile: (path) => readFile(path, "utf8"),
  rename,
  rm,
  writeFile,
};

export interface InstallationLifecycleOptions {
  readonly fileSystem?: InstallationFileSystem;
}

async function installationManifest(
  staging: string,
  plan: ContextOnlyCodexPlan,
  fileSystem: InstallationFileSystem,
): Promise<InstallationManifest> {
  if ((await fileSystem.readFile(join(staging, "context.md"))) !== plan.context) {
    throw new Error("Staged Profile Installation Context does not match the installation plan");
  }
  return {
    adapterVersion: plan.engineVersion,
    engineVersion: plan.engineVersion,
    hostId: "codex",
    hostVersion: plan.capability.version,
    outputHash: await hashOutputDirectory(staging),
    outputs: ["context.md"],
    profileId: plan.profile.id,
    selectedArtifacts: { context: plan.profile.context },
    schemaVersion: 1,
    workspaceInputHash: plan.workspaceInputHash,
    ...(plan.gitProvenance ? { git: plan.gitProvenance } : {}),
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function existingInstallationError(destination: string): Error {
  return new Error(
    `Installation already exists at ${destination}; remove it before installing again`,
  );
}

async function ensureInstallationIsMissing(
  destination: string,
  fileSystem: InstallationFileSystem,
): Promise<void> {
  try {
    await fileSystem.lstat(destination);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw existingInstallationError(destination);
}

async function stageInstallation(
  parent: string,
  plan: ContextOnlyCodexPlan,
  fileSystem: InstallationFileSystem,
): Promise<string> {
  const staging = await fileSystem.mkdtemp(join(parent, ".install-"));
  await fileSystem.writeFile(join(staging, "context.md"), plan.context);
  await fileSystem.writeFile(
    join(staging, "installation.yaml"),
    formatInstallationManifest(await installationManifest(staging, plan, fileSystem)),
  );
  return staging;
}

async function replaceInstallation(
  staging: string,
  destination: string,
  fileSystem: InstallationFileSystem,
): Promise<void> {
  const backup = await fileSystem.mkdtemp(join(dirname(destination), ".previous-"));
  await fileSystem.rm(backup, { recursive: true, force: true });
  await fileSystem.rename(destination, backup);
  try {
    await fileSystem.rename(staging, destination);
  } catch (error) {
    try {
      await fileSystem.rename(backup, destination);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Profile Installation replacement failed and could not restore ${destination}`,
      );
    }
    throw error;
  }
  await fileSystem.rm(backup, { recursive: true, force: true });
}

export async function installContextOnlyCodex(
  plan: ContextOnlyCodexPlan,
  options: InstallationLifecycleOptions = {},
): Promise<void> {
  const fileSystem = options.fileSystem ?? nodeInstallationFileSystem;
  const parent = dirname(plan.destination);
  await fileSystem.mkdir(parent, { recursive: true });
  await ensureInstallationIsMissing(plan.destination, fileSystem);
  let staging: string | undefined;
  try {
    staging = await stageInstallation(parent, plan, fileSystem);
    await fileSystem.rename(staging, plan.destination);
  } catch (error) {
    if (staging) await fileSystem.rm(staging, { recursive: true, force: true });
    if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) {
      throw existingInstallationError(plan.destination);
    }
    throw error;
  }
}

export async function updateContextOnlyCodex(
  plan: ContextOnlyCodexPlan,
  options: InstallationLifecycleOptions = {},
): Promise<void> {
  const fileSystem = options.fileSystem ?? nodeInstallationFileSystem;
  const parent = dirname(plan.destination);
  let staging: string | undefined;
  try {
    staging = await stageInstallation(parent, plan, fileSystem);
    await replaceInstallation(staging, plan.destination, fileSystem);
  } catch (error) {
    if (staging) await fileSystem.rm(staging, { recursive: true, force: true });
    throw error;
  }
}
