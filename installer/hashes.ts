import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProposedDirectoryMember } from "../adapters/project-plan.js";
import { skillPackageMembers } from "../adapters/skill-package.js";
import { type ContextModule, type Profile } from "../schemas/context-profile.js";
import { type Skill } from "../schemas/skill.js";
import { type ArtifactReference } from "../schemas/dependencies.js";
import { type ResolvedProfile } from "./resolve-profile.js";
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

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Rebuild the historical Skill-input tree order: depth-first visitation of
 * code-point-sorted child names at each level. Global locale-aware path sorts
 * (e.g. localeCompare putting `scripts` before `SKILL.md`) must not change
 * workspace input hashes or artifact fingerprints for unchanged packages.
 */
function skillInputFromMembers(
  skill: Skill,
  members: readonly ProposedDirectoryMember[],
): unknown {
  const byPath = new Map(members.map((member) => [member.path, member]));
  const entries: unknown[] = [];

  function childNames(prefix: string): readonly string[] {
    const names = new Set<string>();
    const rooted = prefix.length === 0 ? "" : `${prefix}/`;
    for (const member of members) {
      if (prefix.length === 0) {
        names.add(member.path.split("/")[0]!);
        continue;
      }
      if (!member.path.startsWith(rooted)) continue;
      names.add(member.path.slice(rooted.length).split("/")[0]!);
    }
    return [...names].sort(comparePaths);
  }

  function visit(prefix: string): void {
    for (const name of childNames(prefix)) {
      const path = prefix.length === 0 ? name : `${prefix}/${name}`;
      const member = byPath.get(path);
      if (member === undefined) {
        throw new Error(
          `Skill '${skill.id}' package is missing tree entry '${path}' required for fingerprinting`,
        );
      }
      if (member.type === "directory") {
        entries.push({ mode: member.mode, path, type: "directory" as const });
        visit(path);
        continue;
      }
      entries.push({
        content: sha256(member.bytes),
        mode: member.mode,
        path,
        type: "file" as const,
      });
    }
  }

  visit("");
  return { files: entries, id: skill.id };
}

async function skillInput(skill: Skill): Promise<unknown> {
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

/** Deterministic normalized fingerprint for one Skill package tree. */
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
  // Hash Host package contents separately from Profile selection semantics.
  // A Profile's explicit `context` and `skills` lists and each artifact's
  // content are the desired inputs; no dependency or inclusion-reason data
  // exists to participate (spec #593 DEC-006).
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
          id: context.id,
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
        id: skill.id,
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
          context: profile.context,
          id: profile.id,
          skills: profile.skills,
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
