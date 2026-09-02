import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { compareCanonicalStrings } from "../schemas/installation-manifest.js";
import type {
  OwnershipFailureFact,
  StateReadFailureFact,
  TemporaryRemovalFailureFact,
} from "./blockers.js";

import {
  formatOwnershipState,
  OWNERSHIP_STATE_LIMITS,
  OWNERSHIP_STATE_SCHEMA_VERSION,
  parseOwnershipState,
  parseOwnershipStateDocument,
  type OwnershipOutputReceipt,
  type OwnershipReceipt,
  type OwnershipState,
  type ParsedOwnershipStateDocument,
} from "../schemas/ownership-state.js";
import {
  readVerifiedLegacyInstallationMarker,
  recordsLegacyInstallationMarkerPath,
  LEGACY_INSTALLATION_MARKER_PATH,
  withoutLegacyInstallationMarkerOutputs,
} from "./legacy-installation-marker.js";
import {
  createLifecycleOwnershipInspectionContext,
  recordedOutputMatches,
  unsafeOutputParent,
  type LifecycleOwnershipInspection,
  type OwnedOutputInspection,
} from "./lifecycle-ownership-inspection.js";
import {
  createLifecycleGitInspectionContext,
  type LifecycleGitInspection,
} from "./lifecycle-git-inspection.js";
import { UnprovableGitTopologyError, type GitProject } from "./git.js";
import {
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
        throw new StateReadFailureError({
          case: "oversize-state",
          limitBytes: OWNERSHIP_STATE_LIMITS.maxBytes,
        });
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
  return new StateReadFailureError({
    case: "legacy-yaml-state-expired",
    retiredPath: retiredInstallationStatePath(home),
  });
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
    return normalizePreviousVersionState(
      parseOwnershipStateDocument(
        await readInstallationStateSource(stateManifestPath(home)),
      ),
    );
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return emptyInstallationState();
    throw error;
  }
}

/**
 * The single ingestion boundary for previous-version documents (schema 6, 7,
 * and 8): legacy ownership-token output entries are ignored here, so every
 * downstream reader sees the current shape. Stored `repository_exclusion`
 * fields are already dropped by the schema parser itself, and any later
 * successful write publishes the current schema version.
 */
