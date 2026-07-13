import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { CODEX_ADAPTER_VERSION } from "../adapters/codex.js";
import { type InstallationState, type ProjectInstallationManifest } from "../schemas/installation-manifest.js";
import { formatInstallationMarker as markerText } from "../schemas/installation-manifest.js";
import {
  hashBytes,
  markerPath,
  outputPath,
  type DesiredInstallation,
  type DesiredProjectOutput,
} from "./project-plan.js";
import {
  newInstallationId,
  proveOwnedInstallation,
  proveRemainingOwnedOutputs,
  readInstallationState,
  readMarker,
  stageProvenInstallationRemoval,
  writeInstallationState,
} from "./installation-state.js";
import { isGitTrackedPath } from "./git.js";

export type ReconciliationKind =
  | "addition"
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

export interface ReconciliationReport {
  readonly blockers: readonly string[];
  readonly desired: readonly {
    readonly context: string;
    readonly outputs: readonly string[];
    readonly profile: string;
    readonly project: string;
  }[];
  readonly items: readonly ReconciliationItem[];
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function outputRelativePath(output: DesiredProjectOutput): string {
  return output.path.replaceAll("\\", "/");
}

function markerRelativePath(): string {
  return ".agent-profile-kit/installation.json";
}

function markerOutput(installationId: string): DesiredProjectOutput {
  const bytes = markerText({ installationId, schemaVersion: 1 });
  return {
    bytes,
    hash: hashMarker(bytes),
    mode: 0o644,
    path: markerRelativePath(),
  };
}

function hashMarker(bytes: string): string {
  // Keep this helper local so the marker participates in the same output hash
  // set without making the canonical manifest a second source of content.
  return hashBytes(bytes);
}

function manifestFor(
  desired: DesiredInstallation,
  installationId: string,
): ProjectInstallationManifest {
  const marker = markerText({ installationId, schemaVersion: 1 });
  const outputs = [
    ...desired.outputs.map((output) => ({
      hash: output.hash,
      path: outputRelativePath(output),
    })),
    { hash: hashMarker(marker), path: markerRelativePath() },
  ].sort((left, right) => left.path.localeCompare(right.path));
  return {
    adapterVersion: CODEX_ADAPTER_VERSION,
    engineVersion: desired.engineVersion,
    hosts: desired.binding.hosts,
    hostVersions: { codex: desired.hostVersion },
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
    schemaVersion: 1,
    selectedContext: desired.profile.context,
    workspaceInputHash: desired.sourceHash,
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

async function outputMatches(
  project: string,
  output: { readonly hash: string; readonly path: string },
): Promise<boolean> {
  if ((await pathKind(join(project, output.path))) !== "file") return false;
  try {
    const bytes = await readFile(join(project, output.path), "utf8");
    return hashMarker(bytes) === output.hash;
  } catch {
    return false;
  }
}

async function desiredOutputConflicts(
  desired: DesiredInstallation,
  previous: ProjectInstallationManifest | undefined,
  installationId: string,
): Promise<readonly string[]> {
  const blockers: string[] = [];
  const previousOutputs = new Map(previous?.outputs.map((output) => [output.path, output]) ?? []);
  const outputs = [
    ...desired.outputs.map((output) => ({ hash: output.hash, path: output.path })),
    { hash: hashMarker(markerText({ installationId, schemaVersion: 1 })), path: markerRelativePath() },
  ];
  for (const output of outputs) {
    const absolute = outputPath(desired.binding.canonicalProject, output);
    blockers.push(...await parentConflicts(desired.binding.canonicalProject, absolute));
    if (await isGitTrackedPath(desired.binding.canonicalProject, output.path)) {
      blockers.push(`${absolute} is a tracked project path`);
      continue;
    }
    const kind = await pathKind(absolute);
    if (kind === "missing") continue;
    if (kind !== "file") {
      blockers.push(`${absolute} is an occupied ${kind} path`);
      continue;
    }
    const old = previousOutputs.get(output.path);
    if (!old || !(await outputMatches(desired.binding.canonicalProject, old))) {
      blockers.push(`${absolute} is occupied by unowned or drifted output`);
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
    return [`${marker} contains an unknown Installation Marker identity`];
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

export async function previewReconciliation(
  desired: readonly DesiredInstallation[],
  state: InstallationState,
): Promise<ReconciliationReport> {
  const items: ReconciliationItem[] = [];
  const blockers: string[] = [];
  const desiredReport = desired.map((installation) => ({
    context:
      installation.outputs.find((output) => output.path === ".agent-profile-kit/codex/context.md")?.bytes ?? "",
    outputs: [
      ...installation.outputs.map((output) => output.path),
      ".agent-profile-kit/installation.json",
    ],
    profile: installation.profile.id,
    project: installation.binding.project,
  }));
  const byProject = new Map(state.installations.map((installation) => [installation.project, installation]));
  const desiredProjects = new Set(desired.map((installation) => installation.binding.canonicalProject));
  const movedPreviousProjects = new Set<string>();
  for (const installation of desired) {
    const previous = await previousFor(installation, state, byProject);
    const moved = previous && previous.project !== installation.binding.canonicalProject;
    if (moved) movedPreviousProjects.add(previous.project);
    const id = previous?.installationId ?? newInstallationId();
    blockers.push(...await identityBlockers(installation, state, id));
    blockers.push(...await desiredOutputConflicts(installation, previous, id));
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
    if (markerKind === "missing") {
      const remaining = await proveRemainingOwnedOutputs(previous);
      if (!remaining.owned) blockers.push(ownershipBlocker(installation.binding.project, `Installation Marker is missing and ${remaining.reason ?? "remaining output ownership cannot be proven"}`));
    } else if (!proof.owned) {
      blockers.push(ownershipBlocker(installation.binding.project, proof.reason ?? "ownership could not be proven"));
    }
    if (!proof.owned) {
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
    } else {
      items.push({ kind: "current", project: installation.binding.project });
    }
  }
  for (const installation of state.installations) {
    if (desiredProjects.has(installation.project) || movedPreviousProjects.has(installation.project)) continue;
    const proof = await proveOwnedInstallation(installation);
    if (!proof.owned) {
      blockers.push(
        `Cannot remove stale Profile Installation at ${installation.project}: ${proof.reason ?? "ownership could not be proven"}`,
      );
    }
    items.push({
      kind: "removal",
      project: installation.project,
      ...(proof.reason ? { reason: proof.reason } : {}),
    });
  }
  return { blockers: [...new Set(blockers)], desired: desiredReport, items };
}

async function stageProjectOutputs(
  desired: DesiredInstallation,
  manifest: ProjectInstallationManifest,
): Promise<{ readonly commit: () => Promise<void>; readonly rollback: () => Promise<void> }> {
  const project = desired.binding.canonicalProject;
  const stage = await mkdtemp(join(project, ".agent-profile-kit-stage-"));
  const backup = join(stage, ".backup");
  const outputs = [
    ...desired.outputs,
    markerOutput(manifest.installationId),
  ];
  const moved: string[] = [];
  const installed: string[] = [];
  let settled = false;
  const cleanup = async (): Promise<void> => {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  };
  const rollback = async (): Promise<void> => {
    if (settled) return;
    settled = true;
    for (const path of installed.reverse()) await rm(path, { force: true }).catch(() => undefined);
    for (const path of moved.reverse()) {
      const previous = join(backup, path.slice(project.length + 1));
      await rename(previous, path).catch(() => undefined);
    }
    await cleanup();
  };
  try {
    for (const output of outputs) {
      const staged = join(stage, output.path);
      await mkdir(dirname(staged), { recursive: true });
      await writeFile(staged, output.bytes, { mode: output.mode });
    }
    for (const output of outputs) {
      const destination = outputPath(project, output);
      const staged = join(stage, output.path);
      const existing = await pathKind(destination);
      if (existing !== "missing") {
        const previous = join(backup, output.path);
        await mkdir(dirname(previous), { recursive: true });
        await rename(destination, previous);
        moved.push(destination);
      }
      await mkdir(dirname(destination), { recursive: true });
      await rename(staged, destination);
      installed.push(destination);
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
): Promise<ReconciliationReport> {
  const before = await readInstallationState(home);
  const report = await previewReconciliation(desired, before);
  if (report.blockers.length > 0) {
    throw new Error(`Apply blocked before writes:\n${report.blockers.map((blocker) => `- ${blocker}`).join("\n")}`);
  }

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
    let transaction: { readonly commit: () => Promise<void>; readonly rollback: () => Promise<void> } | undefined;
    try {
      const installationId = previous?.installationId ?? newInstallationId();
      const manifest = manifestFor(item, installationId);
      transaction = await stageProjectOutputs(item, manifest);
      if (moved) installationsByProject.delete(previous.project);
      installationsByProject.set(manifest.project, manifest);
      await writeInstallationState(home, {
        installations: [...installationsByProject.values()],
        schemaVersion: 1,
      });
      await transaction.commit();
      completed.push(item.binding.project);
    } catch (error) {
      if (transaction) await transaction.rollback();
      const pending = desired.slice(index).map((entry) => entry.binding.project);
      throw new Error(
        `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; pending projects: ${pending.join(", ") || "(none)"}\n${error instanceof Error ? error.message : String(error)}`,
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
    try {
      transaction = await stageProvenInstallationRemoval(previous);
      installationsByProject.delete(previous.project);
      await writeInstallationState(home, {
        installations: [...installationsByProject.values()],
        schemaVersion: 1,
      });
      await transaction.commit();
      completed.push(`removal ${previous.project}`);
    } catch (error) {
      if (transaction) await transaction.rollback();
      const pending = stale.slice(index).map((entry) => `removal ${entry.project}`);
      throw new Error(
        `Apply failed; completed projects: ${completed.join(", ") || "(none)"}; pending projects: ${pending.join(", ") || "(none)"}\n${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  await writeInstallationState(home, {
    installations: [...installationsByProject.values()],
    schemaVersion: 1,
  });
  return report;
}
