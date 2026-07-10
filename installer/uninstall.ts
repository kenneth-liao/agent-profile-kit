import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { parseInstallationManifest } from "../schemas/installation-manifest.js";
import { hasErrorCode } from "./fs-error.js";
import { installationPath } from "./plan.js";
import {
  assertCodexSkillLibraryRemovable,
  codexSkillLibraryHasLeases,
  removeOwnedCodexSkillLibrary,
} from "./codex-skill-library.js";
import { installedCodexProfiles } from "./update.js";
import { withCodexLifecycleLock } from "./codex-lifecycle-lock.js";

export async function uninstallContextOnlyCodex(
  home: string,
  profileId: string,
): Promise<string> {
  return withCodexLifecycleLock(home, async () => {
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
    const installedProfiles = await installedCodexProfiles(home);
    const removesLastDependency =
      installedProfiles.length === 1 && installedProfiles[0] === profileId;
    if (removesLastDependency) {
      await assertCodexSkillLibraryRemovable(home);
      if (await codexSkillLibraryHasLeases(home)) {
        throw new Error(
          "Cannot uninstall the final Codex Profile while a managed Codex run is active",
        );
      }
    }
    await rm(destination, { recursive: true, force: false });
    if (removesLastDependency) await removeOwnedCodexSkillLibrary(home);
    return destination;
  });
}
