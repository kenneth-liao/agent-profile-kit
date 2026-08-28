import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import {
  canonicalRepositoryExclusionRecord,
  compareCanonicalStrings,
  INSTALLATION_MARKER_PATH,
} from "../schemas/installation-manifest.js";
import type {
  RepositoryExclusionContribution,
  RepositoryExclusionRecord,
} from "../schemas/installation-manifest.js";
import type {
  OwnershipOutputReceipt,
  OwnershipReceipt,
  OwnershipState,
} from "../schemas/ownership-state.js";
import { assertRealDirectoryPath, findGitProject, gitExcludeEntry, type GitProject } from "./git.js";
import type { LifecycleGitInspection } from "./lifecycle-git-inspection.js";
import type { DesiredInstallation } from "./project-plan.js";
import { readMarker } from "./installation-state.js";
import {
  ordinaryReceipts,
  repositoryExclusionRecords,
  withReceipts,
  withRepositoryExclusion,
} from "./ownership-state.js";
import {
  normalizeBlocker,
  repositoryExclusionInvalidBlocker,
  repositoryExclusionContributionBlocker,
  repositoryExclusionTargetUnprovenBlocker,
  type BlockerInput,
  type ReconciliationBlocker,
} from "./blockers.js";
import {
  isContributionRepair,
  isMissingContributionRepair,
  isMovedContributionRepair,
  isStaleContributionRepair,
  safeRepairTargets,
  withProvenContributions,
  withStagedCurrentContributions,
  type MissingContributionRepair,
  type MovedContributionRepair,
  type RetiringSectionRepair,
  type SafeRepairEligibility,
  type SafeRepairExclusionRepair,
  type SafeRepairIneligibilityCause,
  type StaleContributionRepair,
} from "./safe-repair.js";

/**
 * Repository-local exclusion repairs carry the exhaustive typed Safe Repair
 * boundary (ADR-0022): a damaged recorded section (`exclusion-section`), a
 * provably missing receipt contribution (`missing-contribution`), stale
 * recorded entries at an unchanged proven target (`stale-contribution`), a
 * receipt contribution whose target moved between two proven targets
 * (`moved-contribution`), or a missing section, file, or safe parent during
 * intentional-deletion retirement whose post-retirement union the active
 * receipts and live target prove (`retiring-exclusion-section`).
 */
export type RepositoryExclusionRepair = SafeRepairExclusionRepair;

/** Why one installation's candidate contribution repair was found ineligible. */
export interface IneligibleContributionEvidence {
  readonly cause: SafeRepairIneligibilityCause;
  readonly target: string;
}

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

export interface RepositoryExclusionDiagnostics {
  readonly repairs: readonly RepositoryExclusionRepair[];
  readonly warnings: readonly string[];
}

/** Canonical suffix for a repair warning surfaced by status. */
export const REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX =
  " is missing its Agent Profile Kit exclusion section; apply will restore recorded exact entries";

/** Canonical suffix for a retirement repair warning surfaced by status. */
export const REPOSITORY_EXCLUSION_RETIREMENT_REPAIR_WARNING_SUFFIX =
  " is missing its Agent Profile Kit exclusion section; apply will publish the resulting Git exclusion entries during retirement";

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
  outputs: readonly OwnershipOutputReceipt[],
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
  current: OwnershipState,
  next: OwnershipState,
  includedTargets?: ReadonlySet<string>,
): readonly Target[] {
  const currentByTarget = recordsByTarget(repositoryExclusionRecords(current));
  const nextByTarget = recordsByTarget(repositoryExclusionRecords(next));
  const currentContributionTarget = new Map(current.receipts.flatMap((receipt) =>
    receipt.repositoryExclusion === undefined
      ? []
      : [[receipt.installationId, receipt.repositoryExclusion.target] as const]
  ));
  const currentReceiptByInstallationId = new Map(current.receipts.map(
    (receipt) => [receipt.installationId, receipt] as const,
  ));
  const nextReceiptByInstallationId = new Map(next.receipts.map(
    (receipt) => [receipt.installationId, receipt] as const,
  ));
  return [...new Set([...currentByTarget.keys(), ...nextByTarget.keys()])]
    .filter((target) => includedTargets === undefined || includedTargets.has(target))
    .sort(compareCanonicalStrings)
    .map((target) => {
      const currentRecord = currentByTarget.get(target);
      const nextRecord = nextByTarget.get(target);
      // When an entire Git Project moves, its repository-local exclusion file
      // moves with it. Validate the moved section against the same receipt
      // contribution at the new canonical target without persisting a second
      // target or reconstructing ownership from generated output. The
      // physical-file signature is the receipt's Project changing between the
      // two states: a same-Project target change re-derives its contribution
      // at the new target, so its staged current state there stays the
      // recorded union alone and unrecorded bytes are never adopted.
      const movedEntries = currentRecord === undefined
        ? [...new Set((nextRecord?.contributions ?? []).flatMap((contribution) => {
            const before = currentReceiptByInstallationId.get(contribution.installationId);
            const after = nextReceiptByInstallationId.get(contribution.installationId);
            const physicallyMoved = before !== undefined && after !== undefined &&
              before.project !== after.project;
            return physicallyMoved &&
              currentContributionTarget.has(contribution.installationId) &&
              currentContributionTarget.get(contribution.installationId) !== target
              ? contribution.entries
              : [];
          }))].sort(compareCanonicalStrings)
        : [];
      return {
        allowMissingTarget: currentByTarget.has(target) && !nextByTarget.has(target),
        current: currentRecord?.entries ?? movedEntries,
        git: gitForExclusionTarget(target),
        next: nextRecord?.entries ?? [],
      };
    });
}

