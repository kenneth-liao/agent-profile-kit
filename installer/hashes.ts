import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProposedDirectoryMember } from "../adapters/project-plan.js";
import { skillPackageMembers } from "../adapters/skill-package.js";
import { type ContextModule, type Profile } from "../schemas/context-profile.js";
import { type Skill } from "../schemas/skill.js";
import { type ArtifactReference } from "../schemas/dependencies.js";
import { type ResolvedProfile } from "./resolve-dependencies.js";
import { WORKSPACE_SCHEMA_VERSION } from "../schemas/workspace-manifest.js";

function sha256(source: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function writeFrame(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

function compareNames(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function skillInputFromMembers(
  skill: Skill,
  members: readonly ProposedDirectoryMember[],
): unknown {
  const files = [...members]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((member) =>
      member.type === "directory"
        ? { mode: member.mode, path: member.path, type: "directory" as const }
        : {
            content: sha256(member.bytes),
            mode: member.mode,
            path: member.path,
            type: "file" as const,
          },
    );
  return { files, id: skill.id };
}

async function skillInput(skill: Skill): Promise<unknown> {
  // Sidecar omission matches skillPackageMembers so fingerprint and projection
  // share one portable package shape.
  return skillInputFromMembers(skill, await skillPackageMembers(skill));
}

export async function hashSkillCatalog(skills: ReadonlyMap<string, Skill>): Promise<string> {
  const entries = await Promise.all(
    [...skills.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) => skillInput(skill)),
  );
  return sha256(JSON.stringify({ skills: entries, workspace_schema_version: WORKSPACE_SCHEMA_VERSION }));
}

function normalizedInclusionReasons(
  inclusionReasons: ResolvedProfile["artifacts"][number]["inclusionReasons"],
): readonly {
  readonly path: readonly { readonly id: string; readonly type: string }[];
  readonly profile: string;
}[] {
  return inclusionReasons
    .map((reason) => ({
      path: reason.path.map((reference) => ({ id: reference.id, type: reference.type })),
      profile: reason.profileId,
    }))
    .sort((left, right) => {
      const profileOrder = left.profile.localeCompare(right.profile);
      if (profileOrder !== 0) return profileOrder;
      return JSON.stringify(left.path).localeCompare(JSON.stringify(right.path));
    });
}

function normalizedDependencies(
  dependencies: readonly { readonly id: string; readonly type: string }[],
): readonly { readonly id: string; readonly type: string }[] {
  return [...dependencies]
    .map((dependency) => ({ id: dependency.id, type: dependency.type }))
    .sort((left, right) =>
      left.type.localeCompare(right.type) || left.id.localeCompare(right.id)
    );
}

/** Normalized canonical source fingerprint for one resolved artifact. */
export interface ResolvedArtifactFingerprint {
  readonly fingerprint: string;
  readonly reference: ArtifactReference;
}

export interface WorkspaceInputs {
  readonly fingerprints: readonly ResolvedArtifactFingerprint[];
  readonly hash: string;
}

export interface HashWorkspaceInputsOptions {
  /**
   * Invocation-scoped Skill package reader. When omitted, each Skill package is
   * read directly from the filesystem.
   */
  readonly readSkillPackage?: (
    skill: Skill,
  ) => Promise<readonly ProposedDirectoryMember[]>;
}

/** Deterministic normalized fingerprint for one Context Module's source content. */
function fingerprintContextContent(content: string): string {
  return sha256(JSON.stringify({ content }));
}

/** Deterministic normalized fingerprint for one Skill package tree (sidecar excluded). */
function fingerprintSkillInput(input: unknown): string {
  return sha256(JSON.stringify(input));
}

export async function hashWorkspaceInputs(
  profile: Profile,
  resolvedProfile: ResolvedProfile,
  options: HashWorkspaceInputsOptions = {},
): Promise<WorkspaceInputs> {
  const fingerprints: ResolvedArtifactFingerprint[] = [];
  const readSkillPackage = options.readSkillPackage ?? skillPackageMembers;
  // Hash Host package contents separately from dependency/inclusion semantics.
  // Sidecar file bytes are omitted so formatting noise does not force reinstalls,
  // but normalized dependencies and inclusion reasons must participate so Manifest
  // reasons stay fresh when only a redundant dependency edge changes.
  const resolvedArtifacts = await Promise.all(
    resolvedProfile.artifacts.map(async (resolved) => {
      if (resolved.reference.type === "context") {
        const context = resolved.artifact as ContextModule;
        fingerprints.push({
          fingerprint: fingerprintContextContent(context.content),
          reference: resolved.reference,
        });
        return {
          content: context.content,
          dependencies: normalizedDependencies(context.dependencies),
          id: context.id,
          inclusion_reasons: normalizedInclusionReasons(resolved.inclusionReasons),
          type: "context" as const,
        };
      }
      const skill = resolved.artifact as Skill;
      const input = skillInputFromMembers(skill, await readSkillPackage(skill));
      fingerprints.push({
        fingerprint: fingerprintSkillInput(input),
        reference: resolved.reference,
      });
      return {
        dependencies: normalizedDependencies(skill.dependencies),
        id: skill.id,
        inclusion_reasons: normalizedInclusionReasons(resolved.inclusionReasons),
        input,
        type: "skill" as const,
      };
    }),
  );
  return {
    fingerprints,
    hash: sha256(
      JSON.stringify({
        resolved_artifacts: resolvedArtifacts,
        profile: {
          agents: profile.agents,
          context: profile.context,
          hooks: profile.hooks,
          id: profile.id,
          skills: profile.skills,
          tools: profile.tools,
        },
        workspace_schema_version: WORKSPACE_SCHEMA_VERSION,
      }),
    ),
  };
}

export async function hashOutputDirectory(
  root: string,
  ignoredFiles: readonly string[] = ["installation.yaml"],
): Promise<string> {
  const hash = createHash("sha256");

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(compareNames);
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (ignoredFiles.includes(relativePath)) continue;
      const path = join(directory, entry.name);
      const mode = (await lstat(path)).mode & 0o7777;
      if (entry.isDirectory()) {
        writeFrame(hash, "directory");
        writeFrame(hash, relativePath);
        writeFrame(hash, String(mode));
        await visit(path, relativePath);
        continue;
      }
      if (entry.isFile()) {
        writeFrame(hash, "file");
        writeFrame(hash, relativePath);
        writeFrame(hash, String(mode));
        writeFrame(hash, await readFile(path));
        continue;
      }
      throw new Error(`Generated output contains unsupported entry '${relativePath}'`);
    }
  }

  await visit(root, "");
  return `sha256:${hash.digest("hex")}`;
}
