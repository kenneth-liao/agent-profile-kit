import { createHash, type Hash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { runProcess } from "../../process/process-executor.js";
import type {
  PackageArchiveCommands,
  PackageStageContext,
} from "./package-archive.js";

/**
 * One canonical home for the source/artifact identity contract of prepared
 * and supplied package candidates (#538): the source fingerprint hashes the
 * actual worktree bytes of every relevant source path — tracked files exactly
 * as the build consumes them (worktree content, never an index shortcut),
 * plus untracked non-ignored files — with each entry's worktree mode, derived
 * from Git at capture time. No maintained file catalogue exists: membership
 * comes from `git ls-files` in the same repository, parsed NUL-safely, so
 * paths containing spaces, quotes, unicode, or newlines fold deterministically.
 *
 * Supported source scope (fail closed): regular files only. A source symlink
 * (whose referent is external material) and a submodule (whose checkout state
 * is not captured here) are rejected as unsupported rather than silently
 * fingerprinted as if their consumed content were proven. Ignored paths are
 * outside the fingerprint by definition; the build-output boundary is
 * controlled by the candidate creator, which freshly replaces `dist/` before
 * packing, and the record's packed-file guard rejects packed inputs outside
 * the fingerprinted membership.
 */

/** One bounded capture context: deadlineMs bounds every Git child it spawns. */
export interface SourceCaptureContext {
  readonly repositoryRoot: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal | undefined;
}

/**
 * The content fingerprint of the relevant source at one capture: the folded
 * digest over every relevant path's actual worktree bytes, mode, and
 * membership origin (deletions included), plus the repository HEAD for
 * provenance. `entryCount` names how many paths contributed.
 */
export interface SourceFingerprint {
  readonly repositoryHead: string | null;
  readonly digest: string;
  /** Relevant paths present in the worktree (tracked or untracked non-ignored). */
  readonly relevantPaths: ReadonlySet<string>;
  readonly entryCount: number;
}

/** Source material the identity contract does not support; never silent. */
export class UnsupportedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedSourceError";
  }
}

/** The relevant source changed during preparation: the candidate is disqualified. */
export class UnstableSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnstableSourceError";
  }
}

/** Provenance for a supplied candidate is missing, malformed, or mismatched. */
export class InvalidProvenanceError extends Error {
  readonly reason: "missing" | "malformed" | "digest-mismatch" | "source-mismatch";

  constructor(reason: InvalidProvenanceError["reason"], message: string) {
    super(message);
    this.name = "InvalidProvenanceError";
    this.reason = reason;
  }
}

/**
 * One abort reader for every stage boundary: TS control-flow narrowing does
 * not invalidate across awaits, so each check reads the live signal rather
 * than a value narrowed by an earlier check.
 */
function preparationAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function assertAbsolute(root: string): void {
  if (!isAbsolute(root)) {
    throw new Error(`the source repository root must be an absolute path, got '${root}'`);
  }
}

