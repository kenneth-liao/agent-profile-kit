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
  INSTALLATION_MARKER_PATH,
} from "../schemas/installation-manifest.js";
import {
  OWNERSHIP_STATE_SCHEMA_VERSION,
  type OwnershipState,
  type OwnershipOutputReceipt,
  type OwnershipReceipt,
} from "../schemas/ownership-state.js";
import { hostCatalogEntryFor } from "../adapters/host-catalog.js";
import { CONTEXT_ENVELOPE_PREFIX } from "../adapters/context-envelope.js";
import { formatInstallationMarker as markerText } from "../schemas/installation-manifest.js";
import {
  hashBytes,
  markerPath,
  outputPath,
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
  readInstallationState,
  stageProvenInstallationRemoval,
  writeInstallationState,
  type OwnershipProof,
} from "./installation-state.js";
import { gitExcludeEntry, type GitProject } from "./git.js";
import {
  ordinaryReceipts,
  repositoryExclusionRecords,
  withReceipts,
  withRepositoryExclusion,
} from "./ownership-state.js";
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
  missingContributionRepairEligibility,
  movedContributionRepairEligibility,
  replaceRepositoryExclusionContribution,
  staleContributionRepairEligibility,
  repositoryExclusionChanges,
  repositoryExclusionTargetsForInstallations,
  REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX,
  REPOSITORY_EXCLUSION_RETIREMENT_REPAIR_WARNING_SUFFIX,
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
import {
  isContributionRepair,
  safeRepairItemClassification,
  safeRepairTargets,
  withProvenContributions,
  withStagedCurrentContributions,
  type SafeRepairExclusionRepair,
  type SafeRepairWithProjectItem,
} from "./safe-repair.js";
import type { IneligibleContributionEvidence } from "./git-exclusions.js";

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

export interface ReconciliationWarning {
  readonly copyableValues: readonly string[];
  readonly kind: "diagnostic" | "host-attention";
  readonly message: string;
}

export interface ReconciliationProjectOutput
  extends Omit<OutputReconciliationItem, "project"> {
  readonly consumingHosts: readonly string[];
}

export interface ReconciliationProjectRecord {
  /** Canonical Project identity and deterministic report ordering key. */
  readonly canonicalProject: string;
  /** Authored Project spelling retained for presentation. */
  readonly project: string;
  readonly desired?: {
    readonly capabilityContracts?: Readonly<Record<string, string>>;
    readonly context: string;
    readonly hosts: DesiredInstallation["binding"]["hosts"];
    readonly outputs: readonly string[];
    readonly profile: string;
    readonly resolvedArtifacts: readonly DesiredResolvedArtifactPreview[];
  };
  readonly state: Omit<ReconciliationItem, "project">;
  readonly outputs: readonly ReconciliationProjectOutput[];
  readonly blockers: readonly ReconciliationBlocker[];
  readonly warnings: readonly ReconciliationWarning[];
  readonly setupSteps: DesiredInstallation["setupSteps"];
  readonly repositoryExclusionRepairs: readonly RepositoryExclusionRepair[];
  readonly repositoryExclusions: readonly RepositoryExclusionChange[];
}

/** Canonical reconciliation model: global evidence plus one complete record per Project. */
export interface ReconciliationReport {
  readonly globalBlockers: readonly ReconciliationBlocker[];
  readonly projects: readonly ReconciliationProjectRecord[];
}

/** Whether reconciliation may consider installations outside the desired Project set stale. */
export type ReconciliationScope = { readonly kind: "all" } | { readonly kind: "project" };

/** Internal reconciliation accumulator normalized into Project records at the boundary. */
interface ReconciliationAccumulator {
  readonly blockers: readonly ReconciliationBlocker[];
  readonly desired: readonly {
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
  readonly diagnosticValues: readonly string[];
  readonly warnings: readonly string[];
}

export type BlockedReconciliationReport = ReconciliationReport;

/** Replace Project records without exposing or reconstructing parallel report collections. */
export function reconciliationReportWithProjects(
  report: ReconciliationReport,
  projects: readonly ReconciliationProjectRecord[],
): ReconciliationReport {
  return {
    globalBlockers: report.globalBlockers,
    projects,
  };
}

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

/** Raised after apply execution fails, retaining committed and fresh resulting evidence. */
export class ApplyExecutionError extends Error {
  readonly failedProject: string | undefined;
  readonly pendingProjects: readonly string[];
  readonly receipt: ReconciliationReport;
  readonly resultingState: ReconciliationReport | undefined;

