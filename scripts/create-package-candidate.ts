import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { packageArchiveRepositoryRoot, systemPackageArchiveCommands, type PackageArchiveCommands } from "../test/support/package-archive.js";
import {
  createPackageCandidate,
  UNSUPERVISED_CANDIDATE_DEADLINE_MS,
  type CreatedPackageCandidate,
} from "../test/support/package-identity.js";

/**
 * The CI creation boundary for the supplied package candidate (#538): one
 * invocation of the one from-source creator against this checked-out
 * repository. The creator captures the pre-fingerprint, freshly replaces the
 * ignored build output, runs the system build and pack stages once, digests
 * the exact packed bytes, re-captures the fingerprint (an unequal post-capture
 * fails the step), guards every packed input, and writes the identity record
 * beside the archive — the same creator, record shape, and reader the
 * supervisor uses for prepared candidates and validation uses for supplied
 * ones. Nothing here stamps a record onto a pre-existing archive.
 */

export async function createRepositoryPackageCandidate(
  destination: string,
  commands = systemPackageArchiveCommands,
): Promise<CreatedPackageCandidate> {
  mkdirSync(destination, { recursive: true });
  return createPackageCandidate({
    repositoryRoot: packageArchiveRepositoryRoot(),
    destinationDirectory: destination,
    deadlineMs: UNSUPERVISED_CANDIDATE_DEADLINE_MS,
    signal: undefined,
    commands,
  });
}

const invokedDirectly = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const destination = process.argv[2];
  if (destination === undefined || destination.length === 0) {
    throw new Error("usage: bun run scripts/create-package-candidate.ts <destination-directory>");
  }
  const created = await createRepositoryPackageCandidate(resolve(destination));
  // The canonical workflow consumes the printed archive path.
  console.log(created.archivePath);
}