function normalizePreviousVersionState(state: ParsedOwnershipStateDocument): OwnershipState {
  if (state.schemaVersion === OWNERSHIP_STATE_SCHEMA_VERSION) {
    return state as OwnershipState;
  }
  const receipts = state.receipts.map((receipt) => {
    const normalized = withoutLegacyInstallationMarkerOutputs(receipt);
    if (normalized.outputs.length === 0) {
      throw new StateReadFailureError({
        case: "receipt-records-no-outputs",
        project: receipt.project,
      });
    }
    return normalized;
  });
  return { ...state, receipts, schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION };
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

export function newInstallationId(): string {
  return randomUUID();
}

export interface OwnershipProof {
  /**
   * Typed failure evidence when the proof does not hold; presentation owns
   * every rendered sentence keyed by the discriminant.
   */
  readonly failure?: OwnershipFailureFact;
  readonly owned: boolean;
}

/**
 * Authority proof for recorded generated output roots against the active
 * Installation Receipt. The durable continuity evidence is the receipt's own
 * recorded hashes: at least one extant recorded root must still match its
 * recorded hash, or every recorded root must be wholly absent. Wholly absent
 * roots and extant content, mode, and membership differences are freshness
 * drift that the ordinary refresh path restores; they never revoke authority.
 * Changed extant roots with no matching anchor cannot be distinguished from a
 * different Project later created at the same path, so they fail closed;
 * unsafe parents, unreadable output, and type mismatches also revoke
 * authority.
 */
export async function inspectInstallationOwnership(
  installation: OwnershipReceipt,
  inspection: LifecycleOwnershipInspection = createLifecycleOwnershipInspectionContext(),
): Promise<OwnershipProof> {
  const driftedPaths: string[] = [];
  let matchingRoots = 0;
  for (const output of installation.outputs) {
    const unsafeParent = await inspection.unsafeParent(installation.project, output.path);
    if (unsafeParent) {
      return {
        failure: { case: "unsafe-parent", output: output.path, parent: unsafeParent },
        owned: false,
      };
    }
    const result = await inspection.inspectOutput(installation.project, output);
    if (result.kind === "missing") {
      continue;
    }
    if (result.kind === "unreadable") {
      return {
        failure: { case: "unreadable-output", output: output.path },
        owned: false,
      };
    }
    if (result.kind !== output.type) {
      const failure: OwnershipFailureFact = result.unsupportedMember
        ? { case: "unsupported-entry", member: result.unsupportedMember, output: output.path }
        : { case: "type-mismatch", expected: output.type, output: output.path };
      return { failure, owned: false };
    }
    if (recordedOutputMatches(result, output)) matchingRoots += 1;
    else driftedPaths.push(output.path);
  }
  if (driftedPaths.length > 0 && matchingRoots === 0) {
    return {
      failure: { case: "no-ownership-continuity", output: driftedPaths[0]! },
      owned: false,
    };
  }
  return {
    owned: true,
  };
}

/**
 * Prove removal authority over one recorded installation: Installation identity,
 * path safety, and repository ownership. Freshness drift and wholly absent
 * roots never block removal; missing or foreign identity and Git-tracked
 * recorded roots do — Agent Profile Kit never deletes or untracks
 * repository-owned material.
 */
export async function proveOwnedInstallation(
  installation: OwnershipReceipt,
  inspection: LifecycleOwnershipInspection = createLifecycleOwnershipInspectionContext(),
  gitInspection: LifecycleGitInspection = createLifecycleGitInspectionContext(),
): Promise<OwnershipProof> {
  const inspectionResult = await inspectInstallationOwnership(installation, inspection);
  if (!inspectionResult.owned) {
    return {
      ...(inspectionResult.failure ? { failure: inspectionResult.failure } : {}),
      owned: false,
    };
  }
  const tracked = await trackedRoots(
    installation.project,
    installation.outputs.map((output) => output.path),
    gitInspection,
  );
  if (tracked.length > 0) {
    return {
      failure: { case: "git-tracked-output", outputs: tracked },
      owned: false,
    };
  }
  return { owned: true };
}

/**
 * The one tracked-root reader for every destructive removal surface: the
 * project-relative recorded roots the live Git index tracks, canonically
 * ordered. Ordinary and temporary removal share this fact. Unprovable Git
 * topology (DEC-009) cannot classify trackedness; removal proceeds best-effort
 * with no tracked roots rather than stalling teardown.
 */
async function trackedRoots(
  project: string,
  paths: readonly string[],
  gitInspection: LifecycleGitInspection,
): Promise<readonly string[]> {
  let gitProject: GitProject | undefined;
  try {
    gitProject = await gitInspection.findGitProject(project);
  } catch (error) {
    if (!(error instanceof UnprovableGitTopologyError)) throw error;
    return [];
  }
  if (!gitProject) return [];
  const tracked = await gitInspection.classifyTrackedDestinations(gitProject, paths);
  return paths.filter((path) => tracked.has(path)).sort(compareCanonicalStrings);
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

/**
 * Installation State could not be read for a reason the Installer classified.
 * The failure is a typed fact; presentation owns the rendered sentence.
 */
export class StateReadFailureError extends Error {
  readonly failure: StateReadFailureFact;

  constructor(failure: StateReadFailureFact) {
    super(`installation state read failed: ${failure.case}`);
    this.name = "StateReadFailureError";
    this.failure = failure;
  }
}

/**
 * A temporary installation removal is blocked: removal authority does not hold
 * for one or more recorded roots. The failure is a typed fact; presentation
 * owns the rendered sentence keyed by the blocker kind.
 */
export class TemporaryRemovalBlockedError extends Error {
  readonly failure: TemporaryRemovalFailureFact;

  constructor(failure: TemporaryRemovalFailureFact) {
    super(`temporary installation removal blocked: ${failure.case}`);
    this.name = "TemporaryRemovalBlockedError";
    this.failure = failure;
  }
}

/**
 * Ordinary installation removal is blocked: ownership proof does not hold for
 * the recorded installation. The failure is a typed fact; presentation owns
 * the rendered sentence.
 */
export class OwnershipBlockedRemovalError extends Error {
  readonly failure: OwnershipFailureFact;

  constructor(readonly project: string, failure: OwnershipFailureFact) {
    super(`installation removal blocked: ${project}: ${failure.case}`);
    this.name = "OwnershipBlockedRemovalError";
    this.failure = failure;
  }
}

/**
 * A staged removal could not be rolled back: some already-moved output roots
 * failed to restore, so the staging tree is the only surviving copy of those
 * bytes and is retained for recovery. This is never a skippable per-Project
 * removal condition — it is a tool error.
 */
export class StagedRollbackFailureError extends Error {
  readonly failures: readonly unknown[];

  constructor(message: string, failures: readonly unknown[] = []) {
    super(message);
    this.name = "StagedRollbackFailureError";
    this.failures = failures;
  }
}

export async function stageProvenInstallationRemoval(
  installation: OwnershipReceipt,
  inspection: LifecycleOwnershipInspection = createLifecycleOwnershipInspectionContext(),
  gitInspection: LifecycleGitInspection = createLifecycleGitInspectionContext(),
): Promise<ProvenInstallationRemovalTransaction> {
  const proof = await proveOwnedInstallation(installation, inspection, gitInspection);
  if (!proof.owned) {
    throw new OwnershipBlockedRemovalError(
      installation.project,
      proof.failure ?? { case: "unproven" },
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
    const restoreFailures: unknown[] = [];
    for (const path of moved.reverse()) {
      const staged = join(stage, path.slice(installation.project.length + 1));
      try {
        await rename(staged, path);
      } catch (error) {
        restoreFailures.push(error);
      }
    }
    if (restoreFailures.length > 0) {
      // Restoration failed: the staging tree is the only surviving copy of
      // the moved output. Retain it for recovery instead of deleting bytes
      // the receipt still claims are installed.
      throw new StagedRollbackFailureError(
        `staged output restore failed; staged bytes retained at ${stage}`,
        restoreFailures,
      );
    }
    await cleanup();
  };
  try {
    for (const relativePath of installation.outputs.map((output) => output.path)) {
      const path = join(installation.project, relativePath);
      // A wholly absent recorded root is proven removal authority, not a
      // failure: skip it and remove the surviving proven output.
      try {
        await lstat(path);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) continue;
        throw error;
      }
      const staged = join(stage, relativePath);
      await mkdir(dirname(staged), { recursive: true });
      await rename(path, staged);
      moved.push(path);
    }
    // Migration: a leftover ownership-token file from an earlier version leaves
    // with the recorded installation it belonged to — only when the receipt
    // does not record a legitimate output at the path and the bytes verify as
    // the previous version's token. Unknown content is preserved.
    if (
      !recordsLegacyInstallationMarkerPath(installation.outputs) &&
      (await readVerifiedLegacyInstallationMarker(
        installation.project,
        installation.installationId,
      )) !== undefined
    ) {
      const path = join(installation.project, LEGACY_INSTALLATION_MARKER_PATH);
      const staged = join(stage, LEGACY_INSTALLATION_MARKER_PATH);
      await mkdir(dirname(staged), { recursive: true });
      await rename(path, staged);
      moved.push(path);
    }
  } catch (error) {
    try {
      await rollback();
    } catch (rollbackFailure) {
      if (rollbackFailure instanceof StagedRollbackFailureError) {
        const original = error instanceof Error ? error.message : String(error);
        throw new StagedRollbackFailureError(
          `Cannot remove Project at ${installation.project}: ${original}; ${rollbackFailure.message}`,
          rollbackFailure.failures,
        );
      }
      throw rollbackFailure;
    }
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
 * Idempotently delete complete recorded temporary-owned roots without a
 * process-private staging tree. Removal authority is the active receipt this
 * output set was planned from; wholly missing roots converge so interrupted
 * deletes can finish on retry. Never traverses outside recorded
 * project-relative roots.
 */
export async function removeDisposableOutputs(options: {
  readonly installationId: string;
  readonly outputs: readonly OwnershipOutputReceipt[];
  readonly project: string;
}): Promise<void> {
  const project = options.project;

  const extantRoots: string[] = [];
  for (const output of options.outputs) {
    if (await pathExistsAt(project, output.path)) extantRoots.push(output.path);
  }

  if (extantRoots.length > 0) {
    // Git-tracked recorded roots are repository-owned material: removal never
    // deletes or untracks them, regardless of proven identity or drift.
    const tracked = await trackedRoots(project, extantRoots, createLifecycleGitInspectionContext());
    if (tracked.length > 0) {
      throw new TemporaryRemovalBlockedError({
        case: "git-tracked-output",
        outputs: tracked,
      });
    }
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
      throw new TemporaryRemovalBlockedError({
        case: "unsafe-parent",
        output: output.path,
        parent: unsafeParent,
      });
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
      throw new TemporaryRemovalBlockedError({ case: "symlink-output", output: output.path });
    }
    await rm(path, { recursive: true, force: true });
  }
}