/** Return the canonical union transition without inspecting or reconstructing Git topology. */
export function repositoryExclusionChanges(
  current: OwnershipState,
  next: OwnershipState,
  includedTargets?: ReadonlySet<string>,
): readonly RepositoryExclusionChange[] {
  return targetsFor(current, next, includedTargets).map((target) => ({
    current: target.current,
    next: target.next,
    target: target.git.excludeFile,
  }));
}

export async function relocateRepositoryExclusionsForDesired(
  state: OwnershipState,
  desired: readonly DesiredInstallation[],
): Promise<OwnershipState> {
  let inspectionState = state;
  for (const installation of desired) {
    const git = installation.gitProject;
    if (!git) continue;
    const marker = await readMarker(installation.binding.canonicalProject).catch(() => undefined);
    const previous = marker
      ? ordinaryReceipts(state).find((candidate) => candidate.installationId === marker.installationId)
      : undefined;
    if (
      previous?.repositoryExclusion !== undefined &&
      previous.project !== installation.binding.canonicalProject
    ) {
      inspectionState = withReceipts(
        inspectionState,
        withRepositoryExclusion(
          inspectionState.receipts,
          previous.installationId,
          { ...previous.repositoryExclusion, target: git.excludeFile },
        ),
      );
    }
  }
  return inspectionState;
}

export function repositoryExclusionTargetsForInstallations(
  state: OwnershipState,
  desired: readonly DesiredInstallation[],
  includedInstallationIds: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (includedInstallationIds === undefined) return undefined;
  return new Set([
    ...desired.flatMap((installation) =>
      installation.gitProject === undefined ? [] : [installation.gitProject.excludeFile]
    ),
    ...repositoryExclusionRecords(state)
      .filter((record) => record.contributions.some((contribution) =>
        includedInstallationIds.has(contribution.installationId)
      ))
      .map((record) => record.target),
  ]);
}

