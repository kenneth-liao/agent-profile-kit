import { type ArtifactReference } from "../schemas/dependencies.js";
import { type ContextModule, type Profile } from "../schemas/context-profile.js";
import { type Skill } from "../schemas/skill.js";

/**
 * One Profile's desired artifact set: exactly the Context Modules and Skills
 * the Profile lists, in authored order. Profile lists are the only source of
 * what is installed (spec #593 DEC-006) — there are no Dependencies.
 */
export interface ResolvedArtifact {
  readonly artifact: ContextModule | Skill;
  readonly reference: ArtifactReference;
}

export interface ResolvedProfile {
  readonly artifacts: readonly ResolvedArtifact[];
  readonly contexts: readonly ContextModule[];
  readonly profile: Profile;
  readonly skills: readonly Skill[];
}

/**
 * Resolve one Profile's desired artifacts directly from its explicit
 * `context` and `skills` lists. References were validated against the
 * Workspace catalogs at ingestion, so every listed ID exists here.
 */
export function resolveProfile(
  profile: Profile,
  contexts: ReadonlyMap<string, ContextModule>,
  skills: ReadonlyMap<string, Skill>,
): ResolvedProfile {
  const artifacts: ResolvedArtifact[] = [];
  const resolvedContexts: ContextModule[] = [];
  const resolvedSkills: Skill[] = [];
  for (const id of profile.context) {
    const artifact = contexts.get(id);
    if (artifact === undefined) {
      throw new Error(`Profile '${profile.id}' selects missing Context Module '${id}'`);
    }
    artifacts.push({ artifact, reference: { id, type: "context" } });
    resolvedContexts.push(artifact);
  }
  for (const id of profile.skills) {
    const artifact = skills.get(id);
    if (artifact === undefined) {
      throw new Error(`Profile '${profile.id}' selects missing Skill '${id}'`);
    }
    artifacts.push({ artifact, reference: { id, type: "skill" } });
    resolvedSkills.push(artifact);
  }
  return {
    artifacts,
    contexts: resolvedContexts,
    profile,
    skills: resolvedSkills,
  };
}