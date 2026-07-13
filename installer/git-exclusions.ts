import { chmod, lstat, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { InstallationState } from "../schemas/installation-manifest.js";
import { assertRealDirectoryPath, findGitProject, gitExcludeEntry, type GitProject } from "./git.js";
import { readMarker } from "./installation-state.js";
import type { DesiredInstallation } from "./project-plan.js";

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
  const canonical = [...new Set(expected)].sort();
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
  const entries = [...new Set(nextEntries)].sort();
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

interface ExcludeSnapshot {
  readonly bytes: Buffer;
  readonly exists: boolean;
  readonly mode: number;
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

async function readSnapshot(git: GitProject): Promise<ExcludeSnapshot> {
  await assertSafeExcludePath(git);
  try {
    const stats = await lstat(git.excludeFile);
    return {
      bytes: await readFile(git.excludeFile),
      exists: true,
      mode: stats.mode & 0o7777,
    };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { bytes: Buffer.alloc(0), exists: false, mode: 0o644 };
    throw error;
  }
}

interface Target {
  readonly current: readonly string[];
  readonly git: GitProject;
  readonly next: readonly string[];
}

function slashPath(path: string): string {
  return path.split(sep).join("/");
}

async function gitForRecordedInstallation(
  project: string,
  fallback: GitProject | undefined,
): Promise<GitProject | undefined> {
  try {
    await lstat(project);
    return await findGitProject(project) ?? fallback;
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
  let ancestor = dirname(project);
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return fallback;
    ancestor = parent;
  }
  const priorGit = await findGitProject(ancestor);
  if (priorGit) {
    const oldRelative = slashPath(relative(priorGit.root, project));
    if (oldRelative !== ".." && !oldRelative.startsWith("../")) {
      return { ...priorGit, relativeProject: oldRelative };
    }
  }
  return fallback;
}

async function entriesByExclude(
  state: InstallationState,
  fallbackByInstallationId: ReadonlyMap<string, GitProject> = new Map(),
): Promise<Map<string, { git: GitProject; entries: string[] }>> {
  const targets = new Map<string, { git: GitProject; entries: string[] }>();
  for (const installation of state.installations) {
    const git = await gitForRecordedInstallation(
      installation.project,
      fallbackByInstallationId.get(installation.installationId),
    );
    if (!git) continue;
    const target = targets.get(git.excludeFile) ?? { git, entries: [] };
    for (const output of installation.outputs) target.entries.push(gitExcludeEntry(git, output.path));
    targets.set(git.excludeFile, target);
  }
  return targets;
}

async function targetsFor(current: InstallationState, next: InstallationState): Promise<readonly Target[]> {
  const nextTargets = await entriesByExclude(next);
  const nextGitByInstallationId = new Map<string, GitProject>();
  for (const installation of next.installations) {
    const git = await gitForRecordedInstallation(installation.project, undefined);
    if (git) nextGitByInstallationId.set(installation.installationId, git);
  }
  const currentTargets = await entriesByExclude(current, nextGitByInstallationId);
  return [...new Set([...currentTargets.keys(), ...nextTargets.keys()])].sort().map((path) => ({
    current: currentTargets.get(path)?.entries ?? [],
    git: nextTargets.get(path)?.git ?? currentTargets.get(path)!.git,
    next: nextTargets.get(path)?.entries ?? [],
  }));
}

export async function gitExclusionBlockers(
  state: InstallationState,
  desired: readonly DesiredInstallation[] = [],
): Promise<readonly string[]> {
  const blockers: string[] = [];
  const targets = [...await targetsFor(state, state)];
  const known = new Set(targets.map((target) => target.git.excludeFile));
  for (const installation of desired) {
    const git = installation.gitProject;
    if (!git) continue;
    if (known.has(git.excludeFile)) continue;
    known.add(git.excludeFile);
    const marker = await readMarker(installation.binding.canonicalProject).catch(() => undefined);
    const owner = marker
      ? state.installations.find((candidate) => candidate.installationId === marker.installationId)
      : undefined;
    const current = owner?.outputs.map((output) => gitExcludeEntry(git, output.path)) ?? [];
    targets.push({ current, git, next: current });
  }
  for (const target of targets) {
    try {
      const snapshot = await readSnapshot(target.git);
      reconcileGitExcludeBytes(snapshot.bytes, target.git.excludeFile, target.current, target.current);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }
  return blockers.sort();
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
): Promise<GitExclusionTransaction> {
  const originals = new Map<string, { createdInfo: boolean; git: GitProject; snapshot: ExcludeSnapshot }>();
  const rollbackChanges = async (): Promise<void> => {
    for (const { createdInfo, git, snapshot } of [...originals.values()].reverse()) {
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
  try {
    for (const target of await targetsFor(current, next)) {
      const snapshot = await readSnapshot(target.git);
      const updated = reconcileGitExcludeBytes(
        snapshot.bytes,
        target.git.excludeFile,
        target.current,
        target.next,
      );
      if (updated.equals(snapshot.bytes)) continue;
      const createdInfo = await replace(target.git, updated, snapshot.mode);
      originals.set(target.git.excludeFile, { createdInfo, git: target.git, snapshot });
    }
  } catch (error) {
    await rollbackChanges().catch(() => undefined);
    throw error;
  }
  let settled = false;
  return {
    commit: async () => { settled = true; },
    rollback: async () => {
      if (settled) return;
      settled = true;
      await rollbackChanges();
    },
  };
}
