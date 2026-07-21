import {
  mkdir,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  formatInstallationState,
  INSTALLATION_MARKER_PATH,
  INSTALLATION_STATE_SCHEMA_VERSION,
  parseInstallationMarker,
  parseInstallationState,
  type InstallationMarker,
  type InstallationState,
  type OwnedDirectoryOutput,
  type OwnedOutput,
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
    const state = parseInstallationState(await readFile(stateManifestPath(home), "utf8"));
    return {
      ...state,
      installations: [...state.installations].sort((left, right) => left.project.localeCompare(right.project)),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return {
        installations: [],
        repositoryExclusions: [],
        schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
      };
    }
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
  await writeFile(
    temporary,
    formatInstallationState({
      ...state,
      installations: [...state.installations].sort((left, right) => left.project.localeCompare(right.project)),
    }),
    { flag: "wx" },
  );
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

async function unsafeOutputParent(
  project: string,
  relativePath: string,
): Promise<string | undefined> {
  const parts = relativePath.split("/");
  let parent = project;
  for (const part of parts.slice(0, -1)) {
    let stats;
    try {
      stats = await lstat(parent);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return undefined;
      if (hasErrorCode(error, "ENOTDIR")) return `${parent} is a non-directory parent`;
      throw error;
    }
    if (stats.isSymbolicLink()) return `${parent} is a symlink parent`;
    if (!stats.isDirectory()) return `${parent} is a non-directory parent`;
    parent = join(parent, part);
  }
  let stats;
  try {
    stats = await lstat(parent);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    if (hasErrorCode(error, "ENOTDIR")) return `${parent} is a non-directory parent`;
    throw error;
  }
  if (stats.isSymbolicLink()) return `${parent} is a symlink parent`;
  if (!stats.isDirectory()) return `${parent} is a non-directory parent`;
  return undefined;
}

export interface DirectoryOwnershipInspection {
  readonly driftedMembers: readonly string[];
  readonly missingMembers: readonly string[];
  readonly modeDriftedMembers: readonly string[];
  readonly unexpectedMembers: readonly string[];
}

async function listRelativeEntries(
  root: string,
  prefix = "",
): Promise<readonly { readonly kind: "directory" | "file" | "other"; readonly path: string }[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const result: { kind: "directory" | "file" | "other"; path: string }[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    const absolute = join(root, entry.name);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) {
      result.push({ kind: "other", path: relativePath });
      continue;
    }
    if (entry.isDirectory()) {
      result.push({ kind: "directory", path: relativePath });
      result.push(...await listRelativeEntries(absolute, relativePath));
      continue;
    }
    if (entry.isFile()) {
      result.push({ kind: "file", path: relativePath });
      continue;
    }
    result.push({ kind: "other", path: relativePath });
  }
  return result;
}

/** Inspect one owned artifact directory for missing, drifted, and unexpected members. */
export async function inspectOwnedDirectory(
  project: string,
  output: OwnedDirectoryOutput,
): Promise<DirectoryOwnershipInspection> {
  const root = join(project, output.path);
  const missingMembers: string[] = [];
  const driftedMembers: string[] = [];
  const modeDriftedMembers: string[] = [];
  const expected = new Map(output.members.map((member) => [member.path, member]));
  let onDisk: readonly { readonly kind: "directory" | "file" | "other"; readonly path: string }[] = [];
  try {
    const stats = await lstat(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return {
        driftedMembers: [],
        missingMembers: output.members.map((member) => `${output.path}/${member.path}`),
        modeDriftedMembers: [],
        unexpectedMembers: [],
      };
    }
    if ((stats.mode & 0o7777) !== output.mode) {
      modeDriftedMembers.push(output.path);
    }
    onDisk = await listRelativeEntries(root);
  } catch {
    return {
      driftedMembers: [],
      missingMembers: [output.path, ...output.members.map((member) => `${output.path}/${member.path}`)],
      modeDriftedMembers: [],
      unexpectedMembers: [],
    };
  }

  for (const member of output.members) {
    const absolute = join(root, member.path);
    const label = `${output.path}/${member.path}`;
    try {
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        missingMembers.push(label);
        continue;
      }
      if (member.type === "directory") {
        if (!stats.isDirectory()) {
          missingMembers.push(label);
          continue;
        }
        if ((stats.mode & 0o7777) !== member.mode) modeDriftedMembers.push(label);
        continue;
      }
      if (!stats.isFile()) {
        missingMembers.push(label);
        continue;
      }
      if ((stats.mode & 0o7777) !== member.mode) modeDriftedMembers.push(label);
      const content = await readFile(absolute);
      if (hashBytes(content) !== member.hash) driftedMembers.push(label);
    } catch {
      missingMembers.push(label);
    }
  }

  const unexpectedMembers = onDisk
    .filter((entry) => !expected.has(entry.path) || entry.kind === "other")
    .map((entry) => `${output.path}/${entry.path}`);

  return {
    driftedMembers,
    missingMembers,
    modeDriftedMembers,
    unexpectedMembers,
  };
}

async function proveFileOutput(
  project: string,
  output: Extract<OwnedOutput, { type: "file" }>,
): Promise<{ readonly drifted: boolean; readonly missing: boolean; readonly modeDrifted: boolean }> {
  const path = join(project, output.path);
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return { drifted: false, missing: true, modeDrifted: false };
    }
    const modeDrifted = (stats.mode & 0o7777) !== output.mode;
    const content = await readFile(path, "utf8");
    return {
      drifted: hashBytes(content) !== output.hash,
      missing: false,
      modeDrifted,
    };
  } catch {
    return { drifted: false, missing: true, modeDrifted: false };
  }
}

async function proveOutputHashes(
  installation: ProjectInstallationManifest,
  includeMarker: boolean,
): Promise<{ readonly reason?: string; readonly owned: boolean }> {
  const outputs = installation.outputs.filter(
    (output) => includeMarker || output.path !== INSTALLATION_MARKER_PATH,
  );
  if (outputs.length === 0) {
    return { owned: false, reason: "no remaining owned output proves the installation" };
  }
  const missing: string[] = [];
  const drifted: string[] = [];
  const modeDrifted: string[] = [];
  const unexpected: string[] = [];
  for (const output of outputs) {
    const unsafeParent = await unsafeOutputParent(installation.project, output.path);
    if (unsafeParent) {
      return { owned: false, reason: `owned output ${output.path} has unsafe parent: ${unsafeParent}` };
    }
    if (output.type === "file") {
      const proof = await proveFileOutput(installation.project, output);
      if (proof.missing) missing.push(output.path);
      if (proof.drifted) drifted.push(output.path);
      if (proof.modeDrifted) modeDrifted.push(output.path);
      continue;
    }
    const inspection = await inspectOwnedDirectory(installation.project, output);
    missing.push(...inspection.missingMembers);
    drifted.push(...inspection.driftedMembers);
    modeDrifted.push(...inspection.modeDriftedMembers);
    unexpected.push(...inspection.unexpectedMembers);
  }
  if (missing.length > 0 || drifted.length > 0 || modeDrifted.length > 0 || unexpected.length > 0) {
    const reasons = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(drifted.length > 0 ? [`drifted: ${drifted.join(", ")}`] : []),
      ...(modeDrifted.length > 0 ? [`drifted mode: ${modeDrifted.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unexpected: ${unexpected.join(", ")}`] : []),
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
