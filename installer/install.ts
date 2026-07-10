import { lstat, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type ContextOnlyCodexPlan } from "./plan.js";

function installationManifest(plan: ContextOnlyCodexPlan): string {
  return (
    "schema_version: 1\n" +
    `profile_id: ${plan.profile.id}\n` +
    "host_id: codex\n" +
    "context:\n" +
    plan.profile.context.map((id) => `  - ${id}\n`).join("") +
    "outputs:\n" +
    "  - context.md\n"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function existingInstallationError(destination: string): Error {
  return new Error(
    `Installation already exists at ${destination}; remove it before installing again`,
  );
}

async function ensureInstallationIsMissing(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  throw existingInstallationError(destination);
}

export async function installContextOnlyCodex(
  plan: ContextOnlyCodexPlan,
): Promise<void> {
  const parent = dirname(plan.destination);
  await mkdir(parent, { recursive: true });
  await ensureInstallationIsMissing(plan.destination);
  const staging = await mkdtemp(join(parent, ".install-"));
  try {
    await Promise.all([
      writeFile(join(staging, "context.md"), plan.context),
      writeFile(join(staging, "installation.yaml"), installationManifest(plan)),
    ]);
    await rename(staging, plan.destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (hasErrorCode(error, "EEXIST") || hasErrorCode(error, "ENOTEMPTY")) {
      throw existingInstallationError(plan.destination);
    }
    throw error;
  }
}
