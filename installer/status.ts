import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import { hashOutputDirectory, hashWorkspaceInputs } from "./hashes.js";
import { ingestWorkspace } from "./ingest-workspace.js";
import { installationPath } from "./plan.js";
import { parseInstallationManifest } from "../schemas/installation-manifest.js";

export type InstallationStatus =
  | "current"
  | "drifted output"
  | "malformed Manifest"
  | "missing installation"
  | "stale source";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function statusContextOnlyCodex(
  home: string,
  profileId: string,
): Promise<readonly InstallationStatus[]> {
  const installation = installationPath(home, profileId);
  try {
    if (!(await lstat(installation)).isDirectory()) return ["malformed Manifest"];
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return ["missing installation"];
    throw error;
  }

  let manifest;
  try {
    manifest = parseInstallationManifest(
      await readFile(join(installation, "installation.yaml"), "utf8"),
    );
  } catch {
    return ["malformed Manifest"];
  }
  if (manifest.profileId !== profileId || manifest.hostId !== "codex") {
    return ["malformed Manifest"];
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
  if (!profile || hashWorkspaceInputs(profile, workspace.contexts) !== manifest.workspaceInputHash) {
    statuses.unshift("stale source");
  }

  return statuses.length > 0 ? statuses : ["current"];
}