async function inspectionTargets(
  state: OwnershipState,
  desired: readonly DesiredInstallation[],
  retiringInstallationIds: ReadonlySet<string> = new Set(),
  includedInstallationIds?: ReadonlySet<string>,
): Promise<readonly Target[]> {
  const inspectionState = await relocateRepositoryExclusionsForDesired(state, desired);
  const currentByTarget = recordsByTarget(repositoryExclusionRecords(state));
  const relocatedByTarget = recordsByTarget(repositoryExclusionRecords(inspectionState));
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

/** The canonical recorded union one target's owned section must carry. */
function recordedUnionEntries(state: OwnershipState, target: string): readonly string[] {
  return repositoryExclusionRecords(state).find((record) => record.target === target)?.entries ?? [];
}

/**
 * The one byte gate every contribution eligibility class shares: read the
 * target's live owned section and compare it with the expected canonical
 * union. `absent` marks a file without an owned section, `matches` a section
 * carrying exactly the expected entries, and `mismatched` readable bytes that
 * differ. Read, safety, and parse failures throw so each gate can surface its
 * own unreadable-bytes cause.
 */
async function exclusionSectionGate(
  target: string,
  git: GitProject,
  expected: readonly string[],
  gitInspection?: LifecycleGitInspection,
): Promise<{ readonly kind: "absent" } | { readonly kind: "matches" } | { readonly kind: "mismatched" }> {
  const snapshot = await readSnapshot(git, false, gitInspection);
  const section = parseOwnedSection(snapshot.bytes, target);
  if (section === undefined) return { kind: "absent" };
  return sameEntries(sectionEntries(snapshot.bytes, section), sortedUniqueEntries(expected))
    ? { kind: "matches" }
    : { kind: "mismatched" };
}

/**
 * Decide whether a desired installation whose active receipt lacks its
 * Repository Exclusion Contribution is an eligible missing-contribution Safe
 * Repair. The caller establishes the remaining proof set at the reconciliation
 * boundary: an active receipt, a present Marker with matching identity and
 * hash-proven owned roots (ownership proof), a live Project with a resolved Git
 * target, untracked destinations without conflicts, and an otherwise-current
 * desired write set, so the receipt can prove the exact contribution. This
 * function owns the byte-level gate: the target's owned section must be absent
 * or already contain exactly the recorded union plus the proven contribution,
 * so publication can never disturb unprovable bytes.
 */
export async function missingContributionRepairEligibility(
  previous: OwnershipReceipt,
  git: GitProject,
  state: OwnershipState,
  gitInspection?: LifecycleGitInspection,
): Promise<SafeRepairEligibility<MissingContributionRepair>> {
  const entries = expectedContributionEntries(previous, git.relativeProject);
  const repair: MissingContributionRepair = {
    class: "missing-contribution",
    entries,
    installationId: previous.installationId,
    target: git.excludeFile,
  };
  const incoherentBytes: SafeRepairEligibility<MissingContributionRepair> = {
    cause: "incoherent-exclusion-bytes",
    eligible: false,
  };
  try {
    const gate = await exclusionSectionGate(
      git.excludeFile,
      git,
      [...recordedUnionEntries(state, git.excludeFile), ...entries],
      gitInspection,
    );
    return gate.kind === "mismatched" ? incoherentBytes : { eligible: true, repair };
  } catch {
    // Read, safety, and parse failures are a distinct diagnosis from readable
    // bytes with the wrong entries; the Blocker boundary surfaces the error.
    return { cause: "unreadable-exclusion-bytes", eligible: false };
  }
}

/**
 * Decide whether a desired installation whose active receipt records stale
 * Repository Exclusion Contribution entries is an eligible stale-contribution
 * Safe Repair. The caller establishes the same proof set as the
 * missing-contribution class — an active receipt, a present Marker with
 * matching identity and hash-proven owned roots, a live Project with an
 * unchanged resolved Git target, untracked destinations without conflicts, and
 * an otherwise-current desired write set — plus the staleness itself: recorded
 * entries that differ from the entries the receipt's owned outputs derive. This
 * function owns the byte-level gate: the target's owned section must already
 * contain exactly the recorded union, so one exact replacement can never
 * disturb unprovable bytes.
 */
export async function staleContributionRepairEligibility(
  previous: OwnershipReceipt,
  git: GitProject,
  state: OwnershipState,
  gitInspection?: LifecycleGitInspection,
): Promise<SafeRepairEligibility<StaleContributionRepair>> {
  const recordedContribution = previous.repositoryExclusion;
  if (
    recordedContribution === undefined ||
    recordedContribution.target !== git.excludeFile
  ) {
    // Defensive: the reconciliation boundary proves the unchanged Git target
    // before calling this gate, so a mismatch here is a caller-contract
    // violation, not a byte diagnosis.
    return { cause: "wrong-target", eligible: false };
  }
  const entries = expectedContributionEntries(previous, git.relativeProject);
  const currentEntries = sortedUniqueEntries(recordedContribution.entries);
  if (sameEntries(currentEntries, entries)) {
    // The recorded contribution already equals the entries its receipt derives;
    // no stale correction is pending and repeating status must stay current.
    return { cause: "unchanged-contribution", eligible: false };
  }
  const repair: StaleContributionRepair = {
    class: "stale-contribution",
    currentEntries,
    entries,
    installationId: previous.installationId,
    target: git.excludeFile,
  };
  const incoherentBytes: SafeRepairEligibility<StaleContributionRepair> = {
    cause: "incoherent-exclusion-bytes",
    eligible: false,
  };
  try {
    const gate = await exclusionSectionGate(
      git.excludeFile,
      git,
      recordedUnionEntries(state, git.excludeFile),
      gitInspection,
    );
    return gate.kind === "matches" ? { eligible: true, repair } : incoherentBytes;
  } catch {
    // Read, safety, and parse failures are a distinct diagnosis from readable
    // bytes with the wrong entries; the ineligible cause becomes distinct
    // Blocker evidence at the ownership boundary.
    return { cause: "unreadable-exclusion-bytes", eligible: false };
  }
}

/**
 * Decide whether a desired installation whose active receipt records its
 * Repository Exclusion Contribution at a target other than the live Git target
 * is an eligible moved-contribution Safe Repair. The caller establishes the
 * same proof set as the sibling contribution classes — an active receipt, a
 * present Marker with matching identity and hash-proven owned roots, a live
 * Project with untracked destinations without conflicts, and an
 * otherwise-current desired write set — plus one exact two-target result: the
 * old target derives only from the active receipt and must independently pass
 * path, owned-section, and exact recorded-union proof, and the new target
 * derives from live Git topology and must independently pass its own proof
 * (path safety, then an owned section that is absent or exactly the recorded
 * union there). Any combined condition without that one exact two-target
 * result stays ineligible, so publication can never disturb unprovable bytes.
 */
export async function movedContributionRepairEligibility(
  previous: OwnershipReceipt,
  git: GitProject,
  state: OwnershipState,
  gitInspection?: LifecycleGitInspection,
): Promise<SafeRepairEligibility<MovedContributionRepair>> {
  const recordedContribution = previous.repositoryExclusion;
  if (
    recordedContribution === undefined ||
    recordedContribution.target === git.excludeFile
  ) {
    // Defensive: the reconciliation boundary dispatches missing and stale
    // candidates before this gate, so an absent or same-target recorded
    // contribution here is a caller-contract violation, not a byte diagnosis.
    return { cause: "wrong-target", eligible: false };
  }
  const repair: MovedContributionRepair = {
    class: "moved-contribution",
    current: sortedUniqueEntries(recordedContribution.entries),
    currentTarget: recordedContribution.target,
    installationId: previous.installationId,
    // The new target's GitProject is topology-derived; its relativeProject is
    // the one derivation Git itself uses (the worktree toplevel for a linked
    // worktree, whose root differs from the common-directory exclude root).
    next: expectedContributionEntries(previous, git.relativeProject),
    nextTarget: git.excludeFile,
  };
  const incoherentBytes: SafeRepairEligibility<MovedContributionRepair> = {
    cause: "incoherent-exclusion-bytes",
    eligible: false,
  };
  try {
    // Old-target proof: the receipt derives the target; the section must
    // carry the recorded union exactly.
    const currentGate = await exclusionSectionGate(
      repair.currentTarget,
      gitForExclusionTarget(repair.currentTarget),
      recordedUnionEntries(state, repair.currentTarget),
      gitInspection,
    );
    if (currentGate.kind !== "matches") return incoherentBytes;
    // New-target proof: live Git topology derives the target; its owned
    // section must be absent or match the recorded union there exactly.
    const nextGate = await exclusionSectionGate(
      repair.nextTarget,
      git,
      recordedUnionEntries(state, repair.nextTarget),
      gitInspection,
    );
    return nextGate.kind === "mismatched" ? incoherentBytes : { eligible: true, repair };
  } catch {
    // Read, safety, and parse failures are a distinct diagnosis from readable
    // bytes with the wrong entries; the ineligible cause becomes distinct
    // Blocker evidence at the ownership boundary.
    return { cause: "unreadable-exclusion-bytes", eligible: false };
  }
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * The one shared typed decision for a missing repository-local exclusion
 * section, file, or safe parent during intentional-deletion retirement
 * (ADR-0022). Both the Blocker boundary and the diagnostics evidence consume
 * this gate, so suppression and repair evidence can never diverge. The caller
 * establishes the remaining retirement proof set: the retiring installation's
 * recorded contribution must already pass the retiring-ownership gates, and
 * the resulting union derives only from the surviving active receipts. The
 * byte gate reads the live target: a missing file, a missing safe parent, or
 * an absent owned section is eligible and carries the exact post-retirement
 * union (empty when the retiring installation is the sole contributor); a
 * present owned section means no absence repair is pending; unreadable,
 * unsafe, or malformed bytes stay ineligible so publication can never disturb
 * unprovable bytes.
 */
export async function retiringSectionRepairEligibility(
  state: OwnershipState,
  git: GitProject,
  retiringInstallationIds: ReadonlySet<string>,
  gitInspection?: LifecycleGitInspection,
): Promise<SafeRepairEligibility<RetiringSectionRepair>> {
  const record = repositoryExclusionRecords(state).find(
    (candidate) => candidate.target === git.excludeFile,
  );
  if (
    record === undefined ||
    !record.contributions.some((contribution) =>
      retiringInstallationIds.has(contribution.installationId)
    )
  ) {
    // Defensive: both callers dispatch only retirement targets here, so a
    // target without retiring contributions is a caller-contract violation,
    // not a byte diagnosis.
    return { cause: "wrong-target", eligible: false };
  }
  const repair: RetiringSectionRepair = {
    class: "retiring-exclusion-section",
    entries: sortedUniqueEntries(
      record.contributions
        .filter((contribution) => !retiringInstallationIds.has(contribution.installationId))
        .flatMap((contribution) => contribution.entries),
    ),
    target: git.excludeFile,
  };
  try {
    const snapshot = await readSnapshot(git, false, gitInspection);
    return parseOwnedSection(snapshot.bytes, git.excludeFile) === undefined
      ? { eligible: true, repair }
      : { cause: "unchanged-contribution", eligible: false };
  } catch {
    // Read, safety, and parse failures are a distinct diagnosis from a
    // provable absence; the Blocker boundary surfaces the error.
    return { cause: "unreadable-exclusion-bytes", eligible: false };
  }
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
  installation: OwnershipReceipt,
  relativeProject: string,
): readonly string[] {
  return sortedUniqueEntries(
    [
      ...installation.outputs.map((output) => gitExcludeEntry({ relativeProject }, output.path)),
      gitExcludeEntry({ relativeProject }, INSTALLATION_MARKER_PATH),
    ],
  );
}

function relativeProjectForTarget(target: string, project: string): string {
  const relativeProject = relative(targetRoot(target), project).split(sep).join("/");
  return relativeProject === ".." || relativeProject.startsWith("../") ? "" : relativeProject;
}

function hasExpectedContributionEntries(
  installation: OwnershipReceipt,
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
  state: OwnershipState,
  desired: readonly DesiredInstallation[],
  project: string,
): boolean {
  const recordedTargets = repositoryExclusionRecords(state).map((record) => record.target);
  const desiredTargets = desired.flatMap((installation) =>
    installation.gitProject ? [installation.gitProject.excludeFile] : [],
  );
  return [...new Set([...recordedTargets, ...desiredTargets])]
    .some((target) => targetContainsProject(target, project));
}

async function existingInstallationForDesired(
  state: OwnershipState,
  desired: DesiredInstallation,
): Promise<OwnershipReceipt | undefined> {
  const direct = ordinaryReceipts(state).find(
    (installation) => installation.project === desired.binding.canonicalProject,
  );
  if (direct) return direct;
  const marker = await readMarker(desired.binding.canonicalProject).catch(() => undefined);
  if (!marker) return undefined;
  return ordinaryReceipts(state).find(
    (installation) => installation.installationId === marker.installationId,
  );
}

/**
 * One missing contribution's Blocker message. When the reconciliation boundary
 * already ran the eligibility gate and the byte gate failed, the cause becomes
 * distinct evidence instead of the generic missing-contribution diagnosis.
 */
function missingContributionBlockerMessage(
  target: string,
  installationId: string,
  evidence: IneligibleContributionEvidence | undefined,
  fallback: string,
): string {
  if (evidence === undefined) return fallback;
  if (evidence.cause === "incoherent-exclusion-bytes") {
    return `${target} Git exclusion contribution for Installation ID ` +
      `${installationId} cannot be proven: its owned section does not match ` +
      "the recorded entries; restore the recorded section before retrying";
  }
  if (evidence.cause === "unreadable-exclusion-bytes") {
    return `${target} Git exclusion contribution for Installation ID ` +
      `${installationId} cannot be proven: its exclusion file is unreadable or unsafe`;
  }
  return fallback;
}

/**
 * One moved contribution's Blocker message. When the reconciliation boundary
 * already ran the eligibility gate and either target's byte gate failed, the
 * cause becomes distinct evidence instead of the generic target-mismatch
 * diagnosis.
 */
function movedContributionBlockerMessage(
  currentTarget: string,
  nextTarget: string,
  installationId: string,
  evidence: IneligibleContributionEvidence | undefined,
  fallback: string,
): string {
  if (evidence === undefined) return fallback;
  if (evidence.cause === "incoherent-exclusion-bytes") {
    return `${nextTarget} Git exclusion contribution for Installation ID ` +
      `${installationId} cannot be moved from ${currentTarget}: an owned section ` +
      "does not match the recorded entries; restore the recorded section before retrying";
  }
  if (evidence.cause === "unreadable-exclusion-bytes") {
    return `${nextTarget} Git exclusion contribution for Installation ID ` +
      `${installationId} cannot be moved from ${currentTarget}: an exclusion file ` +
      "is unreadable or unsafe";
  }
  return fallback;
}

/** Validate semantic ownership links before touching any repository-local exclusion bytes. */
async function repositoryExclusionOwnershipBlockers(
  state: OwnershipState,
  desired: readonly DesiredInstallation[],
  eligibleContributionRepairs: readonly SafeRepairExclusionRepair[],
  ineligibleContributionEvidence: ReadonlyMap<string, IneligibleContributionEvidence>,
): Promise<readonly BlockerInput[]> {
  const eligibleMissingContributionIds = new Set(
    eligibleContributionRepairs
      .filter(isMissingContributionRepair)
      .map((repair) => repair.installationId),
  );
  const eligibleStaleContributionIds = new Set(
    eligibleContributionRepairs
      .filter(isStaleContributionRepair)
      .map((repair) => repair.installationId),
  );
  const eligibleMovedContributionIds = new Set(
    eligibleContributionRepairs
      .filter(isMovedContributionRepair)
      .map((repair) => repair.installationId),
  );
  const blockers: BlockerInput[] = [];
  for (const installation of desired) {
    const git = installation.gitProject;
    if (!git) continue;
    const previous = await existingInstallationForDesired(state, installation);
    if (!previous) continue;
    const contribution = contributionFor(repositoryExclusionRecords(state), previous.installationId);
    if (!contribution) {
      if (!eligibleMissingContributionIds.has(previous.installationId)) {
        blockers.push(repositoryExclusionContributionBlocker({
          affectedItems: [{ kind: "installation-id", value: previous.installationId }],
          message: missingContributionBlockerMessage(
            git.excludeFile,
            previous.installationId,
            ineligibleContributionEvidence.get(previous.installationId),
            `${installation.binding.canonicalProject} is missing its Git exclusion ` +
              `contribution for Installation ID ${previous.installationId}`,
          ),
        }));
      }
      continue;
    }
    const moved = previous.project !== installation.binding.canonicalProject;
    if (moved) continue;
    if (contribution.record.target !== git.excludeFile) {
      if (!eligibleMovedContributionIds.has(previous.installationId)) {
        blockers.push(repositoryExclusionContributionBlocker({
          affectedItems: [
            { kind: "path", value: contribution.record.target },
            { kind: "path", value: git.excludeFile },
          ],
          message: movedContributionBlockerMessage(
            contribution.record.target,
            git.excludeFile,
            previous.installationId,
            ineligibleContributionEvidence.get(previous.installationId),
            `${installation.binding.canonicalProject} Git exclusion contribution for ` +
              `Installation ID ${previous.installationId} targets ${contribution.record.target}, ` +
              `expected ${git.excludeFile}`,
          ),
        }));
      }
      continue;
    }
    const expected = expectedContributionEntries(previous, git.relativeProject);
    if (!sameEntries(sortedUniqueEntries(contribution.entries), expected)) {
      if (!eligibleStaleContributionIds.has(previous.installationId)) {
        const evidence = ineligibleContributionEvidence.get(previous.installationId);
        blockers.push(repositoryExclusionContributionBlocker({
          affectedItems: [{ kind: "path", value: git.excludeFile }],
          message: evidence === undefined
            ? `${git.excludeFile} Git exclusion contribution for Installation ID ` +
              `${previous.installationId} does not match the entries recorded by its installation record`
            : evidence.cause === "incoherent-exclusion-bytes"
              ? `${git.excludeFile} Git exclusion contribution for Installation ID ` +
                `${previous.installationId} is stale and its owned section does not match ` +
                "the recorded entries; restore the recorded section before retrying"
              : evidence.cause === "unreadable-exclusion-bytes"
                ? `${git.excludeFile} Git exclusion contribution for Installation ID ` +
                  `${previous.installationId} is stale and its exclusion file is unreadable or unsafe`
                : `${git.excludeFile} Git exclusion contribution for Installation ID ` +
                  `${previous.installationId} targets ${contribution.record.target}, ` +
                  `expected ${git.excludeFile}`,
        }));
      }
    }
  }
  return blockers;
}

/** Validate the canonical exclusion contribution before retiring an absent installation. */
async function retiringInstallationOwnershipBlockers(
  state: OwnershipState,
  desired: readonly DesiredInstallation[],
  retiringInstallationIds: ReadonlySet<string>,
): Promise<readonly BlockerInput[]> {
  if (retiringInstallationIds.size === 0) return [];
  const blockers: BlockerInput[] = [];
  for (const installation of ordinaryReceipts(state)) {
    if (!retiringInstallationIds.has(installation.installationId)) continue;
    const contributionLinks = repositoryExclusionRecords(state).flatMap((record) =>
      record.contributions
        .filter((contribution) => contribution.installationId === installation.installationId)
        .map((contribution) => ({ contribution, record })),
    );
    if (contributionLinks.length === 0) {
      if (hasKnownExclusionTargetForProject(state, desired, installation.project)) {
        blockers.push(repositoryExclusionContributionBlocker({
          affectedItems: [{ kind: "installation-id", value: installation.installationId }],
          message:
            `${installation.project} is missing its Git exclusion contribution for ` +
            `Installation ID ${installation.installationId}`,
        }));
      }
      continue;
    }
    // Keep this defensive check for callers that construct state in memory
    // without passing through the parser's cross-record uniqueness boundary.
    if (contributionLinks.length !== 1) {
      blockers.push(repositoryExclusionContributionBlocker({
        affectedItems: [{ kind: "installation-id", value: installation.installationId }],
        message:
          `${installation.project} has duplicate Git exclusion contributions for ` +
          `Installation ID ${installation.installationId}`,
      }));
      continue;
    }
    const { contribution, record } = contributionLinks[0]!;
    if (!hasExpectedContributionEntries(installation, { entries: contribution.entries, record })) {
      blockers.push(repositoryExclusionContributionBlocker({
        affectedItems: [{ kind: "path", value: record.target }],
        message:
          `${record.target} Git exclusion contribution for Installation ID ` +
          `${installation.installationId} does not match the entries recorded by its installation record`,
      }));
    }
  }
  return blockers;
}

/** Validate every recorded Installation against its live Git target for uninstall. */
async function recordedInstallationOwnershipBlockers(
  state: OwnershipState,
  retiringInstallationIds: ReadonlySet<string> = new Set(),
  gitInspection?: LifecycleGitInspection,
): Promise<readonly BlockerInput[]> {
  const resolveGit = gitInspection?.findGitProject ?? findGitProject;
  const blockers: BlockerInput[] = [];
  for (const installation of ordinaryReceipts(state)) {
    // Absence is the canonical non-Git receipt fact. Do not rediscover a new
    // live Git repository and reinterpret the installation's recorded lifetime.
    if (installation.repositoryExclusion === undefined) continue;
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
    const contribution = contributionFor(repositoryExclusionRecords(state), installation.installationId);
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
            `${installation.project} has a Git exclusion contribution but is no longer a Git project`,
          project: installation.project,
        }));
      }
      continue;
    }
    if (!contribution) {
      blockers.push(repositoryExclusionContributionBlocker({
        affectedItems: [{ kind: "installation-id", value: installation.installationId }],
        message:
          `${installation.project} is missing its Git exclusion contribution for ` +
          `Installation ID ${installation.installationId}`,
      }));
      continue;
    }
    if (contribution.record.target !== git.excludeFile) {
      blockers.push(repositoryExclusionContributionBlocker({
        affectedItems: [
          { kind: "path", value: contribution.record.target },
          { kind: "path", value: git.excludeFile },
        ],
        message:
          `${installation.project} Git exclusion contribution for Installation ID ` +
          `${installation.installationId} targets ${contribution.record.target}, ` +
          `expected ${git.excludeFile}`,
      }));
      continue;
    }
    const expected = expectedContributionEntries(installation, git.relativeProject);
    if (!sameEntries(sortedUniqueEntries(contribution.entries), expected)) {
      blockers.push(repositoryExclusionContributionBlocker({
        affectedItems: [{ kind: "path", value: git.excludeFile }],
        message:
          `${git.excludeFile} Git exclusion contribution for Installation ID ` +
          `${installation.installationId} does not match the entries recorded by its installation record`,
      }));
    }
  }
  return blockers;
}

