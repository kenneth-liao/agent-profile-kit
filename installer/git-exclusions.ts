import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  canonicalRepositoryExclusionRecord,
  compareCanonicalStrings,
} from "../schemas/installation-manifest.js";
import type {
  InstallationState,
  OwnedOutput,
  RepositoryExclusionContribution,
  RepositoryExclusionRecord,
} from "../schemas/installation-manifest.js";
import { assertRealDirectoryPath, findGitProject, gitExcludeEntry, type GitProject } from "./git.js";
import type { LifecycleGitInspection } from "./lifecycle-git-inspection.js";
import type { DesiredInstallation } from "./project-plan.js";
import { readMarker } from "./installation-state.js";
import {
  normalizeBlocker,
  repositoryExclusionInvalidBlocker,
  repositoryExclusionRecordBlocker,
  repositoryExclusionSectionMissingBlocker,
  repositoryExclusionTargetUnprovenBlocker,
  type BlockerInput,
  type ReconciliationBlocker,
} from "./blockers.js";

const BEGIN = "# BEGIN Agent Profile Kit generated paths";
const BEGIN_WITH_SEPARATOR = `${BEGIN} (separator owned)`;
const END = "# END Agent Profile Kit generated paths";
const SEPARATOR = "# Agent Profile Kit generated paths separator";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

interface Line {
  readonly content: Buffer;
  readonly end: number;
  readonly newline: Buffer;
  readonly start: number;
}

function lines(source: Buffer): readonly Line[] {
  const result: Line[] = [];
  let start = 0;
  while (start < source.length) {
    const lf = source.indexOf(0x0a, start);
    if (lf === -1) {
      result.push({ content: source.subarray(start), end: source.length, newline: Buffer.alloc(0), start });
      break;
    }
    const crlf = lf > start && source[lf - 1] === 0x0d;
    result.push({
      content: source.subarray(start, crlf ? lf - 1 : lf),
      end: lf + 1,
      newline: source.subarray(crlf ? lf - 1 : lf, lf + 1),
      start,
    });
    start = lf + 1;
  }
  return result;
}

function equalsAscii(bytes: Buffer, value: string): boolean {
  return bytes.equals(Buffer.from(value, "ascii"));
}

