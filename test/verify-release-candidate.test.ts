import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../process/process-executor.js";
import { InvalidProvenanceError, createPackageCandidate } from "./support/package-identity.js";
import { QUALIFICATION_RECORD_SCHEMA } from "./support/suite-supervisor.js";
import {
  ReleaseCandidateVerificationError,
  verifyReleaseCandidate,
} from "../scripts/verify-release-candidate.js";

/**
 * Release-candidate verification proofs (#550, TEST-007): the publication
 * boundary admits only an archive whose record is present and well-formed,
 * whose actual bytes still match the recorded digest (substitution rejected),
 * whose source revision is the expected release revision, and whose retained
 * qualification record is complete and binds the same artifact digest and
 * source identity. Every path runs against non-publishing fixtures; nothing
 * here creates a release.
 */

const temporaryDirectories: string[] = [];
function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}
afterAll(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function gitRepository(prefix: string): string {
  const path = tempDir(prefix);
  execFileSync("git", ["-C", path, "init", "-q"]);
  execFileSync("git", ["-C", path, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(path, ".gitignore"), "dist/\n");
  writeFileSync(join(path, "package.json"), JSON.stringify({ name: "agent-profile-kit-verify-fixture", version: "0.0.0-verify" }));
  writeFileSync(join(path, "src.txt"), "source\n");
  execFileSync("git", ["-C", path, "add", "."]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
  return path;
}

const FIXTURE_ARCHIVE_BYTES = "FIXTURE-RELEASE-CANDIDATE-BYTES\n";

interface FixtureCandidate {
  readonly repositoryRoot: string;
  readonly destination: string;
  readonly archivePath: string;
  readonly record: ReturnType<typeof JSON.parse>;
  readonly head: string;
}

async function createFixtureCandidate(prefix: string): Promise<FixtureCandidate> {
  const repositoryRoot = gitRepository(prefix);
  const destination = tempDir(`${prefix}-dest-`);
  const staging = tempDir(`${prefix}-staging-`);
  mkdirSync(join(staging, "package", "dist"), { recursive: true });
  writeFileSync(join(staging, "package", "dist", "cli.js"), FIXTURE_ARCHIVE_BYTES);
  const created = await createPackageCandidate({
    repositoryRoot,
    destinationDirectory: destination,
    deadlineMs: 30_000,
    signal: undefined,
    commands: {
      build: async () => undefined,
      createScriptDisabledArchive: async (_stage, directory) => {
        const result = await runProcess({
          executable: "tar",
          arguments_: ["-czf", join(directory, "fixture.tgz"), "-C", staging, "package"],
          deadlineMs: 10_000,
          commandLabel: "fixture pack",
        });
        if (!(result.kind === "exit" && result.exitCode === 0)) {
          throw new Error(`fixture pack failed: ${result.kind}`);
        }
        return { filename: "fixture.tgz", files: ["dist/cli.js"] };
      },
    },
  });
  return {
    repositoryRoot,
    destination,
    archivePath: created.archivePath,
    record: JSON.parse(readFileSync(created.recordPath, "utf8")),
    head: execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  };
}

function qualificationRecord(candidate: FixtureCandidate): Record<string, unknown> {
  return {
    schema: 2,
    mode: "full",
    status: "complete",
    ok: true,
    source: {
      kind: "candidate-record",
      repositoryHead: candidate.head,
      sourceFingerprint: candidate.record.sourceFingerprint,
      reconciliation: "record-validated-against-admission-capture",
    },
    artifact: { archivePath: candidate.archivePath, archiveDigest: candidate.record.archiveDigest },
  };
}

function writeQualificationRecord(candidate: FixtureCandidate, record: unknown): string {
  const path = join(tempDir("q-"), "qualification-record.json");
  writeFileSync(path, `${JSON.stringify(record)}\n`);
  return path;
}

describe("release candidate verification", () => {
  test("a complete qualification of the exact candidate at the expected revision is admitted", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-positive-");
    const evidence = await verifyReleaseCandidate({
      archivePath: candidate.archivePath,
      repositoryRoot: candidate.repositoryRoot,
      expectedRevision: candidate.head,
      qualificationRecordPath: writeQualificationRecord(candidate, qualificationRecord(candidate)),
    });

    expect(evidence.archiveDigest).toBe(candidate.record.archiveDigest);
    expect(evidence.record.archiveDigest).toBe(candidate.record.archiveDigest);
  });

  test("a substituted archive is rejected: its bytes no longer match the recorded digest", async () => {
    // This is the same path the publishing boundary exercises on the handoff:
    // the gate re-digests the bytes at the path it was handed (here, bytes
    // substituted after creation — exactly what a substituted handoff
    // artifact would look like) against the record. The gate has no other
    // substitution path; artifact origin is invisible to it.
    const candidate = await createFixtureCandidate("apkit-verify-substitute-");
    writeFileSync(candidate.archivePath, `${FIXTURE_ARCHIVE_BYTES}tampered\n`);

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, qualificationRecord(candidate)),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidProvenanceError);
    expect((caught as InvalidProvenanceError).reason).toBe("digest-mismatch");
  });

  test("a candidate record that is not valid JSON is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-badrecord-");
    writeFileSync(`${candidate.archivePath}.provenance.json`, "{not json");

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, qualificationRecord(candidate)),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidProvenanceError);
    expect((caught as InvalidProvenanceError).reason).toBe("malformed");
  });

  test("a missing candidate record is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-norecord-");
    rmSync(`${candidate.archivePath}.provenance.json`);

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, qualificationRecord(candidate)),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidProvenanceError);
    expect((caught as InvalidProvenanceError).reason).toBe("missing");
  });

  test("a source-mismatched checkout is rejected: the record describes different source", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-sourcemis-");
    const other = gitRepository("apkit-verify-sourcemis-other-");
    // Identical helper content would fold to the same fingerprint; the
    // mismatch must come from the checkout's actual source bytes.
    writeFileSync(join(other, "src.txt"), "different source bytes\n");

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: other,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, qualificationRecord(candidate)),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidProvenanceError);
    expect((caught as InvalidProvenanceError).reason).toBe("source-mismatch");
  });

  test("a candidate whose revision is not the expected release revision is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-revision-");

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: "0".repeat(40),
        qualificationRecordPath: writeQualificationRecord(candidate, qualificationRecord(candidate)),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseCandidateVerificationError);
    expect((caught as ReleaseCandidateVerificationError).reason).toBe("wrong-revision");
  });

  test("a missing qualification record is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-noqual-");

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: join(tempDir("apkit-verify-noqual-q-"), "qualification-record.json"),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseCandidateVerificationError);
    expect((caught as ReleaseCandidateVerificationError).reason).toBe("missing-qualification");
  });

  test("a malformed qualification record is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-malqual-");
    const path = tempDir("apkit-verify-malqual-q-");
    writeFileSync(join(path, "qualification-record.json"), "{not json");

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: join(path, "qualification-record.json"),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseCandidateVerificationError);
    expect((caught as ReleaseCandidateVerificationError).reason).toBe("malformed-qualification");
  });

  test("a qualification record with an unsupported schema version is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-qualschema-");
    const wrongSchema = {
      ...qualificationRecord(candidate),
      schema: QUALIFICATION_RECORD_SCHEMA + 1,
    };

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, wrongSchema),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseCandidateVerificationError);
    expect((caught as ReleaseCandidateVerificationError).reason).toBe("malformed-qualification");
  });

  test("an incomplete or failed qualification is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-incomplete-");
    const failed = {
      ...qualificationRecord(candidate),
      status: "incomplete",
      ok: false,
      reason: "a required test failed",
    };

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, failed),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseCandidateVerificationError);
    expect((caught as ReleaseCandidateVerificationError).reason).toBe("incomplete-qualification");
  });

  test("a green focused-mode record is not the required full-suite qualification", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-focused-");
    const focused = {
      ...qualificationRecord(candidate),
      mode: "focused",
    };

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, focused),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseCandidateVerificationError);
    expect((caught as ReleaseCandidateVerificationError).reason).toBe("incomplete-qualification");
  });

  test("a qualification of a different artifact digest is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-qualart-");
    const other = {
      ...qualificationRecord(candidate),
      artifact: { archivePath: candidate.archivePath, archiveDigest: "a".repeat(64) },
    };

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, other),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseCandidateVerificationError);
    expect((caught as ReleaseCandidateVerificationError).reason).toBe("qualified-artifact-mismatch");
  });

  test("a qualification whose source identity is not the candidate's is rejected", async () => {
    const candidate = await createFixtureCandidate("apkit-verify-qualsrc-");
    const admittedElsewhere = {
      ...qualificationRecord(candidate),
      source: {
        kind: "admitted-source",
        repositoryHead: candidate.head,
        sourceFingerprint: "b".repeat(64),
        entryCount: 1,
      },
    };

    let caught: unknown;
    try {
      await verifyReleaseCandidate({
        archivePath: candidate.archivePath,
        repositoryRoot: candidate.repositoryRoot,
        expectedRevision: candidate.head,
        qualificationRecordPath: writeQualificationRecord(candidate, admittedElsewhere),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReleaseCandidateVerificationError);
    expect((caught as ReleaseCandidateVerificationError).reason).toBe("qualified-source-mismatch");
  });
});
