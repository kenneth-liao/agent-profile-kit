import { join } from "node:path";

import { detectCodexCapability, type CodexCapability } from "../adapters/codex.js";
import { type Profile, type ContextModule } from "../schemas/context-profile.js";
import { type Skill } from "../schemas/skill.js";
import { type GitProvenance, workspaceGitProvenance } from "./git-provenance.js";
import { hashWorkspaceInputs } from "./hashes.js";
import { ingestWorkspace } from "./ingest-workspace.js";
import { ENGINE_VERSION } from "./version.js";

export interface ContextOnlyCodexPlan {
  readonly capability: CodexCapability;
  readonly context: string;
  readonly destination: string;
  readonly engineVersion: string;
  readonly gitProvenance?: GitProvenance;
  readonly profile: Profile;
  readonly skills: readonly Skill[];
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
  profile: Profile,
  contexts: ReadonlyMap<string, ContextModule>,
): string {
  return profile.context
    .map((id) => {
      const context = contexts.get(id);
      if (!context) {
        throw new Error(`Profile '${profile.id}' selects missing Context Module '${id}'`);
      }
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
  const context = composeContext(profile, workspace.contexts);
  const skills = profile.skills.map((id) => {
    const skill = workspace.skills.get(id);
    if (!skill) throw new Error(`Profile '${profile.id}' selects missing Skill '${id}'`);
    return skill;
  });
  const capability = await detectCodexCapability(skills.length > 0);
  const gitProvenance = await workspaceGitProvenance(workspace.path);
  return {
    capability,
    context,
    destination: installationPath(home, profile.id),
    engineVersion: ENGINE_VERSION,
    ...(gitProvenance ? { gitProvenance } : {}),
    profile,
    skills,
    workspaceInputHash: await hashWorkspaceInputs(profile, workspace.contexts, workspace.skills),
  };
}
