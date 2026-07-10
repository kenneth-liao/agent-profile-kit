import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { parseInstallationManifest } from "../schemas/installation-manifest.js";
import { installationPath } from "./plan.js";

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function uninstallContextOnlyCodex(
  home: string,
  profileId: string,
): Promise<string> {
  const destination = installationPath(home, profileId);
  try {
    if (!(await lstat(destination)).isDirectory()) {
      throw new Error(`Profile Installation at ${destination} must be a directory`);
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`No Profile Installation exists at ${destination}`);
    }
    throw error;
  }
  const manifest = parseInstallationManifest(
    await readFile(join(destination, "installation.yaml"), "utf8"),
  );
  if (manifest.profileId !== profileId || manifest.hostId !== "codex") {
    throw new Error(
      `Installation Manifest does not match requested Codex Profile '${profileId}'`,
    );
  }
  await rm(destination, { recursive: true, force: false });
  return destination;
}
