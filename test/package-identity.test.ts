import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UnsupportedSourceError,
  captureSourceFingerprint,
} from "./support/package-identity.js";

/**
 * Content-identity proofs for the source fingerprint (TEST-002's identity
 * contract): the fingerprint hashes the actual worktree bytes, path, type,
 * and mode of every relevant source path — tracked (as the build consumes
 * them, worktree content, not index shortcuts) plus untracked non-ignored
 * files — derived from Git at capture time, with no maintained file catalogue
 * and NUL-safe path parsing. Already-dirty same-status edits, same-path
 * untracked byte changes, deletions, and mode changes must each change the
 * fingerprint; unsupported source shapes (symlinks, submodules) fail closed.
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

function gitRepository(prefix: string, files: Record<string, string>): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  const git = (...arguments_: string[]): void => {
    execFileSync("git", ["-C", path, ...arguments_], { stdio: "pipe" });
  };
  git("init", "-q");
  git("config", "user.email", "tests@example.com");
  git("config", "user.name", "Agent Profile Kit Tests");
  for (const [name, content] of Object.entries(files)) {
    const destination = join(path, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content);
  }
  git("add", ".");
  git("commit", "-qm", "fixture");
  return path;
}

const CAPTURE = { deadlineMs: 8_000, signal: undefined };

describe("source fingerprint capture", () => {
  test("hashes actual worktree bytes: an already-dirty same-status edit changes the digest", async () => {
    const root = gitRepository("apkit-identity-dirty-", {
      "src/tracked.txt": "original\n",
      "docs/guides/page.md": "guide\n",
    });
    // The file is already dirty before the first capture: status is the same
    // before and after the second edit, so only the content hash can tell.
    writeFileSync(join(root, "src/tracked.txt"), "changed-once\n");
    const first = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });
    writeFileSync(join(root, "src/tracked.txt"), "changed-again\n");
    const second = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });

    expect(second.digest).not.toBe(first.digest);
  });

  test("same-path untracked bytes change the digest", async () => {
    const root = gitRepository("apkit-identity-untracked-", {
      "src/tracked.txt": "tracked\n",
    });
    writeFileSync(join(root, "untracked.txt"), "first bytes\n");
    const first = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });
    writeFileSync(join(root, "untracked.txt"), "second bytes\n");
    const second = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });

    expect(second.digest).not.toBe(first.digest);
  });

  test("a worktree deletion of a tracked file changes the digest and entry count", async () => {
    const root = gitRepository("apkit-identity-delete-", {
      "src/gone.txt": "present\n",
      "src/kept.txt": "kept\n",
    });
    const first = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });
    rmSync(join(root, "src/gone.txt"));
    const second = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });

    expect(second.digest).not.toBe(first.digest);
    expect(second.entryCount).toBe(first.entryCount - 1);
  });

  test("a mode change on a tracked file changes the digest", async () => {
    const root = gitRepository("apkit-identity-mode-", {
      "src/script.txt": "bytes\n",
    });
    const first = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });
    chmodSync(join(root, "src/script.txt"), 0o755);
    const second = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });

    expect(second.digest).not.toBe(first.digest);
  });

  test("staged content does not mask worktree bytes: staged-then-worktree-reverted equals HEAD state", async () => {
    const root = gitRepository("apkit-identity-staged-", {
      "src/tracked.txt": "committed\n",
    });
    const headState = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });
    // Stage different content, then put the HEAD bytes back in the worktree:
    // the build consumes the worktree, so the fingerprint must return to the
    // HEAD-state value even though the index still holds the staged bytes.
    writeFileSync(join(root, "src/tracked.txt"), "staged\n");
    execFileSync("git", ["-C", root, "add", "src/tracked.txt"]);
    writeFileSync(join(root, "src/tracked.txt"), "committed\n");
    const reverted = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });

    expect(reverted.digest).toBe(headState.digest);
  });

  test("ignored files do not affect the fingerprint; the digest is stable across captures", async () => {
    const root = gitRepository("apkit-identity-ignored-", {
      ".gitignore": "dist/\nsecret.env\n",
      "src/tracked.txt": "tracked\n",
    });
    const first = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist/cli.js"), "build output\n");
    writeFileSync(join(root, "secret.env"), "ignored\n");
    const second = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });

    expect(second.digest).toBe(first.digest);
  });

  test("NUL-safe paths (spaces, quotes, unicode, newline) fold deterministically", async () => {
    const files: Record<string, string> = {
      "src/with space.txt": "a\n",
      "src/quote'.txt": "b\n",
      "src/üñïçø∂é.txt": "c\n",
      "src/newline\nname.txt": "d\n",
    };
    const root = gitRepository("apkit-identity-nul-", files);
    const first = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });
    const second = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });

    expect(first.entryCount).toBe(4);
    expect(second.digest).toBe(first.digest);
  });

  test("a source symlink fails closed as unsupported", async () => {
    const root = gitRepository("apkit-identity-symlink-", {
      "src/tracked.txt": "tracked\n",
    });
    execFileSync("ln", ["-s", "src/tracked.txt", join(root, "link.txt")]);

    await expect(
      captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE }),
    ).rejects.toThrow(UnsupportedSourceError);
  });

  test("a submodule entry fails closed as unsupported", async () => {
    const dependency = gitRepository("apkit-identity-submodule-dependency-", {
      "lib.txt": "dependency\n",
    });
    const root = gitRepository("apkit-identity-submodule-", {
      "src/tracked.txt": "tracked\n",
    });
    execFileSync(
      "git",
      ["-C", root, "submodule", "add", dependency, "vendor/dep"],
      { stdio: "pipe", env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" } },
    );

    await expect(
      captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE }),
    ).rejects.toThrow(UnsupportedSourceError);
  });

  test("records the HEAD commit identity", async () => {
    const root = gitRepository("apkit-identity-head-", { "src/tracked.txt": "tracked\n" });
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const capture = await captureSourceFingerprint({ repositoryRoot: root, ...CAPTURE });

    expect(capture.repositoryHead).toBe(head);
  });
});
import {
  InvalidProvenanceError,
  createPackageCandidate,
  packageIdentityRecordPath,
  readPackageIdentityRecord,
  validateSuppliedPackageCandidate,
  type PackageIdentityRecord,
} from "./support/package-identity.js";

const CAPTURE_BUDGET = { deadlineMs: 20_000, signal: undefined };

/**
 * Deterministic injected commands: the build writes one fresh dist bundle,
 * the pack produces a real tarball from the declared file list.
 */
