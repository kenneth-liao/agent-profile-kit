import {
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  formatInstallationState,
  parseInstallationMarker,
  parseInstallationState,
  type InstallationMarker,
  type InstallationState,
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";
import {
  hashBytes,
  markerPath,
  stateManifestPath,
  stateDirectory,
} from "./project-plan.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function readInstallationState(home: string): Promise<InstallationState> {
  try {
    return parseInstallationState(await readFile(stateManifestPath(home), "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { installations: [], schemaVersion: 1 };
    throw error;
  }
}

export async function writeInstallationState(
  home: string,
  state: InstallationState,
): Promise<void> {
  const directory = stateDirectory(home);
  await mkdir(directory, { recursive: true });
  const destination = stateManifestPath(home);
  const temporary = join(directory, `.manifest-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, formatInstallationState(state), { flag: "wx" });
  try {
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function readMarker(project: string): Promise<InstallationMarker | undefined> {
  try {
    return parseInstallationMarker(await readFile(markerPath(project), "utf8"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function newInstallationId(): string {
  return randomUUID();
}

const INSTALLATION_MARKER_RELATIVE_PATH = ".agent-profile-kit/installation.json";

async function proveOutputHashes(
  installation: ProjectInstallationManifest,
  includeMarker: boolean,
): Promise<{ readonly reason?: string; readonly owned: boolean }> {
  const outputs = installation.outputs.filter(
    (output) => includeMarker || output.path !== INSTALLATION_MARKER_RELATIVE_PATH,
  );
  if (outputs.length === 0) {
    return { owned: false, reason: "no remaining owned output proves the installation" };
  }
  const missing: string[] = [];
  const drifted: string[] = [];
  for (const output of outputs) {
    const path = join(installation.project, output.path);
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        missing.push(output.path);
        continue;
      }
      const content = await readFile(path, "utf8");
      if (hashBytes(content) !== output.hash) drifted.push(output.path);
    } catch {
      missing.push(output.path);
    }
  }
  if (missing.length > 0 || drifted.length > 0) {
    const reasons = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(drifted.length > 0 ? [`drifted: ${drifted.join(", ")}`] : []),
    ];
    return { owned: false, reason: `owned output ${reasons.join("; ")}` };
  }
  return { owned: true };
}

/** Prove ownership from non-marker output hashes, for safe marker repair. */
export async function proveRemainingOwnedOutputs(
  installation: ProjectInstallationManifest,
): Promise<{ readonly reason?: string; readonly owned: boolean }> {
  return proveOutputHashes(installation, false);
}

export async function proveOwnedInstallation(
  installation: ProjectInstallationManifest,
): Promise<{ readonly reason?: string; readonly owned: boolean }> {
  try {
    const markerStats = await lstat(markerPath(installation.project));
    if (markerStats.isSymbolicLink() || !markerStats.isFile()) {
      return { owned: false, reason: "Installation Marker is not a regular file" };
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { owned: false, reason: "Installation Marker is missing" };
    }
    throw error;
  }
  let marker;
  try {
    marker = await readMarker(installation.project);
  } catch (error) {
    return {
      owned: false,
      reason: `Installation Marker is malformed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!marker) return { owned: false, reason: "Installation Marker is missing" };
  if (marker.installationId !== installation.installationId) {
    return { owned: false, reason: "Installation Marker identity does not match the Manifest" };
  }
  return proveOutputHashes(installation, true);
}

export async function removeProvenInstallation(
  installation: ProjectInstallationManifest,
): Promise<void> {
  const transaction = await stageProvenInstallationRemoval(installation);
  await transaction.commit();
}

export interface ProvenInstallationRemovalTransaction {
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

export async function stageProvenInstallationRemoval(
  installation: ProjectInstallationManifest,
): Promise<ProvenInstallationRemovalTransaction> {
  const proof = await proveOwnedInstallation(installation);
  if (!proof.owned) {
    throw new Error(
      `Cannot remove Profile Installation at ${installation.project}: ${proof.reason ?? "ownership could not be proven"}`,
    );
  }
  const stage = await mkdtemp(join(installation.project, ".agent-profile-kit-remove-"));
  const moved: string[] = [];
  let settled = false;
  const cleanup = async (): Promise<void> => {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  };
  const rollback = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    for (const path of moved.reverse()) {
      const staged = join(stage, path.slice(installation.project.length + 1));
      await rename(staged, path).catch(() => undefined);
    }
    await cleanup();
  };
  try {
    for (const output of installation.outputs) {
      const path = join(installation.project, output.path);
      const staged = join(stage, output.path);
      await mkdir(dirname(staged), { recursive: true });
      await rename(path, staged);
      moved.push(path);
    }
  } catch (error) {
    await rollback();
    throw error;
  }
  return {
    rollback,
    commit: async () => {
      if (settled) return;
      settled = true;
      await cleanup();
    },
  };
}
