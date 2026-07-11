import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { hasErrorCode } from "./fs-error.js";
import { hashOutputDirectory, hashSkillCatalog, hashWorkspaceInputs } from "./hashes.js";
import { ingestWorkspace } from "./ingest-workspace.js";
import { installationPath } from "./plan.js";
import { resolveProfileDependencies } from "./resolve-dependencies.js";
import { parseInstallationManifest } from "../schemas/installation-manifest.js";
import {
  codexSkillLibraryPath,
  assertCodexSkillLibraryIntact,
  readOwnedSkillLibrary,
} from "./codex-skill-library.js";

export type InstallationStatus =
  | "current"
  | "drifted output"
  | "malformed Manifest"
  | "missing installation"
  | "stale source";

export interface CodexInstallationStatus {
  readonly profile: readonly InstallationStatus[];
  readonly skillLibrary: readonly InstallationStatus[];
}

async function statusCodexSkillLibrary(home: string): Promise<readonly InstallationStatus[]> {
  const destination = codexSkillLibraryPath(home);
  try {
    const entry = await lstat(destination);
    if (!entry.isDirectory() && !entry.isSymbolicLink()) return ["malformed Manifest"];
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return ["missing installation"];
    throw error;
  }
  let manifest;
  try {
    manifest = await readOwnedSkillLibrary(destination);
  } catch {
    return ["malformed Manifest"];
  }
  const statuses: InstallationStatus[] = [];
  try {
    await assertCodexSkillLibraryIntact(destination);
  } catch {
    statuses.push("drifted output");
  }
  const workspace = await ingestWorkspace(home);
  if ((await hashSkillCatalog(workspace.skills)) !== manifest.workspaceInputHash) {
    statuses.unshift("stale source");
  }
  return statuses.length > 0 ? statuses : ["current"];
}

export async function statusContextOnlyCodex(
  home: string,
  profileId: string,
): Promise<CodexInstallationStatus> {
  const installation = installationPath(home, profileId);
  try {
    if (!(await lstat(installation)).isDirectory()) {
      return { profile: ["malformed Manifest"], skillLibrary: await statusCodexSkillLibrary(home) };
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { profile: ["missing installation"], skillLibrary: await statusCodexSkillLibrary(home) };
    }
    throw error;
  }

  let manifest;
  try {
    manifest = parseInstallationManifest(
      await readFile(join(installation, "installation.yaml"), "utf8"),
    );
  } catch {
    return { profile: ["malformed Manifest"], skillLibrary: await statusCodexSkillLibrary(home) };
  }
  if (manifest.profileId !== profileId || manifest.hostId !== "codex") {
    return { profile: ["malformed Manifest"], skillLibrary: await statusCodexSkillLibrary(home) };
  }

  const statuses: InstallationStatus[] = [];
  try {
    if ((await hashOutputDirectory(installation)) !== manifest.outputHash) {
      statuses.push("drifted output");
    }
  } catch {
    statuses.push("drifted output");
  }

  const workspace = await ingestWorkspace(home);
  const profile = workspace.profiles.get(profileId);
  if (
    !profile ||
    (await hashWorkspaceInputs(
      profile,
      resolveProfileDependencies(profile, workspace.agents, workspace.contexts, workspace.skills),
    )) !==
      manifest.workspaceInputHash
  ) {
    statuses.unshift("stale source");
  }

  return {
    profile: statuses.length > 0 ? statuses : ["current"],
    skillLibrary: await statusCodexSkillLibrary(home),
  };
}
