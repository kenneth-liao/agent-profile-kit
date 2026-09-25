/**
 * Evidence-capture helper for #680 (TEST-005): create the packed release
 * candidate through the one from-source creator, extract it through
 * `extractPackageArchive` (which verifies the identity record against the
 * archive bytes), and write a machine-readable identity summary the Python
 * capture driver records in the report.
 *
 * Run this from a checkout whose tree is exactly the recorded product
 * revision (this capture ran it while issue/680-terminal-recapture sat clean
 * at origin/main 24067a5), so `repositoryHead` and the source fingerprint
 * name that revision and no local evidence files.
 *
 * Rerun:
 *   bun run docs/reviews/evidence/2026-09-24-terminal-recapture/prepare-candidate.ts <destination>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { extractPackageArchive } from "../../../../test/support/package-archive.js";
import { createRepositoryPackageCandidate } from "../../../../scripts/create-package-candidate.js";

const destination = process.argv[2];
if (destination === undefined || destination.length === 0) {
  throw new Error(
    "usage: bun run docs/reviews/evidence/2026-09-24-terminal-recapture/prepare-candidate.ts <destination-directory>",
  );
}

const root = resolve(destination);
const created = await createRepositoryPackageCandidate(root);
const extractRoot = join(root, "package");
mkdirSync(extractRoot, { recursive: true });
await extractPackageArchive(created.archivePath, extractRoot);

const sourcePackage = JSON.parse(
  readFileSync(join(fileURLToPath(new URL("../../../../", import.meta.url)), "package.json"), "utf8"),
) as { version: string };

const { execFileSync } = await import("node:child_process");
const nodeBinary = "/opt/homebrew/opt/node@22/bin/node";
const nodeVersion = execFileSync(nodeBinary, ["--version"], { encoding: "utf8" }).trim();

const summary = {
  version: sourcePackage.version,
  repositoryHead: created.record.repositoryHead,
  sourceFingerprint: created.record.sourceFingerprint,
  archiveDigest: created.record.archiveDigest,
  archivePath: created.archivePath,
  recordPath: created.recordPath,
  extractRoot,
  cliPath: join(extractRoot, "package", "dist", "cli.js"),
  runtime: {
    node: nodeVersion,
    nodeBinary,
    buildBun: "1.4.0",
    platform: process.platform,
  },
};
writeFileSync(join(root, "candidate-identity.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
