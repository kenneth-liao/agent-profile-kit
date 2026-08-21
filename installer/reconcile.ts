import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  INSTALLATION_MANIFEST_SCHEMA_VERSION,
  INSTALLATION_MARKER_PATH,
  INSTALLATION_STATE_SCHEMA_VERSION,
  type InstallationState,
  type OwnedOutput,
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";
import { artifactReferenceKey, type ArtifactReference } from "../schemas/dependencies.js";
import { formatInstallationMarker as markerText } from "../schemas/installation-manifest.js";
import {
  hashBytes,
  markerPath,
  outputPath,
  ownedMembersFromDesired,
  stateManifestPath,
  type DesiredInstallation,
  type DesiredProjectDirectoryOutput,
  type DesiredProjectOutput,
} from "./project-plan.js";
import {
  inspectInstallationOwnership,
  newInstallationId,
  proveOwnedInstallation,
  proveRemainingOwnedOutputs,
  readInstallationStateWithMigration,
  stageProvenInstallationRemoval,
  writeInstallationState,
  type OwnershipProof,
} from "./installation-state.js";
import type { GitProject } from "./git.js";
import {
  createLifecycleGitInspectionContext,
  type LifecycleGitInspection,
} from "./lifecycle-git-inspection.js";
import {
  createLifecycleOwnershipInspectionContext,
  type LifecycleOwnershipInspection,
  type OwnedOutputInspection,
} from "./lifecycle-ownership-inspection.js";
import {
  createProjectReadScheduler,
  type ProjectReadScheduler,
} from "./project-scheduler.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import { COMMAND_NAME } from "./version.js";
import {
  prepareRepositoryExclusionMovePreflight,
  gitExclusionBlockers,
  gitExclusionDiagnostics,
  replaceRepositoryExclusionContribution,
  repositoryExclusionChanges,
  stageGitExclusions,
  type RepositoryExclusionChange,
  type RepositoryExclusionRepair,
} from "./git-exclusions.js";
import {
  installationMarkerBlocker,
  installationOwnershipBlocker,
  installationStateUnreadableBlocker,
  normalizeBlocker,
  occupiedOutputBlocker,
  outputOwnershipConflictBlocker,
  type BlockerInput,
  type ProjectScopedBlockerInput,
  type ReconciliationBlocker,
} from "./blockers.js";

export type { ReconciliationBlocker } from "./blockers.js";

export interface ReconciliationFileSystem {
  readonly chmod: typeof chmod;
  readonly mkdir: typeof mkdir;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly writeFile: typeof writeFile;
}

export const nodeFileSystem: ReconciliationFileSystem = {
  chmod,
  mkdir,
  mkdtemp,
  rename,
  rm,
  writeFile,
};

export type ReconciliationKind =
  | "addition"
  | "blocked"
  | "current"
  | "drifted output"
  | "malformed ownership state"
  | "missing output"
  | "repairable missing output"
  | "removal"
  | "stale source"
  | "update";

export interface ReconciliationItem {
  readonly kind: ReconciliationKind;
  readonly project: string;
  readonly reason?: string;
}

export type OutputReconciliationKind =
  | "addition"
  | "drifted output"
  | "removal"
  | "repair"
  | "unchanged"
  | "update";

export interface OutputReconciliationItem {
  readonly kind: OutputReconciliationKind;
  readonly path: string;
  readonly project: string;
}

/** Complete consuming-Host evidence for one desired generated output path. */
export interface OutputConsumerEvidence {
  readonly consumingHosts: readonly string[];
  readonly path: string;
  readonly project: string;
}

export interface DesiredResolvedArtifactPreview {
  readonly id: string;
  readonly inclusionReasons: readonly {
    readonly path: readonly string[];
    readonly profile: string;
  }[];
  readonly type: string;
}

export interface ReconciliationReport {
  readonly blockers: readonly ReconciliationBlocker[];
  readonly desired: readonly {
    /** Canonical project identity used to group authored and expanded paths. */
    readonly canonicalProject: string;
    readonly capabilityContracts?: Readonly<Record<string, string>>;
    readonly context: string;
    readonly hosts: DesiredInstallation["binding"]["hosts"];
    readonly outputs: readonly string[];
    readonly profile: string;
    readonly project: string;
    readonly resolvedArtifacts: readonly DesiredResolvedArtifactPreview[];
    readonly setupSteps: DesiredInstallation["setupSteps"];
  }[];
  readonly items: readonly ReconciliationItem[];
  readonly outputs: readonly OutputReconciliationItem[];
  readonly outputConsumers: readonly OutputConsumerEvidence[];
  readonly repositoryExclusionRepairs: readonly RepositoryExclusionRepair[];
  readonly repositoryExclusions: readonly RepositoryExclusionChange[];
  /** Structured values referenced by lifecycle diagnostics and warnings. */
  readonly diagnosticValues: readonly string[];
  readonly warnings: readonly string[];
}

export type BlockedReconciliationReport = Omit<ReconciliationReport, "blockers"> & {
  readonly blockers: readonly [ReconciliationBlocker, ...ReconciliationBlocker[]];
};

/**
 * The two distinct snapshots produced by a successful apply.
 *
 * `receipt` records the pre-apply work that was executed. `resultingState` is a fresh
 * reconciliation against the state and project output committed by that work.
 * Keeping both snapshots explicit prevents presentation from treating a
 * preflight state as the resulting Profile Installation state.
 */
export interface ApplyReconciliationResult {
  readonly receipt: ReconciliationReport;
  readonly resultingState: ReconciliationReport;
}

/** Raised before writes when apply's preflight report contains actionable blockers. */
export class ApplyBlockedError extends Error {
  readonly report: BlockedReconciliationReport;

  constructor(report: BlockedReconciliationReport) {
    super("Apply blocked before writes");
    this.name = "ApplyBlockedError";
    this.report = report;
  }
}

/** Raised only after all apply writes have committed but verification could not complete. */
export class ApplyVerificationError extends Error {
  readonly receipt: ReconciliationReport;

