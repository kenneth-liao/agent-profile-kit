import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  UNSUPERVISED_CANDIDATE_DEADLINE_MS,
  validateSuppliedPackageCandidate,
  type PackageIdentityRecord,
} from "../test/support/package-identity.js";
import { packageArchiveRepositoryRoot } from "../test/support/package-archive.js";
import { QUALIFICATION_RECORD_SCHEMA } from "../test/support/suite-supervisor.js";

/**
 * The publication boundary for the private release path (#550): the release
 * workflow verifies, immediately before creating the release, that the
 * candidate it is about to publish is exactly the artifact whose required
 * qualification succeeded. This module never publishes, rebuilds, or repacks
 * — it reads retained evidence and fails closed. Rejection reasons:
 *
 * - missing/malformed candidate record, substituted archive bytes, or a
 *   checkout whose source no longer matches the record (`InvalidProvenanceError`,
 *   one taxonomy home in `test/support/package-identity.ts`);
 * - the candidate revision is not the expected release revision
 *   (`wrong-revision`);
 * - the retained qualification record is missing, malformed, or incomplete
 *   (`missing-qualification`, `malformed-qualification`,
 *   `incomplete-qualification`);
 * - the qualification evidence binds a different artifact digest or a
 *   different source identity than the candidate's record
 *   (`qualified-artifact-mismatch`, `qualified-source-mismatch`).
 */

/** The retained qualification record failed one of its admission checks. */
export class ReleaseCandidateVerificationError extends Error {
  readonly reason:
    | "wrong-revision"
    | "missing-qualification"
    | "malformed-qualification"
    | "incomplete-qualification"
    | "qualified-artifact-mismatch"
    | "qualified-source-mismatch";

  constructor(
    reason: ReleaseCandidateVerificationError["reason"],
    message: string,
  ) {
    super(message);
    this.name = "ReleaseCandidateVerificationError";
    this.reason = reason;
  }
}

/**
 * The capture budget for the verification fingerprint re-capture: one
 * bounded read of the consuming checkout's relevant source, the same shape
 * the creator's own stages use. It bounds a hung Git child; it is not a
 * completion target.
 */
const RELEASE_VERIFICATION_DEADLINE_MS = UNSUPERVISED_CANDIDATE_DEADLINE_MS;

export interface ReleaseCandidateEvidence {
  readonly archivePath: string;
  readonly archiveDigest: string;
  readonly record: PackageIdentityRecord;
}

/**
 * Verify one release candidate against its retained evidence. The candidate
 * record must be present and well-formed, the actual archive bytes must
 * match the recorded digest, the consuming checkout's relevant source must
 * still match the record's fingerprint, the candidate revision must be the
 * expected release revision, and the retained qualification record must be
 * complete and bind the same artifact digest and source identity.
 */
export async function verifyReleaseCandidate(options: {
  readonly archivePath: string;
  readonly repositoryRoot: string;
  readonly expectedRevision: string;
  readonly qualificationRecordPath: string;
}): Promise<ReleaseCandidateEvidence> {
  const validation = await validateSuppliedPackageCandidate(options.archivePath, {
    repositoryRoot: options.repositoryRoot,
    deadlineMs: RELEASE_VERIFICATION_DEADLINE_MS,
    signal: undefined,
  });
  const record = validation.record;
  if (record.repositoryHead !== options.expectedRevision) {
    throw new ReleaseCandidateVerificationError(
      "wrong-revision",
      `the candidate's record binds repository head ${record.repositoryHead}, but the release revision is ${options.expectedRevision}; the candidate was not created from the revision being released`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(options.qualificationRecordPath, "utf8");
  } catch (error) {
    throw new ReleaseCandidateVerificationError(
      "missing-qualification",
      `no readable qualification record at '${options.qualificationRecordPath}' (${error instanceof Error ? error.message : String(error)}); a release publishes only after a complete qualification of the exact candidate`,
    );
  }
  let qualification: unknown;
  try {
    qualification = JSON.parse(raw);
  } catch (error) {
    throw new ReleaseCandidateVerificationError(
      "malformed-qualification",
      `the qualification record at '${options.qualificationRecordPath}' is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (
    typeof qualification !== "object" || qualification === null ||
    (qualification as { schema?: unknown }).schema !== QUALIFICATION_RECORD_SCHEMA
  ) {
    throw new ReleaseCandidateVerificationError(
      "malformed-qualification",
      `the qualification record at '${options.qualificationRecordPath}' does not match schema ${QUALIFICATION_RECORD_SCHEMA}`,
    );
  }
  const facts = qualification as {
    mode?: unknown;
    status?: unknown;
    ok?: unknown;
    source?: { kind?: unknown; sourceFingerprint?: unknown; repositoryHead?: unknown };
    artifact?: { archiveDigest?: unknown };
  };
  if (facts.ok !== true || facts.status !== "complete" || facts.mode !== "full") {
    throw new ReleaseCandidateVerificationError(
      "incomplete-qualification",
      `the qualification record reports mode '${String(facts.mode)}' with status '${String(facts.status)}' (ok: ${String(facts.ok)}); a release publishes only a complete full-suite qualification`,
    );
  }
  if (facts.artifact?.archiveDigest !== record.archiveDigest) {
    throw new ReleaseCandidateVerificationError(
      "qualified-artifact-mismatch",
      `the qualification record binds artifact digest ${String(facts.artifact?.archiveDigest)}, but the candidate's digest is ${record.archiveDigest}; the qualified package is not this candidate`,
    );
  }
  if (
    facts.source?.kind !== "candidate-record" ||
    facts.source.sourceFingerprint !== record.sourceFingerprint ||
    facts.source.repositoryHead !== record.repositoryHead
  ) {
    throw new ReleaseCandidateVerificationError(
      "qualified-source-mismatch",
      `the qualification record's source identity (${facts.source?.kind ?? "missing"}) does not bind the candidate's source fingerprint and head; the qualified source is not this candidate's`,
    );
  }

  return {
    archivePath: options.archivePath,
    // The validated digest: validateSuppliedPackageCandidate read the actual
    // archive bytes at this boundary and matched them to the record, so this
    // is the digest of the bytes that were verified, not a carried value.
    archiveDigest: record.archiveDigest,
    record,
  };
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [archivePath, expectedRevision, qualificationRecordPath] = process.argv.slice(2);
  if (!archivePath || !expectedRevision || !qualificationRecordPath) {
    throw new Error(
      "usage: bun run scripts/verify-release-candidate.ts <archive-path> <expected-revision> <qualification-record-path>",
    );
  }
  try {
    const evidence = await verifyReleaseCandidate({
      archivePath: resolve(archivePath),
      repositoryRoot: packageArchiveRepositoryRoot(),
      expectedRevision,
      qualificationRecordPath: resolve(qualificationRecordPath),
    });
    console.log(`verified ${evidence.archivePath} (${evidence.archiveDigest}) at ${expectedRevision}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