function projectsForExclusionTarget(
  state: OwnershipState,
  desired: readonly DesiredInstallation[],
  target: string,
): readonly string[] {
  const projectByInstallationId = new Map(
    ordinaryReceipts(state).map((installation) => [
      installation.installationId,
      installation.project,
    ] as const),
  );
  const projects = new Set(
    repositoryExclusionRecords(state)
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
  state: OwnershipState,
  desired: readonly DesiredInstallation[] = [],
  options: {
    /**
     * Contribution Safe Repairs (missing, stale, and moved) proven by the
     * reconciliation boundary. Their Blockers are suppressed; missing
     * contributions validate the byte-level section check against the recorded
     * union plus the proven contribution, stale contributions validate
     * against the recorded union itself, and moved contributions validate
     * against the recorded union at each of their two targets, without
     * persisting a second ownership record.
     */
    readonly eligibleContributionRepairs?: readonly SafeRepairExclusionRepair[];
    readonly gitInspection?: LifecycleGitInspection;
    readonly retiringInstallationIds?: ReadonlySet<string>;
    readonly validateRecordedInstallations?: boolean;
    readonly includedInstallationIds?: ReadonlySet<string>;
    /**
     * Byte-gate failures the reconciliation boundary already proved for one
     * installation's candidate contribution repair. They become distinct
     * Blocker evidence at the ownership boundary instead of the generic
     * entries-mismatch diagnosis.
     */
    readonly ineligibleContributionEvidence?: ReadonlyMap<string, IneligibleContributionEvidence>;
  } = {},
): Promise<readonly ReconciliationBlocker[]> {
  const validateRecordedInstallations = options.validateRecordedInstallations ?? desired.length === 0;
  const eligibleContributionRepairs = options.eligibleContributionRepairs ?? [];
  const ineligibleContributionEvidence = options.ineligibleContributionEvidence ?? new Map();
  const blockers: BlockerInput[] = [
    ...await repositoryExclusionOwnershipBlockers(
      state,
      desired,
      eligibleContributionRepairs,
      ineligibleContributionEvidence,
    ),
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
  // Proven missing contributions count as expected section content for
  // byte-level validation only; they are persisted by apply's ordinary state
  // write. A proven stale contribution keeps its target's un-overlaid recorded
  // union as expected section content: the live section must still match it
  // exactly until apply replaces the stale entries.
  const eligibleMissingContributionRepairs = eligibleContributionRepairs.filter(
    isMissingContributionRepair,
  );
  const inspectionState = eligibleMissingContributionRepairs.length === 0
    ? state
    : withStagedCurrentContributions(state, eligibleContributionRepairs);
  for (const target of await inspectionTargets(
    inspectionState,
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
      const targetRecord = repositoryExclusionRecords(state).find(
        (record) => record.target === target.git.excludeFile,
      );
      const retiringContributions = targetRecord?.contributions.filter((contribution) =>
        options.retiringInstallationIds?.has(contribution.installationId),
      );
      if (
        options.retiringInstallationIds !== undefined &&
        retiringContributions !== undefined &&
        retiringContributions.length > 0 &&
        target.current.length > 0 &&
        !snapshot.targetMissing
      ) {
        // One shared typed decision owns retirement-absence eligibility for
        // both this Blocker boundary and the diagnostics evidence. An eligible
        // absence is non-blocking pending work: the ordinary retirement pass
        // publishes the exact post-retirement union (or removes the section)
        // and retires the receipt atomically. Every other outcome stays at the
        // existing byte gate below — a present section with drifted entries,
        // malformed bytes, and unsafe paths remain Blockers through
        // reconcileGitExcludeBytes.
        const absence = await retiringSectionRepairEligibility(
          state,
          target.git,
          options.retiringInstallationIds,
          options.gitInspection,
        );
        if (
          absence.eligible &&
          projectsForExclusionTarget(state, desired, target.git.excludeFile).length === 0
        ) {
          blockers.push(repositoryExclusionContributionBlocker({
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
        blockers.push(repositoryExclusionContributionBlocker({
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
  state: OwnershipState,
  desired: readonly DesiredInstallation[] = [],
  options: {
    /**
     * Contribution Safe Repairs (missing and stale) proven by the
     * reconciliation boundary. Their contribution pass publishes the complete
     * proven union at the target, so a separate recorded-section repair would
     * publish a stale conflicting entry list and is suppressed here.
     */
    readonly eligibleContributionRepairs?: readonly SafeRepairExclusionRepair[];
    readonly gitInspection?: LifecycleGitInspection;
    readonly includedInstallationIds?: ReadonlySet<string>;
    /**
     * Intentional-deletion retirement installations. Retirement targets take
     * their evidence from the one shared retirement-absence decision instead
     * of the recorded-section repair, so a retirement never publishes the
     * retiring installation's recorded entries.
     */
    readonly retiringInstallationIds?: ReadonlySet<string>;
  } = {},
): Promise<RepositoryExclusionDiagnostics> {
  const warnings: string[] = [];
  const repairs: RepositoryExclusionRepair[] = [];
  const provenContributionTargets = new Set(
    (options.eligibleContributionRepairs ?? []).flatMap(safeRepairTargets),
  );
  const retiringInstallationIds = options.retiringInstallationIds ?? new Set<string>();
  for (const target of await inspectionTargets(
    state,
    desired,
    retiringInstallationIds,
    options.includedInstallationIds,
  )) {
    if (provenContributionTargets.has(target.git.excludeFile)) continue;
    const retirementRecord = repositoryExclusionRecords(state).find(
      (record) => record.target === target.git.excludeFile,
    );
    if (
      retiringInstallationIds.size > 0 &&
      target.current.length > 0 &&
      retirementRecord?.contributions.some((contribution) =>
        retiringInstallationIds.has(contribution.installationId)
      )
    ) {
      // The one shared typed retirement-absence decision; the Blocker boundary
      // consumes the same gate, so suppression and evidence cannot diverge.
      const absence = await retiringSectionRepairEligibility(
        state,
        target.git,
        retiringInstallationIds,
        options.gitInspection,
      );
      if (absence.eligible) {
        warnings.push(
          `${target.git.excludeFile}${REPOSITORY_EXCLUSION_RETIREMENT_REPAIR_WARNING_SUFFIX}`,
        );
        repairs.push(absence.repair);
      }
      // Present, malformed, and unsafe exclusion bytes stay with the Blocker
      // boundary; they are never retirement diagnostics.
      continue;
    }
    try {
      const snapshot = await readSnapshot(
        target.git,
        target.allowMissingTarget,
        options.gitInspection,
      );
      const expected = new Set(target.current);
      if (expected.size > 0 && !parseOwnedSection(snapshot.bytes, target.git.excludeFile)) {
        warnings.push(`${target.git.excludeFile}${REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX}`);
        repairs.push({ class: "exclusion-section", entries: [...target.current], target: target.git.excludeFile });
      }
    } catch {
      // The blocker path owns malformed or unsafe exclusion diagnostics.
    }
  }
  return {
    repairs: repairs.sort((left, right) =>
      compareCanonicalStrings(safeRepairTargets(left)[0]!, safeRepairTargets(right)[0]!)),
    warnings: warnings.sort(compareCanonicalStrings),
  };
}

/** Backward-compatible warning-only view for callers that do not need repair metadata. */
export async function gitExclusionWarnings(
  state: OwnershipState,
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
  current: OwnershipState,
  next: OwnershipState,
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
