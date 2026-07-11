import {
  artifactReferenceKey,
  type ArtifactReference,
} from "../schemas/dependencies.js";
import { type ContextModule, type Profile } from "../schemas/context-profile.js";
import { type Skill } from "../schemas/skill.js";

export interface InclusionReason {
  readonly path: readonly ArtifactReference[];
  readonly profileId: string;
}

export interface ResolvedArtifact {
  readonly artifact: ContextModule | Skill;
  readonly inclusionReasons: readonly InclusionReason[];
  readonly reference: ArtifactReference;
}

export interface ResolvedProfile {
  readonly artifacts: readonly ResolvedArtifact[];
  readonly contexts: readonly ContextModule[];
  readonly profile: Profile;
  readonly skills: readonly Skill[];
}

interface MutableResolvedArtifact {
  readonly artifact: ContextModule | Skill;
  readonly inclusionReasons: InclusionReason[];
  readonly reference: ArtifactReference;
}

type DependencyArtifact = (ContextModule | Skill) & {
  readonly dependencies: readonly ArtifactReference[];
};

function artifactFor(
  reference: ArtifactReference,
  contexts: ReadonlyMap<string, ContextModule>,
  skills: ReadonlyMap<string, Skill>,
): DependencyArtifact {
  const artifact = reference.type === "context"
    ? contexts.get(reference.id)
    : skills.get(reference.id);
  if (!artifact) {
    const label = reference.type === "context" ? "Context Module" : "Skill";
    throw new Error(`Dependency references missing ${label} '${reference.id}'`);
  }
  return artifact;
}

function compareReferences(left: ArtifactReference, right: ArtifactReference): number {
  return artifactReferenceKey(left).localeCompare(artifactReferenceKey(right));
}

function rootReferences(profile: Profile): readonly ArtifactReference[] {
  return [
    ...profile.context.map((id) => ({ id, type: "context" as const })),
    ...profile.skills.map((id) => ({ id, type: "skill" as const })),
  ];
}

function validationProfile(reference: ArtifactReference): Profile {
  return {
    agents: [],
    context: reference.type === "context" ? [reference.id] : [],
    hooks: [],
    id: "dependency-validation",
    skills: reference.type === "skill" ? [reference.id] : [],
    tools: [],
  };
}

export function resolveProfileDependencies(
  profile: Profile,
  contexts: ReadonlyMap<string, ContextModule>,
  skills: ReadonlyMap<string, Skill>,
): ResolvedProfile {
  const states = new Map<string, "resolving" | "resolved">();
  const artifacts = new Map<string, MutableResolvedArtifact>();
  const ordered: MutableResolvedArtifact[] = [];
  const path: ArtifactReference[] = [];

  function addReason(reference: ArtifactReference, reason: InclusionReason): void {
    const resolved = artifacts.get(artifactReferenceKey(reference));
    if (!resolved) return;
    const existing = resolved.inclusionReasons.some(
      (candidate) =>
        candidate.profileId === reason.profileId &&
        candidate.path.length === reason.path.length &&
        candidate.path.every((reference, index) =>
          artifactReferenceKey(reference) === artifactReferenceKey(reason.path[index]!),
        ),
    );
    if (!existing) {
      resolved.inclusionReasons.push(reason);
    }
  }

  function visit(reference: ArtifactReference, reason: InclusionReason): void {
    const key = artifactReferenceKey(reference);
    const state = states.get(key);
    if (state === "resolving") {
      const cycle = [...path, reference].map(artifactReferenceKey).join(" -> ");
      throw new Error(`Dependency cycle: ${cycle}`);
    }
    if (state === "resolved") {
      addReason(reference, reason);
      const artifact = artifactFor(reference, contexts, skills);
      for (const dependency of [...artifact.dependencies].sort(compareReferences)) {
        visit(dependency, { profileId: reason.profileId, path: [...reason.path, reference] });
      }
      return;
    }
    const artifact = artifactFor(reference, contexts, skills);
    states.set(key, "resolving");
    path.push(reference);
    for (const dependency of [...artifact.dependencies].sort(compareReferences)) {
      visit(dependency, { profileId: reason.profileId, path: [...reason.path, reference] });
    }
    path.pop();
    const resolved: MutableResolvedArtifact = {
      artifact,
      inclusionReasons: [reason],
      reference: { id: artifact.id, type: reference.type },
    };
    states.set(key, "resolved");
    artifacts.set(key, resolved);
    ordered.push(resolved);
  }

  for (const reference of rootReferences(profile)) {
    visit(reference, { profileId: profile.id, path: [] });
  }

  return {
    artifacts: ordered,
    contexts: ordered
      .filter((resolved) => resolved.reference.type === "context")
      .map((resolved) => resolved.artifact as ContextModule),
    profile,
    skills: ordered
      .filter((resolved) => resolved.reference.type === "skill")
      .map((resolved) => resolved.artifact as Skill),
  };
}

export function validateDependencyCatalog(
  contexts: ReadonlyMap<string, ContextModule>,
  skills: ReadonlyMap<string, Skill>,
): void {
  const references: ArtifactReference[] = [
    ...[...contexts.keys()].sort().map((id) => ({ id, type: "context" as const })),
    ...[...skills.keys()].sort().map((id) => ({ id, type: "skill" as const })),
  ];
  for (const reference of references) {
    resolveProfileDependencies(validationProfile(reference), contexts, skills);
  }
}
