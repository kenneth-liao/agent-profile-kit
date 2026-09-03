import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ContextModule,
  parseContextModule,
  parseProfile,
  type Profile,
} from "../schemas/context-profile.js";
import { parseSkill, type Skill } from "../schemas/skill.js";
import { resolveProfileDependencies, validateDependencyCatalog } from "./resolve-dependencies.js";
import { validateWorkspaceStructure, workspacePath } from "./workspace.js";
import { InstallerToolError } from "./tool-errors.js";

export interface Workspace {
  /** Canonical (realpath) Workspace root used for identity and artifact reads. */
  readonly path: string;
  readonly contexts: ReadonlyMap<string, ContextModule>;
  readonly profiles: ReadonlyMap<string, Profile>;
  readonly skills: ReadonlyMap<string, Skill>;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Read directory entries; a missing category directory is an empty collection. */
async function readCategoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

async function skillPaths(directory: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readCategoryEntries(directory);
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = join(prefix, entry.name);
      if (!entry.isDirectory()) return [];
      const source = join(directory, entry.name);
      const nested = await skillPaths(source, relativePath);
      const children = await readdir(source, { withFileTypes: true });
      return children.some((child) => child.isFile() && child.name === "SKILL.md")
        ? [relativePath, ...nested]
        : nested;
    }),
  );
  return paths.flat().sort();
}

async function sourceFiles(
  directory: string,
  extension: string,
  prefix = "",
): Promise<readonly string[]> {
  const entries = await readCategoryEntries(directory);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = join(prefix, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(join(directory, entry.name), extension, relativePath);
      }
      return entry.isFile() && entry.name.endsWith(extension) ? [relativePath] : [];
    }),
  );
  return files.flat().sort();
}

function addUnique<T extends { readonly id: string }>(
  entries: Map<string, T>,
  entry: T,
  artifactType: string,
): void {
  if (entries.has(entry.id)) {
    throw new InstallerToolError({
      kind: "duplicate-artifact-name",
      artifactType,
      id: entry.id,
    });
  }
  entries.set(entry.id, entry);
}

/**
 * Ingest a Workspace at an already-resolved path (typically the canonical
 * realpath from Local Configuration resolution). When given a home directory
 * path that still needs the fixed default layout, pass `workspacePath(home)`.
 */
export async function ingestWorkspace(path: string): Promise<Workspace> {
  await validateWorkspaceStructure(path);
  const contexts = new Map<string, ContextModule>();
  const profiles = new Map<string, Profile>();
  const skills = new Map<string, Skill>();

  for (const name of await sourceFiles(join(path, "context"), ".md")) {
    const sourcePath = join(path, "context", name);
    addUnique(
      contexts,
      parseContextModule(await readFile(sourcePath, "utf8"), `context/${name}`),
      "Context Module",
    );
  }
  for (const name of await sourceFiles(join(path, "profiles"), ".yaml")) {
    const sourcePath = join(path, "profiles", name);
    addUnique(
      profiles,
      parseProfile(await readFile(sourcePath, "utf8"), `profiles/${name}`),
      "Profile",
    );
  }
  for (const name of await skillPaths(join(path, "skills"))) {
    const sourcePath = join(path, "skills", name);
    let sidecar: string | undefined;
    try {
      sidecar = await readFile(join(sourcePath, "agent-profile-kit.yaml"), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    addUnique(
      skills,
      parseSkill(
        await readFile(join(sourcePath, "SKILL.md"), "utf8"),
        `skills/${name}/SKILL.md`,
        sourcePath,
        sidecar,
      ),
      "Skill",
    );
  }

  validateDependencyCatalog(contexts, skills);
  for (const profile of profiles.values()) {
    // At least one currently supported artifact category must be selected. No single
    // category (including Context) is mandatory; empty Profiles fail at ingestion.
    if (profile.context.length === 0 && profile.skills.length === 0) {
      throw new InstallerToolError({
        kind: "profile-without-artifacts",
        profile: profile.id,
      });
    }
    for (const contextId of profile.context) {
      if (!contexts.has(contextId)) {
        throw new InstallerToolError({
          kind: "missing-context-reference",
          profile: profile.id,
          contextId,
        });
      }
    }
    for (const skillId of profile.skills) {
      if (!skills.has(skillId)) {
        throw new InstallerToolError({
          kind: "missing-skill-reference",
          profile: profile.id,
          skillId,
        });
      }
    }
    resolveProfileDependencies(profile, contexts, skills);
  }

  return { path, contexts, profiles, skills };
}

/** Ingest the fixed-default Workspace for a home directory (tests and init helpers). */
export async function ingestDefaultWorkspace(home: string): Promise<Workspace> {
  return ingestWorkspace(workspacePath(home));
}
