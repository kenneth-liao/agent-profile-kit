import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";

import { detectCodexCapability, type CodexCapability } from "../adapters/codex.js";
import { type Profile, type ContextModule } from "../schemas/context-profile.js";
import { type GitProvenance, workspaceGitProvenance } from "./git-provenance.js";
import { hashWorkspaceInputs } from "./hashes.js";
import { ingestWorkspace } from "./ingest-workspace.js";
import { ENGINE_VERSION } from "./version.js";
import { planCodexSkillLibrary, type CodexSkillLibraryPlan } from "./codex-skill-library.js";
import { resolveProfileDependencies, type ResolvedProfile } from "./resolve-dependencies.js";

export interface ContextOnlyCodexPlan {
  readonly capability: CodexCapability;
  readonly context: string;
  readonly destination: string;
  readonly engineVersion: string;
  readonly gitProvenance?: GitProvenance;
  readonly skillLibrary: CodexSkillLibraryPlan;
  readonly profile: Profile;
  readonly resolvedProfile?: ResolvedProfile;
  readonly workspaceInputHash: string;
}

export function installationPath(home: string, profileId: string): string {
  return join(
    home,
    ".agents",
    "agent-profile-kit",
    "installations",
    profileId,
    "codex",
  );
}

export function composeContext(
  contexts: readonly ContextModule[],
): string {
  return contexts
    .map((context) => {
      const body = context.content.endsWith("\n")
        ? context.content
        : `${context.content}\n`;
      return `<!-- Context Module: ${context.id} -->\n${body}<!-- End Context Module: ${context.id} -->`;
    })
    .join("\n\n");
}

export async function planContextOnlyCodex(
  home: string,
  profileId: string,
): Promise<ContextOnlyCodexPlan> {
  const workspace = await ingestWorkspace(home);
  const profile = workspace.profiles.get(profileId);
  if (!profile) {
    throw new Error(`Profile '${profileId}' does not exist in the Workspace`);
  }
  const resolvedProfile = resolveProfileDependencies(profile, workspace.contexts, workspace.skills);
  const context = composeContext(resolvedProfile.contexts);
  const skillLibrary = await planCodexSkillLibrary(home, workspace.skills);
  const capability = await detectCodexCapability();
  let currentGeneration: string | undefined;
  try {
    currentGeneration = await realpath(skillLibrary.destination);
  } catch {
    // A missing library is the normal first-install state.
  }
  for (const skill of capability.skills ?? []) {
    if (
      workspace.skills.has(skill.name) &&
      !resolve(skill.path).startsWith(`${resolve(skillLibrary.destination)}/`) &&
      !(currentGeneration && resolve(skill.path).startsWith(`${currentGeneration}/`))
    ) {
      throw new Error(
        `Workspace Skill '${skill.name}' conflicts with an existing Codex Skill at ${skill.path}`,
      );
    }
  }
  const gitProvenance = await workspaceGitProvenance(workspace.path);
  return {
    capability,
    context,
    destination: installationPath(home, profile.id),
    engineVersion: ENGINE_VERSION,
    ...(gitProvenance ? { gitProvenance } : {}),
    profile,
    resolvedProfile,
    skillLibrary,
    workspaceInputHash: await hashWorkspaceInputs(profile, resolvedProfile),
  };
}
