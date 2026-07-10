import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { codexContextOverride, runCodex } from "../adapters/codex.js";
import { parseInstallationManifest } from "../schemas/installation-manifest.js";
import { installationPath } from "./plan.js";

function configKey(value: string): string | undefined {
  const delimiter = value.indexOf("=");
  return delimiter === -1 ? undefined : value.slice(0, delimiter).trim();
}

function configOverride(
  arguments_: readonly string[],
  index: number,
): string | undefined {
  const argument = arguments_[index];
  if (!argument) return undefined;
  if (argument === "--config" || argument === "-c") {
    return arguments_[index + 1];
  }
  if (argument.startsWith("--config=")) return argument.slice("--config=".length);
  if (argument.startsWith("-c")) return argument.slice(2);
  return undefined;
}

export async function runContextOnlyCodex(
  home: string,
  profileId: string,
  nativeArguments: readonly string[],
): Promise<number> {
  if (
    nativeArguments.some(
      (_, index) =>
        configKey(configOverride(nativeArguments, index) ?? "") === "developer_instructions",
    )
  ) {
    throw new Error(
      "Native Codex arguments may not override developer_instructions selected by the Profile",
    );
  }

  const installation = installationPath(home, profileId);
  const manifest = parseInstallationManifest(
    await readFile(join(installation, "installation.yaml"), "utf8"),
  );
  if (manifest.profileId !== profileId || manifest.hostId !== "codex") {
    throw new Error(
      `Installation Manifest does not match requested Codex Profile '${profileId}'`,
    );
  }
  const context = await readFile(join(installation, "context.md"), "utf8");
  if (manifest.selectedArtifacts.skills.length > 0) {
    throw new Error(
      "Codex does not support per-process Skill discovery and isolation for Profile-selected Skills",
    );
  }
  return runCodex(["-c", codexContextOverride(context), ...nativeArguments]);
}
