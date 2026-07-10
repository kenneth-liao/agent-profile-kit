import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseInstallationManifest } from "../schemas/installation-manifest.js";
import { hasErrorCode } from "./fs-error.js";
import { updateContextOnlyCodex } from "./install.js";
import { installationPath, planContextOnlyCodex } from "./plan.js";

function compareNames(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export async function installedCodexProfiles(home: string): Promise<readonly string[]> {
  const root = join(home, ".agents", "agent-profile-kit", "installations");
  let profileEntries;
  try {
    profileEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  }

  const profiles: string[] = [];
  for (const profileEntry of profileEntries.sort(compareNames)) {
    if (profileEntry.name.startsWith(".")) continue;
    if (!profileEntry.isDirectory()) {
      throw new Error(`Profile Installation root contains unexpected entry '${profileEntry.name}'`);
    }
    const hosts = await readdir(join(root, profileEntry.name), { withFileTypes: true });
    for (const hostEntry of hosts.sort(compareNames)) {
      if (hostEntry.name.startsWith(".")) continue;
      if (!hostEntry.isDirectory()) {
        throw new Error(
          `Profile Installation '${profileEntry.name}' contains unexpected entry '${hostEntry.name}'`,
        );
      }
      const destination = join(root, profileEntry.name, hostEntry.name);
      const manifest = parseInstallationManifest(
        await readFile(join(destination, "installation.yaml"), "utf8"),
      );
      if (
        manifest.profileId !== profileEntry.name ||
        manifest.hostId !== hostEntry.name ||
        destination !== installationPath(home, manifest.profileId)
      ) {
        throw new Error(`Installation Manifest does not match ${destination}`);
      }
      profiles.push(manifest.profileId);
    }
  }
  return profiles;
}

export async function updateInstalledContextOnlyCodex(
  home: string,
): Promise<number> {
  const profiles = await installedCodexProfiles(home);
  const plans = await Promise.all(profiles.map((profile) => planContextOnlyCodex(home, profile)));
  for (const plan of plans) {
    await updateContextOnlyCodex(plan);
  }
  return plans.length;
}
