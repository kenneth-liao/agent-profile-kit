import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  INSTALLATION_MARKER_PATH,
  parseInstallationMarker,
  type InstallationMarker,
} from "../schemas/installation-manifest.js";
import {
  formatOwnershipState,
  OWNERSHIP_STATE_LIMITS,
  OWNERSHIP_STATE_SCHEMA_VERSION,
  parseOwnershipState,
  type OwnershipOutputReceipt,
  type OwnershipReceipt,
  type OwnershipState,
} from "../schemas/ownership-state.js";
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
async function readInstallationStateSource(path: string): Promise<string> {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(
        Math.min(STATE_READ_CHUNK_BYTES, OWNERSHIP_STATE_LIMITS.maxBytes + 1 - total),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > OWNERSHIP_STATE_LIMITS.maxBytes) {
        throw new Error(
          `Installation State exceeds the ${OWNERSHIP_STATE_LIMITS.maxBytes} byte limit`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

function retiredInstallationStatePath(home: string): string {
  return join(stateDirectory(home), "manifest.yaml");
}

function legacyStateClosedError(home: string): Error {
  return new Error(
    `Legacy YAML Installation State at ${retiredInstallationStatePath(home)} is unsupported because the migration window is closed. Use Agent Profile Kit 0.95.0 to migrate it to manifest.json, then retry this command. Agent Profile Kit never reconstructs ownership from generated output.`,
  );
}

export function emptyInstallationState(): OwnershipState {
  return {
    receipts: [],
    removedTemporaryInstallationIds: [],
    schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
  };
}

async function rejectRetiredInstallationState(home: string): Promise<void> {
  try {
    await lstat(retiredInstallationStatePath(home));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw legacyStateClosedError(home);
}

/** Read only the final strict JSON Installation State schema. */
export async function readInstallationState(home: string): Promise<OwnershipState> {
  await rejectRetiredInstallationState(home);
  try {
    return parseOwnershipState(
      await readInstallationStateSource(stateManifestPath(home)),
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return emptyInstallationState();
    throw error;
  }
}

export async function readTemporaryInstallations(
  home: string,
): Promise<readonly OwnershipReceipt[]> {
  return (await readInstallationState(home)).receipts.filter(
    (receipt) => receipt.lifetime === "temporary",
  );
}

export async function writeInstallationState(
  home: string,
  state: OwnershipState,
): Promise<void> {
  const source = formatOwnershipState(state);
  // Publication is allowed only when the production reader accepts the exact bytes.
  parseOwnershipState(source);

  const directory = stateDirectory(home);
  await mkdir(directory, { recursive: true });
  const destination = stateManifestPath(home);
  const temporary = join(directory, `.manifest-${process.pid}-${Date.now()}.tmp`);
  await writeFile(temporary, source, { flag: "wx" });
  try {
    await rename(temporary, destination);
    parseOwnershipState(await readInstallationStateSource(destination));
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
  output: OwnershipOutputReceipt,
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
  installation: OwnershipReceipt,
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
  installation: OwnershipReceipt,
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
  installation: OwnershipReceipt,
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
  const surviving: OwnershipReceipt = {
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
  installation: OwnershipReceipt,
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
  installation: OwnershipReceipt,
): Promise<void> {
  const transaction = await stageProvenInstallationRemoval(installation);
  await transaction.commit();
}

export interface ProvenInstallationRemovalTransaction {
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

export async function stageProvenInstallationRemoval(
  installation: OwnershipReceipt,
  inspection: LifecycleOwnershipInspection = createLifecycleOwnershipInspectionContext(),
): Promise<ProvenInstallationRemovalTransaction> {
  const proof = await proveOwnedInstallation(installation, inspection);
  if (!proof.owned) {
    throw new Error(
      `Cannot remove Project at ${installation.project}: ${proof.reason ?? "ownership could not be proven"}`,
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
    for (const relativePath of [
      ...installation.outputs.map((output) => output.path),
      INSTALLATION_MARKER_PATH,
    ]) {
      const path = join(installation.project, relativePath);
      const staged = join(stage, relativePath);
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
  readonly outputs: readonly OwnershipOutputReceipt[];
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
        `Cannot remove Temporary Profile Installation: Installation Marker is missing while owned output still exists (${extantRoots.join(", ")})`,
      );
    }
    if (marker.installationId !== options.installationId) {
      throw new Error(
        `Cannot remove Temporary Profile Installation: Installation Marker identity does not match the temporary installation`,
      );
    }
  } else if (marker && marker.installationId !== options.installationId) {
    throw new Error(
      `Cannot remove Temporary Profile Installation: Installation Marker identity does not match the temporary installation`,
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
        `Cannot remove Temporary Profile Installation: owned output ${output.path} has unsafe parent: ${unsafeParent}`,
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
        `Cannot remove Temporary Profile Installation: owned output ${output.path} is a symlink`,
      );
    }
    await rm(path, { recursive: true, force: true });
  }
  await rm(markerPath(project), { force: true });
}
