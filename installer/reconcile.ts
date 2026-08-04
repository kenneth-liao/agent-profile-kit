import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  INSTALLATION_MARKER_PATH,
  INSTALLATION_STATE_SCHEMA_VERSION,
  type InstallationState,
  type OwnedOutput,
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";
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
  inspectOwnedDirectory,
  inspectInstallationOwnership,
  newInstallationId,
  proveOwnedInstallation,
  proveRemainingOwnedOutputs,
  readInstallationStateWithMigration,
  readMarker,
  stageProvenInstallationRemoval,
  writeInstallationState,
  type OwnershipProof,
} from "./installation-state.js";
import { hasTrackedGitDescendants } from "./git.js";
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
  normalizeBlocker,
  type BlockerInput,
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
  | "intended teardown"
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
  | "drifted member"
  | "missing member"
  | "removal"
  | "repair"
  | "unchanged"
  | "unexpected member"
  | "update";

export interface OutputReconciliationItem {
  readonly kind: OutputReconciliationKind;
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
  readonly repositoryExclusionRepairs: readonly RepositoryExclusionRepair[];
  readonly repositoryExclusions: readonly RepositoryExclusionChange[];
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
    blockers: [normalizeBlocker(message)],
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

export function manifestFor(
  desired: DesiredInstallation,
  installationId: string,
): ProjectInstallationManifest {
  const marker = markerText({ installationId, schemaVersion: 1 });
  const outputs: OwnedOutput[] = [
    ...desired.outputs.map(ownedOutputFromDesired),
    { hash: hashMarker(marker), mode: 0o644, path: markerRelativePath(), type: "file" as const },
  ].sort((left, right) => left.path.localeCompare(right.path));
  return {
    adapterVersion: desired.adapterVersion,
    engineVersion: desired.engineVersion,
    gitProject: desired.gitProject !== undefined,
    hosts: desired.binding.hosts,
    hostVersions: desired.hostVersions,
    installationId,
    outputs,
    profileId: desired.profile.id,
    project: desired.binding.canonicalProject,
    resolvedArtifacts: desired.resolvedProfile.artifacts.map((artifact) => ({
      inclusionReasons: artifact.inclusionReasons.map((reason) => ({
        path: reason.path,
        profile: reason.profileId,
      })),
      reference: artifact.reference,
    })),
    schemaVersion: 2,
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
    intendedTeardowns: state.intendedTeardowns.filter(
      (teardown) => teardown.project !== installation.project,
    ),
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

function hostVersionsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
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

async function parentConflicts(project: string, path: string): Promise<readonly string[]> {
  const blockers: string[] = [];
  let parent = dirname(path);
  while (parent !== project && parent.startsWith(`${project}/`)) {
    const kind = await pathKind(parent);
    if (kind !== "missing" && kind !== "directory") {
      blockers.push(`${parent} is an occupied ${kind} parent path`);
      break;
    }
    parent = dirname(parent);
  }
  return blockers;
}

async function fileOutputMatches(
  project: string,
  output: Extract<OwnedOutput, { type: "file" }>,
): Promise<boolean> {
  const path = join(project, output.path);
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile() || (stats.mode & 0o7777) !== output.mode) return false;
    const bytes = await readFile(path);
    return hashMarker(bytes) === output.hash;
  } catch {
    return false;
  }
}

async function directoryOutputMatches(
  project: string,
  output: Extract<OwnedOutput, { type: "directory" }>,
): Promise<boolean> {
  const inspection = await inspectOwnedDirectory(project, output);
  return (
    inspection.missingMembers.length === 0 &&
    inspection.driftedMembers.length === 0 &&
    inspection.modeDriftedMembers.length === 0 &&
    inspection.unexpectedMembers.length === 0
  );
}

async function ownedOutputMatches(
  project: string,
  output: OwnedOutput,
): Promise<boolean> {
  if (output.type === "file") return fileOutputMatches(project, output);
  return directoryOutputMatches(project, output);
}

async function pathIsTrackedDestination(project: string, relativePath: string): Promise<boolean> {
  // Fail closed: Git inspection errors propagate rather than looking untracked.
  return hasTrackedGitDescendants(project, relativePath);
}

export async function desiredOutputConflicts(
  desired: DesiredInstallation,
  previous: ProjectInstallationManifest | undefined,
  installationId: string,
): Promise<readonly string[]> {
  const blockers: string[] = [];
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
  for (const output of outputs) {
    const absolute = outputPath(desired.binding.canonicalProject, output);
    if (await pathIsTrackedDestination(desired.binding.canonicalProject, output.path)) {
      blockers.push(`${absolute} is a tracked project path`);
      continue;
    }
    const old = previousOutputs.get(output.path);
    if (old?.type === output.type) {
      // Recorded outputs are checked once by ownership inspection at the
      // current root, including the Marker-proven destination of a move.
      // This preflight owns only conflicts at new desired destinations.
      continue;
    }
    blockers.push(...await parentConflicts(desired.binding.canonicalProject, absolute));
    const kind = await pathKind(absolute);
    if (kind === "missing") continue;
    if (output.type === "file") {
      if (kind !== "file") {
        blockers.push(`${absolute} is an occupied ${kind} path`);
        continue;
      }
      blockers.push(`${absolute} is occupied by unowned or drifted output`);
      continue;
    }
    if (kind !== "directory") {
      blockers.push(`${absolute} is an occupied ${kind} path`);
      continue;
    }
    blockers.push(`${absolute} is an occupied unowned artifact directory`);
  }
  return blockers;
}

async function identityBlockers(
  desired: DesiredInstallation,
  state: InstallationState,
  installationId: string,
): Promise<readonly string[]> {
  const marker = markerPath(desired.binding.canonicalProject);
  const markerKind = await pathKind(marker);
  if (markerKind === "missing") return [];
  if (markerKind !== "file") return [`${marker} is not a regular Installation Marker file`];
  let markerValue;
  try {
    markerValue = await readMarker(desired.binding.canonicalProject);
  } catch (error) {
    return [`${marker} is malformed: ${error instanceof Error ? error.message : String(error)}`];
  }
  if (!markerValue) return [`${marker} is missing`];
  const owner = state.installations.find((installation) => installation.installationId === markerValue.installationId);
  if (owner && owner.project !== desired.binding.canonicalProject) {
    if ((await pathKind(owner.project)) === "missing") return [];
    return [`${marker} copies Installation Marker identity owned by ${owner.project}`];
  }
  if (!owner && markerValue.installationId !== installationId) {
    return [`${marker} contains an unknown Installation Marker identity; restore the Marker linked to this project's Manifest or remove the unowned generated paths before retrying`];
  }
  return [];
}

async function previousFor(
  desired: DesiredInstallation,
  state: InstallationState,
  byProject: ReadonlyMap<string, ProjectInstallationManifest>,
): Promise<ProjectInstallationManifest | undefined> {
  const canonicalProject = desired.binding.canonicalProject;
  const direct = byProject.get(canonicalProject);
  if (direct) return direct;
  let marker;
  try {
    marker = await readMarker(canonicalProject);
  } catch {
    return undefined;
  }
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
 */
async function installationRetirementSelection(
  desired: readonly DesiredInstallation[],
  state: InstallationState,
): Promise<InstallationRetirementSelection> {
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  const byProject = new Map(state.installations.map((installation) => [installation.project, installation]));
  const movedPreviousProjects = new Set<string>();
  for (const installation of desired) {
    const previous = await previousFor(installation, state, byProject);
    if (previous && previous.project !== installation.binding.canonicalProject) {
      movedPreviousProjects.add(previous.project);
    }
  }
  // Local Configuration is the sole canonical desired-state record. A successful
  // exact-path `unbind` (or an equivalent supported hand edit) is represented by
  // the binding's absence; no second retirement tombstone is persisted.
  const intentionallyDeletedProjects = new Set<string>();
  for (const installation of state.installations) {
    if (
      !desiredProjects.has(installation.project) &&
      !movedPreviousProjects.has(installation.project) &&
      (await pathKind(installation.project)) === "missing"
    ) {
      intentionallyDeletedProjects.add(installation.project);
    }
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

function ownershipBlocker(project: string, proof: OwnershipProof): string {
  const reason = proof.reason ?? "ownership could not be proven";
  if (proof.driftKind) {
    const deletionRoute = proof.driftKind === "unexpected-member"
      ? "delete the unexpected file"
      : proof.driftKind === "both"
        ? "delete the edited generated file and the unexpected file"
        : "delete the generated file";
    return (
      `Cannot reconcile Profile Installation at ${project}: ${reason}. ` +
      "Agent Profile Kit will not overwrite your edit. Move the change into the Workspace, " +
      `or ${deletionRoute}, then run ${COMMAND_NAME} apply to restore the generated output`
    );
  }
  return `Cannot reconcile Profile Installation at ${project}: ${reason}`;
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

function pushDirectoryMemberItems(
  outputItems: OutputReconciliationItem[],
  project: string,
  inspection: Awaited<ReturnType<typeof inspectOwnedDirectory>>,
): void {
  for (const path of inspection.missingMembers) {
    outputItems.push({ kind: "missing member", path, project });
  }
  for (const path of new Set([...inspection.driftedMembers, ...inspection.modeDriftedMembers])) {
    outputItems.push({ kind: "drifted member", path, project });
  }
  for (const path of inspection.unexpectedMembers) {
    outputItems.push({ kind: "unexpected member", path, project });
  }
}

export async function previewReconciliation(
  desired: readonly DesiredInstallation[],
  state: InstallationState,
): Promise<ReconciliationReport> {
  const items: ReconciliationItem[] = [];
  const outputItems: OutputReconciliationItem[] = [];
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  const byProject = new Map(state.installations.map((installation) => [installation.project, installation]));
  const {
    intentionallyDeletedInstallationIds,
    intentionallyDeletedProjects,
    movedPreviousProjects,
  } = await installationRetirementSelection(desired, state);
  const blockers: BlockerInput[] = desired.flatMap((installation) =>
    installation.blockers.map((message) =>
      normalizeBlocker(message, installation.binding.canonicalProject)
    )
  );
  blockers.push(...(await gitExclusionBlockers(state, desired, {
    retiringInstallationIds: intentionallyDeletedInstallationIds,
  })).map((message) => ({ message })));
  const exclusionDiagnostics = await gitExclusionDiagnostics(state, desired);
  const desiredReport = desired.map((installation) => {
    return {
      canonicalProject: installation.binding.canonicalProject,
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
  let projectedExclusions = state.repositoryExclusions;
  for (const installation of desired) {
    const previous = await previousFor(installation, state, byProject);
    const moved = previous && previous.project !== installation.binding.canonicalProject;
    const id = previous?.installationId ?? newInstallationId();
    const projectedManifest = manifestFor(installation, id);
    projectedExclusions = replaceRepositoryExclusionContribution(
      projectedExclusions,
      id,
      installation.gitProject,
      projectedManifest.outputs,
    );
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
      ? await inspectInstallationOwnership(ownershipTarget)
      : undefined;
    const proposedOutputPaths = new Set(proposedOutputs.map((output) => output.path));
    const repairableMissingOutputs = new Set(
      (ownership?.repairableMissingOutputs ?? []).filter((path) => proposedOutputPaths.has(path)),
    );
    for (const output of proposedOutputs) {
      const previousOutput = previousOutputs.get(output.path);
      const kind: OutputReconciliationKind = repairableMissingOutputs.has(output.path)
        ? "repair"
        : previousOutput === undefined
        ? "addition"
        : previousOutput.hash === output.hash &&
            previousOutput.mode === output.mode &&
            previousOutput.type === output.type
          ? "unchanged"
          : "update";
      outputItems.push({
        kind,
        path: output.path,
        project: installation.binding.project,
      });
      if (previousOutput?.type === "directory" && previous && kind !== "repair") {
        pushDirectoryMemberItems(
          outputItems,
          installation.binding.project,
          await inspectOwnedDirectory(installation.binding.canonicalProject, previousOutput),
        );
      }
      previousOutputs.delete(output.path);
    }
    for (const [path, previousOutput] of previousOutputs) {
      outputItems.push({
        kind: "removal",
        path,
        project: installation.binding.project,
      });
      if (previousOutput.type === "directory" && previous) {
        pushDirectoryMemberItems(
          outputItems,
          installation.binding.project,
          await inspectOwnedDirectory(installation.binding.canonicalProject, previousOutput),
        );
      }
    }
    const project = installation.binding.canonicalProject;
    const outputConflicts = await desiredOutputConflicts(installation, previous, id);
    blockers.push(
      ...(await identityBlockers(installation, state, id)).map((message) => ({ message, project })),
      ...outputConflicts.map((message) => ({ message, project })),
    );
    if (!previous && outputConflicts.length > 0) {
      let copiedInstallation = false;
      for (const candidate of state.installations) {
        if (!intentionallyDeletedProjects.has(candidate.project)) continue;
        const copiedOutputs = candidate.outputs.filter((output) => output.path !== markerRelativePath());
        if (
          copiedOutputs.length > 0 &&
          (await Promise.all(copiedOutputs.map((output) => ownedOutputMatches(project, output)))).every(Boolean)
        ) {
          copiedInstallation = true;
          break;
        }
      }
      if (copiedInstallation) {
        blockers.push({
          message: ownershipBlocker(
            installation.binding.project,
            {
              failureKind: "missing",
              owned: false,
              reason: "Installation Marker is missing; if this project moved, restore its Manifest-linked Installation Marker at the new root before retrying",
            },
          ),
          project,
        });
      }
    }
    if (!previous) {
      const intendedTeardown = state.intendedTeardowns.some(
        (teardown) =>
          teardown.project === installation.binding.canonicalProject &&
          teardown.profileId === installation.profile.id &&
          teardown.hosts.length === installation.binding.hosts.length &&
          teardown.hosts.every((host, index) => host === installation.binding.hosts[index]),
      );
      items.push({
        kind: intendedTeardown ? "intended teardown" : "addition",
        project: installation.binding.project,
        ...(intendedTeardown
          ? { reason: "Output was removed by uninstall; Project Binding was preserved" }
          : {}),
      });
      continue;
    }
    if (moved) {
      if (ownership && !ownership.owned) {
        blockers.push({
          message: ownershipBlocker(installation.binding.project, ownership),
          project,
        });
      }
      items.push({
        kind: "update",
        project: installation.binding.project,
        reason: "project moved",
      });
      continue;
    }
    const markerKind = await pathKind(markerPath(installation.binding.canonicalProject));
    const proof = ownership ?? await inspectInstallationOwnership(previous);
    let repairableMissingMarker = false;
    if (markerKind === "missing") {
      const remaining = await proveRemainingOwnedOutputs(previous);
      repairableMissingMarker = remaining.owned;
      if (!remaining.owned) {
        blockers.push({
          message: ownershipBlocker(installation.binding.project, {
            ...remaining,
            reason: `Installation Marker is missing and ${remaining.reason ?? "remaining output ownership cannot be proven"}`,
          }),
          project,
        });
      }
    } else if (!proof.owned) {
      blockers.push({
        message: ownershipBlocker(installation.binding.project, proof),
        project,
      });
    }
    const repairableMissingOutput = repairableMissingOutputs.size > 0;
    if (!proof.owned && !repairableMissingMarker && !repairableMissingOutput) {
      items.push({
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
      items.push({
        kind: "repairable missing output",
        project: installation.binding.project,
        reason: [...repairableMissingOutputs].join(", "),
      });
    } else if (previous.workspaceInputHash !== installation.sourceHash) {
      items.push({
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
      items.push({
        kind: "update",
        project: installation.binding.project,
        reason: "desired output changed",
      });
    } else if (repairableMissingMarker) {
      items.push({
        kind: "update",
        project: installation.binding.project,
        reason: "Installation Marker is missing and repairable",
      });
    } else {
      items.push({
        kind: "current",
        project: installation.binding.project,
      });
    }
  }
  for (const installation of state.installations) {
    if (desiredProjects.has(installation.project) || movedPreviousProjects.has(installation.project)) continue;
    const intentionallyDeleted = intentionallyDeletedProjects.has(installation.project);
    const proof = intentionallyDeleted
      ? { owned: true as const }
      : await proveOwnedInstallation(installation);
    if (!proof.owned) {
      const remediation = proof.reason?.includes("Installation Marker")
        ? "; if this project moved, restore its Manifest-linked Installation Marker at the new root before retrying"
        : "";
      blockers.push({
        message: `Cannot remove stale Profile Installation at ${installation.project}: ${proof.reason ?? "ownership could not be proven"}${remediation}`,
        project: installation.project,
      });
    }
    items.push({
      kind: "removal",
      project: installation.project,
      ...(intentionallyDeleted
        ? { reason: "project intentionally deleted" }
        : proof.reason
          ? { reason: proof.reason }
          : {}),
    });
    for (const output of installation.outputs) {
      outputItems.push({
        kind: "removal",
        path: output.path,
        project: installation.project,
      });
    }
    projectedExclusions = replaceRepositoryExclusionContribution(
      projectedExclusions,
      installation.installationId,
      undefined,
      [],
    );
  }
  const projectedState: InstallationState = {
    intendedTeardowns: state.intendedTeardowns,
    installations: state.installations,
    repositoryExclusions: projectedExclusions,
    schemaVersion: INSTALLATION_STATE_SCHEMA_VERSION,
    temporaryInstallations: state.temporaryInstallations,
  };
  return {
    blockers: [...new Map(
      blockers.map((input) => {
        const blocker = normalizeBlocker(input);
        const structured = "kind" in blocker
          ? JSON.stringify({
              affectedItems: blocker.affectedItems,
              kind: blocker.kind,
              problem: blocker.problem,
              remedy: blocker.remedy,
              requirement: blocker.requirement,
              scope: blocker.scope,
            })
          : "";
        return [
          `${blocker.project ?? ""}\0${blocker.message}\0${structured}`,
          blocker,
        ] as const;
      }),
    ).values()].sort((left, right) =>
      (left.project ?? "").localeCompare(right.project ?? "") || left.message.localeCompare(right.message)
    ),
    desired: desiredReport,
    items,
    outputs: outputItems.sort((left, right) =>
      left.project.localeCompare(right.project) || left.path.localeCompare(right.path)
    ),
    repositoryExclusionRepairs: exclusionDiagnostics.repairs,
    repositoryExclusions: repositoryExclusionChanges(state, projectedState),
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
    readonly fileSystem?: Partial<ReconciliationFileSystem>;
    readonly lockTimeoutMs?: number;
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
    readonly fileSystem?: Partial<ReconciliationFileSystem>;
    readonly verifyReconciliation?: typeof previewReconciliation;
    readonly writeInstallationState?: typeof writeInstallationState;
  } = {},
): Promise<ApplyReconciliationResult> {
  const fileSystem: ReconciliationFileSystem = { ...nodeFileSystem, ...options.fileSystem };
  const writeState = options.writeInstallationState ?? writeInstallationState;
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
  const report = await previewReconciliation(desired, before);
  const [blocker, ...remainingBlockers] = report.blockers;
  if (blocker) {
    throw new ApplyBlockedError({
      ...report,
      blockers: [blocker, ...remainingBlockers],
    });
  }
  const retirement = await installationRetirementSelection(desired, before);
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
    const previous = await previousFor(item, before, byProject);
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
          intendedTeardowns: workingState.intendedTeardowns,
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
  for (const [index, previous] of stale.entries()) {
    let transaction: Awaited<ReturnType<typeof stageProvenInstallationRemoval>> | undefined;
    let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
    let stateWriteAttempted = false;
    try {
      const intentionallyDeleted = retirement.intentionallyDeletedProjects.has(previous.project);
      if (!intentionallyDeleted) {
        transaction = await stageProvenInstallationRemoval(previous);
      }
      installationsByProject.delete(previous.project);
      const nextState: InstallationState = {
        intendedTeardowns: workingState.intendedTeardowns,
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
    await writeState(home, workingState);
  }
  const repairedExclusions = await stageGitExclusions(workingState, workingState);
  await repairedExclusions.commit();
  let resultingState: ReconciliationReport;
  try {
    resultingState = await (options.verifyReconciliation ?? previewReconciliation)(desired, workingState);
  } catch (error) {
    throw new ApplyVerificationError(report, error);
  }
  return {
    receipt: report,
    resultingState,
  };
}
