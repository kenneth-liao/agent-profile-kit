import {
  mkdir,
  lstat,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";

import {
  formatInstallationState,
  canonicalRepositoryExclusionRecord,
  compareCanonicalStrings,
  INSTALLATION_MARKER_PATH,
  INSTALLATION_STATE_MAX_BYTES,
  parseLegacyInstallationState,
  parsePreviousInstallationState,
  parseV4InstallationState,
  INSTALLATION_STATE_SCHEMA_VERSION,
  parseInstallationMarker,
  parseInstallationState,
  type InstallationMarker,
  type InstallationState,
  type OwnedDirectoryOutput,
  type OwnedOutput,
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";
import { findGitProject, gitExcludeEntry, type GitProject } from "./git.js";
import {
  createLifecycleOwnershipInspectionContext,
  unsafeOutputParent,
  type LifecycleOwnershipInspection,
  type OwnedOutputInspection,
} from "./lifecycle-ownership-inspection.js";
import {
  hashBytes,
  markerPath,
  stateManifestPath,
  stateDirectory,
} from "./project-plan.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

const STATE_READ_CHUNK_BYTES = 64 * 1024;

/** Read Installation State without ever buffering more than the accepted size. */
async function readInstallationStateSource(home: string): Promise<string> {
  const handle = await open(stateManifestPath(home), "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(STATE_READ_CHUNK_BYTES, INSTALLATION_STATE_MAX_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > INSTALLATION_STATE_MAX_BYTES) {
        throw new Error(
          `Installation State exceeds the ${INSTALLATION_STATE_MAX_BYTES} byte limit`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

export interface InstallationStateRead {
  readonly migrated: boolean;
  readonly state: InstallationState;
}

function slashPath(path: string): string {
  return path.split(sep).join("/");
}

/**
 * Resolve a legacy recorded project without making this lookup part of the
 * schema-v3 read path. It exists only to preserve v2 ownership during the
 * one-time state-boundary migration.
 */
async function gitProjectForLegacyInstallation(project: string): Promise<GitProject | undefined> {
  try {
    await lstat(project);
    return await findGitProject(project);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  let ancestor = dirname(project);
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return undefined;
    ancestor = parent;
  }
  const priorGit = await findGitProject(ancestor);
  if (!priorGit) return undefined;
  const relativeProject = slashPath(relative(priorGit.root, project));
  if (relativeProject === ".." || relativeProject.startsWith("../")) return undefined;
  return { ...priorGit, relativeProject };
}

async function migrateLegacyInstallationState(
  legacy: ReturnType<typeof parseLegacyInstallationState>,
): Promise<InstallationState> {
  const contributionsByTarget = new Map<string, {
    readonly entries: readonly string[];
    readonly installationId: string;
  }[]>();
  for (const installation of legacy.installations) {
    const git = await gitProjectForLegacyInstallation(installation.project);
    if (!git) continue;
    const targetContributions = contributionsByTarget.get(git.excludeFile) ?? [];
    targetContributions.push({
      entries: installation.outputs.map((output) => gitExcludeEntry(git, output.path)),
      installationId: installation.installationId,
    });
    contributionsByTarget.set(git.excludeFile, targetContributions);
  }
  const repositoryExclusions = [...contributionsByTarget.entries()]
    .sort(([left], [right]) => compareCanonicalStrings(left, right))
    .map(([target, contributions]) => canonicalRepositoryExclusionRecord(target, contributions));
  return {
    intendedTeardowns: [],
    installations: legacy.installations,
    repositoryExclusions,
    schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
    temporaryInstallations: [],
  };
}

type ParsedInstallationState =
  | { readonly schemaVersion: 5; readonly state: InstallationState }
  | { readonly schemaVersion: 4; readonly state: ReturnType<typeof parseV4InstallationState> }
  | { readonly schemaVersion: 3; readonly state: ReturnType<typeof parsePreviousInstallationState> }
  | { readonly schemaVersion: 2; readonly state: ReturnType<typeof parseLegacyInstallationState> };

function parseInstallationStateSource(source: string): ParsedInstallationState {
  let currentStateError: unknown;
  try {
    return { schemaVersion: 5, state: parseInstallationState(source) };
  } catch (error) {
    currentStateError = error;
  }

  try {
    return { schemaVersion: 4, state: parseV4InstallationState(source) };
  } catch {
    try {
      return { schemaVersion: 3, state: parsePreviousInstallationState(source) };
    } catch {
      try {
        return { schemaVersion: 2, state: parseLegacyInstallationState(source) };
      } catch {
        throw currentStateError;
      }
    }
  }
}

function normalizedInstallationState(state: InstallationState): InstallationState {
  return {
    ...state,
    // Retain the persisted legacy field until the final schema contraction, but
    // retire its records at ingestion so lifecycle code cannot assign meaning to them.
    intendedTeardowns: [],
    installations: [...state.installations].sort((left, right) => left.project.localeCompare(right.project)),
    temporaryInstallations: [...state.temporaryInstallations].sort((left, right) =>
      left.temporaryInstallationId.localeCompare(right.temporaryInstallationId)
    ),
  };
}

export function emptyInstallationState(): InstallationState {
  return {
    intendedTeardowns: [],
    installations: [],
    repositoryExclusions: [],
    schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
    temporaryInstallations: [],
  };
}

export async function readInstallationStateWithMigration(home: string): Promise<InstallationStateRead> {
  try {
    const source = await readInstallationStateSource(home);
    const parsed = parseInstallationStateSource(source);
    let state: InstallationState;
    switch (parsed.schemaVersion) {
      case 5:
        state = parsed.state;
        break;
      case 4:
        state = {
          intendedTeardowns: [],
          installations: parsed.state.installations,
          repositoryExclusions: parsed.state.repositoryExclusions,
          schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
          temporaryInstallations: [],
        };
        break;
      case 3:
        state = {
          intendedTeardowns: [],
          installations: parsed.state.installations,
          repositoryExclusions: parsed.state.repositoryExclusions,
          schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
          temporaryInstallations: [],
        };
        break;
      case 2:
        state = await migrateLegacyInstallationState(parsed.state);
        break;
    }
    return {
      migrated: parsed.schemaVersion !== 5 || state.installations.some(
        (installation) => installation.outputOrigins === undefined,
      ),
      state: normalizedInstallationState(state),
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return {
        migrated: false,
        state: emptyInstallationState(),
      };
    }
    throw error;
  }
}

export async function readInstallationState(home: string): Promise<InstallationState> {
  return (await readInstallationStateWithMigration(home)).state;
}

/**
 * Read only the temporary records needed by read-only inventory. Legacy state
 * cannot contain temporary records, so it is parsed without migrating ordinary
 * installations or inspecting their Project and Git state.
 */
export async function readTemporaryInstallations(
  home: string,
): Promise<InstallationState["temporaryInstallations"]> {
  let source: string;
  try {
    source = await readInstallationStateSource(home);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }
  const parsed = parseInstallationStateSource(source);
  return parsed.schemaVersion === 5 ? parsed.state.temporaryInstallations : [];
}

export async function writeInstallationState(
  home: string,
  state: InstallationState,
): Promise<void> {
  const source = formatInstallationState(normalizedInstallationState(state));
  // Publication is allowed only when the production reader accepts the exact bytes.
  parseInstallationState(source);

  const directory = stateDirectory(home);
  await mkdir(directory, { recursive: true });
  const destination = stateManifestPath(home);
  const temporary = join(directory, `.manifest-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, source, { flag: "wx" });
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

function proveFileOutput(
  inspection: OwnedOutputInspection,
  output: Extract<OwnedOutput, { type: "file" }>,
): { readonly drifted: boolean; readonly missing: boolean; readonly modeDrifted: boolean } {
  if (inspection.kind === "file") {
    return {
      drifted: inspection.contentHash !== output.hash,
      missing: false,
      modeDrifted: inspection.mode !== output.mode,
    };
  }
  return { drifted: false, missing: true, modeDrifted: false };
}

export type OwnershipFailureKind = "drift" | "malformed" | "missing";
export type OwnershipDriftKind = "generated-file" | "generated-root";

export interface OwnershipProof {
  readonly driftKind?: OwnershipDriftKind;
  readonly failureKind?: OwnershipFailureKind;
  readonly reason?: string;
  readonly owned: boolean;
}

async function proveOutputHashes(
  installation: ProjectInstallationManifest,
  includeMarker: boolean,
  inspection: LifecycleOwnershipInspection,
): Promise<OwnershipProof> {
  const outputs = installation.outputs.filter(
    (output) => includeMarker || output.path !== INSTALLATION_MARKER_PATH,
  );
  if (outputs.length === 0) {
    return {
      failureKind: "missing",
      owned: false,
      reason: "no remaining owned output proves the installation",
    };
  }
  const missing: string[] = [];
  const drifted: string[] = [];
  const modeDrifted: string[] = [];
  let directoryDrift = false;
  for (const output of outputs) {
    const unsafeParent = await inspection.unsafeParent(installation.project, output.path);
    if (unsafeParent) {
      return {
        failureKind: "drift",
        owned: false,
        reason: `owned output ${output.path} has unsafe parent: ${unsafeParent}`,
      };
    }
    const result = await inspection.inspectOutput(installation.project, output);
    if (output.type === "file") {
      const proof = proveFileOutput(result, output);
      if (proof.missing) missing.push(output.path);
      if (proof.drifted) drifted.push(output.path);
      if (proof.modeDrifted) modeDrifted.push(output.path);
      continue;
    }
    if (result.kind === "missing") {
      missing.push(output.path);
      continue;
    }
    if (result.kind !== "directory" || result.directoryHash !== output.hash) {
      drifted.push(output.path);
      directoryDrift = true;
    }
    if (result.kind === "directory" && result.mode !== output.mode) {
      modeDrifted.push(output.path);
      directoryDrift = true;
    }
  }
  if (missing.length > 0 || drifted.length > 0 || modeDrifted.length > 0) {
    const reasons = [
      ...(missing.length > 0 ? [`missing: ${missing.join(", ")}`] : []),
      ...(drifted.length > 0 ? [`drifted: ${drifted.join(", ")}`] : []),
      ...(modeDrifted.length > 0 ? [`drifted mode: ${modeDrifted.join(", ")}`] : []),
    ];
    return {
      ...(drifted.length > 0 || modeDrifted.length > 0
        ? { driftKind: directoryDrift ? "generated-root" as const : "generated-file" as const }
        : {}),
      failureKind: missing.length > 0 ? "missing" : "drift",
      owned: false,
      reason: `owned output ${reasons.join("; ")}`,
    };
  }
  return { owned: true };
}

/** Prove ownership from non-marker output hashes, for safe marker repair. */
export async function proveRemainingOwnedOutputs(
  installation: ProjectInstallationManifest,
  inspection: LifecycleOwnershipInspection = createLifecycleOwnershipInspectionContext(),
): Promise<OwnershipProof> {
  return proveOutputHashes(installation, false, inspection);
}

export interface InstallationOwnershipInspection extends OwnershipProof {
  readonly repairableMissingOutputs: readonly string[];
}

/**
 * Inspect the Installation Marker and every recorded output once, distinguishing
 * whole-output absence from ambiguous partial absence or drift. Reads are routed
 * through one shared ownership inspection result when a context is supplied.
 */
export async function inspectInstallationOwnership(
  installation: ProjectInstallationManifest,
  inspection: LifecycleOwnershipInspection = createLifecycleOwnershipInspectionContext(),
): Promise<InstallationOwnershipInspection> {
  const marker = await inspection.inspectMarker(installation.project);
  if (marker.kind === "other") {
    return {
      failureKind: "drift",
      owned: false,
      reason: "Installation Marker is not a regular file",
      repairableMissingOutputs: [],
    };
  }
  if (marker.kind === "missing") {
    return {
      failureKind: "missing",
      owned: false,
      reason: "Installation Marker is missing",
      repairableMissingOutputs: [],
    };
  }
  if (marker.malformed !== undefined) {
    return {
      failureKind: "malformed",
      owned: false,
      reason: `Installation Marker is malformed: ${marker.malformed}`,
      repairableMissingOutputs: [],
    };
  }
  if (!marker.value) {
    return {
      failureKind: "missing",
      owned: false,
      reason: "Installation Marker is missing",
      repairableMissingOutputs: [],
    };
  }
  if (marker.value.installationId !== installation.installationId) {
    return {
      failureKind: "drift",
      owned: false,
      reason: "Installation Marker identity does not match the Manifest",
      repairableMissingOutputs: [],
    };
  }

  const repairableMissingOutputs: string[] = [];
  for (const output of installation.outputs) {
    if (output.path === INSTALLATION_MARKER_PATH) continue;
    const unsafeParent = await inspection.unsafeParent(installation.project, output.path);
    if (unsafeParent) {
      return {
        failureKind: "drift",
        owned: false,
        reason: `owned output ${output.path} has unsafe parent: ${unsafeParent}`,
        repairableMissingOutputs: [],
      };
    }
    const result = await inspection.inspectOutput(installation.project, output);
    if (result.kind === "missing") {
      repairableMissingOutputs.push(output.path);
    }
  }
  const missingPaths = new Set(repairableMissingOutputs);
  const surviving: ProjectInstallationManifest = {
    ...installation,
    outputs: installation.outputs.filter(
      (output) => !missingPaths.has(output.path),
    ),
  };
  const proof = await proveOutputHashes(surviving, true, inspection);
  if (!proof.owned && repairableMissingOutputs.length > 0) {
    return {
      ...(proof.driftKind ? { driftKind: proof.driftKind } : {}),
      failureKind: "missing",
      owned: false,
      reason: `owned output missing: ${repairableMissingOutputs.join(", ")}; ${proof.reason ?? "surviving output ownership cannot be proven"}`,
      repairableMissingOutputs: [],
    };
  }
  return {
    ...proof,
    repairableMissingOutputs: proof.owned ? repairableMissingOutputs : [],
  };
}

export async function proveOwnedInstallation(
  installation: ProjectInstallationManifest,
  inspection: LifecycleOwnershipInspection = createLifecycleOwnershipInspectionContext(),
): Promise<OwnershipProof> {
  const inspectionResult = await inspectInstallationOwnership(installation, inspection);
  if (inspectionResult.repairableMissingOutputs.length > 0) {
    return {
      failureKind: "missing",
      owned: false,
      reason: `owned output missing: ${inspectionResult.repairableMissingOutputs.join(", ")}`,
    };
  }
  return inspectionResult;
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
  inspection: LifecycleOwnershipInspection = createLifecycleOwnershipInspectionContext(),
): Promise<ProvenInstallationRemovalTransaction> {
  const proof = await proveOwnedInstallation(installation, inspection);
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

async function pathExistsAt(project: string, relativePath: string): Promise<boolean> {
  try {
    await lstat(join(project, relativePath));
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * Idempotently delete complete recorded temporary-owned roots without hash-strict
 * ownership proof and without a process-private staging tree. Extant roots require
 * a matching Installation Marker (the durable recovery ownership token). Missing
 * roots converge so interrupted deletes can finish on retry. Never traverses
 * outside recorded project-relative roots.
 */
export async function removeDisposableOutputs(options: {
  readonly installationId: string;
  readonly outputs: readonly OwnedOutput[];
  readonly project: string;
}): Promise<void> {
  const project = options.project;
  const marker = await readMarker(project);

  const extantRoots: string[] = [];
  for (const output of options.outputs) {
    if (await pathExistsAt(project, output.path)) extantRoots.push(output.path);
  }

  if (extantRoots.length > 0) {
    if (!marker) {
      throw new Error(
        `Cannot remove Temporary Profile Installation at ${project}: Installation Marker is missing while owned output still exists (${extantRoots.join(", ")})`,
      );
    }
    if (marker.installationId !== options.installationId) {
      throw new Error(
        `Cannot remove Temporary Profile Installation at ${project}: Installation Marker identity does not match the temporary installation`,
      );
    }
  } else if (marker && marker.installationId !== options.installationId) {
    throw new Error(
      `Cannot remove Temporary Profile Installation at ${project}: Installation Marker identity does not match the temporary installation`,
    );
  }

  // Deepest paths first so nested owned roots are removed before ancestors when both are listed.
  const outputs = [...options.outputs].sort(
    (left, right) =>
      right.path.split("/").length - left.path.split("/").length ||
      right.path.localeCompare(left.path),
  );

  for (const output of outputs) {
    const unsafeParent = await unsafeOutputParent(project, output.path);
    if (unsafeParent) {
      throw new Error(
        `Cannot remove Temporary Profile Installation at ${project}: owned output ${output.path} has unsafe parent: ${unsafeParent}`,
      );
    }
    const path = join(project, output.path);
    let stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    // Refuse to follow a recorded root that is now a symlink pointing elsewhere.
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Cannot remove Temporary Profile Installation at ${project}: owned output ${output.path} is a symlink`,
      );
    }
    await rm(path, { recursive: true, force: true });
  }
}
