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
  type DesiredInstallation,
  type DesiredProjectDirectoryOutput,
  type DesiredProjectOutput,
} from "./project-plan.js";
import {
  inspectOwnedDirectory,
  newInstallationId,
  proveOwnedInstallation,
  proveRemainingOwnedOutputs,
  readInstallationState,
  readMarker,
  stageProvenInstallationRemoval,
  writeInstallationState,
} from "./installation-state.js";
import { hasTrackedGitDescendants } from "./git.js";
import {
  gitExclusionBlockers,
  gitExclusionWarnings,
  stageGitExclusions,
} from "./git-exclusions.js";

export interface ReconciliationFileSystem {
  readonly chmod: typeof chmod;
  readonly mkdir: typeof mkdir;
  readonly mkdtemp: (prefix: string) => Promise<string>;
  readonly rename: typeof rename;
  readonly rm: typeof rm;
  readonly writeFile: typeof writeFile;
}

const nodeFileSystem: ReconciliationFileSystem = {
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
  | "unchanged"
  | "unexpected member"
  | "update";

export interface OutputReconciliationItem {
  readonly kind: OutputReconciliationKind;
  readonly path: string;
  readonly project: string;
}

export interface ReconciliationBlocker {
  readonly message: string;
  /** Canonical project identity; absent only for application-state blockers. */
  readonly project?: string;
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
    readonly context: string;
    readonly outputs: readonly string[];
    readonly profile: string;
    readonly project: string;
    readonly resolvedArtifacts: readonly DesiredResolvedArtifactPreview[];
  }[];
  readonly items: readonly ReconciliationItem[];
  readonly outputs: readonly OutputReconciliationItem[];
  readonly warnings: readonly string[];
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

function manifestFor(
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

async function desiredOutputConflicts(
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
    blockers.push(...await parentConflicts(desired.binding.canonicalProject, absolute));
    if (await pathIsTrackedDestination(desired.binding.canonicalProject, output.path)) {
      blockers.push(`${absolute} is a tracked project path`);
      continue;
    }
    const kind = await pathKind(absolute);
    if (kind === "missing") continue;
    if (output.type === "file") {
      if (kind !== "file") {
        blockers.push(`${absolute} is an occupied ${kind} path`);
        continue;
      }
      const old = previousOutputs.get(output.path);
      if (!old || old.type !== "file" || !(await ownedOutputMatches(desired.binding.canonicalProject, old))) {
        blockers.push(`${absolute} is occupied by unowned or drifted output`);
      }
      continue;
    }
    if (kind !== "directory") {
      blockers.push(`${absolute} is an occupied ${kind} path`);
      continue;
    }
    const old = previousOutputs.get(output.path);
    if (!old || old.type !== "directory") {
      blockers.push(`${absolute} is an occupied unowned artifact directory`);
      continue;
    }
    if (!(await ownedOutputMatches(desired.binding.canonicalProject, old))) {
      blockers.push(`${absolute} is occupied by an unowned or drifted artifact directory`);
    }
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

function ownershipBlocker(project: string, reason: string): string {
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
  for (const path of [...inspection.driftedMembers, ...inspection.modeDriftedMembers]) {
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
  const blockers: ReconciliationBlocker[] = desired.flatMap((installation) =>
    installation.blockers.map((message) => ({
      message,
      project: installation.binding.canonicalProject,
    }))
  );
  blockers.push(...(await gitExclusionBlockers(state, desired)).map((message) => ({ message })));
  const exclusionWarnings = await gitExclusionWarnings(state, desired);
  const desiredReport = desired.map((installation) => {
    return {
      context: composedContextFromOutputs(installation.outputs),
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
    };
  });
  const byProject = new Map(state.installations.map((installation) => [installation.project, installation]));
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  const movedPreviousProjects = new Set<string>();
  for (const installation of desired) {
    const previous = await previousFor(installation, state, byProject);
    const moved = previous && previous.project !== installation.binding.canonicalProject;
    if (moved) movedPreviousProjects.add(previous.project);
    const id = previous?.installationId ?? newInstallationId();
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
    for (const output of proposedOutputs) {
      const previousOutput = previousOutputs.get(output.path);
      const kind: OutputReconciliationKind = previousOutput === undefined
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
      if (previousOutput?.type === "directory" && previous) {
        pushDirectoryMemberItems(
          outputItems,
          installation.binding.project,
          await inspectOwnedDirectory(installation.binding.canonicalProject, previousOutput),
        );
      }
      previousOutputs.delete(output.path);
    }
    for (const [path, previousOutput] of previousOutputs) {
      outputItems.push({ kind: "removal", path, project: installation.binding.project });
      if (previousOutput.type === "directory" && previous) {
        pushDirectoryMemberItems(
          outputItems,
          installation.binding.project,
          await inspectOwnedDirectory(installation.binding.canonicalProject, previousOutput),
        );
      }
    }
    const project = installation.binding.canonicalProject;
    blockers.push(
      ...(await identityBlockers(installation, state, id)).map((message) => ({ message, project })),
      ...(await desiredOutputConflicts(installation, previous, id)).map((message) => ({ message, project })),
    );
    if (!previous) {
      items.push({ kind: "addition", project: installation.binding.project });
      continue;
    }
    if (moved) {
      items.push({ kind: "update", project: installation.binding.project, reason: "project moved" });
      continue;
    }
    const markerKind = await pathKind(markerPath(installation.binding.canonicalProject));
    const proof = await proveOwnedInstallation(previous);
    let repairableMissingMarker = false;
    if (markerKind === "missing") {
      const remaining = await proveRemainingOwnedOutputs(previous);
      repairableMissingMarker = remaining.owned;
      if (!remaining.owned) {
        blockers.push({
          message: ownershipBlocker(installation.binding.project, `Installation Marker is missing and ${remaining.reason ?? "remaining output ownership cannot be proven"}`),
          project,
        });
      }
    } else if (!proof.owned) {
      blockers.push({
        message: ownershipBlocker(installation.binding.project, proof.reason ?? "ownership could not be proven"),
        project,
      });
    }
    if (!proof.owned && !repairableMissingMarker) {
      items.push({
        kind: proof.reason?.includes("malformed")
          ? "malformed ownership state"
          : proof.reason?.includes("missing")
            ? "missing output"
            : "drifted output",
        project: installation.binding.project,
        ...(proof.reason ? { reason: proof.reason } : {}),
      });
    } else if (previous.workspaceInputHash !== installation.sourceHash) {
      items.push({ kind: "stale source", project: installation.binding.project });
    } else if (
      previous.engineVersion !== installation.engineVersion ||
      previous.adapterVersion !== installation.adapterVersion ||
      !hostVersionsEqual(previous.hostVersions, installation.hostVersions) ||
      previous.hosts.join("\n") !== installation.binding.hosts.join("\n") ||
      previous.profileId !== installation.profile.id ||
      previous.outputs.length !== proposedOutputs.length ||
      proposedOutputs.some((output) => {
        const previousOutput = previous.outputs.find((entry) => entry.path === output.path);
        return previousOutput?.hash !== output.hash ||
          previousOutput.mode !== output.mode ||
          previousOutput.type !== output.type;
      })
    ) {
      items.push({ kind: "update", project: installation.binding.project, reason: "desired output changed" });
    } else if (repairableMissingMarker) {
      items.push({
        kind: "update",
        project: installation.binding.project,
        reason: "Installation Marker is missing and repairable",
      });
    } else {
      items.push({ kind: "current", project: installation.binding.project });
    }
  }
  for (const installation of state.installations) {
    if (desiredProjects.has(installation.project) || movedPreviousProjects.has(installation.project)) continue;
    const proof = await proveOwnedInstallation(installation);
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
      ...(proof.reason ? { reason: proof.reason } : {}),
    });
    for (const output of installation.outputs) {
      outputItems.push({ kind: "removal", path: output.path, project: installation.project });
    }
  }
  return {
    blockers: [...new Map(
      blockers.map((blocker) => [`${blocker.project ?? ""}\0${blocker.message}`, blocker]),
    ).values()].sort((left, right) =>
      (left.project ?? "").localeCompare(right.project ?? "") || left.message.localeCompare(right.message)
    ),
    desired: desiredReport,
    items,
    outputs: outputItems.sort((left, right) =>
      left.project.localeCompare(right.project) || left.path.localeCompare(right.path)
    ),
    warnings: [...new Set([
      ...desired.flatMap((installation) => installation.warnings),
      ...exclusionWarnings,
    ])].sort(),
  };
}

async function stageProjectOutputs(
  desired: DesiredInstallation,
  manifest: ProjectInstallationManifest,
  previous: ProjectInstallationManifest | undefined,
  fileSystem: ReconciliationFileSystem,
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
  options: { readonly fileSystem?: Partial<ReconciliationFileSystem> } = {},
): Promise<ReconciliationReport> {
  const fileSystem: ReconciliationFileSystem = { ...nodeFileSystem, ...options.fileSystem };
  let before;
  try {
    before = await readInstallationState(home);
  } catch (error) {
    throw new Error(
      `Apply blocked before writes:\n- ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const report = await previewReconciliation(desired, before);
  if (report.blockers.length > 0) {
    throw new Error(`Apply blocked before writes:\n${report.blockers.map((blocker) => `- ${blocker.message}`).join("\n")}`);
  }
  const repairedExclusions = await stageGitExclusions(before, before);
  await repairedExclusions.commit();

  const currentProjects = new Set(
    report.items
      .filter((item) => item.kind === "current")
      .map((item) => item.project),
  );
  const byProject = new Map(before.installations.map((installation) => [installation.project, installation]));
  const installationsByProject = new Map(
    before.installations.map((installation) => [installation.project, installation]),
  );
  const movedPreviousProjects = new Set<string>();
  const completed: string[] = [];
  for (const [index, item] of desired.entries()) {
    const previous = await previousFor(item, before, byProject);
    const moved = previous && previous.project !== item.binding.canonicalProject;
    if (moved) movedPreviousProjects.add(previous.project);
    if (currentProjects.has(item.binding.project)) continue;
    let transaction: { readonly commit: () => Promise<void>; readonly rollback: () => Promise<void> } | undefined;
    let exclusions: Awaited<ReturnType<typeof stageGitExclusions>> | undefined;
    try {
      const installationId = previous?.installationId ?? newInstallationId();
      const manifest = manifestFor(item, installationId);
      transaction = await stageProjectOutputs(item, manifest, previous, fileSystem);
      if (moved) installationsByProject.delete(previous.project);
      installationsByProject.set(manifest.project, manifest);
      const nextState: InstallationState = {
        installations: [...installationsByProject.values()],
        schemaVersion: 2,
      };
      exclusions = await stageGitExclusions(
        { installations: [...byProject.values()], schemaVersion: 2 },
        nextState,
      );
      await writeInstallationState(home, nextState);
      await transaction.commit();
      await exclusions.commit();
      byProject.clear();
      for (const installation of nextState.installations) byProject.set(installation.project, installation);
      completed.push(item.binding.project);
    } catch (error) {
      if (exclusions) await exclusions.rollback();
      if (transaction) await transaction.rollback();
      const pending = desired.slice(index + 1).map((entry) => entry.binding.project);
      throw new Error(
        `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; failed project: ${item.binding.project}; pending projects: ${pending.join(", ") || "(none)"}\n${error instanceof Error ? error.message : String(error)}`,
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
    try {
      transaction = await stageProvenInstallationRemoval(previous);
      installationsByProject.delete(previous.project);
      const nextState: InstallationState = {
        installations: [...installationsByProject.values()],
        schemaVersion: 2,
      };
      exclusions = await stageGitExclusions(
        { installations: [...byProject.values()], schemaVersion: 2 },
        nextState,
      );
      await writeInstallationState(home, nextState);
      await transaction.commit();
      await exclusions.commit();
      byProject.delete(previous.project);
      completed.push(`removal ${previous.project}`);
    } catch (error) {
      if (exclusions) await exclusions.rollback();
      if (transaction) await transaction.rollback();
      const pending = stale.slice(index + 1).map((entry) => `removal ${entry.project}`);
      throw new Error(
        `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; failed project: removal ${previous.project}; pending projects: ${pending.join(", ") || "(none)"}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return report;
}