function injectedCandidateCommands(
  root: string,
  packedFiles: readonly string[],
): { readonly commands: import("./support/package-archive.js").PackageArchiveCommands; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    commands: {
      build: async (stage) => {
        calls.push("build");
        if (stage.deadlineMs <= 0) throw new Error("build ran with no budget");
        mkdirSync(join(root, "dist"), { recursive: true });
        writeFileSync(join(root, "dist", "cli.js"), 'console.log("CANDIDATE-CLI-MARKER");\n');
      },
      createScriptDisabledArchive: async (stage, destination) => {
        calls.push("pack");
        if (stage.deadlineMs <= 0) throw new Error("pack ran with no budget");
        const staging = join(destination, "staging", "package");
        for (const file of packedFiles) {
          mkdirSync(dirname(join(staging, file)), { recursive: true });
          writeFileSync(join(staging, file), `PACKED:${file}\n`);
        }
        const tarball = join(destination, "agent-profile-kit-test.tgz");
        execFileSync("tar", ["-czf", tarball, "-C", join(destination, "staging"), "."], { stdio: "pipe" });
        return { filename: "agent-profile-kit-test.tgz", files: packedFiles };
      },
    },
  };
}

function commitAll(root: string): void {
  execFileSync("git", ["-C", root, "add", "."], { stdio: "pipe" });
  execFileSync("git", ["-C", root, "commit", "-qm", "membership"], { stdio: "pipe" });
}

