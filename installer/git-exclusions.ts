import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { compareCanonicalStrings } from "../schemas/canonical.js";
import type { OwnershipOutputReceipt, OwnershipState } from "../schemas/ownership-state.js";
import { identifierPart, type InlineContent } from "../adapters/project-plan.js";
import { assertRealDirectoryPath, findGitProject, gitExcludeEntry, type GitProject } from "./git.js";
import type { LifecycleGitInspection } from "./lifecycle-git-inspection.js";

/**
 * Repository Exclusion Contribution is derived, best-effort bookkeeping: a
 * cache rewritten from the active receipts' recorded output roots at write
 * time, never durable ownership evidence. It can never produce a Blocker; any
 * read, write, or derivation failure produces one warning and does not affect
 * the outcome of the installation.
 */

const BEGIN = "# BEGIN Agent Profile Kit generated paths";
const BEGIN_WITH_SEPARATOR = `${BEGIN} (separator owned)`;
const END = "# END Agent Profile Kit generated paths";
const SEPARATOR = "# Agent Profile Kit generated paths separator";

/** Canonical suffix for a missing-section warning surfaced by status. */
export const REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX =
  " is missing its Agent Profile Kit exclusion section; apply will restore recorded exact entries";

/** Canonical suffix for a drifted-section warning surfaced by status. */
export const REPOSITORY_EXCLUSION_MODIFIED_WARNING_SUFFIX =
  " Agent Profile Kit exclusion section does not match the generated entries; apply will rewrite it";

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

function newlineFor(source: Buffer, section?: OwnedSection): Buffer {
  if (section?.begin.newline.length) return section.begin.newline;
  const existing = [...lines(source)].reverse().find((line) => line.newline.length > 0)?.newline;
  return existing ?? Buffer.from("\n");
}