async function gitChild(
  arguments_: readonly string[],
  context: SourceCaptureContext,
): Promise<string> {
  const result = await runProcess(
    {
      executable: "git",
      arguments_: ["-C", context.repositoryRoot, ...arguments_],
      deadlineMs: context.deadlineMs,
      commandLabel: `git ${arguments_.slice(0, 2).join(" ")}`,
    },
    context.signal,
  );
  if (!(result.kind === "exit" && result.exitCode === 0)) {
    throw new Error(
      `git ${arguments_.join(" ")} in ${context.repositoryRoot} failed: ${result.kind} exit=${result.exitCode} ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Parse one NUL-terminated index listing (`git ls-files -s -z`): entries are
 * `<mode> <object> <stage>\t<path>\0`, unquoted. Returns each path with its
 * index mode so submodule gitlinks (mode 160000) are detectable.
 */
function parseIndexEntries(indexListing: string): readonly { readonly path: string; readonly indexMode: string }[] {
  return indexListing
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const separator = entry.indexOf("\t");
      if (separator < 0) {
        throw new Error(`malformed git ls-files entry: ${JSON.stringify(entry)}`);
      }
      const header = entry.slice(0, separator);
      const path = entry.slice(separator + 1);
      const parts = header.split(" ");
      if (parts.length !== 3 || parts[2] !== "0") {
        throw new Error(`malformed git ls-files header: ${JSON.stringify(entry)}`);
      }
      return { path, indexMode: parts[0]! };
    });
}

/** Parse one NUL-terminated untracked listing (`git ls-files --others -z`). */
function parseUntrackedPaths(othersListing: string): readonly string[] {
  return othersListing.split("\0").filter((entry) => entry.length > 0);
}

function foldEntry(hash: Hash, fields: readonly string[]): void {
  hash.update(fields.join("\0"));
  hash.update("\0");
}

/** One worktree file's contributing entry: worktree mode plus content digest. */
function worktreeEntry(
  hash: Hash,
  absolutePath: string,
  relativePath: string,
  origin: "tracked" | "untracked",
): void {
  const stats = lstatSync(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new UnsupportedSourceError(
      `the source path '${relativePath}' is a symlink; source symlinks are unsupported because their referent is external material the fingerprint cannot prove`,
    );
  }
  if (!stats.isFile()) {
    throw new UnsupportedSourceError(
      `the source path '${relativePath}' is neither a regular file nor absent; the identity contract supports regular files only`,
    );
  }
  const contentDigest = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
  hash.update(
    [
      (stats.mode & 0o7777).toString(8),
      relativePath,
      origin,
      contentDigest,
    ].join("\0") + "\0",
  );
}

/** One path recorded as consumed in its deleted state. */
function deletionEntry(hash: Hash, relativePath: string): void {
  hash.update(["deleted", relativePath].join("\0") + "\0");
}

/**
 * Capture the source fingerprint: actual worktree bytes for every tracked
 * path and every untracked non-ignored path, with worktree modes, deletion
 * markers for tracked paths absent from the worktree, and NUL-safe parsing.
 * The index is used for tracked membership and submodule detection only —
 * the fingerprint itself is worktree content, because the build consumes
 * worktree bytes, and staged content must not mask them.
 */
export async function captureSourceFingerprint(context: SourceCaptureContext): Promise<SourceFingerprint> {
  assertAbsolute(context.repositoryRoot);
  const [headOutput, indexListing, othersListing] = await Promise.all([
    gitChild(["rev-parse", "HEAD"], context).catch(() => ""),
    gitChild(["ls-files", "-s", "-z"], context),
    gitChild(["ls-files", "--others", "--exclude-standard", "-z"], context),
  ]);

  const indexEntries = parseIndexEntries(indexListing);
  const untrackedPaths = parseUntrackedPaths(othersListing);
  for (const entry of indexEntries) {
    if (entry.indexMode === "160000") {
      throw new UnsupportedSourceError(
        `the source path '${entry.path}' is a submodule; submodule checkout state is not captured, so it is unsupported source material`,
      );
    }
  }

  const hash = createHash("sha256");
  let entryCount = 0;
  for (const entry of indexEntries) {
    const absolutePath = `${context.repositoryRoot}/${entry.path}`;
    let stats;
    try {
      stats = lstatSync(absolutePath);
    } catch {
      stats = undefined;
    }
    if (stats === undefined) {
      deletionEntry(hash, entry.path);
    } else {
      worktreeEntry(hash, absolutePath, entry.path, "tracked");
      entryCount += 1;
    }
  }
  for (const path of untrackedPaths) {
    worktreeEntry(hash, `${context.repositoryRoot}/${path}`, path, "untracked");
    entryCount += 1;
  }

  return {
    repositoryHead: headOutput.length > 0 ? headOutput.trim() : null,
    digest: hash.digest("hex"),
    relevantPaths: new Set([
      ...indexEntries.filter((entry) => existsInWorktree(`${context.repositoryRoot}/${entry.path}`)).map((entry) => entry.path),
      ...untrackedPaths,
    ]),
    entryCount,
  };
}

function existsInWorktree(absolutePath: string): boolean {
  try {
    lstatSync(absolutePath);
    return true;
  } catch {
    return false;
  }
}
/**
 * The record schema version; a reader that meets another schema rejects the
 * record as malformed instead of guessing its meaning.
 */
export const PACKAGE_IDENTITY_SCHEMA = 1;

/**
 * One identity record, created once at the actual candidate-creation boundary
 * by `createPackageCandidate` — the same creator, file shape, and reader for
 * prepared and supplied candidates. The archive digest binds the exact packed
 * bytes; the source fingerprint binds the relevant worktree bytes at capture.
 */
export interface PackageIdentityRecord {
  readonly schema: number;
  readonly repositoryHead: string | null;
  readonly sourceFingerprint: string;
  readonly archiveDigest: string;
}

/** The record travels beside the archive it describes, at this one convention. */
export function packageIdentityRecordPath(archivePath: string): string {
  return `${archivePath}.provenance.json`;
}

const IDENTITY_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Read one identity record beside its archive. A missing or malformed record
 * fails closed: no consumer may treat an unrecorded archive as qualified.
 */
export function readPackageIdentityRecord(archivePath: string): PackageIdentityRecord {
  let raw: string;
  try {
    raw = readFileSync(packageIdentityRecordPath(archivePath), "utf8");
  } catch {
    throw new InvalidProvenanceError(
      "missing",
      `no package identity record beside '${archivePath}' (${packageIdentityRecordPath(archivePath)}); a package candidate qualifies only the source identity its record demonstrably represents`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidProvenanceError("malformed", `the package identity record beside '${archivePath}' is not valid JSON`);
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    (parsed as PackageIdentityRecord).schema !== PACKAGE_IDENTITY_SCHEMA ||
    typeof (parsed as PackageIdentityRecord).sourceFingerprint !== "string" ||
    typeof (parsed as PackageIdentityRecord).archiveDigest !== "string" ||
    !IDENTITY_DIGEST_PATTERN.test((parsed as PackageIdentityRecord).sourceFingerprint) ||
    !IDENTITY_DIGEST_PATTERN.test((parsed as PackageIdentityRecord).archiveDigest) ||
    ((parsed as PackageIdentityRecord).repositoryHead !== null &&
      typeof (parsed as PackageIdentityRecord).repositoryHead !== "string")
  ) {
    throw new InvalidProvenanceError("malformed", `the package identity record beside '${archivePath}' does not match the record schema`);
  }
  return parsed as PackageIdentityRecord;
}

/** The sha256 digest of an archive's exact bytes. */
export function digestArchiveBytes(archivePath: string): string {
  return createHash("sha256").update(readFileSync(archivePath)).digest("hex");
}

/** Provenance validation context: the consuming repository and bounded budgets. */
export interface ProvenanceValidationContext {
  readonly repositoryRoot: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal | undefined;
}

/**
 * Validate one supplied candidate's provenance against the consuming checkout:
 * the record must exist and be well-formed, the archive's actual bytes must
 * match the record's digest (substituted or stale-artifact rejection), and the
 * consuming checkout's freshly captured source fingerprint must match the
 * record's (stale or mismatched source rejection). The archive bytes are never
 * rewritten; ownership stays external.
 */
export async function validateSuppliedPackageCandidate(
  archivePath: string,
  context: ProvenanceValidationContext,
): Promise<PackageIdentityRecord> {
  const record = readPackageIdentityRecord(archivePath);
  const actualDigest = digestArchiveBytes(archivePath);
  if (actualDigest !== record.archiveDigest) {
    throw new InvalidProvenanceError(
      "digest-mismatch",
      `the supplied archive's actual bytes (${actualDigest}) do not match its record's artifact digest (${record.archiveDigest}); the archive was substituted or replaced after its record was written`,
    );
  }
  const current = await captureSourceFingerprint(context);
  if (current.digest !== record.sourceFingerprint) {
    throw new InvalidProvenanceError(
      "source-mismatch",
      `the supplied archive's record describes source fingerprint ${record.sourceFingerprint}, but the consuming checkout's relevant source is now ${current.digest}; the provenance is stale or mismatched`,
    );
  }
  return record;
}

/** One creation stage's remaining budget context, shared across the sequence. */
interface CreationBudget {
  readonly startedAt: number;
  readonly deadlineMs: number;
}

function remainingMs(budget: CreationBudget): number {
  return budget.deadlineMs - (Date.now() - budget.startedAt);
}

function assertBudgetRemaining(budget: CreationBudget, stage: string): number {
  const remaining = remainingMs(budget);
  if (remaining <= 0) {
    throw new Error(
      `package candidate creation budget (${budget.deadlineMs}ms) exhausted before the ${stage} stage`,
    );
  }
  return remaining;
}

function stageContext(
  context: { readonly repositoryRoot: string; readonly signal: AbortSignal | undefined },
  budget: CreationBudget,
  stage: string,
): PackageStageContext {
  return {
    repositoryRoot: context.repositoryRoot,
    deadlineMs: assertBudgetRemaining(budget, stage),
    signal: context.signal,
  };
}

/** Bounded removal of one path through the shared executor; failures throw. */
export async function removePathBounded(
  path: string,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const result = await runProcess(
    {
      executable: "rm",
      arguments_: ["-rf", path],
      deadlineMs,
      commandLabel: "bounded path removal",
    },
    signal,
  );
  if (!(result.kind === "exit" && result.exitCode === 0)) {
    throw new Error(`bounded path removal of '${path}' failed: ${result.kind} exit=${result.exitCode} ${result.stderr}`);
  }
}

/** The archive's packed entry list, via one bounded `tar -t` child. */
async function packedArchiveEntries(archivePath: string, deadlineMs: number, signal: AbortSignal | undefined): Promise<readonly string[]> {
  const result = await runProcess(
    {
      executable: "tar",
      arguments_: ["-tzf", archivePath],
      deadlineMs,
      commandLabel: "packed archive listing",
    },
    signal,
  );
  if (!(result.kind === "exit" && result.exitCode === 0)) {
    throw new Error(`listing the packed archive failed: ${result.kind} exit=${result.exitCode} ${result.stderr}`);
  }
  return result.stdout
    .split("\n")
    .map((entry) => (entry.startsWith("./") ? entry.slice(2) : entry))
    // Only file entries carry content: directory entries (the bare package
    // root and intermediate directories) end with '/' or lack it entirely.
    .filter((entry) => entry.length > 0 && entry.includes("/") && !entry.endsWith("/"));
}

/**
 * The build-output boundary: the ignored directory the build stage owns and
 * the creator freshly replaces before packing. Packed inputs outside the
 * fingerprinted membership and this boundary are rejected, so an ignored
 * input that reaches the archive can never qualify silently.
 */
export const PACKAGE_BUILD_OUTPUT_DIRECTORY = "dist";

/**
 * Hang bound for candidate creation outside a canonical invocation (the
 * unsupervised fallback and the CI creation entry): pre-capture, build-output
 * replacement, build, pack, post-capture, digest, and the packed-input guard
 * share it. It bounds a hung child; it is not a completion target.
 */
export const UNSUPERVISED_CANDIDATE_DEADLINE_MS = 120_000;

/**
 * The one candidate creator, from source only. Capture the pre-fingerprint,
 * freshly replace the ignored build output, run the caller's bounded build and
 * pack stages, digest the packed bytes, re-capture the fingerprint (an unequal
 * post-capture means unstable source: no record is written and the candidate
 * is disqualified), guard every packed entry against the fingerprinted
 * membership plus the build-output boundary, then write the record atomically
 * beside the archive. There is no stamping API: nothing blesses an
 * externally given archive; every record is written here, from source.
 */
export interface CreatedPackageCandidate {
  readonly archivePath: string;
  readonly recordPath: string;
  readonly record: PackageIdentityRecord;
}

export async function createPackageCandidate(
  context: {
    readonly repositoryRoot: string;
    readonly destinationDirectory: string;
    readonly deadlineMs: number;
    readonly signal: AbortSignal | undefined;
    readonly commands: PackageArchiveCommands;
  },
): Promise<CreatedPackageCandidate> {
  assertAbsolute(context.repositoryRoot);
  const budget: CreationBudget = { startedAt: Date.now(), deadlineMs: context.deadlineMs };
  const pre = await captureSourceFingerprint({
    repositoryRoot: context.repositoryRoot,
    deadlineMs: assertBudgetRemaining(budget, "pre-capture"),
    signal: context.signal,
  });
  await removePathBounded(
    join(context.repositoryRoot, PACKAGE_BUILD_OUTPUT_DIRECTORY),
    assertBudgetRemaining(budget, "build-output replacement"),
    context.signal,
  );
  await context.commands.build(
    {
      repositoryRoot: context.repositoryRoot,
      deadlineMs: assertBudgetRemaining(budget, "build"),
      signal: context.signal,
    },
  );
  if (preparationAborted(context.signal)) {
    throw new Error("package candidate creation was interrupted during the build stage");
  }
  const filename = await context.commands.createScriptDisabledArchive(
    {
      repositoryRoot: context.repositoryRoot,
      deadlineMs: assertBudgetRemaining(budget, "pack"),
      signal: context.signal,
    },
    context.destinationDirectory,
  );
  if (preparationAborted(context.signal)) {
    throw new Error("package candidate creation was interrupted during the pack stage");
  }
  // The record travels beside the archive's canonical path, so a consumer
  // resolving the archive through realpath finds the same record.
  const archivePath = realpathSync(join(context.destinationDirectory, filename));
  const archiveDigest = digestArchiveBytes(archivePath);
  const post = await captureSourceFingerprint({
    repositoryRoot: context.repositoryRoot,
    deadlineMs: assertBudgetRemaining(budget, "post-capture"),
    signal: context.signal,
  });
  if (post.digest !== pre.digest) {
    throw new UnstableSourceError(
      `unstable source: the relevant source changed during package preparation (pre-capture ${pre.digest}, post-capture ${post.digest}); the candidate is disqualified`,
    );
  }
  // Guard the actual archive content: every packed file must be fingerprinted
  // membership or fresh build output, so an ignored input cannot enter the
  // candidate silently.
  const entries = await packedArchiveEntries(
    archivePath,
    assertBudgetRemaining(budget, "packed-input guard"),
    context.signal,
  );
  for (const entry of entries) {
    const separator = entry.indexOf("/");
    const relative = separator < 0 ? entry : entry.slice(separator + 1);
    if (
      relative.length === 0 ||
      !(post.relevantPaths.has(relative) || relative.startsWith(`${PACKAGE_BUILD_OUTPUT_DIRECTORY}/`))
    ) {
      throw new UnsupportedSourceError(
        `the packed input '${entry}' is outside the identity boundary (fingerprinted source membership plus the '${PACKAGE_BUILD_OUTPUT_DIRECTORY}' build output); the candidate is disqualified`,
      );
    }
  }
  const record: PackageIdentityRecord = {
    schema: PACKAGE_IDENTITY_SCHEMA,
    repositoryHead: post.repositoryHead,
    sourceFingerprint: post.digest,
    archiveDigest,
  };
  const recordPath = packageIdentityRecordPath(archivePath);
  // Atomic write: a consumer either sees no record or a complete one.
  const staged = `${recordPath}.publishing`;
  writeFileSync(staged, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(staged, recordPath);
  return { archivePath, recordPath, record };
}