describe("package candidate creator (one from-source creator)", () => {
  test("creates archive and record at the build/pack boundary; the reader validates both", async () => {
    const root = gitRepository("apkit-identity-create-", {
      ".gitignore": "dist/\n",
      "src/tracked.txt": "tracked\n",
      "package.json": JSON.stringify({ name: "agent-profile-kit", version: "0.0.0" }),
    });
    const destination = tempDir("apkit-identity-dest-");
    const { commands, calls } = injectedCandidateCommands(root, ["dist/cli.js", "README.md"]);
    writeFileSync(join(root, "README.md"), "readme\n");
    commitAll(root);
    mkdirSync(join(root, "dist"), { recursive: true });

    const created = await createPackageCandidate({
      repositoryRoot: root,
      destinationDirectory: destination,
      ...CAPTURE_BUDGET,
      commands,
    });

    expect(calls).toEqual(["build", "pack"]);
    expect(created.archivePath).toBe(realpathSync(join(destination, "agent-profile-kit-test.tgz")));
    expect(created.recordPath).toBe(packageIdentityRecordPath(created.archivePath));
    const record: PackageIdentityRecord = JSON.parse(
      readFileSync(created.recordPath, "utf8"),
    ) as PackageIdentityRecord;
    expect(record.schema).toBe(1);
    expect(record.archiveDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(readPackageIdentityRecord(created.archivePath)).toEqual(record);

    const validated = await validateSuppliedPackageCandidate(created.archivePath, {
      repositoryRoot: root,
      ...CAPTURE_BUDGET,
    });
    expect(validated.record.archiveDigest).toBe(record.archiveDigest);
  });

  test("freshly replaces the ignored build output before the build stage", async () => {
    const root = gitRepository("apkit-identity-fresh-dist-", {
      ".gitignore": "dist/\n",
      "src/tracked.txt": "tracked\n",
      "package.json": JSON.stringify({ name: "agent-profile-kit", version: "0.0.0" }),
    });
    const destination = tempDir("apkit-identity-dest-");
    const { commands, calls } = injectedCandidateCommands(root, ["dist/cli.js"]);
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "cli.js"), "STALE-BUILD-OUTPUT\n");

    await createPackageCandidate({
      repositoryRoot: root,
      destinationDirectory: destination,
      ...CAPTURE_BUDGET,
      commands,
    });

    expect(calls).toEqual(["build", "pack"]);
    expect(readFileSync(join(root, "dist", "cli.js"), "utf8")).toBe('console.log("CANDIDATE-CLI-MARKER");\n');
  });

  test("rejects an unstable source: a tracked mutation between pre- and post-capture fails with no record", async () => {
    const root = gitRepository("apkit-identity-unstable-", {
      ".gitignore": "dist/\n",
      "src/tracked.txt": "tracked\n",
      "package.json": JSON.stringify({ name: "agent-profile-kit", version: "0.0.0" }),
    });
    const destination = tempDir("apkit-identity-dest-");
    const { commands } = injectedCandidateCommands(root, ["dist/cli.js"]);
    const mutatingBuild = {
      ...commands,
      build: async (stage: Parameters<typeof commands.build>[0]) => {
        await commands.build(stage);
        writeFileSync(join(root, "src/tracked.txt"), "mutated during preparation\n");
      },
    };

    await expect(
      createPackageCandidate({
        repositoryRoot: root,
        destinationDirectory: destination,
        ...CAPTURE_BUDGET,
        commands: mutatingBuild,
      }),
    ).rejects.toThrow(/unstable source/);
    expect(existsSync(packageIdentityRecordPath(join(destination, "agent-profile-kit-test.tgz")))).toBe(false);
  });

  test("rejects a packed input outside the fingerprinted membership and the build-output boundary", async () => {
    const root = gitRepository("apkit-identity-guard-", {
      ".gitignore": "dist/\n",
      "src/tracked.txt": "tracked\n",
      "package.json": JSON.stringify({ name: "agent-profile-kit", version: "0.0.0" }),
    });
    const destination = tempDir("apkit-identity-dest-");
    const { commands } = injectedCandidateCommands(root, ["dist/cli.js", "extra-ignored.txt"]);
    mkdirSync(join(root, "dist"), { recursive: true });

    await expect(
      createPackageCandidate({
        repositoryRoot: root,
        destinationDirectory: destination,
        ...CAPTURE_BUDGET,
        commands,
      }),
    ).rejects.toThrow(/outside the identity boundary/);
  });
});