  constructor(options: {
    readonly cause: unknown;
    readonly failedProject?: string;
    readonly pendingProjects: readonly string[];
    readonly receipt: ReconciliationReport;
    readonly resultingState?: ReconciliationReport;
  }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(
      options.failedProject === undefined
        ? `Apply failed after committing Project work: ${detail}`
        : `Apply failed at ${options.failedProject}: ${detail}`,
      { cause: options.cause },
    );
    this.name = "ApplyExecutionError";
    this.failedProject = options.failedProject;
    this.pendingProjects = options.pendingProjects;
    this.receipt = options.receipt;
    this.resultingState = options.resultingState;
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
    receipts: [],
    removedTemporaryInstallationIds: [],
    schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
  });
  return {
    globalBlockers: [normalizeBlocker(installationStateUnreadableBlocker({
      message,
      statePath: stateManifestPath(home),
    }))],
    // Ownership cannot be read, so planned Project states and output changes
    // are not trustworthy diagnostics. Keep desired identity plus the boundary failure.
    projects: desiredReport.projects.map((project) => ({
      ...project,
      state: { kind: "malformed ownership state", reason: message },
      outputs: [],
      blockers: [],
    })),
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function hostReceiptsEqual(
  receipt: OwnershipReceipt,
  desired: DesiredInstallation,
): boolean {
  const desiredHosts = desired.binding.hosts;
  const recordedHosts = Object.keys(receipt.hosts);
  return desiredHosts.length === recordedHosts.length && desiredHosts.every((host) => {
    const recorded = receipt.hosts[host];
    return recorded?.adapterVersion === hostCatalogEntryFor(host).adapterVersion &&
      recorded.capabilityContract === desired.hostVersions[host];
  });
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

function ownedOutputFromDesired(output: DesiredProjectOutput): OwnershipOutputReceipt {
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
    mode: output.mode,
    path: outputRelativePath(output),
    type: "directory",
  };
}

export function manifestFor(
  desired: DesiredInstallation,
  installationId: string,
): OwnershipReceipt {
  return {
    desiredInputDigest: desired.sourceHash,
    hosts: Object.fromEntries(desired.binding.hosts.map((host) => [host, {
      adapterVersion: hostCatalogEntryFor(host).adapterVersion,
      capabilityContract: desired.hostVersions[host]!,
    }])),
    installationId,
    lifetime: "ordinary",
    outputs: desired.outputs.map(ownedOutputFromDesired),
    profileId: desired.profile.id,
    project: desired.binding.canonicalProject,
  };
}

function stateWithInstallationExclusion(
  state: OwnershipState,
  installation: OwnershipReceipt,
  gitProject: DesiredInstallation["gitProject"],
): OwnershipState {
  const repositoryExclusion = gitProject === undefined
    ? undefined
    : {
        entries: [...installation.outputs.map((output) => gitExcludeEntry(gitProject, output.path)),
          gitExcludeEntry(gitProject, INSTALLATION_MARKER_PATH)],
        target: gitProject.excludeFile,
      };
  return withReceipts(
    state,
    withRepositoryExclusion(
      state.receipts,
      installation.installationId,
      repositoryExclusion,
    ),
  );
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
      const relativeParent = parent.slice(project.length + 1);
      blockers.push(occupiedOutputBlocker({
        message: `${relativeParent} is an occupied ${kind} parent path`,
        path: relativeParent,
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
  output: OwnershipOutputReceipt,
): boolean {
  return (
    inspection.kind === "file" &&
    inspection.mode === output.mode &&
    inspection.contentHash === output.hash
  );
}

function directoryOutputMatches(
  inspection: OwnedOutputInspection,
  output: OwnershipOutputReceipt,
): boolean {
  return (
    inspection.kind === "directory" &&
    inspection.mode === output.mode &&
    inspection.directoryHash === output.hash
  );
}

async function ownedOutputMatches(
  project: string,
  output: OwnershipOutputReceipt,
  inspection: LifecycleOwnershipInspection,
): Promise<boolean> {
  const result = await inspection.inspectOutput(project, output);
  if (output.type === "file") return fileOutputMatches(result, output);
  return directoryOutputMatches(result, output);
}

export async function desiredOutputConflicts(
  desired: DesiredInstallation,
  previous: OwnershipReceipt | undefined,
  installationId: string,
  gitInspection: LifecycleGitInspection = createLifecycleGitInspectionContext(),
): Promise<readonly BlockerInput[]> {
  const blockers: BlockerInput[] = [];
  const project = desired.binding.canonicalProject;
  const previousOutputs = new Map(previous === undefined ? [] : [
    ...previous.outputs.map((output) => [output.path, output] as const),
    [markerRelativePath(), {
      hash: hashMarker(markerText({ installationId: previous.installationId, schemaVersion: 1 })),
      mode: 0o644,
      path: markerRelativePath(),
      type: "file" as const,
    }] as const,
  ]);
  const outputs: OwnershipOutputReceipt[] = [
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
  const remedies = new Map(
    desired.outputs.map((output) => [output.path, output.remedy]),
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
    const remedy = remedies.get(output.path);
    if (output.type === "file") {
      if (kind !== "file") {
        blockers.push(occupiedOutputBlocker({
          message: `${output.path} is an occupied ${kind} path`,
          path: output.path,
          project,
          ...(remedy === undefined ? {} : { remedy }),
        }));
        continue;
      }
      blockers.push(occupiedOutputBlocker({
        message: `${output.path} is occupied by unowned or drifted output`,
        path: output.path,
        project,
        ...(remedy === undefined ? {} : { remedy }),
      }));
      continue;
    }
    if (kind !== "directory") {
      blockers.push(occupiedOutputBlocker({
        message: `${output.path} is an occupied ${kind} path`,
        path: output.path,
        project,
        ...(remedy === undefined ? {} : { remedy }),
      }));
      continue;
    }
    blockers.push(occupiedOutputBlocker({
      message: `${output.path} is an occupied unowned artifact directory`,
      path: output.path,
      project,
      ...(remedy === undefined ? {} : { remedy }),
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
  state: OwnershipState,
  installationId: string,
  inspection: LifecycleOwnershipInspection,
): Promise<readonly BlockerInput[]> {
  const project = desired.binding.canonicalProject;
  const marker = markerRelativePath();
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
  const owner = ordinaryReceipts(state).find((installation) => installation.installationId === markerValue.installationId);
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
  state: OwnershipState,
  byProject: ReadonlyMap<string, OwnershipReceipt>,
  inspection: LifecycleOwnershipInspection,
): Promise<OwnershipReceipt | undefined> {
  const canonicalProject = desired.binding.canonicalProject;
  const direct = byProject.get(canonicalProject);
  if (direct) return direct;
  const markerEvidence = await inspection.inspectMarker(canonicalProject);
  const marker = markerEvidence.malformed === undefined ? markerEvidence.value : undefined;
  if (!marker) return undefined;
  const owner = ordinaryReceipts(state).find(
    (installation) => installation.installationId === marker.installationId,
  );
  if (!owner || owner.project === canonicalProject) return undefined;
  return (await pathKind(owner.project)) === "missing" ? owner : undefined;
}

async function installationIdsInScope(
  desired: readonly DesiredInstallation[],
  state: OwnershipState,
  inspection: LifecycleOwnershipInspection,
  scope: ReconciliationScope,
): Promise<ReadonlySet<string> | undefined> {
  if (scope.kind === "all") return undefined;
  const byProject = new Map(ordinaryReceipts(state).map((installation) => [installation.project, installation]));
  const previous = await Promise.all(
    desired.map((installation) => previousFor(installation, state, byProject, inspection)),
  );
  return new Set(previous.flatMap((installation) =>
    installation === undefined ? [] : [installation.installationId]
  ));
}

interface InstallationRetirementSelection {
  readonly intentionallyDeletedInstallationIds: ReadonlySet<string>;
  readonly intentionallyDeletedProjects: ReadonlySet<string>;
  readonly movedPreviousProjects: ReadonlySet<string>;
}

/**
 * Select stale installations that may be retired without project-tree ownership
 * proof after an exact-path unbind. Both status and apply use this same reader
 * so deletion intent cannot silently lose its exclusion-ownership safeguards.
 * Independent per-Project reads run through the shared bounded scheduler; the
 * deletion-intent selection folds in canonical order afterwards.
 */
async function installationRetirementSelection(
  desired: readonly DesiredInstallation[],
  state: OwnershipState,
  inspection: LifecycleOwnershipInspection,
  scheduler: ProjectReadScheduler = createProjectReadScheduler(),
  scope: ReconciliationScope = { kind: "all" },
): Promise<InstallationRetirementSelection> {
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  const byProject = new Map(ordinaryReceipts(state).map((installation) => [installation.project, installation]));
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
  const retiredCandidates = scope.kind === "all"
    ? ordinaryReceipts(state).filter((installation) =>
        !desiredProjects.has(installation.project) &&
        !movedPreviousProjects.has(installation.project)
      )
    : [];
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
      ordinaryReceipts(state)
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
      `Cannot sync the generated ${generatedBoundary}: ${reason}. ` +
      "Agent Profile Kit will not overwrite your edit. Move the change into the Workspace, " +
      `or delete the generated ${generatedBoundary}, then run ${COMMAND_NAME} apply to restore it`;
  } else {
    message = `Cannot verify generated-file ownership: ${reason}`;
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
    // Match the stable bare prefix, not one full header spelling: the header
    // shape has changed before and detection must survive future changes too.
    if (bytes.startsWith(CONTEXT_ENVELOPE_PREFIX)) return bytes;
  }
  return "";
}

function directoryRootRequiresAttention(
  output: OwnershipOutputReceipt,
  inspection: OwnedOutputInspection,
): boolean {
  return inspection.kind !== "missing" && !directoryOutputMatches(inspection, output);
}

function nestedReconciliationReport(
  flat: ReconciliationAccumulator,
  desiredInstallations: readonly DesiredInstallation[],
  exclusionProjects: ReadonlyMap<string, ReadonlySet<string>>,
): ReconciliationReport {
  const canonicalByProject = new Map<string, string>();
  for (const installation of flat.desired) {
    canonicalByProject.set(installation.project, installation.canonicalProject);
    canonicalByProject.set(installation.canonicalProject, installation.canonicalProject);
  }
  const canonicalProject = (project: string): string => canonicalByProject.get(project) ?? project;
  const desiredByCanonical = new Map(flat.desired.map((entry) => [entry.canonicalProject, entry]));
  const stateByCanonical = new Map(
    flat.items.map((item) => [canonicalProject(item.project), item]),
  );
  const projectBlockers = new Map<string, ReconciliationBlocker[]>();
  const globalBlockers: ReconciliationBlocker[] = [];
  for (const blocker of flat.blockers) {
    if (blocker.scope === "global") {
      globalBlockers.push(blocker);
      continue;
    }
    const key = canonicalProject(blocker.project);
    const records = projectBlockers.get(key) ?? [];
    records.push(blocker);
    projectBlockers.set(key, records);
  }
  const outputsByCanonical = new Map<string, ReconciliationProjectOutput[]>();
  const consumers = new Map(
    flat.outputConsumers.map((consumer) => [
      `${canonicalProject(consumer.project)}\0${consumer.path}`,
      consumer.consumingHosts,
    ]),
  );
  for (const output of flat.outputs) {
    const key = canonicalProject(output.project);
    const records = outputsByCanonical.get(key) ?? [];
    records.push({
      consumingHosts: consumers.get(`${key}\0${output.path}`) ?? [],
      kind: output.kind,
      path: output.path,
    });
    outputsByCanonical.set(key, records);
  }
  const warningsByCanonical = new Map<string, ReconciliationWarning[]>();
  for (const installation of desiredInstallations) {
    const key = installation.binding.canonicalProject;
    warningsByCanonical.set(key, installation.warnings.map((warning) => ({
      copyableValues: [...warning.copyableValues],
      kind: "diagnostic" as const,
      message: warning.message,
    })));
  }
  const exclusionsByCanonical = new Map<string, RepositoryExclusionChange[]>();
  for (const change of flat.repositoryExclusions) {
    for (const project of exclusionProjects.get(change.target) ?? []) {
      const key = canonicalProject(project);
      const records = exclusionsByCanonical.get(key) ?? [];
      records.push(change);
      exclusionsByCanonical.set(key, records);
    }
  }
  const repairsByCanonical = new Map<string, RepositoryExclusionRepair[]>();
  for (const repair of flat.repositoryExclusionRepairs) {
    for (const target of safeRepairTargets(repair)) {
      for (const project of exclusionProjects.get(target) ?? []) {
        const key = canonicalProject(project);
        const records = repairsByCanonical.get(key) ?? [];
        // One moved repair covers two targets whose Project sets can overlap;
        // each Project record carries the repair once.
        if (records.includes(repair)) continue;
        records.push(repair);
        repairsByCanonical.set(key, records);
        const warningSuffix =
          repair.class === "exclusion-section"
            ? REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX
            : repair.class === "retiring-exclusion-section"
              ? REPOSITORY_EXCLUSION_RETIREMENT_REPAIR_WARNING_SUFFIX
              : undefined;
        if (warningSuffix === undefined) continue;
        const repairTarget = safeRepairTargets(repair)[0]!;
        const warnings = warningsByCanonical.get(key) ?? [];
        warnings.push({
          copyableValues: [repairTarget],
          kind: "diagnostic",
          message: `${repairTarget}${warningSuffix}`,
        });
        warningsByCanonical.set(key, warnings);
      }
    }
  }
  const projectKeys = new Set([
    ...desiredByCanonical.keys(),
    ...stateByCanonical.keys(),
    ...projectBlockers.keys(),
    ...outputsByCanonical.keys(),
    ...exclusionsByCanonical.keys(),
    ...repairsByCanonical.keys(),
  ]);
  return {
    globalBlockers: [...globalBlockers],
    projects: [...projectKeys].sort().map((key) => {
      const desired = desiredByCanonical.get(key);
      const state = stateByCanonical.get(key) ?? { kind: "current" as const, project: desired?.project ?? key };
      return {
        canonicalProject: key,
        project: desired?.project ?? state.project,
        ...(desired === undefined ? {} : {
          desired: {
            ...(desired.capabilityContracts === undefined
              ? {}
              : { capabilityContracts: desired.capabilityContracts }),
            context: desired.context,
            hosts: desired.hosts,
            outputs: desired.outputs,
            profile: desired.profile,
            resolvedArtifacts: desired.resolvedArtifacts,
          },
        }),
        state: {
          kind: state.kind,
          ...(state.reason === undefined ? {} : { reason: state.reason }),
        },
        outputs: outputsByCanonical.get(key) ?? [],
        blockers: projectBlockers.get(key) ?? [],
        warnings: warningsByCanonical.get(key) ?? [],
        setupSteps: desired?.setupSteps ?? [],
        repositoryExclusionRepairs: repairsByCanonical.get(key) ?? [],
        repositoryExclusions: exclusionsByCanonical.get(key) ?? [],
      };
    }),
  };
}

export interface PreviewReconciliationOptions {
  /** Project-scoped commands must not classify unrelated installations as stale. */
  readonly scope?: ReconciliationScope;
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
  state: OwnershipState,
  options: PreviewReconciliationOptions = {},
): Promise<ReconciliationReport> {
  const gitInspection = options.gitInspection ?? createLifecycleGitInspectionContext();
  const inspection = options.ownershipInspection ?? createLifecycleOwnershipInspectionContext();
  const scheduler = options.scheduler ?? createProjectReadScheduler();
  const scope = options.scope ?? { kind: "all" };
  const items: ReconciliationItem[] = [];
  const outputItems: OutputReconciliationItem[] = [];
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  const byProject = new Map(ordinaryReceipts(state).map((installation) => [installation.project, installation]));
  const {
    intentionallyDeletedInstallationIds,
    intentionallyDeletedProjects,
    movedPreviousProjects,
  } = await installationRetirementSelection(desired, state, inspection, scheduler, scope);
  const includedInstallationIds = await installationIdsInScope(
    desired,
    state,
    inspection,
    scope,
  );
  const includedExclusionTargets = repositoryExclusionTargetsForInstallations(
    state,
    desired,
    includedInstallationIds,
  );
  const blockers: ReconciliationBlocker[] = desired.flatMap((installation) =>
    installation.blockers.map((input) =>
      normalizeBlocker(input, installation.binding.canonicalProject)
    )
  );
  /**
   * Contribution Safe Repairs (missing and stale) proven at the reconciliation
   * boundary. Collected per Project below and passed to the Blocker boundary so
   * the proven contributions suppress their Blocker and validate exclusion
   * bytes.
   */
  const eligibleContributionRepairs: SafeRepairExclusionRepair[] = [];
  const ineligibleContributionEvidence = new Map<string, IneligibleContributionEvidence>();
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
    const proposedOutputs: OwnershipOutputReceipt[] = [
      ...installation.outputs.map(ownedOutputFromDesired),
      {
        hash: hashMarker(markerText({ installationId: id, schemaVersion: 1 })),
        mode: 0o644,
        path: markerRelativePath(),
        type: "file" as const,
      },
    ];
    const previousOutputs = new Map(previous === undefined ? [] : [
      ...previous.outputs.map((output) => [output.path, output] as const),
      [markerRelativePath(), {
        hash: hashMarker(markerText({ installationId: previous.installationId, schemaVersion: 1 })),
        mode: 0o644,
        path: markerRelativePath(),
        type: "file" as const,
      }] as const,
    ]);
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
      for (const candidate of ordinaryReceipts(state)) {
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
      // Contribution Safe Repair candidate: the receipt can prove the exact
      // contribution this lifecycle operation will publish only when every
      // remaining proof holds — ownership proof, no destination conflicts, and
      // an otherwise-current desired write set — and the recorded contribution
      // is missing, stale at the unchanged live Git target, or moved between
      // two independently proven targets. A changing desired source, Profile,
      // Host set, or output set keeps the contribution blocking rather than
      // proving one write set and applying another through the ordinary
      // update.
      const contributionRepairProof =
        installation.gitProject !== undefined &&
        proof.owned &&
        outputConflicts.length === 0 &&
        previous.desiredInputDigest === installation.sourceHash &&
        previous.profileId === installation.profile.id &&
        hostReceiptsEqual(previous, installation) &&
        previous.outputs.length === projectedManifest.outputs.length &&
        projectedManifest.outputs.every((output) => {
          const previousOutput = previous.outputs.find((entry) => entry.path === output.path);
          return previousOutput !== undefined &&
            previousOutput.hash === output.hash &&
            previousOutput.mode === output.mode &&
            previousOutput.type === output.type;
        });
      let contributionRepair: SafeRepairExclusionRepair | undefined;
      if (contributionRepairProof) {
        const git = installation.gitProject!;
        const eligibility = previous.repositoryExclusion === undefined
          ? await missingContributionRepairEligibility(previous, git, state, gitInspection)
          : previous.repositoryExclusion.target === git.excludeFile
            ? await staleContributionRepairEligibility(previous, git, state, gitInspection)
            : await movedContributionRepairEligibility(previous, git, state, gitInspection);
        if (eligibility.eligible) {
          contributionRepair = eligibility.repair;
          eligibleContributionRepairs.push(eligibility.repair);
        } else {
          ineligibleContributionEvidence.set(previous.installationId, {
            cause: eligibility.cause,
            target: git.excludeFile,
          });
        }
      }
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
        const repair: SafeRepairWithProjectItem = {
          class: "absent-output",
          paths: [...repairableMissingOutputs],
        };
        projectItems.push({
          ...safeRepairItemClassification(repair),
          project: installation.binding.project,
        });
      } else if (previous.desiredInputDigest !== installation.sourceHash) {
        projectItems.push({
          kind: "stale source",
          project: installation.binding.project,
        });
      } else if (
        contributionRepair === undefined &&
        (
          !hostReceiptsEqual(previous, installation) ||
          previous.profileId !== installation.profile.id ||
          (previous.repositoryExclusion !== undefined) !== (installation.gitProject !== undefined) ||
          previous.outputs.length !== projectedManifest.outputs.length ||
          projectedManifest.outputs.some((output) => {
            const previousOutput = previous.outputs.find((entry) => entry.path === output.path);
            return previousOutput?.hash !== output.hash ||
              previousOutput.mode !== output.mode ||
              previousOutput.type !== output.type;
          })
        )
      ) {
        projectItems.push({
          kind: "update",
          project: installation.binding.project,
          reason: "desired output changed",
        });
      } else if (repairableMissingMarker) {
        const repair: SafeRepairWithProjectItem = { class: "missing-marker" };
        projectItems.push({
          ...safeRepairItemClassification(repair),
          project: installation.binding.project,
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
      receipt: projectedManifest,
    };
  }));
  // Active receipts are the sole contribution authority. Deterministic target
  // unions are derived only when planning or publishing the exclusion file.
  let projectedReceipts = state.receipts;
  for (const result of desiredResults) {
    projectedReceipts = [
      ...projectedReceipts.filter((receipt) => receipt.installationId !== result.id),
      result.receipt,
    ];
    projectedReceipts = withRepositoryExclusion(
      projectedReceipts,
      result.id,
      result.gitProject === undefined
        ? undefined
        : {
            entries: [...result.outputs.map((output) => gitExcludeEntry(result.gitProject!, output.path)),
              gitExcludeEntry(result.gitProject!, INSTALLATION_MARKER_PATH)],
            target: result.gitProject.excludeFile,
          },
    );
    items.push(...result.items);
    outputItems.push(...result.outputItems);
    blockers.push(...result.blockers);
  }
  // Exclusion Blockers and diagnostics run after per-Project planning so
  // proven contribution Safe Repairs suppress their Blocker, validate bytes,
  // and subsume any recorded-section repair at their target.
  const exclusionDiagnostics = await gitExclusionDiagnostics(state, desired, {
    gitInspection,
    retiringInstallationIds: intentionallyDeletedInstallationIds,
    ...(includedInstallationIds === undefined ? {} : { includedInstallationIds }),
    ...(eligibleContributionRepairs.length === 0
      ? {}
      : { eligibleContributionRepairs }),
  });
  blockers.push(...(await gitExclusionBlockers(state, desired, {
    gitInspection,
    retiringInstallationIds: intentionallyDeletedInstallationIds,
    ...(includedInstallationIds === undefined ? {} : { includedInstallationIds }),
    ...(eligibleContributionRepairs.length === 0
      ? {}
      : { eligibleContributionRepairs }),
    ...(ineligibleContributionEvidence.size === 0
      ? {}
      : { ineligibleContributionEvidence }),
  })));
  const staleCandidates = scope.kind === "all" ? ordinaryReceipts(state) : [];
  const staleResults = await scheduler.run(staleCandidates.map((installation) => async () => {
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
            "Cannot remove stale generated files: " +
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
    projectedReceipts = projectedReceipts.filter(
      (receipt) => receipt.installationId !== result.installationId,
    );
    items.push(...result.items);
    outputItems.push(...result.outputItems);
    blockers.push(...result.blockers);
  }
  const projectedState = withReceipts(state, projectedReceipts);
  const deduplicated = new Map<string, ReconciliationBlocker>();
  for (const blocker of blockers) {
    const key = JSON.stringify({
      affectedItems: blocker.affectedItems,
      kind: blocker.kind,
      problem: blocker.problem,
      project: blocker.project,
      remedy: blocker.remedy,
      requirement: blocker.requirement,
      scope: blocker.scope,
    });
    if (!deduplicated.has(key)) deduplicated.set(key, blocker);
  }
  const flat: ReconciliationAccumulator = {
    blockers: [...deduplicated.values()].sort((left, right) =>
      (left.project ?? "").localeCompare(right.project ?? "") || left.message.localeCompare(right.message)
    ),
    desired: desiredReport,
    items,
    outputs: outputItems.sort((left, right) =>
      left.project.localeCompare(right.project) || left.path.localeCompare(right.path)
    ),
    outputConsumers,
    repositoryExclusionRepairs: [...exclusionDiagnostics.repairs, ...eligibleContributionRepairs],
    repositoryExclusions: repositoryExclusionChanges(
      state,
      projectedState,
      includedExclusionTargets,
    ),
    diagnosticValues: [...new Set(
      desired.flatMap((installation) =>
        installation.warnings.flatMap((warning) => warning.copyableValues)
      ),
    )].sort(),
    warnings: [...new Set([
      ...desired.flatMap((installation) => installation.warnings.map((warning) => warning.message)),
      ...exclusionDiagnostics.warnings,
    ])].sort(),
  };
  const projectByInstallationId = new Map(
    ordinaryReceipts(state).map((installation) => [installation.installationId, installation.project]),
  );
  desiredResults.forEach((result, index) => {
    projectByInstallationId.set(result.id, desired[index]!.binding.project);
  });
  const exclusionProjects = new Map<string, Set<string>>();
  const includedReportProjects = scope.kind === "all"
    ? undefined
    : new Set(desired.flatMap((installation) => [
        installation.binding.project,
        installation.binding.canonicalProject,
      ]));
  for (const record of [...repositoryExclusionRecords(state), ...repositoryExclusionRecords(projectedState)]) {
    const projects = exclusionProjects.get(record.target) ?? new Set<string>();
    for (const contribution of record.contributions) {
      const project = projectByInstallationId.get(contribution.installationId);
      if (
        project !== undefined &&
        (includedReportProjects === undefined || includedReportProjects.has(project))
      ) {
        projects.add(project);
      }
    }
    exclusionProjects.set(record.target, projects);
  }
  return nestedReconciliationReport(flat, desired, exclusionProjects);
}

export async function stageProjectOutputs(
  desired: DesiredInstallation,
  manifest: OwnershipReceipt,
  previous: OwnershipReceipt | undefined,
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

async function blockedProjectMutationSet(
  report: ReconciliationReport,
  desired: readonly DesiredInstallation[],
  state: OwnershipState,
  inspection: LifecycleOwnershipInspection,
  retirement: InstallationRetirementSelection,
  scheduler: ProjectReadScheduler,
): Promise<Set<string>> {
  const blockedProjects = new Set(
    report.projects
      .filter((project) => project.blockers.length > 0)
      .map((project) => project.canonicalProject),
  );
  // A blocked destination can still share durable identity or one physical Git
  // exclusion target with another Project record. Keep that complete coupled
  // ownership boundary untouched rather than retiring or republishing one side.
  for (const installation of desired) {
    if (!blockedProjects.has(installation.binding.canonicalProject)) continue;
    const markerEvidence = await inspection.inspectMarker(
      installation.binding.canonicalProject,
    );
    const owner = markerEvidence.value === undefined
      ? undefined
      : ordinaryReceipts(state).find((candidate) =>
          candidate.installationId === markerEvidence.value?.installationId
        );
    if (owner !== undefined) {
      blockedProjects.add(owner.project);
    } else if (markerEvidence.kind === "missing") {
      const candidates = ordinaryReceipts(state).filter((candidate) =>
        retirement.intentionallyDeletedProjects.has(candidate.project)
      );
      const possibleMoves = await scheduler.run(candidates.map((candidate) => async () => {
        const generatedOutputs = candidate.outputs.filter((output) =>
          output.path !== markerRelativePath()
        );
        if (generatedOutputs.length === 0) return undefined;
        for (const output of generatedOutputs) {
          if (!await ownedOutputMatches(
            installation.binding.canonicalProject,
            output,
            inspection,
          )) {
            return undefined;
          }
        }
        return candidate.project;
      }));
      for (const project of possibleMoves) {
        if (project !== undefined) blockedProjects.add(project);
      }
    }
  }
  const installationProjectById = new Map(
    ordinaryReceipts(state).map((installation) => [installation.installationId, installation.project]),
  );
  const blockedExclusionTargets = new Set(
    repositoryExclusionRecords(state)
      .filter((record) => record.contributions.some((contribution) => {
        const project = installationProjectById.get(contribution.installationId);
        return project !== undefined && blockedProjects.has(project);
      }))
      .map((record) => record.target),
  );
  for (const installation of desired) {
    if (
      blockedProjects.has(installation.binding.canonicalProject) &&
      installation.gitProject !== undefined
    ) {
      blockedExclusionTargets.add(installation.gitProject.excludeFile);
    }
  }
  for (const record of repositoryExclusionRecords(state)) {
    if (!blockedExclusionTargets.has(record.target)) continue;
    for (const contribution of record.contributions) {
      const project = installationProjectById.get(contribution.installationId);
      if (project !== undefined) blockedProjects.add(project);
    }
  }
  for (const installation of desired) {
    if (
      installation.gitProject !== undefined &&
      blockedExclusionTargets.has(installation.gitProject.excludeFile)
    ) {
      blockedProjects.add(installation.binding.canonicalProject);
    }
  }
  return blockedProjects;
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
    readonly scope?: ReconciliationScope;
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
    readonly scope?: ReconciliationScope;
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
  const scope = options.scope ?? { kind: "all" };
  let before;
  try {
    before = await readInstallationState(home);
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
    scope,
  });
  if (report.globalBlockers.length > 0) {
    throw new ApplyBlockedError(report);
  }
  const retirement = await installationRetirementSelection(
    desired,
    before,
    preflightOwnershipInspection,
    scheduler,
    scope,
  );
  const blockedProjects = await blockedProjectMutationSet(
    report,
    desired,
    before,
    preflightOwnershipInspection,
    retirement,
    scheduler,
  );
  const applicableProjects = report.projects.filter((project) =>
    !blockedProjects.has(project.canonicalProject) &&
    (
      project.state.kind !== "current" ||
      project.outputs.some((output) => output.kind !== "unchanged") ||
      project.repositoryExclusionRepairs.length > 0
    )
  );
  if (
    blockedProjects.size > 0 &&
    (scope.kind === "project" || applicableProjects.length === 0)
  ) {
    throw new ApplyBlockedError(report);
  }
  const currentProjects = new Set(
    report.projects
      .filter((project) => project.state.kind === "current")
      .map((project) => project.project),
  );
  const byProject = new Map(ordinaryReceipts(before).map((installation) => [installation.project, installation]));
  const installationsByProject = new Map(
    ordinaryReceipts(before).map((installation) => [installation.project, installation]),
  );
  // Contribution Safe Repairs publish their exclusion work through the
  // dedicated contribution pass so the complete proven union is staged once.
  const pendingContributionInstallationIds = new Set(
    report.projects
      .filter((project) => !blockedProjects.has(project.canonicalProject))
      .flatMap((project) => project.repositoryExclusionRepairs)
      .filter(isContributionRepair)
      .map((repair) => repair.installationId),
  );
  let workingState = before;
  const movedPreviousProjects = new Set(retirement.movedPreviousProjects);
  const stale = scope.kind === "all"
    ? ordinaryReceipts(before).filter(
        (installation) =>
          !desired.some((item) => item.binding.canonicalProject === installation.project) &&
          !movedPreviousProjects.has(installation.project)
      )
    : [];
  const completed: string[] = [];
  const appliedProjects = new Set<string>();
  const appliedReceipt = (): ReconciliationReport => {
    const actualExclusionChanges = repositoryExclusionChanges(before, workingState);
    return reconciliationReportWithProjects(
      report,
      report.projects
        .filter((project) => appliedProjects.has(project.canonicalProject))
        .map((project) => {
          const installationIds = new Set(
            [...ordinaryReceipts(before), ...ordinaryReceipts(workingState)]
              .filter((installation) => installation.project === project.canonicalProject)
              .map((installation) => installation.installationId),
          );
          const targets = new Set(
            [...repositoryExclusionRecords(before), ...repositoryExclusionRecords(workingState)]
              .filter((record) => record.contributions.some((contribution) =>
                installationIds.has(contribution.installationId)
              ))
              .map((record) => record.target),
          );
          return {
            ...project,
            repositoryExclusions: actualExclusionChanges.filter((change) =>
              targets.has(change.target)
            ),
          };
        }),
    );
  };
  const verifyResultingState = async (state: OwnershipState): Promise<ReconciliationReport> => {
    const verify = options.verifyReconciliation ?? (
      (nextDesired, nextState) => previewReconciliation(nextDesired, nextState, {
        gitInspection: createGitInspection(),
        ownershipInspection: createOwnershipInspection(),
        scheduler,
        scope,
      })
    );
    return verify(desired, state);
  };
  const failExecution = async (failure: {
    readonly cause: unknown;
    readonly failedProject?: string;
    readonly pendingProjects: readonly string[];
  }): Promise<never> => {
    let resultingState: ReconciliationReport | undefined;
    try {
      resultingState = await verifyResultingState(workingState);
    } catch {
      // The execution failure remains primary. The applied receipt still
      // identifies committed Projects when fresh verification also fails.
    }
    throw new ApplyExecutionError({
      ...failure,
      receipt: appliedReceipt(),
      ...(resultingState === undefined ? {} : { resultingState }),
    });
  };
  for (const [index, item] of desired.entries()) {
    if (blockedProjects.has(item.binding.canonicalProject)) continue;
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
        withReceipts(workingState, [
          ...workingState.receipts.filter((receipt) => receipt.lifetime === "temporary"),
          ...installationsByProject.values(),
        ]),
        manifest,
        item.gitProject,
      );
      installationsByProject.set(
        manifest.project,
        ordinaryReceipts(nextState).find(
          (receipt) => receipt.installationId === manifest.installationId,
        )!,
      );
      const projectExclusionTargets = repositoryExclusionTargetsForInstallations(
        workingState,
        [item],
        new Set(previous === undefined ? [] : [previous.installationId]),
      );
      if (!pendingContributionInstallationIds.has(installationId)) {
        exclusions = await stageGitExclusions(
          workingState,
          nextState,
          { includedTargets: projectExclusionTargets ?? new Set() },
        );
      }
      stateWriteAttempted = true;
      await writeState(home, nextState);
      // Publish bytes first; GitExclusionTransaction can restore them if the
      // following project commit reports a failure.
      if (exclusions) await exclusions.commit();
      await transaction.commit();
      byProject.clear();
      for (const installation of ordinaryReceipts(nextState)) {
        byProject.set(installation.project, installation);
      }
      workingState = nextState;
      completed.push(item.binding.canonicalProject);
      appliedProjects.add(item.binding.canonicalProject);
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
      const pending = desired
        .slice(index + 1)
        .filter((entry) =>
          !blockedProjects.has(entry.binding.canonicalProject) &&
          !currentProjects.has(entry.binding.project)
        )
        .map((entry) => entry.binding.canonicalProject)
        .concat(
          stale
            .filter((entry) => !blockedProjects.has(entry.project))
            .map((entry) => entry.project),
        );
      const failureMessage = error instanceof Error ? error.message : String(error);
      const recoveryMessages = [
        ...(rollbackFailure === undefined
          ? []
          : [`Exclusion rollback failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`]),
        ...(stateRestoreFailure === undefined
          ? []
          : [`Installation State restore failed: ${stateRestoreFailure instanceof Error ? stateRestoreFailure.message : String(stateRestoreFailure)}`]),
      ];
      const cause = new Error(
        `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; failed project: ${item.binding.canonicalProject}; pending projects: ${pending.join(", ") || "(none)"}\n${failureMessage}${recoveryMessages.length > 0 ? `\n${recoveryMessages.join("\n")}` : ""}`,
      );
      await failExecution({
        cause,
        failedProject: item.binding.canonicalProject,
        pendingProjects: pending,
      });
    }
  }

  // Destructive staging is a distinct removal pass: each stale removal re-proves
  // ownership from filesystem evidence captured after all earlier project commits
  // and never from preflight snapshots, so changed output cannot be removed
  // without a fresh proof.
  const staleRemovalOwnershipInspection = stale.length > 0
    ? createOwnershipInspection()
    : undefined;
  for (const [index, previous] of stale.entries()) {
    if (blockedProjects.has(previous.project)) continue;
    let transaction: Awaited<ReturnType<typeof stageProvenInstallationRemoval>> | undefined;
    let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
    let stateWriteAttempted = false;
    try {
      const intentionallyDeleted = retirement.intentionallyDeletedProjects.has(previous.project);
      if (!intentionallyDeleted) {
        transaction = await stageProvenInstallationRemoval(previous, staleRemovalOwnershipInspection);
      }
      installationsByProject.delete(previous.project);
      const nextState = withReceipts(
        workingState,
        workingState.receipts.filter(
          (receipt) => receipt.installationId !== previous.installationId,
        ),
      );
      const projectExclusionTargets = repositoryExclusionTargetsForInstallations(
        workingState,
        [],
        new Set([previous.installationId]),
      );
      exclusions = await stageGitExclusions(
        workingState,
        nextState,
        { includedTargets: projectExclusionTargets ?? new Set() },
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
      appliedProjects.add(previous.project);
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
      const pending = stale
        .slice(index + 1)
        .filter((entry) => !blockedProjects.has(entry.project))
        .map((entry) => entry.project);
      const failureMessage = error instanceof Error ? error.message : String(error);
      const recoveryMessages = [
        ...(rollbackFailure === undefined
          ? []
          : [`Exclusion rollback failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`]),
        ...(stateRestoreFailure === undefined
          ? []
          : [`Installation State restore failed: ${stateRestoreFailure instanceof Error ? stateRestoreFailure.message : String(stateRestoreFailure)}`]),
      ];
      const cause = new Error(
        `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; failed project: removal ${previous.project}; pending projects: ${pending.join(", ") || "(none)"}\n${failureMessage}${recoveryMessages.length > 0 ? `\n${recoveryMessages.join("\n")}` : ""}`,
      );
      await failExecution({
        cause,
        failedProject: previous.project,
        pendingProjects: pending,
      });
    }
  }
  // Contribution Safe Repair pass (missing, stale, and moved): record every
  // proven contribution in Installation State and publish the resulting union
  // in one transaction. The staged current state carries only the
  // missing-contribution overlay — a stale target's live section must still
  // match its un-overlaid recorded union, and a moved contribution's receipt
  // stays un-overlaid so both of its targets gate against their recorded
  // unions — while the staged next state carries the full proven overlay, so
  // the byte plan only ever publishes the exact proven delta and never
  // disturbs unrelated repository-local bytes.
  const pendingContributionRepairs = report.projects
    .filter((project) => !blockedProjects.has(project.canonicalProject))
    .flatMap((project) => project.repositoryExclusionRepairs)
    .filter(isContributionRepair);
  const contributionTargets = new Set(pendingContributionRepairs.flatMap(safeRepairTargets));
  if (contributionTargets.size > 0) {
    const stagedCurrentState = withStagedCurrentContributions(workingState, pendingContributionRepairs);
    const contributionState = withProvenContributions(workingState, pendingContributionRepairs);
    let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
    let stateWriteAttempted = false;
    try {
      exclusions = await stageGitExclusions(
        stagedCurrentState,
        contributionState,
        { includedTargets: contributionTargets },
      );
      stateWriteAttempted = true;
      await writeState(home, contributionState);
      await exclusions.commit();
      workingState = contributionState;
      for (const project of report.projects) {
        if (
          !blockedProjects.has(project.canonicalProject) &&
          project.repositoryExclusionRepairs.some(isContributionRepair)
        ) {
          appliedProjects.add(project.canonicalProject);
        }
      }
    } catch (error) {
      let rollbackFailure: unknown;
      if (exclusions) {
        try {
          await exclusions.rollback();
        } catch (failure) {
          rollbackFailure = failure;
        }
      }
      let stateRestoreFailure: unknown;
      if (stateWriteAttempted) {
        try {
          await writeState(home, workingState);
        } catch (failure) {
          stateRestoreFailure = failure;
        }
      }
      const pendingProjects = report.projects
        .filter((project) =>
          !blockedProjects.has(project.canonicalProject) &&
          project.repositoryExclusionRepairs.some(isContributionRepair) &&
          !appliedProjects.has(project.canonicalProject)
        )
        .map((project) => project.canonicalProject);
      const failureMessage = error instanceof Error ? error.message : String(error);
      const recoveryMessages = [
        ...(rollbackFailure === undefined
          ? []
          : [`Exclusion rollback failed: ${rollbackFailure instanceof Error ? rollbackFailure.message : String(rollbackFailure)}`]),
        ...(stateRestoreFailure === undefined
          ? []
          : [`Installation State restore failed: ${stateRestoreFailure instanceof Error ? stateRestoreFailure.message : String(stateRestoreFailure)}`]),
      ];
      await failExecution({
        cause: new Error(
          `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; pending projects: ${pendingProjects.join(", ") || "(none)"}\n${failureMessage}${recoveryMessages.length > 0 ? `\n${recoveryMessages.join("\n")}` : ""}`,
        ),
        pendingProjects,
      });
    }
  }
  try {
    const repairTargets = new Set(
      report.projects
        .filter((project) => !blockedProjects.has(project.canonicalProject))
        .flatMap((project) => project.repositoryExclusionRepairs)
        .filter((repair) => repair.class === "exclusion-section")
        .filter((repair) => !contributionTargets.has(repair.target))
        .map((repair) => repair.target),
    );
    const repairedExclusions = await stageGitExclusions(
      workingState,
      workingState,
      { includedTargets: repairTargets },
    );
    await repairedExclusions.commit();
    for (const project of report.projects) {
      if (
        !blockedProjects.has(project.canonicalProject) &&
        project.repositoryExclusionRepairs.length > 0
      ) {
        appliedProjects.add(project.canonicalProject);
      }
    }
  } catch (error) {
    const pendingProjects = report.projects
      .filter((project) =>
        !blockedProjects.has(project.canonicalProject) &&
        project.repositoryExclusionRepairs.length > 0 &&
        !appliedProjects.has(project.canonicalProject)
      )
      .map((project) => project.canonicalProject);
    await failExecution({ cause: error, pendingProjects });
  }
  const receipt = appliedReceipt();
  let resultingState: ReconciliationReport;
  try {
    // Fresh inspection pass: never reuse preflight Git, exclusion, or ownership
    // snapshots as proof of post-write ownership or exclusion bytes.
    resultingState = await verifyResultingState(workingState);
  } catch (error) {
    throw new ApplyVerificationError(receipt, error);
  }
  return {
    receipt,
    resultingState,
  };
}