/** Pure byte-oriented reconciliation used by filesystem code and table tests. */
export function reconcileGitExcludeBytes(
  source: Buffer,
  path: string,
  nextEntries: readonly string[],
): Buffer {
  const section = parseOwnedSection(source, path);
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
export async function readGitExcludeSnapshot(git: GitProject): Promise<GitExcludeSnapshot> {
  await assertSafeExcludePath(git);
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

/** The derived exclusion entries one installation publishes for its outputs. */
export function derivedExclusionEntries(
  git: Pick<GitProject, "relativeProject">,
  outputs: readonly OwnershipOutputReceipt[],
): readonly string[] {
  return [...new Set(outputs.map((output) => gitExcludeEntry(git, output.path)))]
    .sort(compareCanonicalStrings);
}

export interface DerivedExclusionTarget {
  readonly git: GitProject;
  readonly target: string;
  /** Canonical union of every contributing receipt's derived entries. */
  readonly entries: readonly string[];
  readonly projects: readonly string[];
}

export interface RepositoryExclusionChange {
  readonly current: readonly string[];
  readonly next: readonly string[];
  readonly target: string;
  /** True when a contributing receipt existed before the operation under way. */
  readonly installed: boolean;
}

export interface RepositoryExclusionWarning {
  readonly message: string;
  readonly parts: readonly InlineContent[];
  /** The one Project whose derivation failed, when known. */
  readonly project?: string;
  /** Every target the warning's condition covers. */
  readonly targets: readonly string[];
}

export interface RepositoryExclusionInspection {
  readonly changes: readonly RepositoryExclusionChange[];
  readonly warnings: readonly RepositoryExclusionWarning[];
  /** Every derived target and the Projects whose receipts contribute to it. */
  readonly targetProjects: ReadonlyMap<string, readonly string[]>;
}

interface DerivedTarget {
  readonly git: GitProject;
  readonly projects: Set<string>;
  readonly entries: Set<string>;
  installed: boolean;
}

/**
 * Derive every target's canonical entry union from the receipts of `states`.
 * `markerStates` contribute targets (so a removed receipt's target still gets
 * cleaned up) but never entries. Scope never shrinks the union: sibling
 * Projects sharing one repository-local exclude file always keep their
 * contributions. Callers select which targets to inspect or publish; the
 * union itself is global.
 */
async function deriveTargetUnions(
  states: readonly OwnershipState[],
  options: {
    readonly gitInspection?: LifecycleGitInspection;
    readonly markerStates?: readonly OwnershipState[];
    /** Projects whose receipts count as installed for change classification. */
    readonly installedProjects?: ReadonlySet<string>;
    /**
     * Projects in lifecycle scope. Every receipt still contributes entries so
     * shared targets keep their siblings' union, but out-of-scope receipts
     * never emit derivation warnings: a scoped run stays silent about
     * unrelated Projects.
     */
    readonly includedProjects?: ReadonlySet<string>;
  },
): Promise<{
  readonly targets: Map<string, DerivedTarget>;
  readonly warnings: RepositoryExclusionWarning[];
}> {
  const resolveGit = options.gitInspection?.findGitProject;
  const targets = new Map<string, DerivedTarget>();
  const warnings: RepositoryExclusionWarning[] = [];
  const resolve = async (project: string): Promise<GitProject | undefined> => {
    try {
      return resolveGit === undefined
        ? await findGitProject(project)
        : await resolveGit(project);
    } catch (error) {
      if (
        options.includedProjects === undefined ||
        options.includedProjects.has(project)
      ) {
        const detail = error instanceof Error ? error.message : String(error);
        warnings.push({
          message: `Git exclusion entries for ${project} could not be derived: ${detail}`,
          parts: ["Git exclusion entries for ", identifierPart(project), ` could not be derived: ${detail}`],
          project,
          targets: [],
        });
      }
      return undefined;
    }
  };
  const record = async (state: OwnershipState, contributes: boolean): Promise<void> => {
    // Temporary receipts publish exclusion contributions too; retired receipts
    // keep theirs recorded only as a marker, never as entries.
    for (const receipt of state.receipts) {
      const git = await resolve(receipt.project);
      if (git === undefined) continue;
      const existing = targets.get(git.excludeFile);
      const entries = derivedExclusionEntries(git, receipt.outputs);
      const installed = options.installedProjects?.has(receipt.project) === true;
      if (existing) {
        existing.projects.add(receipt.project);
        if (contributes) for (const entry of entries) existing.entries.add(entry);
        if (installed) existing.installed = true;
        continue;
      }
      targets.set(git.excludeFile, {
        entries: new Set(contributes ? entries : []),
        git,
        installed,
        projects: new Set([receipt.project]),
      });
    }
  };
  for (const state of states) await record(state, true);
  for (const state of options.markerStates ?? []) await record(state, false);
  return { targets, warnings };
}

function sortedEntries(entries: ReadonlySet<string>): readonly string[] {
  return [...entries].sort(compareCanonicalStrings);
}

/**
 * Read-only inspection of every derived exclusion target: compare each live
 * owned section with the union the current receipts derive. Never blocks; any
 * read or parse failure becomes one warning. Used by status and apply
 * preflight to report pending exclusion bookkeeping.
 */
export async function inspectRepositoryExclusions(
  state: OwnershipState,
  options: {
    readonly gitInspection?: LifecycleGitInspection;
    readonly includedProjects?: ReadonlySet<string>;
    readonly installedProjects?: ReadonlySet<string>;
    /** Receipts present before the operation; their targets stay inspectable. */
    readonly markerState?: OwnershipState;
  } = {},
): Promise<RepositoryExclusionInspection> {
  const readSnapshot = options.gitInspection?.readExcludeSnapshot;
  const derivation = await deriveTargetUnions([state], {
    ...options,
    ...(options.markerState === undefined ? {} : { markerStates: [options.markerState] }),
  });
  const changes: RepositoryExclusionChange[] = [];
  const warnings = [...derivation.warnings];
  for (const [target, derived] of [...derivation.targets.entries()].sort(([left], [right]) =>
    compareCanonicalStrings(left, right)
  )) {
    if (
      options.includedProjects !== undefined &&
      ![...derived.projects].some((project) => options.includedProjects!.has(project))
    ) {
      continue;
    }
    const git = derived.git;
    try {
      const snapshot = readSnapshot === undefined
        ? await readGitExcludeSnapshot(git)
        : await readSnapshot(git);
      const section = parseOwnedSection(snapshot.bytes, target);
      const next = sortedEntries(derived.entries);
      if (section === undefined) {
        if (next.length > 0) {
          changes.push({ current: [], installed: derived.installed, next, target });
          if (derived.installed) {
            warnings.push({
              message: `${target}${REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX}`,
              parts: [identifierPart(target), REPOSITORY_EXCLUSION_REPAIR_WARNING_SUFFIX],
              targets: [target],
            });
          }
        }
        continue;
      }
      const current = sectionEntries(snapshot.bytes, section);
      if (current.length !== next.length || current.some((entry, index) => entry !== next[index])) {
        changes.push({
          current: [...current].sort(compareCanonicalStrings),
          installed: derived.installed,
          next,
          target,
        });
        if (derived.installed) {
          warnings.push({
            message: `${target}${REPOSITORY_EXCLUSION_MODIFIED_WARNING_SUFFIX}`,
            parts: [identifierPart(target), REPOSITORY_EXCLUSION_MODIFIED_WARNING_SUFFIX],
            targets: [target],
          });
        }
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push({
        message: `Git exclusion bookkeeping at ${target} was skipped: ${detail}`,
        parts: ["Git exclusion bookkeeping at ", identifierPart(target), ` was skipped: ${detail}`],
        targets: [target],
      });
    }
  }
  const targetProjects = new Map<string, readonly string[]>(
    [...derivation.targets.entries()]
      .filter(([target]) =>
        options.includedProjects === undefined ||
        [...derivation.targets.get(target)!.projects].some((project) =>
          options.includedProjects!.has(project)
        ))
      .map(([target, derived]) => [target, [...derived.projects].sort(compareCanonicalStrings)]),
  );
  return { changes, warnings, targetProjects };
}

export interface ExclusionPublication {
  readonly changes: readonly RepositoryExclusionChange[];
  readonly warnings: readonly RepositoryExclusionWarning[];
  /** Every published target and the Projects whose receipts contribute to it. */
  readonly targetProjects: ReadonlyMap<string, readonly string[]>;
}

async function writeExcludeFile(
  git: GitProject,
  source: Buffer,
  mode: number,
  snapshot: GitExcludeSnapshot,
): Promise<void> {
  const { infoExists } = await assertSafeExcludePath(git);
  const info = dirname(git.excludeFile);
  if (!infoExists) await mkdir(info);
  const temporary = join(info, `.exclude-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await writeFile(temporary, source, { flag: "wx", mode });
    await chmod(temporary, mode);
    // Compare-before-swap: revalidate safety and re-read the live target
    // immediately before the rename. Concurrent edits to unrelated bytes are
    // never overwritten — the publication is skipped and surfaces as the
    // caller's best-effort warning instead.
    const current = await readGitExcludeSnapshot(git);
    if (
      current.exists !== snapshot.exists ||
      current.mode !== snapshot.mode ||
      !current.bytes.equals(snapshot.bytes)
    ) {
      throw new Error(
        `${git.excludeFile} changed during exclusion publication; skipping to preserve unrelated bytes`,
      );
    }
    await rename(temporary, git.excludeFile);
  } catch (error) {
    if (!infoExists) await rmdir(info).catch(() => undefined);
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Best-effort publication: rewrite every derived target's owned section from
 * the receipts' recorded output roots, preserving unrelated bytes. Each target
 * is independent; a read, parse, or write failure produces one warning for
 * that target and never affects the outcome of the installation. Absent
 * targets are created when the derived union is nonempty and left absent
 * otherwise.
 */
export async function publishRepositoryExclusions(
  state: OwnershipState,
  options: {
    readonly gitInspection?: LifecycleGitInspection;
    readonly includedProjects?: ReadonlySet<string>;
    readonly previousState?: OwnershipState;
    /** Test-only seam: runs after the snapshot read, before the write. */
    readonly beforeWrite?: (target: string) => Promise<void>;
  } = {},
): Promise<ExclusionPublication> {
  const derivation = await deriveTargetUnions([state], {
    ...options,
    ...(options.previousState === undefined ? {} : { markerStates: [options.previousState] }),
  });
  const changes: RepositoryExclusionChange[] = [];
  const warnings = [...derivation.warnings];
  for (const [target, derived] of [...derivation.targets.entries()].sort(([left], [right]) =>
    compareCanonicalStrings(left, right)
  )) {
    if (
      options.includedProjects !== undefined &&
      ![...derived.projects].some((project) => options.includedProjects!.has(project))
    ) {
      continue;
    }
    const git = derived.git;
    try {
      const snapshot = await readGitExcludeSnapshot(git);
      const updated = reconcileGitExcludeBytes(snapshot.bytes, target, sortedEntries(derived.entries));
      if (updated.equals(snapshot.bytes)) continue;
      const section = parseOwnedSection(snapshot.bytes, target);
      const current = section === undefined
        ? []
        : [...sectionEntries(snapshot.bytes, section)].sort(compareCanonicalStrings);
      await options.beforeWrite?.(target);
      await writeExcludeFile(git, updated, snapshot.exists ? snapshot.mode : 0o644, snapshot);
      changes.push({ current, installed: derived.installed, next: sortedEntries(derived.entries), target });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      warnings.push({
        message: `Git exclusion update at ${target} failed: ${detail}`,
        parts: ["Git exclusion update at ", identifierPart(target), ` failed: ${detail}`],
        targets: [target],
      });
    }
  }
  const targetProjects = new Map<string, readonly string[]>(
    [...derivation.targets.entries()]
      .filter(([target]) =>
        options.includedProjects === undefined ||
        [...derivation.targets.get(target)!.projects].some((project) =>
          options.includedProjects!.has(project)
        ))
      .map(([target, derived]) => [target, [...derived.projects].sort(compareCanonicalStrings)]),
  );
  return { changes, warnings, targetProjects };
}

/** Best-effort derived contribution of one installation, for teardown reporting. */
export async function receiptExclusionContribution(
  project: string,
  outputs: readonly OwnershipOutputReceipt[],
  options: { readonly gitInspection?: LifecycleGitInspection } = {},
): Promise<{ readonly entries: readonly string[]; readonly target: string } | undefined> {
  const resolveGit = options.gitInspection?.findGitProject;
  let git: GitProject | undefined;
  try {
    git = resolveGit === undefined
      ? await findGitProject(project)
      : await resolveGit(project);
  } catch {
    return undefined;
  }
  if (git === undefined) return undefined;
  return { entries: derivedExclusionEntries(git, outputs), target: git.excludeFile };
}
