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
  compareCanonicalStrings,
} from "../schemas/installation-manifest.js";
import {
  OWNERSHIP_STATE_SCHEMA_VERSION,
  type OwnershipState,
  type OwnershipOutputReceipt,
  type OwnershipReceipt,
} from "../schemas/ownership-state.js";
import { hostCatalogEntryFor } from "../adapters/host-catalog.js";
import { CONTEXT_ENVELOPE_PREFIX } from "../adapters/context-envelope.js";
import {
  readVerifiedLegacyInstallationMarker,
  recordsLegacyInstallationMarkerPath,
  LEGACY_INSTALLATION_MARKER_PATH,
} from "./legacy-installation-marker.js";
import {
  hashBytes,
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
  readInstallationState,
  stageProvenInstallationRemoval,
  StateReadFailureError,
  writeInstallationState,
  type OwnershipProof,
} from "./installation-state.js";
import { gitExcludeEntry, type GitProject } from "./git.js";
import {
  ingestApplicationModelFromSource,
  readLocalConfigurationSource,
} from "./local-configuration.js";
import {
  ordinaryReceipts,
  retiredReceipts,
  temporaryReceipts,
  withReceipts,
} from "./ownership-state.js";
import {
  createLifecycleGitInspectionContext,
  type LifecycleGitInspection,
} from "./lifecycle-git-inspection.js";
import {
  createLifecycleOwnershipInspectionContext,
  type LifecycleOwnershipInspection,
  recordedOutputMatches,
} from "./lifecycle-ownership-inspection.js";
import {
  createProjectReadScheduler,
  type ProjectReadScheduler,
} from "./project-scheduler.js";
import { withInstallationLifecycleLock } from "./installation-lifecycle-lock.js";
import {
  inspectRepositoryExclusions,
  publishRepositoryExclusions,
  type RepositoryExclusionChange,
  type RepositoryExclusionWarning,
} from "./git-exclusions.js";
import {
  installationOwnershipBlocker,
  installationStateUnreadableBlocker,
  normalizeBlocker,
  occupiedOutputBlocker,
  outputOwnershipConflictBlocker,
  type BlockerInput,
  type OwnershipFailureFact,
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
  | "removal"
  | "stale source"
  | "update";

export interface ReconciliationItem {
  readonly kind: ReconciliationKind;
  readonly project: string;
  /** A diagnostic string, or a typed ownership-failure fact presentation renders. */
  readonly reason?: OwnershipFailureFact | string;
}

export type OutputReconciliationKind =
  | "addition"
  | "removal"
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
  readonly consequence?: string;
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
  readonly exclusionWarnings: readonly RepositoryExclusionWarning[];
  readonly repositoryExclusions: readonly RepositoryExclusionChange[];
  readonly diagnosticValues: readonly string[];
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
  // Installer-classified state-read failures cross as typed facts; foreign
  // diagnostics (fs and parse errors) stay plain detail facts.
  const statePath = stateManifestPath(home);
  const blocker = error instanceof StateReadFailureError
    ? installationStateUnreadableBlocker({ stateFailure: error.failure, statePath })
    : installationStateUnreadableBlocker({ detail: message, statePath });
  return {
    globalBlockers: [normalizeBlocker(blocker)],
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
        occupied: { case: "occupied-parent", occupation: kind },
        path: relativeParent,
        project,
      }));
      break;
    }
    parent = dirname(parent);
  }
  return blockers;
}

async function ownedOutputMatches(
  project: string,
  output: OwnershipOutputReceipt,
  inspection: LifecycleOwnershipInspection,
): Promise<boolean> {
  const result = await inspection.inspectOutput(project, output);
  return recordedOutputMatches(result, output);
}