function startsWithAscii(bytes: Buffer, value: string): boolean {
  const prefix = Buffer.from(value, "ascii");
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

interface OwnedSection {
  readonly begin: Line;
  readonly end: Line;
  readonly ownsSeparator: boolean;
  readonly prefixEnd: number;
  readonly suffixStart: number;
}

function parseOwnedSection(source: Buffer, path: string): OwnedSection | undefined {
  const allLines = lines(source);
  const markerLike = allLines.filter((line) =>
    startsWithAscii(line.content, BEGIN) ||
    startsWithAscii(line.content, END) ||
    equalsAscii(line.content, SEPARATOR)
  );
  const begins = allLines.filter((line) =>
    equalsAscii(line.content, BEGIN) || equalsAscii(line.content, BEGIN_WITH_SEPARATOR)
  );
  const ends = allLines.filter((line) => equalsAscii(line.content, END));
  if (begins.length === 0 && ends.length === 0 && markerLike.length === 0) return undefined;
  if (
    begins.length !== 1 || ends.length !== 1 ||
    (markerLike.length !== 2 && markerLike.length !== 3)
  ) {
    throw new Error(`${path} has a malformed or duplicate Agent Profile Kit exclusion section`);
  }
  const begin = begins[0]!;
  const end = ends[0]!;
  if (end.start < begin.end) {
    throw new Error(`${path} has a malformed Agent Profile Kit exclusion section`);
  }
  const ownsSeparator = equalsAscii(begin.content, BEGIN_WITH_SEPARATOR);
  if (markerLike.length !== (ownsSeparator ? 3 : 2)) {
    throw new Error(`${path} has an inconsistent Agent Profile Kit exclusion separator header`);
  }
  let prefixEnd = begin.start;
  if (ownsSeparator) {
    const separator = allLines.find((line) => line.end === begin.start);
    const previous = separator
      ? allLines.find((line) => line.end === separator.start)
      : undefined;
    if (
      !separator || !equalsAscii(separator.content, SEPARATOR) ||
      !previous || previous.newline.length === 0
    ) {
      throw new Error(`${path} has a malformed Agent Profile Kit exclusion separator`);
    }
    prefixEnd = separator.start - previous.newline.length;
    if (prefixEnd === 0 || source[prefixEnd - 1] === 0x0a) {
      throw new Error(`${path} has an impossible Agent Profile Kit owned separator`);
    }
  } else {
    const previous = allLines.find((line) => line.end === begin.start);
    if (previous && equalsAscii(previous.content, SEPARATOR)) {
      throw new Error(`${path} has an inconsistent Agent Profile Kit exclusion separator header`);
    }
    if (begin.start > 0 && source[begin.start - 1] !== 0x0a) {
      throw new Error(`${path} has a malformed Agent Profile Kit exclusion separator`);
    }
  }
  return { begin, end, ownsSeparator, prefixEnd, suffixStart: end.end };
}

function sectionEntries(source: Buffer, section: OwnedSection): readonly string[] {
  return lines(source)
    .filter((line) => line.start >= section.begin.end && line.end <= section.end.start)
    .map((line) => line.content.toString("utf8"));
}

function assertExpectedEntries(
  source: Buffer,
  path: string,
  section: OwnedSection | undefined,
  expected: readonly string[],
): void {
  if (!section) return;
  const actual = sectionEntries(source, section);
  const canonical = [...new Set(expected)].sort(compareCanonicalStrings);
  if (actual.length !== canonical.length || actual.some((entry, index) => entry !== canonical[index])) {
    throw new Error(`${path} Agent Profile Kit exclusion section is modified; restore its exact generated entries before retrying`);
  }
}

function newlineFor(source: Buffer, section?: OwnedSection): Buffer {
  if (section?.begin.newline.length) return section.begin.newline;
  const existing = [...lines(source)].reverse().find((line) => line.newline.length > 0)?.newline;
  return existing ?? Buffer.from("\n");
}

/** Pure byte-oriented reconciliation used by filesystem code and table tests. */
export function reconcileGitExcludeBytes(
  source: Buffer,
  path: string,
  currentEntries: readonly string[],
  nextEntries: readonly string[],
): Buffer {
  const section = parseOwnedSection(source, path);
  assertExpectedEntries(source, path, section, currentEntries);
  const prefix = section ? source.subarray(0, section.prefixEnd) : source;
  const suffix = section ? source.subarray(section.suffixStart) : Buffer.alloc(0);
  const entries = [...new Set(nextEntries)].sort(compareCanonicalStrings);
  if (entries.length === 0) return Buffer.concat([prefix, suffix]);
  const newline = newlineFor(source, section);
  const ownsSeparator = prefix.length > 0 && prefix[prefix.length - 1] !== 0x0a;
  const header = ownsSeparator ? BEGIN_WITH_SEPARATOR : BEGIN;
  const block = Buffer.from(
    `${header}${newline.toString("ascii")}${entries.join(newline.toString("ascii"))}${newline.toString("ascii")}${END}${newline.toString("ascii")}`,
    "utf8",
  );
  const separator = ownsSeparator
    ? Buffer.from(`${newline.toString("ascii")}${SEPARATOR}${newline.toString("ascii")}`, "ascii")
    : Buffer.alloc(0);
  return Buffer.concat([prefix, separator, block, suffix]);
}

export interface GitExcludeSnapshot {
  readonly bytes: Buffer;
  readonly exists: boolean;
  readonly mode: number;
  /** True only when the Git common directory itself is absent. */
  readonly targetMissing: boolean;
}

async function assertSafeExcludePath(git: GitProject): Promise<{ readonly infoExists: boolean }> {
  await assertRealDirectoryPath(git.commonDirectory, `Git common directory ${git.commonDirectory}`);
  const common = await lstat(git.commonDirectory);
  if (common.isSymbolicLink() || !common.isDirectory()) {
    throw new Error(`Git common directory ${git.commonDirectory} must be a real directory`);
  }
  const info = dirname(git.excludeFile);
  let infoExists = true;
  try {
    const stats = await lstat(info);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Git exclusion parent ${info} must be a real directory`);
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) infoExists = false;
    else throw error;
  }
  try {
    const stats = await lstat(git.excludeFile);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Git exclusion file ${git.excludeFile} must be a regular file`);
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  return { infoExists };
}

/** Read one repository-local exclusion target. Prefer the invocation-scoped inspection reader. */
export async function readGitExcludeSnapshot(
  git: GitProject,
  allowMissingTarget = false,
): Promise<GitExcludeSnapshot> {
  try {
    await assertSafeExcludePath(git);
  } catch (error) {
    if (allowMissingTarget && hasErrorCode(error, "ENOENT")) {
      return { bytes: Buffer.alloc(0), exists: false, mode: 0o644, targetMissing: true };
    }
    throw error;
  }
  try {
    const stats = await lstat(git.excludeFile);
    return {
      bytes: await readFile(git.excludeFile),
      exists: true,
      mode: stats.mode & 0o7777,
      targetMissing: false,
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return {
        bytes: Buffer.alloc(0),
        exists: false,
        mode: 0o644,
        targetMissing: false,
      };
    }
    throw error;
  }
}

async function readSnapshot(
  git: GitProject,
  allowMissingTarget = false,
  gitInspection?: LifecycleGitInspection,
): Promise<GitExcludeSnapshot> {
  if (gitInspection) return gitInspection.readExcludeSnapshot(git, allowMissingTarget);
  return readGitExcludeSnapshot(git, allowMissingTarget);
}

interface Target {
  readonly allowMissingTarget?: boolean;
  readonly current: readonly string[];
  readonly git: GitProject;
  readonly next: readonly string[];
}

export interface RepositoryExclusionChange {
  readonly current: readonly string[];
  readonly next: readonly string[];
  readonly target: string;
}

export interface RepositoryExclusionRepair {
  readonly entries: readonly string[];
  readonly target: string;
}

export interface RepositoryExclusionDiagnostics {
  readonly repairs: readonly RepositoryExclusionRepair[];
  readonly warnings: readonly string[];
}

/** Canonical suffix for a repair warning surfaced by status. */
export const REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX =
  " is missing its Agent Profile Kit exclusion section; apply will restore recorded exact entries";

function removeContribution(
  records: readonly RepositoryExclusionRecord[],
  installationId: string,
): readonly RepositoryExclusionRecord[] {
  return records.flatMap((record) => {
    const contributions = record.contributions.filter(
      (contribution) => contribution.installationId !== installationId,
    );
    return contributions.length === 0 ? [] : [canonicalRepositoryExclusionRecord(record.target, contributions)];
  });
}

/** Replace one Installation ID's canonical exclusion contribution in machine-local state. */
export function replaceRepositoryExclusionContribution(
  records: readonly RepositoryExclusionRecord[],
  installationId: string,
  git: Pick<GitProject, "excludeFile" | "relativeProject"> | undefined,
  outputs: readonly OwnedOutput[],
): readonly RepositoryExclusionRecord[] {
  const withoutInstallation = removeContribution(records, installationId);
  if (!git) return withoutInstallation;
  const contribution: RepositoryExclusionContribution = {
    entries: [...new Set(outputs.map((output) => gitExcludeEntry(git, output.path)))].sort(compareCanonicalStrings),
    installationId,
  };
  const existing = withoutInstallation.find((record) => record.target === git.excludeFile);
  if (!existing) {
    return [...withoutInstallation, canonicalRepositoryExclusionRecord(git.excludeFile, [contribution])]
      .sort((left, right) => compareCanonicalStrings(left.target, right.target));
  }
  return withoutInstallation
    .map((record) => record.target === git.excludeFile
      ? canonicalRepositoryExclusionRecord(record.target, [...record.contributions, contribution])
      : record)
    .sort((left, right) => compareCanonicalStrings(left.target, right.target));
}

/** Move one recorded contribution to a newly proven target while preserving its prior entries for preflight. */
export function moveRepositoryExclusionContribution(
  records: readonly RepositoryExclusionRecord[],
  installationId: string,
  target: string,
): readonly RepositoryExclusionRecord[] {
  const contribution = records
    .flatMap((record) => record.contributions)
    .find((entry) => entry.installationId === installationId);
  if (!contribution) return records;
  const withoutInstallation = removeContribution(records, installationId);
  const existing = withoutInstallation.find((record) => record.target === target);
  if (!existing) {
    return [...withoutInstallation, canonicalRepositoryExclusionRecord(target, [contribution])]
      .sort((left, right) => compareCanonicalStrings(left.target, right.target));
  }
  return withoutInstallation
    .map((record) => record.target === target
      ? canonicalRepositoryExclusionRecord(target, [...record.contributions, contribution])
      : record)
    .sort((left, right) => compareCanonicalStrings(left.target, right.target));
}

/** Prepare moved-file preflight without changing an already-recorded destination union. */
export function prepareRepositoryExclusionMovePreflight(
  records: readonly RepositoryExclusionRecord[],
  installationId: string,
  target: string,
): readonly RepositoryExclusionRecord[] {
  const contribution = records
    .flatMap((record) => record.contributions)
    .find((entry) => entry.installationId === installationId);
  if (!contribution) return records;
  const existing = records.find((record) => record.target === target);
  if (!existing) {
    return [...records, canonicalRepositoryExclusionRecord(target, [contribution])]
      .sort((left, right) => compareCanonicalStrings(left.target, right.target));
  }
  // A destination with an existing record is physically preflighted against
  // its recorded union; the moved contribution is added only to `next`.
  return records;
}

function gitForExclusionTarget(target: string): GitProject {
  const commonDirectory = dirname(dirname(target));
  return {
    commonDirectory,
    excludeFile: target,
    relativeProject: "",
    root: dirname(commonDirectory),
  };
}

function recordsByTarget(
  records: readonly RepositoryExclusionRecord[],
): Map<string, RepositoryExclusionRecord> {
  return new Map(records.map((record) => [record.target, record]));
}

function targetsFor(
  current: InstallationState,
  next: InstallationState,
  includedTargets?: ReadonlySet<string>,
): readonly Target[] {
  const currentByTarget = recordsByTarget(current.repositoryExclusions);
  const nextByTarget = recordsByTarget(next.repositoryExclusions);
  return [...new Set([...currentByTarget.keys(), ...nextByTarget.keys()])]
    .filter((target) => includedTargets === undefined || includedTargets.has(target))
    .sort(compareCanonicalStrings)
    .map((target) => ({
      allowMissingTarget: currentByTarget.has(target) && !nextByTarget.has(target),
      current: currentByTarget.get(target)?.entries ?? [],
      git: gitForExclusionTarget(target),
      next: nextByTarget.get(target)?.entries ?? [],
    }));
}

/** Return the canonical union transition without inspecting or reconstructing Git topology. */
export function repositoryExclusionChanges(
  current: InstallationState,
  next: InstallationState,
  includedTargets?: ReadonlySet<string>,
): readonly RepositoryExclusionChange[] {
  return targetsFor(current, next, includedTargets).map((target) => ({
    current: target.current,
    next: target.next,
    target: target.git.excludeFile,
  }));
}

export async function relocateRepositoryExclusionsForDesired(
  state: InstallationState,
  desired: readonly DesiredInstallation[],
): Promise<InstallationState> {
  let inspectionState = state;
  for (const installation of desired) {
    const git = installation.gitProject;
    if (!git) continue;
    const marker = await readMarker(installation.binding.canonicalProject).catch(() => undefined);
    const previous = marker
      ? state.installations.find((candidate) => candidate.installationId === marker.installationId)
      : undefined;
    if (previous && previous.project !== installation.binding.canonicalProject) {
      inspectionState = {
        ...inspectionState,
        repositoryExclusions: moveRepositoryExclusionContribution(
          inspectionState.repositoryExclusions,
          previous.installationId,
          git.excludeFile,
        ),
      };
    }
  }
  return inspectionState;
}

export function repositoryExclusionTargetsForInstallations(
  state: InstallationState,
  desired: readonly DesiredInstallation[],
  includedInstallationIds: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (includedInstallationIds === undefined) return undefined;
  return new Set([
    ...desired.flatMap((installation) =>
      installation.gitProject === undefined ? [] : [installation.gitProject.excludeFile]
    ),
    ...state.repositoryExclusions
      .filter((record) => record.contributions.some((contribution) =>
        includedInstallationIds.has(contribution.installationId)
      ))
      .map((record) => record.target),
  ]);
}

async function inspectionTargets(
  state: InstallationState,
  desired: readonly DesiredInstallation[],
  retiringInstallationIds: ReadonlySet<string> = new Set(),
  includedInstallationIds?: ReadonlySet<string>,
): Promise<readonly Target[]> {
  const inspectionState = await relocateRepositoryExclusionsForDesired(state, desired);
  const currentByTarget = recordsByTarget(state.repositoryExclusions);
  const relocatedByTarget = recordsByTarget(inspectionState.repositoryExclusions);
  const includedTargets = repositoryExclusionTargetsForInstallations(
    state,
    desired,
    includedInstallationIds,
  );
  const targets = [...new Set([
    ...currentByTarget.keys(),
    ...relocatedByTarget.keys(),
  ])]
    .filter((target) => includedTargets === undefined || includedTargets.has(target))
    .sort(compareCanonicalStrings)
    .map((target) => {
      const record = currentByTarget.get(target);
      const allContributionsRetiring = record !== undefined &&
        record.contributions.length > 0 &&
        retiringInstallationIds.size > 0 &&
        record.contributions.every((contribution) => retiringInstallationIds.has(contribution.installationId));
      return {
        allowMissingTarget:
          (currentByTarget.has(target) && !relocatedByTarget.has(target)) || allContributionsRetiring,
        current: currentByTarget.get(target)?.entries ?? relocatedByTarget.get(target)?.entries ?? [],
        git: gitForExclusionTarget(target),
        next: relocatedByTarget.get(target)?.entries ?? [],
      };
    });
  const known = new Set(targets.map((target) => target.git.excludeFile));
  for (const installation of desired) {
    const git = installation.gitProject;
    if (!git || known.has(git.excludeFile)) continue;
    known.add(git.excludeFile);
    targets.push({ allowMissingTarget: false, current: [], git, next: [] });
  }
  return targets;
}

function sortedUniqueEntries(entries: readonly string[]): readonly string[] {
  return [...new Set(entries)].sort(compareCanonicalStrings);
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function contributionFor(
  records: readonly RepositoryExclusionRecord[],
  installationId: string,
): { readonly record: RepositoryExclusionRecord; readonly entries: readonly string[] } | undefined {
  for (const record of records) {
    const contribution = record.contributions.find((entry) => entry.installationId === installationId);
    if (contribution) return { entries: contribution.entries, record };
  }
  return undefined;
}

function targetRoot(target: string): string {
  return dirname(dirname(dirname(target)));
}

function targetContainsProject(target: string, project: string): boolean {
  const root = targetRoot(target);
  return project === root || project.startsWith(`${root}${sep}`);
}

function expectedContributionEntries(
  installation: InstallationState["installations"][number],
  relativeProject: string,
): readonly string[] {
  return sortedUniqueEntries(
    installation.outputs.map((output) => gitExcludeEntry({ relativeProject }, output.path)),
  );
}

function relativeProjectForTarget(target: string, project: string): string {
  const relativeProject = relative(targetRoot(target), project).split(sep).join("/");
  return relativeProject === ".." || relativeProject.startsWith("../") ? "" : relativeProject;
}

function hasExpectedContributionEntries(
  installation: InstallationState["installations"][number],
  contribution: { readonly record: RepositoryExclusionRecord; readonly entries: readonly string[] },
): boolean {
  const expected = expectedContributionEntries(
    installation,
    relativeProjectForTarget(contribution.record.target, installation.project),
  );
  return sameEntries(
    sortedUniqueEntries(contribution.entries),
    expected,
  );
}

function hasKnownExclusionTargetForProject(
  state: InstallationState,
  desired: readonly DesiredInstallation[],
  project: string,
): boolean {
  const recordedTargets = state.repositoryExclusions.map((record) => record.target);
  const desiredTargets = desired.flatMap((installation) =>
    installation.gitProject ? [installation.gitProject.excludeFile] : [],
  );
  return [...new Set([...recordedTargets, ...desiredTargets])]
    .some((target) => targetContainsProject(target, project));
}

async function existingInstallationForDesired(
  state: InstallationState,
  desired: DesiredInstallation,
): Promise<InstallationState["installations"][number] | undefined> {
  const direct = state.installations.find(
    (installation) => installation.project === desired.binding.canonicalProject,
  );
  if (direct) return direct;
  const marker = await readMarker(desired.binding.canonicalProject).catch(() => undefined);
  if (!marker) return undefined;
  return state.installations.find(
    (installation) => installation.installationId === marker.installationId,
  );
}

/** Validate semantic ownership links before touching any repository-local exclusion bytes. */
async function repositoryExclusionOwnershipBlockers(
  state: InstallationState,
  desired: readonly DesiredInstallation[],
): Promise<readonly BlockerInput[]> {
  const blockers: BlockerInput[] = [];
  for (const installation of desired) {
    const git = installation.gitProject;
    if (!git) continue;
    const previous = await existingInstallationForDesired(state, installation);
    if (!previous) continue;
    const contribution = contributionFor(state.repositoryExclusions, previous.installationId);
    if (!contribution) {
      blockers.push(repositoryExclusionRecordBlocker({
        affectedItems: [{ kind: "installation-id", value: previous.installationId }],
        message:
          `${installation.binding.canonicalProject} is missing its Git exclusion ` +
          `record for Installation ID ${previous.installationId}`,
      }));
      continue;
    }
    const moved = previous.project !== installation.binding.canonicalProject;
    if (moved) continue;
    if (contribution.record.target !== git.excludeFile) {
      blockers.push(repositoryExclusionRecordBlocker({
        affectedItems: [
          { kind: "path", value: contribution.record.target },
          { kind: "path", value: git.excludeFile },
        ],
        message:
          `${installation.binding.canonicalProject} Git exclusion record for ` +
          `Installation ID ${previous.installationId} targets ${contribution.record.target}, ` +
          `expected ${git.excludeFile}`,
      }));
      continue;
    }
    const expected = expectedContributionEntries(previous, git.relativeProject);
    if (!sameEntries(sortedUniqueEntries(contribution.entries), expected)) {
      blockers.push(repositoryExclusionRecordBlocker({
        affectedItems: [{ kind: "path", value: git.excludeFile }],
        message:
          `${git.excludeFile} Git exclusion record for Installation ID ` +
          `${previous.installationId} does not match its recorded installation record contribution`,
      }));
    }
  }
  return blockers;
}

/** Validate the canonical exclusion contribution before retiring an absent installation. */
async function retiringInstallationOwnershipBlockers(
  state: InstallationState,
  desired: readonly DesiredInstallation[],
  retiringInstallationIds: ReadonlySet<string>,
): Promise<readonly BlockerInput[]> {
  if (retiringInstallationIds.size === 0) return [];
  const blockers: BlockerInput[] = [];
  for (const installation of state.installations) {
    if (!retiringInstallationIds.has(installation.installationId)) continue;
    const contributionLinks = state.repositoryExclusions.flatMap((record) =>
      record.contributions
        .filter((contribution) => contribution.installationId === installation.installationId)
        .map((contribution) => ({ contribution, record })),
    );
    if (contributionLinks.length === 0) {
      // Repository Exclusion Records are the only durable ownership proof after
      // a root disappears. Do not rediscover Git topology for a missing record;
      // the installation-time Git classification distinguishes a missing Git
      // record from a non-Git installation without becoming an ownership source;
      // an absent classification remains unknown and therefore fails closed.
      if (
        installation.gitProject !== false ||
        hasKnownExclusionTargetForProject(state, desired, installation.project)
      ) {
        blockers.push(repositoryExclusionRecordBlocker({
          affectedItems: [{ kind: "installation-id", value: installation.installationId }],
          message:
            `${installation.project} is missing its Git exclusion record for ` +
            `Installation ID ${installation.installationId}`,
        }));
      }
      continue;
    }
    // Keep this defensive check for callers that construct state in memory
    // without passing through the parser's cross-record uniqueness boundary.
    if (contributionLinks.length !== 1) {
      blockers.push(repositoryExclusionRecordBlocker({
        affectedItems: [{ kind: "installation-id", value: installation.installationId }],
        message:
          `${installation.project} has duplicate Git exclusion records for ` +
          `Installation ID ${installation.installationId}`,
      }));
      continue;
    }
    const { contribution, record } = contributionLinks[0]!;
    if (!hasExpectedContributionEntries(installation, { entries: contribution.entries, record })) {
      blockers.push(repositoryExclusionRecordBlocker({
        affectedItems: [{ kind: "path", value: record.target }],
        message:
          `${record.target} Git exclusion record for Installation ID ` +
          `${installation.installationId} does not match its recorded installation record contribution`,
      }));
    }
  }
  return blockers;
}

/** Validate every recorded Installation against its live Git target for uninstall. */
async function recordedInstallationOwnershipBlockers(
  state: InstallationState,
  retiringInstallationIds: ReadonlySet<string> = new Set(),
  gitInspection?: LifecycleGitInspection,
): Promise<readonly BlockerInput[]> {
  const resolveGit = gitInspection?.findGitProject ?? findGitProject;
  const blockers: BlockerInput[] = [];
  for (const installation of state.installations) {
    try {
      await lstat(installation.project);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        if (retiringInstallationIds.has(installation.installationId)) continue;
        blockers.push(repositoryExclusionTargetUnprovenBlocker({
          message: `${installation.project} Git target cannot be proven: project root is missing`,
          project: installation.project,
        }));
        continue;
      }
      throw error;
    }
    const contribution = contributionFor(state.repositoryExclusions, installation.installationId);
    let git: GitProject | undefined;
    try {
      git = await resolveGit(installation.project);
    } catch (error) {
      blockers.push(repositoryExclusionTargetUnprovenBlocker({
        message:
          `${installation.project} Git target cannot be proven: ` +
          `${error instanceof Error ? error.message : String(error)}`,
        project: installation.project,
      }));
      continue;
    }
    if (!git) {
      if (contribution) {
        blockers.push(repositoryExclusionTargetUnprovenBlocker({
          message:
            `${installation.project} has a Git exclusion record but is no longer a Git project`,
          project: installation.project,
        }));
      }
      continue;
    }
    if (!contribution) {
      blockers.push(repositoryExclusionRecordBlocker({
        affectedItems: [{ kind: "installation-id", value: installation.installationId }],
        message:
          `${installation.project} is missing its Git exclusion record for ` +
          `Installation ID ${installation.installationId}`,
      }));
      continue;
    }
    if (contribution.record.target !== git.excludeFile) {
      blockers.push(repositoryExclusionRecordBlocker({
        affectedItems: [
          { kind: "path", value: contribution.record.target },
          { kind: "path", value: git.excludeFile },
        ],
        message:
          `${installation.project} Git exclusion record for Installation ID ` +
          `${installation.installationId} targets ${contribution.record.target}, ` +
          `expected ${git.excludeFile}`,
      }));
      continue;
    }
    const expected = expectedContributionEntries(installation, git.relativeProject);
    if (!sameEntries(sortedUniqueEntries(contribution.entries), expected)) {
      blockers.push(repositoryExclusionRecordBlocker({
        affectedItems: [{ kind: "path", value: git.excludeFile }],
        message:
          `${git.excludeFile} Git exclusion record for Installation ID ` +
          `${installation.installationId} does not match its recorded installation record contribution`,
      }));
    }
  }
  return blockers;
}

function projectsForExclusionTarget(
  state: InstallationState,
  desired: readonly DesiredInstallation[],
  target: string,
): readonly string[] {
  const projectByInstallationId = new Map(
    state.installations.map((installation) => [
      installation.installationId,
      installation.project,
    ] as const),
  );
  const projects = new Set(
    state.repositoryExclusions
      .find((record) => record.target === target)
      ?.contributions.flatMap((contribution) => {
        const project = projectByInstallationId.get(contribution.installationId);
        return project === undefined ? [] : [project];
      }) ?? [],
  );
  for (const installation of desired) {
    if (installation.gitProject?.excludeFile === target) {
      projects.add(installation.binding.canonicalProject);
    }
  }
  return [...projects].sort(compareCanonicalStrings);
}

export async function gitExclusionBlockers(
  state: InstallationState,
  desired: readonly DesiredInstallation[] = [],
  options: {
    readonly gitInspection?: LifecycleGitInspection;
    readonly retiringInstallationIds?: ReadonlySet<string>;
    readonly validateRecordedInstallations?: boolean;
    readonly includedInstallationIds?: ReadonlySet<string>;
  } = {},
): Promise<readonly ReconciliationBlocker[]> {
  const validateRecordedInstallations = options.validateRecordedInstallations ?? desired.length === 0;
  const blockers: BlockerInput[] = [
    ...await repositoryExclusionOwnershipBlockers(state, desired),
    ...await retiringInstallationOwnershipBlockers(
      state,
      desired,
      options.retiringInstallationIds ?? new Set(),
    ),
    ...(validateRecordedInstallations
      ? await recordedInstallationOwnershipBlockers(
        state,
        options.retiringInstallationIds,
        options.gitInspection,
      )
      : []),
  ];
  for (const target of await inspectionTargets(
    state,
    desired,
    options.retiringInstallationIds,
    options.includedInstallationIds,
  )) {
    try {
      const snapshot = await readSnapshot(
        target.git,
        target.allowMissingTarget,
        options.gitInspection,
      );
      const targetRecord = state.repositoryExclusions.find(
        (record) => record.target === target.git.excludeFile,
      );
      if (
        options.retiringInstallationIds !== undefined &&
        targetRecord?.contributions.some((contribution) => options.retiringInstallationIds?.has(contribution.installationId)) &&
        target.current.length > 0 &&
        ((!snapshot.exists && !snapshot.targetMissing) ||
          (snapshot.exists && !parseOwnedSection(snapshot.bytes, target.git.excludeFile)))
      ) {
        const projects = projectsForExclusionTarget(state, desired, target.git.excludeFile);
        for (const project of projects) {
          blockers.push(repositoryExclusionSectionMissingBlocker({
            message:
              `${target.git.excludeFile} is missing its Agent Profile Kit exclusion section; ` +
              "intentional-deletion retirement requires the recorded section to be present",
            project,
            target: target.git.excludeFile,
          }));
        }
        if (projects.length === 0) {
          blockers.push(repositoryExclusionRecordBlocker({
            affectedItems: [{ kind: "path", value: target.git.excludeFile }],
            message: `${target.git.excludeFile} has no Project identity for its recorded exclusion ownership`,
          }));
        }
      }
      reconcileGitExcludeBytes(snapshot.bytes, target.git.excludeFile, target.current, target.current);
    } catch (error) {
      const projects = projectsForExclusionTarget(state, desired, target.git.excludeFile);
      for (const project of projects) {
        blockers.push(repositoryExclusionInvalidBlocker({
          message: error instanceof Error ? error.message : String(error),
          project,
          target: target.git.excludeFile,
        }));
      }
      if (projects.length === 0) {
        blockers.push(repositoryExclusionRecordBlocker({
          affectedItems: [{ kind: "path", value: target.git.excludeFile }],
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }
  return blockers
    .map((input) => normalizeBlocker(input))
    .sort((left, right) => compareCanonicalStrings(left.message, right.message));
}

export async function gitExclusionDiagnostics(
  state: InstallationState,
  desired: readonly DesiredInstallation[] = [],
  options: {
    readonly gitInspection?: LifecycleGitInspection;
    readonly includedInstallationIds?: ReadonlySet<string>;
  } = {},
): Promise<RepositoryExclusionDiagnostics> {
  const warnings: string[] = [];
  const repairs: RepositoryExclusionRepair[] = [];
  for (const target of await inspectionTargets(
    state,
    desired,
    new Set(),
    options.includedInstallationIds,
  )) {
    try {
      const snapshot = await readSnapshot(
        target.git,
        target.allowMissingTarget,
        options.gitInspection,
      );
      const expected = new Set(target.current);
      if (expected.size > 0 && !parseOwnedSection(snapshot.bytes, target.git.excludeFile)) {
        warnings.push(`${target.git.excludeFile}${REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX}`);
        repairs.push({ entries: [...target.current], target: target.git.excludeFile });
      }
    } catch {
      // The blocker path owns malformed or unsafe exclusion diagnostics.
    }
  }
  return {
    repairs: repairs.sort((left, right) => compareCanonicalStrings(left.target, right.target)),
    warnings: warnings.sort(compareCanonicalStrings),
  };
}

/** Backward-compatible warning-only view for callers that do not need repair metadata. */
export async function gitExclusionWarnings(
  state: InstallationState,
  desired: readonly DesiredInstallation[] = [],
  options: {
    readonly gitInspection?: LifecycleGitInspection;
  } = {},
): Promise<readonly string[]> {
  return (await gitExclusionDiagnostics(state, desired, options)).warnings;
}

async function replace(git: GitProject, source: Buffer, mode: number): Promise<boolean> {
  const { infoExists } = await assertSafeExcludePath(git);
  const info = dirname(git.excludeFile);
  if (!infoExists) await mkdir(info);
  const temporary = join(info, `.exclude-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await assertSafeExcludePath(git);
    await writeFile(temporary, source, { flag: "wx", mode });
    await chmod(temporary, mode);
    await assertSafeExcludePath(git);
    await rename(temporary, git.excludeFile);
    return !infoExists;
  } catch (error) {
    if (!infoExists) await rmdir(info).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export interface GitExclusionTransaction {
  readonly commit: () => Promise<void>;
  readonly rollback: () => Promise<void>;
}

export async function stageGitExclusions(
  current: InstallationState,
  next: InstallationState,
  options: { readonly includedTargets?: ReadonlySet<string> } = {},
): Promise<GitExclusionTransaction> {
  const plans: Array<{
    readonly git: GitProject;
    readonly allowMissingTarget: boolean;
    readonly snapshot: GitExcludeSnapshot;
    readonly updated: Buffer;
  }> = [];
  for (const target of await targetsFor(current, next, options.includedTargets)) {
    const snapshot = await readSnapshot(target.git, target.allowMissingTarget);
    const updated = reconcileGitExcludeBytes(
      snapshot.bytes,
      target.git.excludeFile,
      target.current,
      target.next,
    );
    if (!updated.equals(snapshot.bytes)) {
      plans.push({
        allowMissingTarget: target.allowMissingTarget ?? false,
        git: target.git,
        snapshot,
        updated,
      });
    }
  }
  const originals = new Map<string, {
    readonly allowMissingTarget: boolean;
    readonly createdInfo: boolean;
    readonly git: GitProject;
    readonly snapshot: GitExcludeSnapshot;
    readonly updated: Buffer;
  }>();
  const rollbackChanges = async (): Promise<void> => {
    for (const { allowMissingTarget, createdInfo, git, snapshot, updated } of [...originals.values()].reverse()) {
      const current = await readSnapshot(git, allowMissingTarget);
      if (
        !current.exists ||
        current.mode !== snapshot.mode ||
        !current.bytes.equals(updated)
      ) {
        throw new Error(
          `${git.excludeFile} changed before exclusion rollback; refusing to overwrite concurrent repository-local edits`,
        );
      }
      if (snapshot.exists) await replace(git, snapshot.bytes, snapshot.mode);
      else {
        await assertSafeExcludePath(git);
        await rm(git.excludeFile, { force: true });
      }
      if (createdInfo) await rmdir(dirname(git.excludeFile)).catch((error) => {
        if (!hasErrorCode(error, "ENOTEMPTY") && !hasErrorCode(error, "ENOENT")) throw error;
      });
    }
  };
  let status: "staged" | "committed" | "rolled-back" = "staged";
  return {
    commit: async () => {
      if (status !== "staged") return;
      try {
        for (const plan of plans) {
          const currentSnapshot = await readSnapshot(plan.git, plan.allowMissingTarget);
          if (
            currentSnapshot.exists !== plan.snapshot.exists ||
            currentSnapshot.mode !== plan.snapshot.mode ||
            !currentSnapshot.bytes.equals(plan.snapshot.bytes)
          ) {
            throw new Error(
              `${plan.git.excludeFile} changed after exclusion preflight; retry without modifying repository-local exclusions concurrently`,
            );
          }
          const createdInfo = await replace(plan.git, plan.updated, plan.snapshot.mode);
          originals.set(plan.git.excludeFile, {
            allowMissingTarget: plan.allowMissingTarget,
            createdInfo,
            git: plan.git,
            snapshot: plan.snapshot,
            updated: plan.updated,
          });
        }
        status = "committed";
      } catch (error) {
        status = "rolled-back";
        try {
          await rollbackChanges();
        } catch (rollbackError) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n` +
            `Exclusion rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
        throw error;
      }
    },
    rollback: async () => {
      if (status === "rolled-back") return;
      if (status === "committed") {
        await rollbackChanges();
      }
      status = "rolled-back";
    },
  };
}