describe("supplied candidate provenance validation", () => {
  function creatorFor(root: string, packedFiles: readonly string[]) {
    const { commands } = injectedCandidateCommands(root, packedFiles);
    return commands;
  }

  test("a missing record fails closed", async () => {
    const root = tempDir("apkit-identity-supplied-root-");
    const archive = join(root, "agent-profile-kit-x.tgz");
    writeFileSync(archive, "bytes");

    await expect(
      validateSuppliedPackageCandidate(archive, { repositoryRoot: root, ...CAPTURE_BUDGET }),
    ).rejects.toThrow(InvalidProvenanceError);
    try {
      await validateSuppliedPackageCandidate(archive, { repositoryRoot: root, ...CAPTURE_BUDGET });
    } catch (error) {
      expect((error as InvalidProvenanceError).reason).toBe("missing");
    }
  });

  test("a malformed record fails closed", async () => {
    const root = tempDir("apkit-identity-supplied-root-");
    const archive = join(root, "agent-profile-kit-x.tgz");
    writeFileSync(archive, "bytes");
    writeFileSync(packageIdentityRecordPath(archive), "{not json");

    await expect(
      validateSuppliedPackageCandidate(archive, { repositoryRoot: root, ...CAPTURE_BUDGET }),
    ).rejects.toThrow(InvalidProvenanceError);
  });

  test("a substituted archive (bytes changed after the record was written) fails closed", async () => {
    const root = gitRepository("apkit-identity-substitute-", {
      ".gitignore": "dist/\n",
      "src/tracked.txt": "tracked\n",
      "package.json": JSON.stringify({ name: "agent-profile-kit", version: "0.0.0" }),
    });
    const destination = tempDir("apkit-identity-dest-");
    const { commands } = injectedCandidateCommands(root, ["dist/cli.js"]);
    const created = await createPackageCandidate({
      repositoryRoot: root,
      destinationDirectory: destination,
      ...CAPTURE_BUDGET,
      commands,
    });
    writeFileSync(created.archivePath, "substituted bytes");

    try {
      await validateSuppliedPackageCandidate(created.archivePath, {
        repositoryRoot: root,
        ...CAPTURE_BUDGET,
      });
      throw new Error("expected validation to reject a substituted archive");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProvenanceError);
      expect((error as InvalidProvenanceError).reason).toBe("digest-mismatch");
    }
  });

  test("a stale record (relevant source changed since capture) fails closed", async () => {
    const root = gitRepository("apkit-identity-stale-", {
      ".gitignore": "dist/\n",
      "src/tracked.txt": "tracked\n",
      "package.json": JSON.stringify({ name: "agent-profile-kit", version: "0.0.0" }),
    });
    const destination = tempDir("apkit-identity-dest-");
    const { commands } = injectedCandidateCommands(root, ["dist/cli.js"]);
    const created = await createPackageCandidate({
      repositoryRoot: root,
      destinationDirectory: destination,
      ...CAPTURE_BUDGET,
      commands,
    });
    // Ignored build output changed: not source, still valid.
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "cli.js"), "rebuilt\n");
    const stillValid = await validateSuppliedPackageCandidate(created.archivePath, {
      repositoryRoot: root,
      ...CAPTURE_BUDGET,
    });
    expect(stillValid.record.archiveDigest).toBe(created.record.archiveDigest);
    // Relevant source changed after capture: stale provenance.
    writeFileSync(join(root, "src/tracked.txt"), "changed after capture\n");

    try {
      await validateSuppliedPackageCandidate(created.archivePath, {
        repositoryRoot: root,
        ...CAPTURE_BUDGET,
      });
      throw new Error("expected validation to reject stale provenance");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidProvenanceError);
      expect((error as InvalidProvenanceError).reason).toBe("source-mismatch");
    }
  });
});
