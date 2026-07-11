import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { type Stats } from "node:fs";
import { dirname, join } from "node:path";

import {
  formatInstallationManifest,
  type InstallationManifest,
} from "../schemas/installation-manifest.js";
import { hasErrorCode } from "./fs-error.js";
import { hashOutputDirectory } from "./hashes.js";
import { type ContextOnlyCodexPlan } from "./plan.js";
import { formatCodexAgentConfig } from "../adapters/codex.js";
import { syncCodexSkillLibraryUnderLock } from "./codex-skill-library.js";
import { withCodexLifecycleLock } from "./codex-lifecycle-lock.js";

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
    outputs: [
      ...(plan.resolvedProfile.agents.length > 0
        ? ["agents", ...plan.resolvedProfile.agents.map((agent) => `agents/${agent.id}.config.toml`)]
        : []),
      "context.md",
    ],
    profileId: plan.profile.id,
    renderedAgents: plan.resolvedProfile.agents.map((agent) => ({
      description: agent.description,
      id: agent.id,
    })),
    selectedArtifacts: {
      agents: plan.profile.agents,
      context: plan.profile.context,
      skills: plan.profile.skills,
    },
    resolvedArtifacts: plan.resolvedProfile.artifacts.map((resolved) => ({
      reference: resolved.reference,
      inclusionReasons: resolved.inclusionReasons.map((reason) => ({
        path: reason.path,
        profile: reason.profileId,
      })),
    })),
    schemaVersion: 3,
    workspaceInputHash: plan.workspaceInputHash,
    ...(plan.gitProvenance ? { git: plan.gitProvenance } : {}),
  };
}

function existingInstallationError(destination: string): Error {
  return new Error(
    `Installation already exists at ${destination}; run agent-profile-kit update to regenerate it or uninstall it before installing again`,
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
  staging: string,
  plan: ContextOnlyCodexPlan,
  fileSystem: InstallationFileSystem,
): Promise<void> {
  await fileSystem.writeFile(join(staging, "context.md"), plan.context);
  if (plan.resolvedProfile.agents.length > 0) {
    await fileSystem.mkdir(join(staging, "agents"), { recursive: true });
    await Promise.all(plan.resolvedProfile.agents.map((agent) =>
      fileSystem.writeFile(join(staging, "agents", `${agent.id}.config.toml`), formatCodexAgentConfig(agent.requirements, agent.role)),
    ));
  }
  await fileSystem.writeFile(
    join(staging, "installation.yaml"),
    formatInstallationManifest(await installationManifest(staging, plan, fileSystem)),
  );
}

async function cleanupStaging(
  staging: string | undefined,
  fileSystem: InstallationFileSystem,
  failure: unknown,
): Promise<void> {
  if (!staging) return;
  try {
    await fileSystem.rm(staging, { recursive: true, force: true });
  } catch (cleanupFailure) {
    throw new AggregateError(
      [failure, cleanupFailure],
      `Profile Installation failed and could not clean staging output at ${staging}`,
    );
  }
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
  try {
    await fileSystem.rm(backup, { recursive: true, force: true });
  } catch {
    // The live replacement succeeded. A hidden backup cannot block a later update.
  }
}

export async function installContextOnlyCodex(
  plan: ContextOnlyCodexPlan,
  options: InstallationLifecycleOptions = {},
): Promise<void> {
  return withCodexLifecycleLock(plan.skillLibrary.home, async () => {
    const fileSystem = options.fileSystem ?? nodeInstallationFileSystem;
    const parent = dirname(plan.destination);
    await fileSystem.mkdir(parent, { recursive: true });
    await ensureInstallationIsMissing(plan.destination, fileSystem);
    let staging: string | undefined;
    try {
      staging = await fileSystem.mkdtemp(join(parent, ".install-"));
      await stageInstallation(staging, plan, fileSystem);
      await syncCodexSkillLibraryUnderLock(plan.skillLibrary);
      await fileSystem.rename(staging, plan.destination);
    } catch (error) {
      await cleanupStaging(staging, fileSystem, error);
      if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) {
        throw existingInstallationError(plan.destination);
      }
      throw error;
    }
  });
}

export async function updateContextOnlyCodex(
  plan: ContextOnlyCodexPlan,
  options: InstallationLifecycleOptions = {},
): Promise<void> {
  return withCodexLifecycleLock(plan.skillLibrary.home, async () => {
    const fileSystem = options.fileSystem ?? nodeInstallationFileSystem;
    const parent = dirname(plan.destination);
    let staging: string | undefined;
    try {
      staging = await fileSystem.mkdtemp(join(parent, ".install-"));
      await stageInstallation(staging, plan, fileSystem);
      await syncCodexSkillLibraryUnderLock(plan.skillLibrary);
      await replaceInstallation(staging, plan.destination, fileSystem);
    } catch (error) {
      await cleanupStaging(staging, fileSystem, error);
      throw error;
    }
  });
}