  constructor(receipt: ReconciliationReport, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Apply committed; post-apply verification failed: ${detail}`, { cause });
    this.name = "ApplyVerificationError";
    this.receipt = receipt;
  }
}

/** Render an unreadable Installation State as one canonical lifecycle blocker. */
export async function unreadableInstallationStateReport(
  home: string,
  desired: readonly DesiredInstallation[],
  error: unknown,
): Promise<BlockedReconciliationReport> {
  const message = error instanceof Error ? error.message : String(error);
  const desiredReport = await previewReconciliation(desired, {
    intendedTeardowns: [],
    installations: [],
    repositoryExclusions: [],
    temporaryInstallations: [],
    schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
  });
  return {
    ...desiredReport,
    blockers: [normalizeBlocker(installationStateUnreadableBlocker({
      message,
      statePath: stateManifestPath(home),
    }))],
    // Ownership cannot be read, so planned project states and output changes
    // are not trustworthy diagnostics. Keep only the boundary failure.
    items: [{
      kind: "malformed ownership state",
      project: stateManifestPath(home),
      reason: message,
    }],
    outputs: [],
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function hostVersionsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every(
    (key, index) => key === rightKeys[index] && left[key] === right[key],
  );
}

function outputRelativePath(output: DesiredProjectOutput): string {
  return output.path.replaceAll("\\", "/");
}

function markerRelativePath(): string {
  return INSTALLATION_MARKER_PATH;
}

interface StagedFileOutput {
  readonly bytes: string | Uint8Array;
  readonly hash: string;
  readonly mode: number;
  readonly path: string;
  readonly type: "file";
}

interface StagedDirectoryOutput {
  readonly hash: string;
  readonly members: DesiredProjectDirectoryOutput["members"];
  readonly mode: number;
  readonly path: string;
  readonly type: "directory";
}

type StagedProjectOutput = StagedDirectoryOutput | StagedFileOutput;

function markerOutput(installationId: string): StagedFileOutput {
  const bytes = markerText({ installationId, schemaVersion: 1 });
  return {
    bytes,
    hash: hashMarker(bytes),
    mode: 0o644,
    path: markerRelativePath(),
    type: "file",
  };
}

function hashMarker(bytes: string | Uint8Array): string {
  // Keep this helper local so the marker participates in the same output hash
  // set without making the canonical manifest a second source of content.
  return hashBytes(bytes);
}

function ownedOutputFromDesired(output: DesiredProjectOutput): OwnedOutput {
  if (output.type === "file") {
    return {
      hash: output.hash,
      mode: output.mode,
      path: outputRelativePath(output),
      type: "file",
    };
  }
  return {
    hash: output.hash,
    members: ownedMembersFromDesired(output.members),
    mode: output.mode,
    path: outputRelativePath(output),
    type: "directory",
  };
}

/**
 * Complete the provenance evidence of a legacy manifest from current trusted
 * desired state without rewriting any recorded ownership evidence. Short-circuits
 * when the manifest already carries complete provenance.
 */
export function provenanceFromDesired(
  manifest: ProjectInstallationManifest,
  desired: DesiredInstallation,
): ProjectInstallationManifest {
  if (manifest.outputOrigins !== undefined) return manifest;
  const fingerprintByReference = new Map(
    desired.artifactFingerprints.map((fingerprint) => [
      artifactReferenceKey(fingerprint.reference),
      fingerprint.fingerprint,
    ]),
  );
  const outputOrigins: Record<string, readonly ArtifactReference[]> = {};
  for (const output of desired.outputs) {
    outputOrigins[output.path] = output.origins;
  }
  outputOrigins[markerRelativePath()] = [];
  for (const output of manifest.outputs) {
    if (!(output.path in outputOrigins)) {
      throw new Error(
        `Cannot backfill provenance for legacy output '${output.path}': no matching desired output`,
      );
    }
  }
  return {
    ...manifest,
    outputOrigins,
    resolvedArtifacts: manifest.resolvedArtifacts.map((artifact) => {
      const fingerprint = fingerprintByReference.get(
        artifactReferenceKey(artifact.reference),
      );
      if (fingerprint === undefined) {
        throw new Error(
          `Cannot backfill provenance for resolved artifact '${artifactReferenceKey(artifact.reference)}': no normalized fingerprint`,
        );
      }
      return { ...artifact, fingerprint };
    }),
  };
}

function backfillLegacyProvenance(
  state: InstallationState,
  desired: readonly DesiredInstallation[],
): InstallationState {
  const byProject = new Map(
    desired.map((installation) => [
      installation.binding.canonicalProject,
      installation,
    ]),
  );
  return {
    ...state,
    installations: state.installations.map((installation) => {
      const matching = byProject.get(installation.project);
      return matching === undefined
        ? installation
        : provenanceFromDesired(installation, matching);
    }),
  };
}

export function manifestFor(
  desired: DesiredInstallation,
  installationId: string,
): ProjectInstallationManifest {
  const marker = markerText({ installationId, schemaVersion: 1 });
  const outputs: OwnedOutput[] = [
    ...desired.outputs.map(ownedOutputFromDesired),
    { hash: hashMarker(marker), mode: 0o644, path: markerRelativePath(), type: "file" as const },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const fingerprintByReference = new Map(
    desired.artifactFingerprints.map((fingerprint) => [
      artifactReferenceKey(fingerprint.reference),
      fingerprint.fingerprint,
    ]),
  );
  const outputOrigins: Record<string, readonly ArtifactReference[]> = {};
  // Origins were validated against the resolved Profile at the planning boundary.
  for (const output of desired.outputs) {
    outputOrigins[output.path] = output.origins;
  }
  outputOrigins[markerRelativePath()] = [];
  return {
    adapterVersion: desired.adapterVersion,
    engineVersion: desired.engineVersion,
    gitProject: desired.gitProject !== undefined,
    hosts: desired.binding.hosts,
    hostVersions: desired.hostVersions,
    installationId,
    outputOrigins,
    outputs,
    profileId: desired.profile.id,
    project: desired.binding.canonicalProject,
    resolvedArtifacts: desired.resolvedProfile.artifacts.map((artifact) => {
      const fingerprint = fingerprintByReference.get(
        artifactReferenceKey(artifact.reference),
      );
      if (fingerprint === undefined) {
        throw new Error(
          `Missing normalized fingerprint for resolved artifact '${artifactReferenceKey(artifact.reference)}'`,
        );
      }
      return {
        fingerprint,
        inclusionReasons: artifact.inclusionReasons.map((reason) => ({
          path: reason.path,
          profile: reason.profileId,
        })),
        reference: artifact.reference,
      };
    }),
    schemaVersion: INSTALLATION_MANIFEST_SCHEMA_VERSION,
    selectedContext: desired.profile.context,
    workspaceInputHash: desired.sourceHash,
  };
}

function stateWithInstallationExclusion(
  state: InstallationState,
  installation: ProjectInstallationManifest,
  gitProject: DesiredInstallation["gitProject"],
): InstallationState {
  return {
    intendedTeardowns: [],
    installations: state.installations,
    repositoryExclusions: replaceRepositoryExclusionContribution(
      state.repositoryExclusions,
      installation.installationId,
      gitProject,
      installation.outputs,
    ),
    schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
    temporaryInstallations: state.temporaryInstallations,
  };
}

async function pathKind(path: string): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "missing";
    if (hasErrorCode(error, "ENOTDIR")) return "other";
    throw error;
  }
}

async function parentConflicts(project: string, path: string): Promise<readonly BlockerInput[]> {
  const blockers: BlockerInput[] = [];
  let parent = dirname(path);
  while (parent !== project && parent.startsWith(`${project}/`)) {
    const kind = await pathKind(parent);
    if (kind !== "missing" && kind !== "directory") {
      blockers.push(occupiedOutputBlocker({
        message: `${parent} is an occupied ${kind} parent path`,
        path: parent.slice(project.length + 1),
        project,
      }));
      break;
    }
    parent = dirname(parent);
  }
  return blockers;
}

function fileOutputMatches(
  inspection: OwnedOutputInspection,
  output: Extract<OwnedOutput, { type: "file" }>,
): boolean {
  return (
    inspection.kind === "file" &&
    inspection.mode === output.mode &&
    inspection.contentHash === output.hash
  );
}

function directoryOutputMatches(
  inspection: OwnedOutputInspection,
  output: Extract<OwnedOutput, { type: "directory" }>,
): boolean {
  return (
    inspection.kind === "directory" &&
    inspection.mode === output.mode &&
    inspection.directoryHash === output.hash
  );
}

async function ownedOutputMatches(
  project: string,
  output: OwnedOutput,
  inspection: LifecycleOwnershipInspection,
): Promise<boolean> {
  const result = await inspection.inspectOutput(project, output);
  if (output.type === "file") return fileOutputMatches(result, output);
  return directoryOutputMatches(result, output);
}

export async function desiredOutputConflicts(
  desired: DesiredInstallation,
  previous: ProjectInstallationManifest | undefined,
  installationId: string,
  gitInspection: LifecycleGitInspection = createLifecycleGitInspectionContext(),
): Promise<readonly BlockerInput[]> {
  const blockers: BlockerInput[] = [];
  const project = desired.binding.canonicalProject;
  const previousOutputs = new Map(previous?.outputs.map((output) => [output.path, output]) ?? []);
  const outputs: OwnedOutput[] = [
    ...desired.outputs.map(ownedOutputFromDesired),
    {
      hash: hashMarker(markerText({ installationId, schemaVersion: 1 })),
      mode: 0o644,
      path: markerRelativePath(),
      type: "file" as const,
    },
  ];
  // Prefer the topology already proven for this Desired Installation; fall back
  // only when a caller constructed desired state without Git evidence.
  const gitProject: GitProject | undefined = desired.gitProject ??
    await gitInspection.findGitProject(project);
  const trackedPathSet = gitProject === undefined
    ? new Set<string>()
    : await gitInspection.classifyTrackedDestinations(
      gitProject,
      outputs.map((output) => output.path),
    );
  const trackedPaths: string[] = [];
  for (const output of outputs) {
    const absolute = outputPath(project, output);
    if (trackedPathSet.has(output.path)) {
      trackedPaths.push(output.path);
      continue;
    }
    const old = previousOutputs.get(output.path);
    if (old?.type === output.type) {
      // Recorded outputs are checked once by ownership inspection at the
      // current root, including the Marker-proven destination of a move.
      // This preflight owns only conflicts at new desired destinations.
      continue;
    }
    blockers.push(...await parentConflicts(project, absolute));
    const kind = await pathKind(absolute);
    if (kind === "missing") continue;
    if (output.type === "file") {
      if (kind !== "file") {
        blockers.push(occupiedOutputBlocker({
          message: `${absolute} is an occupied ${kind} path`,
          path: output.path,
          project,
        }));
        continue;
      }
      blockers.push(occupiedOutputBlocker({
        message: `${absolute} is occupied by unowned or drifted output`,
        path: output.path,
        project,
      }));
      continue;
    }
    if (kind !== "directory") {
      blockers.push(occupiedOutputBlocker({
        message: `${absolute} is an occupied ${kind} path`,
        path: output.path,
        project,
      }));
      continue;
    }
    blockers.push(occupiedOutputBlocker({
      message: `${absolute} is an occupied unowned artifact directory`,
      path: output.path,
      project,
    }));
  }
  if (trackedPaths.length > 0) {
    blockers.push(outputOwnershipConflictBlocker({
      paths: trackedPaths,
      project,
    }));
  }
  return blockers;
}

async function identityBlockers(
  desired: DesiredInstallation,
  state: InstallationState,
  installationId: string,
  inspection: LifecycleOwnershipInspection,
): Promise<readonly BlockerInput[]> {
  const project = desired.binding.canonicalProject;
  const marker = markerPath(project);
  const markerEvidence = await inspection.inspectMarker(project);
  if (markerEvidence.kind === "missing") return [];
  if (markerEvidence.kind === "other") {
    return [installationMarkerBlocker({
      message: `${marker} is not a regular Installation Marker file`,
      project,
    })];
  }
  if (markerEvidence.malformed !== undefined) {
    return [installationMarkerBlocker({
      message: `${marker} is malformed: ${markerEvidence.malformed}`,
      project,
    })];
  }
  const markerValue = markerEvidence.value;
  if (!markerValue) {
    return [installationMarkerBlocker({ message: `${marker} is missing`, project })];
  }
  const owner = state.installations.find((installation) => installation.installationId === markerValue.installationId);
  if (owner && owner.project !== project) {
    if ((await pathKind(owner.project)) === "missing") return [];
    return [installationMarkerBlocker({
      message: `${marker} copies Installation Marker identity owned by ${owner.project}`,
      project,
    })];
  }
  if (!owner && markerValue.installationId !== installationId) {
    return [installationMarkerBlocker({
      message:
        `${marker} contains an unknown Installation Marker identity; restore the Marker ` +
        "linked to this project's Manifest or remove the unowned generated paths before retrying",
      project,
    })];
  }
  return [];
}

async function previousFor(
  desired: DesiredInstallation,
  state: InstallationState,
  byProject: ReadonlyMap<string, ProjectInstallationManifest>,
  inspection: LifecycleOwnershipInspection,
): Promise<ProjectInstallationManifest | undefined> {
  const canonicalProject = desired.binding.canonicalProject;
  const direct = byProject.get(canonicalProject);
  if (direct) return direct;
  const markerEvidence = await inspection.inspectMarker(canonicalProject);
  const marker = markerEvidence.malformed === undefined ? markerEvidence.value : undefined;
  if (!marker) return undefined;
  const owner = state.installations.find(
    (installation) => installation.installationId === marker.installationId,
  );
  if (!owner || owner.project === canonicalProject) return undefined;
  return (await pathKind(owner.project)) === "missing" ? owner : undefined;
}

interface InstallationRetirementSelection {
  readonly intentionallyDeletedInstallationIds: ReadonlySet<string>;
  readonly intentionallyDeletedProjects: ReadonlySet<string>;
  readonly movedPreviousProjects: ReadonlySet<string>;
}

/**
 * Select stale installations that may be retired without project-tree ownership
 * proof after an exact-path unbind. Both preview and apply use this same reader
 * so deletion intent cannot silently lose its exclusion-ownership safeguards.
 * Independent per-Project reads run through the shared bounded scheduler; the
 * deletion-intent selection folds in canonical order afterwards.
 */
async function installationRetirementSelection(
  desired: readonly DesiredInstallation[],
  state: InstallationState,
  inspection: LifecycleOwnershipInspection,
  scheduler: ProjectReadScheduler = createProjectReadScheduler(),
): Promise<InstallationRetirementSelection> {
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  const byProject = new Map(state.installations.map((installation) => [installation.project, installation]));
  const movedPreviousProjects = new Set<string>();
  const previousProjects = await scheduler.run(desired.map((installation) => async () => {
    const previous = await previousFor(installation, state, byProject, inspection);
    return previous && previous.project !== installation.binding.canonicalProject
      ? previous.project
      : undefined;
  }));
  for (const previousProject of previousProjects) {
    if (previousProject !== undefined) movedPreviousProjects.add(previousProject);
  }
  // Local Configuration is the sole canonical desired-state record. A successful
  // exact-path `unbind` (or an equivalent supported hand edit) is represented by
  // the binding's absence; no second retirement tombstone is persisted.
  const intentionallyDeletedProjects = new Set<string>();
  const retiredCandidates = state.installations.filter((installation) =>
    !desiredProjects.has(installation.project) &&
    !movedPreviousProjects.has(installation.project),
  );
  const deletedProjects = await scheduler.run(retiredCandidates.map((installation) => async () => {
    return (await pathKind(installation.project)) === "missing"
      ? installation.project
      : undefined;
  }));
  for (const deletedProject of deletedProjects) {
    if (deletedProject !== undefined) intentionallyDeletedProjects.add(deletedProject);
  }
  return {
    intentionallyDeletedInstallationIds: new Set(
      state.installations
        .filter((installation) => intentionallyDeletedProjects.has(installation.project))
        .map((installation) => installation.installationId),
    ),
    intentionallyDeletedProjects,
    movedPreviousProjects,
  };
}

function ownershipBlocker(project: string, proof: OwnershipProof): ProjectScopedBlockerInput {
  const reason = proof.reason ?? "ownership could not be proven";
  let message: string;
  if (proof.driftKind) {
    const generatedBoundary = proof.driftKind === "generated-root" ? "root" : "file";
    message =
      `Cannot reconcile Profile Installation at ${project}: ${reason}. ` +
      "Agent Profile Kit will not overwrite your edit. Move the change into the Workspace, " +
      `or delete the generated ${generatedBoundary}, then run ${COMMAND_NAME} apply to restore it`;
  } else {
    message = `Cannot reconcile Profile Installation at ${project}: ${reason}`;
  }
  return installationOwnershipBlocker({ message, project });
}

/** Host-agnostic: any Adapter file carrying the canonical Context envelope. */
function composedContextFromOutputs(outputs: readonly DesiredProjectOutput[]): string {
  for (const output of outputs) {
    if (output.type !== "file") continue;
    const bytes = typeof output.bytes === "string"
      ? output.bytes
      : Buffer.from(output.bytes).toString("utf8");
    if (bytes.startsWith("# Agent Profile Kit Context\n")) return bytes;
  }
  return "";
}

function directoryRootRequiresAttention(
  output: Extract<OwnedOutput, { type: "directory" }>,
  inspection: OwnedOutputInspection,
): boolean {
  return inspection.kind !== "missing" && !directoryOutputMatches(inspection, output);
}

export interface PreviewReconciliationOptions {
  /**
   * Invocation-scoped Git inspection reader. When omitted, one short-lived
   * context is created for this pass only.
   */
  readonly gitInspection?: LifecycleGitInspection;
  /**
   * Invocation-scoped ownership inspection reader. When omitted, one short-lived
   * context is created for this pass only. One reconciliation pass must reuse a
   * single context so each owned output is read or walked at most once.
   */
  readonly ownershipInspection?: LifecycleOwnershipInspection;
  /**
   * Invocation-scoped bounded scheduler for independent per-Project planning and
   * inspection reads, shared with desired-state planning and apply so one
   * concurrency boundary governs the whole lifecycle. When omitted, one
   * short-lived scheduler is created for this pass only.
   */
  readonly scheduler?: ProjectReadScheduler;
}

export async function previewReconciliation(
  desired: readonly DesiredInstallation[],
  state: InstallationState,
  options: PreviewReconciliationOptions = {},
): Promise<ReconciliationReport> {
  const gitInspection = options.gitInspection ?? createLifecycleGitInspectionContext();
  const inspection = options.ownershipInspection ?? createLifecycleOwnershipInspectionContext();
  const scheduler = options.scheduler ?? createProjectReadScheduler();
  const items: ReconciliationItem[] = [];
  const outputItems: OutputReconciliationItem[] = [];
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  const byProject = new Map(state.installations.map((installation) => [installation.project, installation]));
  const {
    intentionallyDeletedInstallationIds,
    intentionallyDeletedProjects,
    movedPreviousProjects,
  } = await installationRetirementSelection(desired, state, inspection, scheduler);
  const blockers: ReconciliationBlocker[] = desired.flatMap((installation) =>
    installation.blockers.map((input) =>
      normalizeBlocker(input, installation.binding.canonicalProject)
    )
  );
  blockers.push(...(await gitExclusionBlockers(state, desired, {
    gitInspection,
    retiringInstallationIds: intentionallyDeletedInstallationIds,
  })));
  const exclusionDiagnostics = await gitExclusionDiagnostics(state, desired, { gitInspection });
  const desiredReport = desired.map((installation) => {
    return {
      canonicalProject: installation.binding.canonicalProject,
      capabilityContracts: installation.hostVersions,
      context: composedContextFromOutputs(installation.outputs),
      hosts: installation.binding.hosts,
      outputs: [
        ...installation.outputs.map((output) => output.path),
        ".agent-profile-kit/installation.json",
      ],
      profile: installation.profile.id,
      project: installation.binding.project,
      resolvedArtifacts: installation.resolvedProfile.artifacts.map((artifact) => ({
        id: artifact.reference.id,
        inclusionReasons: artifact.inclusionReasons.map((reason) => ({
          path: reason.path.map((reference) => `${reference.type}:${reference.id}`),
          profile: reason.profileId,
        })),
        type: artifact.reference.type,
      })),
      setupSteps: installation.setupSteps,
    };
  });
  const outputConsumers = desired
    .flatMap((installation) => installation.outputs.map((output) => ({
      consumingHosts: [...output.consumingHosts],
      path: output.path,
      project: installation.binding.project,
    })))
    .sort((left, right) =>
      left.project.localeCompare(right.project) || left.path.localeCompare(right.path)
    );
  // Independent per-Project planning and inspection reads run through the shared
  // bounded scheduler (DEC-014); exclusion projections and report accumulation
  // fold in canonical input order afterwards so scheduling order is never
  // observable in human or machine output (DEC-016).
  const desiredResults = await scheduler.run(desired.map((installation) => async () => {
    const previous = await previousFor(installation, state, byProject, inspection);
    const moved = previous && previous.project !== installation.binding.canonicalProject;
    const id = previous?.installationId ?? newInstallationId();
    const projectedManifest = manifestFor(installation, id);
    const proposedOutputs: OwnedOutput[] = [
      ...installation.outputs.map(ownedOutputFromDesired),
      {
        hash: hashMarker(markerText({ installationId: id, schemaVersion: 1 })),
        mode: 0o644,
        path: markerRelativePath(),
        type: "file" as const,
      },
    ];
    const previousOutputs = new Map(previous?.outputs.map((output) => [output.path, output]) ?? []);
    const ownershipTarget = previous && moved
      ? { ...previous, project: installation.binding.canonicalProject }
      : previous;
    const ownership = ownershipTarget
      ? await inspectInstallationOwnership(ownershipTarget, inspection)
      : undefined;
    const proposedOutputPaths = new Set(proposedOutputs.map((output) => output.path));
    const repairableMissingOutputs = new Set(
      (ownership?.repairableMissingOutputs ?? []).filter((path) => proposedOutputPaths.has(path)),
    );
    const projectOutputItems: OutputReconciliationItem[] = [];
    for (const output of proposedOutputs) {
      const previousOutput = previousOutputs.get(output.path);
      let kind: OutputReconciliationKind = repairableMissingOutputs.has(output.path)
        ? "repair"
        : previousOutput === undefined
        ? "addition"
        : previousOutput.hash === output.hash &&
            previousOutput.mode === output.mode &&
            previousOutput.type === output.type
          ? "unchanged"
          : "update";
      if (
        previousOutput?.type === "directory" &&
        previous &&
        kind !== "repair" &&
        directoryRootRequiresAttention(
          previousOutput,
          await inspection.inspectOutput(installation.binding.canonicalProject, previousOutput),
        )
      ) {
        kind = "drifted output";
      }
      projectOutputItems.push({
        kind,
        path: output.path,
        project: installation.binding.project,
      });
      previousOutputs.delete(output.path);
    }
    for (const [path, previousOutput] of previousOutputs) {
      const kind: OutputReconciliationKind =
        previousOutput.type === "directory" &&
          previous &&
          directoryRootRequiresAttention(
            previousOutput,
            await inspection.inspectOutput(installation.binding.canonicalProject, previousOutput),
          )
          ? "drifted output"
          : "removal";
      projectOutputItems.push({
        kind,
        path,
        project: installation.binding.project,
      });
    }
    const project = installation.binding.canonicalProject;
    const projectBlockers: ReconciliationBlocker[] = [];
    const outputConflicts = await desiredOutputConflicts(
      installation,
      previous,
      id,
      gitInspection,
    );
    projectBlockers.push(
      ...(await identityBlockers(installation, state, id, inspection)).map((input) =>
        normalizeBlocker(input, project)
      ),
      ...outputConflicts.map((input) => normalizeBlocker(input, project)),
    );
    if (!previous && outputConflicts.length > 0) {
      let copiedInstallation = false;
      for (const candidate of state.installations) {
        if (!intentionallyDeletedProjects.has(candidate.project)) continue;
        const copiedOutputs = candidate.outputs.filter((output) => output.path !== markerRelativePath());
        if (
          copiedOutputs.length > 0 &&
          (await Promise.all(copiedOutputs.map((output) => ownedOutputMatches(project, output, inspection)))).every(Boolean)
        ) {
          copiedInstallation = true;
          break;
        }
      }
      if (copiedInstallation) {
        projectBlockers.push(normalizeBlocker(
          {
            ...ownershipBlocker(
              installation.binding.project,
              {
                failureKind: "missing",
                owned: false,
                reason: "Installation Marker is missing; if this project moved, restore its Manifest-linked Installation Marker at the new root before retrying",
              },
            ),
            project,
          },
          project,
        ));
      }
    }
    const projectItems: ReconciliationItem[] = [];
    if (!previous) {
      projectItems.push({
        kind: "addition",
        project: installation.binding.project,
      });
    } else if (moved) {
      if (ownership && !ownership.owned) {
        projectBlockers.push(normalizeBlocker(
          { ...ownershipBlocker(installation.binding.project, ownership), project },
          project,
        ));
      }
      projectItems.push({
        kind: "update",
        project: installation.binding.project,
        reason: "project moved",
      });
    } else {
      const markerEvidence = await inspection.inspectMarker(installation.binding.canonicalProject);
      const proof = ownership ?? await inspectInstallationOwnership(previous, inspection);
      let repairableMissingMarker = false;
      if (markerEvidence.kind === "missing") {
        const remaining = await proveRemainingOwnedOutputs(previous, inspection);
        repairableMissingMarker = remaining.owned;
        if (!remaining.owned) {
          projectBlockers.push(normalizeBlocker(
            {
              ...ownershipBlocker(installation.binding.project, {
                ...remaining,
                reason: `Installation Marker is missing and ${remaining.reason ?? "remaining output ownership cannot be proven"}`,
              }),
              project,
            },
            project,
          ));
        }
      } else if (!proof.owned) {
        projectBlockers.push(normalizeBlocker(
          { ...ownershipBlocker(installation.binding.project, proof), project },
          project,
        ));
      }
      const repairableMissingOutput = repairableMissingOutputs.size > 0;
      if (!proof.owned && !repairableMissingMarker && !repairableMissingOutput) {
        projectItems.push({
          kind: proof.failureKind === "malformed"
            ? "malformed ownership state"
            : proof.failureKind === "missing"
              ? "missing output"
              : "drifted output",
          project: installation.binding.project,
          ...(proof.reason ? { reason: proof.reason } : {}),
        });
      // Surface safe recreation ahead of stale source because apply repairs from
      // that current source; missing-Marker repair does not restore project output.
      } else if (repairableMissingOutput) {
        projectItems.push({
          kind: "repairable missing output",
          project: installation.binding.project,
          reason: [...repairableMissingOutputs].join(", "),
        });
      } else if (previous.workspaceInputHash !== installation.sourceHash) {
        projectItems.push({
          kind: "stale source",
          project: installation.binding.project,
        });
      } else if (
        previous.adapterVersion !== installation.adapterVersion ||
        !hostVersionsEqual(previous.hostVersions, installation.hostVersions) ||
        previous.hosts.join("\n") !== installation.binding.hosts.join("\n") ||
        previous.profileId !== installation.profile.id ||
        previous.gitProject !== (installation.gitProject !== undefined) ||
        previous.outputs.length !== proposedOutputs.length ||
        proposedOutputs.some((output) => {
          const previousOutput = previous.outputs.find((entry) => entry.path === output.path);
          return previousOutput?.hash !== output.hash ||
            previousOutput.mode !== output.mode ||
            previousOutput.type !== output.type;
        })
      ) {
        projectItems.push({
          kind: "update",
          project: installation.binding.project,
          reason: "desired output changed",
        });
      } else if (repairableMissingMarker) {
        projectItems.push({
          kind: "update",
          project: installation.binding.project,
          reason: "Installation Marker is missing and repairable",
        });
      } else {
        projectItems.push({
          kind: "current",
          project: installation.binding.project,
        });
      }
    }
    return {
      blockers: projectBlockers,
      gitProject: installation.gitProject,
      id,
      items: projectItems,
      outputItems: projectOutputItems,
      outputs: projectedManifest.outputs,
    };
  }));
  // Exclusion contributions fold in canonical Project order: contribution
  // ownership stays keyed by Installation ID exactly as before, so scheduling
  // order never reaches the deterministic union or the report.
  let projectedExclusions = state.repositoryExclusions;
  for (const result of desiredResults) {
    projectedExclusions = replaceRepositoryExclusionContribution(
      projectedExclusions,
      result.id,
      result.gitProject,
      result.outputs,
    );
    items.push(...result.items);
    outputItems.push(...result.outputItems);
    blockers.push(...result.blockers);
  }
  const staleResults = await scheduler.run(state.installations.map((installation) => async () => {
    if (desiredProjects.has(installation.project) || movedPreviousProjects.has(installation.project)) {
      return undefined;
    }
    const intentionallyDeleted = intentionallyDeletedProjects.has(installation.project);
    const proof = intentionallyDeleted
      ? { owned: true as const }
      : await proveOwnedInstallation(installation, inspection);
    const projectBlockers: ReconciliationBlocker[] = [];
    if (!proof.owned) {
      const remediation = proof.reason?.includes("Installation Marker")
        ? "; if this project moved, restore its Manifest-linked Installation Marker at the new root before retrying"
        : "";
      projectBlockers.push(normalizeBlocker(
        installationOwnershipBlocker({
          message:
            `Cannot remove stale Profile Installation at ${installation.project}: ` +
            `${proof.reason ?? "ownership could not be proven"}${remediation}`,
          project: installation.project,
        }),
        installation.project,
      ));
    }
    return {
      blockers: projectBlockers,
      installationId: installation.installationId,
      items: [{
        kind: "removal" as const,
        project: installation.project,
        ...(intentionallyDeleted
          ? { reason: "project intentionally deleted" }
          : proof.reason
            ? { reason: proof.reason }
            : {}),
      }],
      outputItems: installation.outputs.map((output) => ({
        kind: "removal" as const,
        path: output.path,
        project: installation.project,
      })),
    };
  }));
  for (const result of staleResults) {
    if (result === undefined) continue;
    projectedExclusions = replaceRepositoryExclusionContribution(
      projectedExclusions,
      result.installationId,
      undefined,
      [],
    );
    items.push(...result.items);
    outputItems.push(...result.outputItems);
    blockers.push(...result.blockers);
  }
  const projectedState: InstallationState = {
    intendedTeardowns: [],
    installations: state.installations,
    repositoryExclusions: projectedExclusions,
    schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
    temporaryInstallations: state.temporaryInstallations,
  };
  const deduplicated = new Map<string, ReconciliationBlocker>();
  for (const blocker of blockers) {
    const key = `${blocker.project ?? ""}\0${blocker.message}`;
    if (!deduplicated.has(key)) deduplicated.set(key, blocker);
  }
  return {
    blockers: [...deduplicated.values()].sort((left, right) =>
      (left.project ?? "").localeCompare(right.project ?? "") || left.message.localeCompare(right.message)
    ),
    desired: desiredReport,
    items,
    outputs: outputItems.sort((left, right) =>
      left.project.localeCompare(right.project) || left.path.localeCompare(right.path)
    ),
    outputConsumers,
    repositoryExclusionRepairs: exclusionDiagnostics.repairs,
    repositoryExclusions: repositoryExclusionChanges(state, projectedState),
    diagnosticValues: [...new Set(
      desired.flatMap((installation) => installation.diagnosticValues),
    )].sort(),
    warnings: [...new Set([
      ...desired.flatMap((installation) => installation.warnings),
      ...exclusionDiagnostics.warnings,
    ])].sort(),
  };
}

export async function stageProjectOutputs(
  desired: DesiredInstallation,
  manifest: ProjectInstallationManifest,
  previous: ProjectInstallationManifest | undefined,
  fileSystem: ReconciliationFileSystem = nodeFileSystem,
): Promise<{ readonly commit: () => Promise<void>; readonly rollback: () => Promise<void> }> {
  const project = desired.binding.canonicalProject;
  const stage = await fileSystem.mkdtemp(join(project, ".agent-profile-kit-stage-"));
  const backup = join(stage, ".backup");
  const outputs = [
    ...desired.outputs,
    markerOutput(manifest.installationId),
  ];
  const moved: string[] = [];
  const installed: string[] = [];
  /** Published directory trees whose exact modes may block recursive removal on rollback. */
  const installedDirectoryTrees: {
    readonly memberDirectories: readonly string[];
    readonly path: string;
  }[] = [];
  let settled = false;
  const cleanup = async (): Promise<void> => {
    await fileSystem.rm(stage, { recursive: true, force: true }).catch(() => undefined);
  };
  const makeDirectoryTreeWritable = async (
    tree: { readonly memberDirectories: readonly string[]; readonly path: string },
  ): Promise<void> => {
    // Top-down: parent must be writable before children can be removed or entered.
    await fileSystem.chmod(tree.path, 0o755).catch(() => undefined);
    for (const relative of tree.memberDirectories) {
      await fileSystem.chmod(join(tree.path, relative), 0o755).catch(() => undefined);
    }
  };
  const rollback = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    const treesByPath = new Map(installedDirectoryTrees.map((tree) => [tree.path, tree]));
    for (const path of installed.reverse()) {
      const tree = treesByPath.get(path);
      if (tree) await makeDirectoryTreeWritable(tree);
      await fileSystem.rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const path of moved.reverse()) {
      const previous = join(backup, path.slice(project.length + 1));
      await fileSystem.rename(previous, path).catch(() => undefined);
    }
    await cleanup();
  };
  try {
    for (const output of outputs) {
      const staged = join(stage, output.path);
      if (output.type === "file") {
        await fileSystem.mkdir(dirname(staged), { recursive: true });
        await fileSystem.writeFile(staged, output.bytes, { mode: output.mode });
        await fileSystem.chmod(staged, output.mode);
        continue;
      }
      // Keep directories writable in the stage so members and later rename work.
      // Exact directory modes are applied after publication (see below).
      await fileSystem.mkdir(staged, { recursive: true });
      const members = [...output.members].sort((left, right) => left.path.localeCompare(right.path));
      for (const member of members) {
        const memberPath = join(staged, member.path);
        if (member.type === "directory") {
          await fileSystem.mkdir(memberPath, { recursive: true });
          continue;
        }
        await fileSystem.mkdir(dirname(memberPath), { recursive: true });
        await fileSystem.writeFile(memberPath, member.bytes, { mode: member.mode });
        await fileSystem.chmod(memberPath, member.mode);
      }
    }
    // The marker is the usability/ownership guard. Remove the old marker
    // before changing any generated output and publish the replacement last.
    const markerDestination = markerPath(project);
    if ((await pathKind(markerDestination)) !== "missing") {
      const priorMarker = join(backup, markerRelativePath());
      await fileSystem.mkdir(dirname(priorMarker), { recursive: true });
      await fileSystem.rename(markerDestination, priorMarker);
      moved.push(markerDestination);
    }
    const desiredPaths = new Set(outputs.map((output) => output.path));
    for (const output of previous?.outputs ?? []) {
      if (desiredPaths.has(output.path)) continue;
      const destination = join(project, output.path);
      if ((await pathKind(destination)) === "missing") continue;
      const prior = join(backup, output.path);
      await fileSystem.mkdir(dirname(prior), { recursive: true });
      await fileSystem.rename(destination, prior);
      moved.push(destination);
    }
    for (const output of outputs) {
      const destination = outputPath(project, output);
      const staged = join(stage, output.path);
      const existing = await pathKind(destination);
      if (existing !== "missing") {
        const previousPath = join(backup, output.path);
        await fileSystem.mkdir(dirname(previousPath), { recursive: true });
        await fileSystem.rename(destination, previousPath);
        moved.push(destination);
      }
      await fileSystem.mkdir(dirname(destination), { recursive: true });
      await fileSystem.rename(staged, destination);
      installed.push(destination);
      if (output.type === "directory") {
        const directoryMembers = output.members.filter((member) => member.type === "directory");
        const memberDirectories = directoryMembers
          .map((member) => member.path)
          .sort((left, right) => {
            const depth = left.split("/").filter(Boolean).length - right.split("/").filter(Boolean).length;
            return depth !== 0 ? depth : left.localeCompare(right);
          });
        installedDirectoryTrees.push({ memberDirectories, path: destination });
        // Apply exact directory modes deepest-first only after the tree is in place.
        const directoryModes = [
          ...directoryMembers.map((member) => ({ mode: member.mode, path: member.path })),
          { mode: output.mode, path: "" },
        ].sort((left, right) => {
          const depth =
            right.path.split("/").filter(Boolean).length - left.path.split("/").filter(Boolean).length;
          return depth !== 0 ? depth : right.path.localeCompare(left.path);
        });
        for (const directory of directoryModes) {
          const path = directory.path.length === 0 ? destination : join(destination, directory.path);
          await fileSystem.chmod(path, directory.mode);
        }
      }
    }
    return {
      rollback,
      commit: async () => {
        if (settled) return;
        settled = true;
        await cleanup();
      },
    };
  } catch (error) {
    await rollback();
    throw error;
  }
}

export async function applyReconciliation(
  home: string,
  desired: readonly DesiredInstallation[],
  options: {
    /**
     * Factory for one Git inspection context. Apply creates a fresh context for
     * preflight and another for post-commit verification so pre-write snapshots
     * cannot prove post-write state. Tests may inject a counting factory.
     */
    readonly createGitInspection?: () => LifecycleGitInspection;
    /**
     * Factory for one ownership inspection context. Apply creates a fresh
     * context for preflight and another for post-commit verification so
     * pre-write filesystem evidence cannot prove post-write state. Tests may
     * inject a counting factory.
     */
    readonly createOwnershipInspection?: () => LifecycleOwnershipInspection;
    readonly fileSystem?: Partial<ReconciliationFileSystem>;
    readonly lockTimeoutMs?: number;
    /**
     * Invocation-scoped bounded scheduler for independent Project reads. Apply
     * passes it to preflight and post-commit verification while all mutation,
     * publication, and rollback stay sequential.
     */
    readonly scheduler?: ProjectReadScheduler;
    readonly verifyReconciliation?: typeof previewReconciliation;
    readonly writeInstallationState?: typeof writeInstallationState;
  } = {},
): Promise<ApplyReconciliationResult> {
  return withInstallationLifecycleLock(
    home,
    "apply",
    () => applyReconciliationLocked(home, desired, options),
    options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs },
  );
}

async function applyReconciliationLocked(
  home: string,
  desired: readonly DesiredInstallation[],
  options: {
    readonly createGitInspection?: () => LifecycleGitInspection;
    /**
     * Factory for one ownership inspection context. Apply creates a fresh
     * context for preflight and another for post-commit verification so
     * pre-write filesystem evidence cannot prove post-write state. Tests may
     * inject a counting factory.
     */
    readonly createOwnershipInspection?: () => LifecycleOwnershipInspection;
    readonly fileSystem?: Partial<ReconciliationFileSystem>;
    /**
     * Invocation-scoped bounded scheduler for independent Project reads. Apply
     * passes it to preflight and post-commit verification while all mutation,
     * publication, and rollback stay sequential.
     */
    readonly scheduler?: ProjectReadScheduler;
    readonly verifyReconciliation?: typeof previewReconciliation;
    readonly writeInstallationState?: typeof writeInstallationState;
  } = {},
): Promise<ApplyReconciliationResult> {
  const fileSystem: ReconciliationFileSystem = { ...nodeFileSystem, ...options.fileSystem };
  const writeState = options.writeInstallationState ?? writeInstallationState;
  const createGitInspection = options.createGitInspection ?? createLifecycleGitInspectionContext;
  const createOwnershipInspection =
    options.createOwnershipInspection ?? createLifecycleOwnershipInspectionContext;
  const scheduler = options.scheduler ?? createProjectReadScheduler();
  let before;
  let migratedState = false;
  try {
    const loaded = await readInstallationStateWithMigration(home);
    before = loaded.state;
    migratedState = loaded.migrated;
  } catch (error) {
    throw new ApplyBlockedError(
      await unreadableInstallationStateReport(home, desired, error),
    );
  }
  // Fresh inspection pass: pre-write filesystem evidence only. One context
  // serves the preflight report and the ownership proof for stale removals so
  // each owned output is read or walked at most once before any write.
  const preflightOwnershipInspection = createOwnershipInspection();
  const report = await previewReconciliation(desired, before, {
    gitInspection: createGitInspection(),
    ownershipInspection: preflightOwnershipInspection,
    scheduler,
  });
  const [blocker, ...remainingBlockers] = report.blockers;
  if (blocker) {
    throw new ApplyBlockedError({
      ...report,
      blockers: [blocker, ...remainingBlockers],
    });
  }
  const retirement = await installationRetirementSelection(
    desired,
    before,
    preflightOwnershipInspection,
    scheduler,
  );
  const currentProjects = new Set(
    report.items
      .filter((item) => item.kind === "current")
      .map((item) => item.project),
  );
  const byProject = new Map(before.installations.map((installation) => [installation.project, installation]));
  const installationsByProject = new Map(
    before.installations.map((installation) => [installation.project, installation]),
  );
  let workingState = before;
  const movedPreviousProjects = new Set(retirement.movedPreviousProjects);
  const completed: string[] = [];
  for (const [index, item] of desired.entries()) {
    const previous = await previousFor(item, before, byProject, preflightOwnershipInspection);
    const moved = previous && previous.project !== item.binding.canonicalProject;
    if (currentProjects.has(item.binding.project)) continue;
    let transaction: { readonly commit: () => Promise<void>; readonly rollback: () => Promise<void> } | undefined;
    let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
    let stateWriteAttempted = false;
    try {
      const installationId = previous?.installationId ?? newInstallationId();
      const manifest = manifestFor(item, installationId);
      transaction = await stageProjectOutputs(item, manifest, previous, fileSystem);
      if (moved) installationsByProject.delete(previous.project);
      installationsByProject.set(manifest.project, manifest);
      const nextState = stateWithInstallationExclusion(
        {
          intendedTeardowns: [],
          installations: [...installationsByProject.values()],
          repositoryExclusions: workingState.repositoryExclusions,
          schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
          temporaryInstallations: workingState.temporaryInstallations,
        },
        manifest,
        item.gitProject,
      );
      const exclusionCurrentState = moved && item.gitProject
        ? {
            ...workingState,
            repositoryExclusions: prepareRepositoryExclusionMovePreflight(
              workingState.repositoryExclusions,
              previous!.installationId,
              item.gitProject.excludeFile,
            ),
          }
        : workingState;
      exclusions = await stageGitExclusions(
        exclusionCurrentState,
        nextState,
      );
      stateWriteAttempted = true;
      await writeState(home, nextState);
      // Publish bytes first; GitExclusionTransaction can restore them if the
      // following project commit reports a failure.
      await exclusions.commit();
      await transaction.commit();
      byProject.clear();
      for (const installation of nextState.installations) {
        byProject.set(installation.project, installation);
      }
      workingState = nextState;
      completed.push(item.binding.project);
    } catch (error) {
      let rollbackFailure: unknown;
      if (exclusions) {
        try {
          await exclusions.rollback();
        } catch (failure) {
          rollbackFailure = failure;
        }
      }
      if (transaction) await transaction.rollback();
      let stateRestoreFailure: unknown;
      if (stateWriteAttempted) {
        try {
          await writeState(home, workingState);
        } catch (failure) {
          stateRestoreFailure = failure;
        }
      }
      const pending = desired.slice(index + 1).map((entry) => entry.binding.project);
      const failureMessage = error instanceof Error ? error.message : String(error);
      const recoveryMessages = [
        ...(rollbackFailure === undefined
          ? []
          : [`Exclusion rollback failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`]),
        ...(stateRestoreFailure === undefined
          ? []
          : [`Installation State restore failed: ${stateRestoreFailure instanceof Error ? stateRestoreFailure.message : String(stateRestoreFailure)}`]),
      ];
      throw new Error(
        `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; failed project: ${item.binding.project}; pending projects: ${pending.join(", ") || "(none)"}\n${failureMessage}${recoveryMessages.length > 0 ? `\n${recoveryMessages.join("\n")}` : ""}`,
      );
    }
  }

  const stale = before.installations.filter(
    (installation) =>
      !desired.some((item) => item.binding.canonicalProject === installation.project) &&
      !movedPreviousProjects.has(installation.project),
  );
  // Destructive staging is a distinct removal pass: each stale removal re-proves
  // ownership from filesystem evidence captured after all earlier project commits
  // and never from preflight snapshots, so changed output cannot be removed
  // without a fresh proof.
  const staleRemovalOwnershipInspection = stale.length > 0
    ? createOwnershipInspection()
    : undefined;
  for (const [index, previous] of stale.entries()) {
    let transaction: Awaited<ReturnType<typeof stageProvenInstallationRemoval>> | undefined;
    let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
    let stateWriteAttempted = false;
    try {
      const intentionallyDeleted = retirement.intentionallyDeletedProjects.has(previous.project);
      if (!intentionallyDeleted) {
        transaction = await stageProvenInstallationRemoval(previous, staleRemovalOwnershipInspection);
      }
      installationsByProject.delete(previous.project);
      const nextState: InstallationState = {
        intendedTeardowns: [],
        installations: [...installationsByProject.values()],
        repositoryExclusions: replaceRepositoryExclusionContribution(
          workingState.repositoryExclusions,
          previous.installationId,
          undefined,
          [],
        ),
        schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
        temporaryInstallations: workingState.temporaryInstallations,
      };
      exclusions = await stageGitExclusions(
        workingState,
        nextState,
      );
      stateWriteAttempted = true;
      await writeState(home, nextState);
      // The exclusion transaction remains reversible until the removal commit
      // succeeds, keeping state, bytes, and output ownership retryable together.
      await exclusions.commit();
      if (transaction) await transaction.commit();
      byProject.delete(previous.project);
      workingState = nextState;
      completed.push(`removal ${previous.project}`);
    } catch (error) {
      let rollbackFailure: unknown;
      if (exclusions) {
        try {
          await exclusions.rollback();
        } catch (failure) {
          rollbackFailure = failure;
        }
      }
      if (transaction) await transaction.rollback();
      let stateRestoreFailure: unknown;
      if (stateWriteAttempted) {
        try {
          await writeState(home, workingState);
        } catch (failure) {
          stateRestoreFailure = failure;
        }
      }
      const pending = stale.slice(index + 1).map((entry) => `removal ${entry.project}`);
      const failureMessage = error instanceof Error ? error.message : String(error);
      const recoveryMessages = [
        ...(rollbackFailure === undefined
          ? []
          : [`Exclusion rollback failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`]),
        ...(stateRestoreFailure === undefined
          ? []
          : [`Installation State restore failed: ${stateRestoreFailure instanceof Error ? stateRestoreFailure.message : String(stateRestoreFailure)}`]),
      ];
      throw new Error(
        `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; failed project: removal ${previous.project}; pending projects: ${pending.join(", ") || "(none)"}\n${failureMessage}${recoveryMessages.length > 0 ? `\n${recoveryMessages.join("\n")}` : ""}`,
      );
    }
  }
  if (migratedState) {
    await writeState(home, backfillLegacyProvenance(workingState, desired));
  }
  const repairedExclusions = await stageGitExclusions(workingState, workingState);
  await repairedExclusions.commit();
  let resultingState: ReconciliationReport;
  try {
    // Fresh inspection pass: never reuse preflight Git, exclusion, or ownership
    // snapshots as proof of post-write ownership or exclusion bytes.
    const verify = options.verifyReconciliation ?? (
      (nextDesired, nextState) => previewReconciliation(nextDesired, nextState, {
        gitInspection: createGitInspection(),
        ownershipInspection: createOwnershipInspection(),
        scheduler,
      })
    );
    resultingState = await verify(desired, workingState);
  } catch (error) {
    throw new ApplyVerificationError(report, error);
  }
  return {
    receipt: report,
    resultingState,
  };
}
