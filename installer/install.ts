import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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

export async function installContextOnlyCodex(
  plan: ContextOnlyCodexPlan,
): Promise<void> {
  const parent = dirname(plan.destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".install-"));
  try {
    await Promise.all([
      writeFile(join(staging, "context.md"), plan.context),
      writeFile(join(staging, "installation.yaml"), installationManifest(plan)),
    ]);
    await rename(staging, plan.destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
