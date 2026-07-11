import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  codexContextOverride,
  codexSkillRoots,
  codexSkillsOverride,
  startCodexWithLease,
  type RunningCodex,
} from "../adapters/codex.js";
import { parseInstallationManifest } from "../schemas/installation-manifest.js";
import { installationPath } from "./plan.js";
import {
  assertNoCodexSkillConflicts,
  codexSkillLibraryHasLeases,
  codexSkillLibraryPath,
  pinCodexSkillLibraryUnderLock,
  releaseCodexSkillLibraryLeaseUnderLock,
  removeOwnedCodexSkillLibrary,
  type CodexSkillLibraryLease,
} from "./codex-skill-library.js";
import { withCodexLifecycleLock } from "./codex-lifecycle-lock.js";
import { installedCodexProfiles } from "./update.js";

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

function codexWorkingDirectory(arguments_: readonly string[]): string {
  let directory = process.cwd();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if ((argument === "--cd" || argument === "-C") && arguments_[index + 1]) {
      directory = resolve(process.cwd(), arguments_[index + 1]!);
      index += 1;
    } else if (argument?.startsWith("--cd=")) {
      directory = resolve(process.cwd(), argument.slice("--cd=".length));
    } else if (argument?.startsWith("-C") && argument.length > 2) {
      directory = resolve(process.cwd(), argument.slice(2));
    }
  }
  return directory;
}

export async function runContextOnlyCodex(
  home: string,
  profileId: string,
  nativeArguments: readonly string[],
): Promise<number> {
  const protectedKey = nativeArguments
    .map((_, index) => configKey(configOverride(nativeArguments, index) ?? ""))
    .find((key) => key === "developer_instructions" || key === "skills.config");
  if (protectedKey) {
    throw new Error(
      `Native Codex arguments may not override ${protectedKey} selected by the Profile`,
    );
  }

  let lease: CodexSkillLibraryLease | undefined;
  const running: RunningCodex = await withCodexLifecycleLock(home, async () => {
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
    const libraryPath = codexSkillLibraryPath(home);
    const pinned = await pinCodexSkillLibraryUnderLock(home);
    lease = pinned.lease;
    try {
      const librarySkills = new Set(pinned.manifest.skills);
      await assertNoCodexSkillConflicts(
        await codexSkillRoots(home, codexWorkingDirectory(nativeArguments)),
        libraryPath,
        librarySkills,
      );
      const resolvedSkillIds = manifest.resolvedArtifacts
        ? manifest.resolvedArtifacts
            .filter((artifact) => artifact.reference.type === "skill")
            .map((artifact) => artifact.reference.id)
        : manifest.selectedArtifacts.skills;
      for (const id of resolvedSkillIds) {
        if (!librarySkills.has(id)) {
          throw new Error(`Installed Profile selects missing Codex Skill Library entry '${id}'`);
        }
      }
      const selected = new Set(resolvedSkillIds);
      const skillConfiguration = pinned.manifest.skills.map((id) => ({
        enabled: selected.has(id),
        path: join(pinned.lease.generation, id, "SKILL.md"),
      }));
      const arguments_ = [
        "-c",
        codexContextOverride(context),
        "-c",
        codexSkillsOverride(skillConfiguration),
        ...nativeArguments,
      ];
      return await startCodexWithLease(arguments_, pinned.lease.path);
    } catch (error) {
      await releaseCodexSkillLibraryLeaseUnderLock(pinned.lease);
      lease = undefined;
      throw error;
    }
  });
  try {
    return await running.completion;
  } finally {
    if (lease) {
      await withCodexLifecycleLock(home, async () => {
        await releaseCodexSkillLibraryLeaseUnderLock(lease!);
        if (
          !(await codexSkillLibraryHasLeases(home)) &&
          (await installedCodexProfiles(home)).length === 0
        ) {
          await removeOwnedCodexSkillLibrary(home);
        }
      });
    }
  }
}
