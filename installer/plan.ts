import { join } from "node:path";

import { detectCodexCapability, type CodexCapability } from "../adapters/codex.js";
import { type Profile, type ContextModule } from "../schemas/context-profile.js";
import { ingestWorkspace } from "./ingest-workspace.js";

export interface ContextOnlyCodexPlan {
  readonly capability: CodexCapability;
  readonly context: string;
  readonly destination: string;
  readonly profile: Profile;
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
  const capability = await detectCodexCapability();
  return {
    capability,
    context,
    destination: installationPath(home, profile.id),
    profile,
  };
}
