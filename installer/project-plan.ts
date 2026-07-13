import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  assertCodexProjectCapability,
  planCodexProject,
  type ProposedProjectOutput,
} from "../adapters/codex.js";
import { type ProjectBinding } from "../schemas/local-configuration.js";
import { hashWorkspaceInputs } from "./hashes.js";
import { ingestApplication } from "./local-configuration.js";
import { resolveProfileDependencies, type ResolvedProfile } from "./resolve-dependencies.js";
import { ENGINE_VERSION } from "./version.js";
import { findGitProject } from "./git.js";
import type { Profile } from "../schemas/context-profile.js";
import type { Workspace } from "./ingest-workspace.js";

export interface DesiredProjectOutput extends ProposedProjectOutput {
  readonly hash: string;
}

export interface DesiredInstallation {
  readonly binding: ProjectBinding;
  readonly engineVersion: string;
  readonly hostVersion: string;
  readonly outputs: readonly DesiredProjectOutput[];
  readonly profile: Profile;
  readonly resolvedProfile: ResolvedProfile;
  readonly sourceHash: string;
}

export interface DesiredState {
  readonly installations: readonly DesiredInstallation[];
  readonly workspace: Workspace;
}

export function hashBytes(source: string): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export async function buildDesiredState(
  home: string,
  options: { readonly checkHostCapability?: boolean } = {},
): Promise<DesiredState> {
  const { configuration, workspace } = await ingestApplication(home);
  const installations: DesiredInstallation[] = [];
  for (const binding of configuration.bindings) {
    if (options.checkHostCapability !== false) {
      await assertCodexProjectCapability(home, binding.canonicalProject);
    }
    const profile = workspace.profiles.get(binding.profile);
    if (!profile) {
      throw new Error(
        `Project Binding for '${binding.project}' selects missing Profile '${binding.profile}'`,
      );
    }
    const resolvedProfile = resolveProfileDependencies(
      profile,
      workspace.contexts,
      workspace.skills,
    );
    if (resolvedProfile.skills.length > 0) {
      throw new Error(
        `Profile '${profile.id}' selects Skills, which the Context-only Codex project slice does not support; remove Skills from the Profile before applying`,
      );
    }
    if (profile.agents.length > 0 || profile.hooks.length > 0 || profile.tools.length > 0) {
      throw new Error(
        `Profile '${profile.id}' selects unsupported artifact categories; Agents, Hooks, and Tools are not supported in the Context-only Codex project slice`,
      );
    }
    const contextModules = resolvedProfile.contexts;
    const gitProject = await findGitProject(binding.canonicalProject);
    const contextPath = [
      gitProject?.relativeProject ?? "",
      ".agent-profile-kit",
      "codex",
      "context.md",
    ].filter((part) => part.length > 0).join("/");
    const adapterPlan = planCodexProject(profile.id, contextModules, { contextPath });
    const sourceHash = await hashWorkspaceInputs(profile, resolvedProfile);
    installations.push({
      binding,
      engineVersion: ENGINE_VERSION,
      hostVersion: adapterPlan.hostVersion,
      outputs: adapterPlan.outputs.map((output) => ({
        ...output,
        hash: hashBytes(output.bytes),
      })),
      profile,
      resolvedProfile,
      sourceHash,
    });
  }
  return { installations, workspace };
}

export function stateDirectory(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state");
}

export function stateManifestPath(home: string): string {
  return join(stateDirectory(home), "manifest.yaml");
}

export function markerPath(project: string): string {
  return join(project, ".agent-profile-kit", "installation.json");
}

export function outputPath(project: string, output: { readonly path: string }): string {
  return join(project, output.path);
}