export async function desiredOutputConflicts(
  desired: DesiredInstallation,
  previous: OwnershipReceipt | undefined,
  inspection: LifecycleOwnershipInspection,
  gitInspection: LifecycleGitInspection = createLifecycleGitInspectionContext(),
  options: {
    /**
     * Whether a byte-identical extant destination is adopted instead of
     * blocking. The ordinary apply adopts it so a re-bound Project at a moved
     * path installs cleanly. Temporary installations must not adopt: their
     * durable Receipt precedes publication, so adoption would give the
     * recovery removal authority over pre-existing bytes it never published.
     */
    readonly adoptByteIdentical?: boolean;
  } = {},
): Promise<readonly BlockerInput[]> {
  const blockers: BlockerInput[] = [];
  const project = desired.binding.canonicalProject;
  const previousOutputs = new Map(previous === undefined ? [] : [
    ...previous.outputs.map((output) => [output.path, output] as const),
  ]);
  const outputs: OwnershipOutputReceipt[] = desired.outputs.map(ownedOutputFromDesired);
  // Prefer the topology already proven for this Desired Installation; fall back
  // only when a caller constructed desired state without Git evidence. Tracked
  // classification stays fail-closed: an inspection failure is a tool error,
  // never a silent "untracked" (DEC-009 covers exclusion bookkeeping only).
  const gitProject: GitProject | undefined = desired.gitProject ??
    await gitInspection.findGitProject(project);
  const trackedPathSet = gitProject === undefined
    ? new Set<string>()
    : await gitInspection.classifyTrackedDestinations(
      gitProject,
      outputs.map((output) => output.path),
    );
  const remedyKeys = new Map(
    desired.outputs.map((output) => [output.path, output.remedyKey]),
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
      // current root. This preflight owns only conflicts at new desired
      // destinations.
      continue;
    }
    blockers.push(...await parentConflicts(project, absolute));
    const kind = await pathKind(absolute);
    if (kind === "missing") continue;
    // Byte-identical existing output is not occupied when adoption applies:
    // the write is a byte-identical no-op, so nothing not created by Agent
    // Profile Kit can be lost. Any other extant content still blocks.
    if (options.adoptByteIdentical !== false && await outputMatchesDesired(project, output, inspection)) continue;
    const remedyKey = remedyKeys.get(output.path);
    if (output.type === "file") {
      if (kind !== "file") {
        blockers.push(occupiedOutputBlocker({
          occupied: { case: "occupied-destination", occupation: kind },
          path: output.path,
          project,
          ...(remedyKey === undefined ? {} : { remedyKey }),
        }));
        continue;
      }
      blockers.push(occupiedOutputBlocker({
        occupied: { case: "drifted-output" },
        path: output.path,
        project,
        ...(remedyKey === undefined ? {} : { remedyKey }),
      }));
      continue;
    }
    if (kind !== "directory") {
      blockers.push(occupiedOutputBlocker({
        occupied: { case: "occupied-destination", occupation: kind },
        path: output.path,
        project,
        ...(remedyKey === undefined ? {} : { remedyKey }),
      }));
      continue;
    }
    blockers.push(occupiedOutputBlocker({
      occupied: { case: "unowned-artifact-directory" },
      path: output.path,
      project,
      ...(remedyKey === undefined ? {} : { remedyKey }),
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

function previousFor(
  desired: DesiredInstallation,
  byProject: ReadonlyMap<string, OwnershipReceipt>,
): OwnershipReceipt | undefined {
  // Project Binding scope alone decides which recorded installation a desired
  // installation reconciles: no copy or relocation detection exists.
  return byProject.get(desired.binding.canonicalProject);
}

async function installationIdsInScope(
  desired: readonly DesiredInstallation[],
  state: OwnershipState,
  scope: ReconciliationScope,
): Promise<ReadonlySet<string> | undefined> {
  if (scope.kind === "all") return undefined;
  const byProject = new Map(ordinaryReceipts(state).map((installation) => [installation.project, installation]));
  const previous = desired.map((installation) => previousFor(installation, byProject));
  return new Set(previous.flatMap((installation) =>
    installation === undefined ? [] : [installation.installationId]
  ));
}

interface InstallationRetirementSelection {
  readonly intentionallyDeletedInstallationIds: ReadonlySet<string>;
  readonly intentionallyDeletedProjects: ReadonlySet<string>;
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
  scheduler: ProjectReadScheduler = createProjectReadScheduler(),
  scope: ReconciliationScope = { kind: "all" },
): Promise<InstallationRetirementSelection> {
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  // Local Configuration is the sole canonical desired-state record, and a
  // successful `unbind` retires the Project's active receipt in the same
  // operation: the retired receipt keeps its recorded detail as the one
  // teardown authority until apply proves and removes the surviving output.
  // Both status and apply use this same reader so deletion intent cannot
  // silently lose its exclusion-ownership safeguards. Independent per-Project
  // reads run through the shared bounded scheduler; the deletion-intent
  // selection folds in canonical order afterwards.
  const intentionallyDeletedProjects = new Set<string>();
  const retiredCandidates = scope.kind === "all"
    ? [...ordinaryReceipts(state), ...retiredReceipts(state)].filter((installation) =>
        !desiredProjects.has(installation.project)
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
      [...ordinaryReceipts(state), ...retiredReceipts(state)]
        .filter((installation) => intentionallyDeletedProjects.has(installation.project))
        .map((installation) => installation.installationId),
    ),
    intentionallyDeletedProjects,
  };
}

function ownershipBlocker(project: string, proof: OwnershipProof): ProjectScopedBlockerInput {
  return installationOwnershipBlocker({
    action: "verify",
    failure: proof.failure ?? { case: "unproven" },
    project,
  });
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

/**
 * Whether the extant Project path already holds exactly the desired bytes.
 * Adopting byte-identical output lets a re-bound Project at a new path install
 * cleanly over its own moved material without ever writing over content that
 * differs from the desired output.
 */
async function outputMatchesDesired(
  project: string,
  output: OwnershipOutputReceipt,
  inspection: LifecycleOwnershipInspection,
): Promise<boolean> {
  return recordedOutputMatches(
    await inspection.inspectOutput(project, output),
    output,
  );
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
    const key = canonicalProject(blocker.project!);
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
    const warnings: ReconciliationWarning[] = installation.warnings.map((warning) => ({
      ...(warning.consequence === undefined ? {} : { consequence: warning.consequence }),
      copyableValues: [...warning.copyableValues],
      kind: "diagnostic" as const,
      message: warning.message,
    }));
    for (const entry of installation.capabilityWarnings) {
      warnings.push({
        copyableValues: [...entry.warning.copyableValues],
        kind: "host-attention",
        message: entry.warning.message,
      });
    }
    warningsByCanonical.set(key, warnings);
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
  // Exclusion inspection warnings attach to every Project record whose
  // receipts contribute to the affected target, so the warning set stays the
  // single home for advisory diagnostics while each Project keeps its own view.
  for (const warning of flat.exclusionWarnings) {
    const affectedProjects = new Set<string>(warning.project === undefined ? [] : [warning.project]);
    for (const target of warning.targets) {
      for (const contributor of exclusionProjects.get(target) ?? []) {
        affectedProjects.add(contributor);
      }
    }
    for (const project of affectedProjects) {
      const key = canonicalProject(project);
      const warnings = warningsByCanonical.get(key) ?? [];
      if (!warnings.some((entry) => entry.message === warning.message)) {
        warnings.push({
          copyableValues: [...warning.targets],
          kind: "diagnostic",
          message: warning.message,
        });
      }
      warningsByCanonical.set(key, warnings);
    }
  }
  const projectKeys = new Set([
    ...desiredByCanonical.keys(),
    ...stateByCanonical.keys(),
    ...projectBlockers.keys(),
    ...outputsByCanonical.keys(),
    ...exclusionsByCanonical.keys(),
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
  } = await installationRetirementSelection(desired, state, scheduler, scope);
  const includedInstallationIds = await installationIdsInScope(
    desired,
    state,
    scope,
  );
  const blockers: ReconciliationBlocker[] = [];
  const desiredReport = desired.map((installation) => {
    return {
      canonicalProject: installation.binding.canonicalProject,
      capabilityContracts: installation.hostVersions,
      context: composedContextFromOutputs(installation.outputs),
      hosts: installation.binding.hosts,
      outputs: installation.outputs.map((output) => output.path),
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
    const previous = previousFor(installation, byProject);
    const id = previous?.installationId ?? newInstallationId();
    const projectedManifest = manifestFor(installation, id);
    const proposedOutputs: OwnershipOutputReceipt[] = installation.outputs.map(ownedOutputFromDesired);
    const previousOutputs = new Map(previous === undefined ? [] : [
      ...previous.outputs.map((output) => [output.path, output] as const),
    ]);
    const ownership = previous
      ? await inspectInstallationOwnership(previous, inspection)
      : undefined;
    const projectOutputItems: OutputReconciliationItem[] = [];
    /** Recorded outputs whose on-disk bytes are absent or drifted from the receipt. */
    const diskMismatchedOutputs = new Set<string>();
    for (const output of proposedOutputs) {
      const previousOutput = previousOutputs.get(output.path);
      let kind: OutputReconciliationKind;
      if (previousOutput === undefined) {
        kind = "addition";
      } else {
        // One shared inspection per recorded output: absent or drifted bytes are
        // ordinary pending update work that `apply` rewrites from the Workspace.
        const disk = await inspection.inspectOutput(installation.binding.canonicalProject, previousOutput);
        const diskMismatched = !recordedOutputMatches(disk, previousOutput);
        if (diskMismatched) diskMismatchedOutputs.add(output.path);
        kind = diskMismatched ||
            previousOutput.hash !== output.hash ||
            previousOutput.mode !== output.mode ||
            previousOutput.type !== output.type
          ? "update"
          : "unchanged";
      }
      projectOutputItems.push({
        kind,
        path: output.path,
        project: installation.binding.project,
      });
      previousOutputs.delete(output.path);
    }
    for (const [path] of previousOutputs) {
      projectOutputItems.push({
        kind: "removal",
        path,
        project: installation.binding.project,
      });
    }
    const project = installation.binding.canonicalProject;
    const projectBlockers: ReconciliationBlocker[] = [];
    const outputConflicts = await desiredOutputConflicts(
      installation,
      previous,
      inspection,
      gitInspection,
    );
    projectBlockers.push(
      ...outputConflicts.map((input) => normalizeBlocker(input, project)),
    );
    const projectItems: ReconciliationItem[] = [];
    if (!previous) {
      projectItems.push({
        kind: "addition",
        project: installation.binding.project,
      });
    } else {
      const proof = ownership ?? await inspectInstallationOwnership(previous, inspection);
      if (!proof.owned) {
        projectBlockers.push(normalizeBlocker(
          { ...ownershipBlocker(installation.binding.project, proof), project },
          project,
        ));
      }
      if (!proof.owned) {
        projectItems.push({
          kind: "drifted output",
          project: installation.binding.project,
          ...(proof.failure ? { reason: proof.failure } : {}),
        });
      // Surface safe recreation ahead of stale source because apply restores from
      // that current source.
      } else if (diskMismatchedOutputs.size > 0) {
        // Identity-proven freshness drift and wholly absent roots are ordinary
        // pending generated-output work: apply replaces the whole recorded root
        // from current Workspace source. It never blocks the lifecycle or
        // revokes ownership.
        projectItems.push({
          kind: "drifted output",
          project: installation.binding.project,
          reason: [...diskMismatchedOutputs]
            .sort(compareCanonicalStrings)
            .join(", "),
        });
      } else if (previous.desiredInputDigest !== installation.sourceHash) {
        projectItems.push({
          kind: "stale source",
          project: installation.binding.project,
        });
      } else if (
        !hostReceiptsEqual(previous, installation) ||
        previous.profileId !== installation.profile.id ||
        previous.outputs.length !== projectedManifest.outputs.length ||
          projectedManifest.outputs.some((output) => {
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
  // Desired receipts replace prior records; exclusion entries are derived
  // from the projected receipts' recorded output roots at write time and are
  // never stored.
  let projectedReceipts = state.receipts;
  for (const result of desiredResults) {
    projectedReceipts = [
      ...projectedReceipts.filter((receipt) => receipt.installationId !== result.id),
      result.receipt,
    ];
    items.push(...result.items);
    outputItems.push(...result.outputItems);
    blockers.push(...result.blockers);
  }
  // Exclusion inspection runs over the projected state after per-Project
  // planning: published entries derive from the receipts that will exist after
  // this operation. It is advisory only — no exclusion condition can block.
  const includedProjects = scope.kind === "all"
    ? undefined
    : new Set([
      ...desired.map((installation) => installation.binding.canonicalProject),
    ]);
  // Retired receipts (from unbind) join the stale candidates: apply consumes
  // their recorded detail to prove and remove the surviving output, exactly as
  // it consumes receipts orphaned by a supported hand edit. A retired receipt
  // whose Project is desired again is consumed by the ordinary install pass
  // below instead: the fresh binding owns a clean lifetime.
  const staleCandidates = scope.kind === "all"
    ? [...ordinaryReceipts(state), ...retiredReceipts(state)]
      .sort((left, right) => compareCanonicalStrings(left.project, right.project))
    : [];
  const staleResults = await scheduler.run(staleCandidates.map((installation) => async () => {
    if (desiredProjects.has(installation.project)) {
      return installation.retired === true
        ? {
          blockers: [],
          installationId: installation.installationId,
          items: [],
          outputItems: [],
        }
        : undefined;
    }
    const intentionallyDeleted = intentionallyDeletedProjects.has(installation.project);
    const proof = intentionallyDeleted
      ? { owned: true as const }
      : await proveOwnedInstallation(installation, inspection, gitInspection);
    const projectBlockers: ReconciliationBlocker[] = [];
    if (!proof.owned) {
      projectBlockers.push(normalizeBlocker(
        installationOwnershipBlocker({
          action: "remove",
          failure: proof.failure ?? { case: "unproven" },
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
          : proof.failure
            ? { reason: proof.failure }
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
  const exclusionInspection = await inspectRepositoryExclusions(projectedState, {
    gitInspection,
    markerState: state,
    ...(includedProjects === undefined ? {} : { includedProjects }),
    installedProjects: new Set(ordinaryReceipts(state).map((receipt) => receipt.project)),
  });
  const deduplicated = new Map<string, ReconciliationBlocker>();
  for (const blocker of blockers) {
    const key = JSON.stringify(blocker);
    if (!deduplicated.has(key)) deduplicated.set(key, blocker);
  }
  const flat: ReconciliationAccumulator = {
    blockers: [...deduplicated.values()].sort((left, right) =>
      (left.project ?? "").localeCompare(right.project ?? "") ||
      left.kind.localeCompare(right.kind) ||
      JSON.stringify(left.affectedItems).localeCompare(JSON.stringify(right.affectedItems))
    ),
    desired: desiredReport,
    items,
    outputs: outputItems.sort((left, right) =>
      left.project.localeCompare(right.project) || left.path.localeCompare(right.path)
    ),
    outputConsumers,
    exclusionWarnings: exclusionInspection.warnings,
    repositoryExclusions: exclusionInspection.changes,
    diagnosticValues: [...new Set(
      desired.flatMap((installation) =>
        installation.warnings.flatMap((warning) => warning.copyableValues)
      ),
    )].sort(),
  };
  const projectByInstallationId = new Map(
    [...ordinaryReceipts(state), ...retiredReceipts(state)].map(
      (installation) => [installation.installationId, installation.project],
    ),
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
  for (const [target, projects] of exclusionInspection.targetProjects) {
    const included = includedReportProjects === undefined
      ? [...projects]
      : projects.filter((project) => includedReportProjects.has(project));
    if (included.length === 0) continue;
    exclusionProjects.set(target, new Set(included));
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
  const outputs = [...desired.outputs];
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
    // Migration: a leftover ownership-token file from an earlier version
    // leaves with this transaction unless the current outputs record it and
    // only when the bytes verify as the previous version's token. Unknown
    // content at the legacy pathname is user material — preserve it.
    const recordedOrDesiredPaths = new Set([
      ...outputs.map((output) => output.path),
      ...manifest.outputs.map((output) => output.path),
    ]);
    if (
      !recordedOrDesiredPaths.has(LEGACY_INSTALLATION_MARKER_PATH) &&
      previous !== undefined &&
      (await readVerifiedLegacyInstallationMarker(project, previous.installationId)) !== undefined
    ) {
      const legacyDestination = join(project, LEGACY_INSTALLATION_MARKER_PATH);
      if ((await pathKind(legacyDestination)) !== "missing") {
        const prior = join(backup, LEGACY_INSTALLATION_MARKER_PATH);
        await fileSystem.mkdir(dirname(prior), { recursive: true });
        await fileSystem.rename(legacyDestination, prior);
        moved.push(legacyDestination);
      }
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
): Promise<Set<string>> {
  // Exclusion bookkeeping is best-effort and can never block, so the blocked
  // set is exactly the Projects whose own report carries Blockers.
  return new Set(
    report.projects
      .filter((project) => project.blockers.length > 0)
      .map((project) => project.canonicalProject),
  );
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
  // Serialize the desired-state snapshot with lifecycle mutation: Local
  // Configuration is re-ingested under the lifecycle lock and must still match
  // the bindings `desired` was planned from, or a concurrent bind/unbind could
  // resurrect an active Installation Receipt after its binding was removed.
  // Fail closed; the retry re-plans from the current configuration. Bindings
  // are matched by authored path so a missing unrelated root in a scoped run
  // stays irrelevant while any desired binding drift fails the run.
  const configurationSource = await readLocalConfigurationSource(home);
  const freshModel = await ingestApplicationModelFromSource(
    home,
    configurationSource.source,
    configurationSource.path,
    { allowMissingProjects: true },
  );
  const bindingTuple = (binding: {
    readonly canonicalProject?: string;
    readonly hosts: readonly string[];
    readonly profile: string;
    readonly project: string;
  }): string =>
    JSON.stringify([
      binding.project,
      binding.canonicalProject ?? null,
      binding.profile,
      binding.hosts,
    ]);
  const expectedBindings = new Map(
    desired.map((installation) => [installation.binding.project, bindingTuple(installation.binding)]),
  );
  const freshBindings = new Map(
    freshModel.bindings
      .filter((binding) => expectedBindings.has(binding.project))
      .map((binding) => [binding.project, bindingTuple(binding)]),
  );
  const configurationMismatch = scope.kind === "all"
    ? expectedBindings.size !== freshModel.bindings.length ||
      freshModel.bindings.some((binding) => !expectedBindings.has(binding.project)) ||
      [...expectedBindings].some(([project, tuple]) => freshBindings.get(project) !== tuple)
    : [...expectedBindings].some(([project, tuple]) => freshBindings.get(project) !== tuple);
  if (configurationMismatch) {
    throw new Error(
      "Local Configuration changed while apply was planning; retry apply",
    );
  }
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
    scheduler,
    scope,
  );
  const blockedProjects = await blockedProjectMutationSet(report);
  const applicableProjects = report.projects.filter((project) =>
    !blockedProjects.has(project.canonicalProject) &&
    (
      project.state.kind !== "current" ||
      project.outputs.some((output) => output.kind !== "unchanged") ||
      project.repositoryExclusions.length > 0
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
  let workingState = before;
  const stale = scope.kind === "all"
    ? [...ordinaryReceipts(before), ...retiredReceipts(before)]
      .filter(
        (installation) =>
          !desired.some((item) => item.binding.canonicalProject === installation.project)
      )
      .sort((left, right) => compareCanonicalStrings(left.project, right.project))
    : [];
  const completed: string[] = [];
  const appliedProjects = new Set<string>();
  /** Best-effort publication result; filled by the final publication pass. */
  let publication: Awaited<ReturnType<typeof publishRepositoryExclusions>> | undefined;
  /** Inverse of the publication's target→Projects map, for report attachment. */
  let publicationProjects = new Map<string, readonly string[]>();
  const appliedReceipt = (): ReconciliationReport => {
    return reconciliationReportWithProjects(
      report,
      report.projects
        .filter((project) => appliedProjects.has(project.canonicalProject))
        .map((project) => {
          const targets = publicationProjects.get(project.canonicalProject);
          if (publication === undefined || targets === undefined) return project;
          const attached = publication.changes.filter((change) => targets.includes(change.target));
          const warnings = publication.warnings.filter((warning) =>
            warning.targets.some((target) => targets.includes(target)) ||
            warning.project === project.canonicalProject
          );
          return {
            ...project,
            repositoryExclusions: attached,
            warnings: [
              ...project.warnings,
              ...warnings.map((warning) => ({
                copyableValues: [...warning.targets],
                kind: "diagnostic" as const,
                message: warning.message,
              })),
            ],
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
    const previous = previousFor(item, byProject);
    if (currentProjects.has(item.binding.project)) {
      // Migration: a leftover ownership-token file from an earlier version
      // leaves with the next apply even when the Project is otherwise current.
      // The sweep skips the path when this installation records or desires an
      // output there (the path is no longer reserved), and removes only bytes
      // that verify as the previous version's token naming this Project's own
      // Installation Receipt — unknown content and foreign tokens stay.
      const claimsLegacyPath =
        recordsLegacyInstallationMarkerPath(item.outputs) ||
        (previous !== undefined && recordsLegacyInstallationMarkerPath(previous.outputs));
      if (
        !claimsLegacyPath &&
        (await readVerifiedLegacyInstallationMarker(
          item.binding.canonicalProject,
          previous?.installationId,
        )) !== undefined
      ) {
        await fileSystem.rm(
          join(item.binding.canonicalProject, LEGACY_INSTALLATION_MARKER_PATH),
          { force: true },
        );
      }
      continue;
    }
    let transaction: { readonly commit: () => Promise<void>; readonly rollback: () => Promise<void> } | undefined;
    let stateWriteAttempted = false;
    try {
      const installationId = previous?.installationId ?? newInstallationId();
      const manifest = manifestFor(item, installationId);
      transaction = await stageProjectOutputs(item, manifest, previous, fileSystem);
      installationsByProject.set(manifest.project, manifest);
      // A retired receipt whose Project is desired again is consumed here: the
      // fresh binding starts a clean lifetime, so its record leaves with this
      // state write instead of pending a stale-removal pass against fresh
      // output it no longer describes.
      const remainingRetired = retiredReceipts(workingState)
        .filter((receipt) => receipt.project !== item.binding.canonicalProject);
      const nextState = withReceipts(workingState, [
        ...temporaryReceipts(workingState),
        ...remainingRetired,
        ...installationsByProject.values(),
      ]);
      installationsByProject.set(
        manifest.project,
        ordinaryReceipts(nextState).find(
          (receipt) => receipt.installationId === manifest.installationId,
        )!,
      );
      stateWriteAttempted = true;
      await writeState(home, nextState);
      await transaction.commit();
      byProject.clear();
      for (const installation of ordinaryReceipts(nextState)) {
        byProject.set(installation.project, installation);
      }
      workingState = nextState;
      completed.push(item.binding.canonicalProject);
      appliedProjects.add(item.binding.canonicalProject);
    } catch (error) {
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
      stateWriteAttempted = true;
      await writeState(home, nextState);
      if (transaction) await transaction.commit();
      byProject.delete(previous.project);
      workingState = nextState;
      completed.push(`removal ${previous.project}`);
      appliedProjects.add(previous.project);
    } catch (error) {
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

  // One best-effort exclusion publication pass after all state and output
  // writes: every derived target's owned section is rewritten from the final
  // receipts' recorded output roots, preserving unrelated bytes. A failure to
  // read, derive, or write any target produces one warning for that target and
  // never affects the outcome of the installation. Exclusions are a cache, so
  // there is no rollback: a superseded or failed write self-heals on the next
  // apply.
  const includedPublicationProjects = scope.kind === "all"
    ? undefined
    : new Set(desired.map((installation) => installation.binding.canonicalProject));
  publication = await publishRepositoryExclusions(workingState, {
    gitInspection: createGitInspection(),
    previousState: before,
    ...(includedPublicationProjects === undefined ? {} : { includedProjects: includedPublicationProjects }),
  });
  publicationProjects = new Map(
    [...publication.targetProjects].flatMap(([target, projects]) =>
      projects.map((project) => [project, [target] as const] as const),
    ),
  );
  for (const project of report.projects) {
    if (publicationProjects.has(project.canonicalProject)) {
      appliedProjects.add(project.canonicalProject);
    }
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
