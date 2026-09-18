import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ContextModule,
  parseContextModule,
  parseProfile,
  type Profile,
} from "../schemas/context-profile.js";
import { parseSkill, SKILL_PACKAGE_SIDECAR, type Skill } from "../schemas/skill.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import {
  collectWorkspaceStructure,
  validateWorkspaceStructure,
  SKILL_FILE_NAME,
  skillEntryRelativePath,
} from "./workspace.js";
import {
  InstallerToolError,
  type CreationArtifactType,
  type WorkspaceViolation,
  type WorkspaceViolationsFact,
} from "./tool-errors.js";

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

/**
 * Find the first retired Skill sidecar entry under one Skill package root,
 * depth-first in sorted order; a package that does not contain one yields
 * undefined. Symlinked directories are not traversed: packages are read from
 * regular files and directories only.
 */
async function findSkillSidecar(directory: string, prefix: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sorted) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name === SKILL_PACKAGE_SIDECAR) return relative;
    if (entry.isDirectory()) {
      const nested = await findSkillSidecar(join(directory, entry.name), relative);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Find the first `.yaml` file under one `profiles/` subdirectory, depth-first
 * in sorted order; a subdirectory without one yields undefined. Symlinked
 * directories are not traversed, matching the Skill-package reader's
 * regular-files-and-directories boundary.
 */
async function findNestedProfileYaml(directory: string, prefix: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  });
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sorted) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isFile() && entry.name.endsWith(".yaml")) return relative;
    if (entry.isDirectory()) {
      const nested = await findNestedProfileYaml(join(directory, entry.name), relative);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
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
      return children.some((child) => child.isFile() && child.name === SKILL_FILE_NAME)
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

/**
 * Ingest one artifact into its category, refusing a repeated Artifact ID. The
 * duplicate fact carries the existing artifact's Workspace-relative canonical
 * file as its `path`, derived from the already-stored record — the entries map
 * stays the one home for that locator (#508). `locatorOf` exists because the
 * Skill record's `path` is the absolute source directory, while Context Module
 * and Profile records carry the workspace-relative file directly.
 */
function addUnique<T extends { readonly id: string; readonly path: string }>(
  entries: Map<string, T>,
  entry: T,
  artifactType: CreationArtifactType,
  locatorOf: (existing: T) => string,
): void {
  const existing = entries.get(entry.id);
  if (existing !== undefined) {
    throw new InstallerToolError({
      kind: "duplicate-artifact-name",
      artifactType,
      id: entry.id,
      path: locatorOf(existing),
    });
  }
  entries.set(entry.id, entry);
}

/**
 * Normalize one caught rejection into a collected violation. Only
 * Installer-authored typed facts and portable-schema rejections are
 * violations; anything else (an I/O failure, for example) is not a contract
 * violation and propagates (fail fast, DEC-009).
 */
function collectedViolation(error: unknown): WorkspaceViolation {
  if (error instanceof InstallerToolError && error.fact.kind === "duplicate-artifact-name") {
    return { via: "ingestion", fact: error.fact };
  }
  if (error instanceof SchemaRejectionError) {
    if (error.reason.schema === "workspace-manifest") {
      return { via: "manifest", detail: error.reason.detail };
    }
    if (error.reason.schema === "workspace-artifact") {
      return { via: "artifact", detail: error.reason.detail };
    }
  }
  throw error;
}

/**
 * Ingest a Workspace at an already-resolved path (typically the canonical
 * realpath from Local Configuration resolution).
 * `manifestSource` has the same meaning as in `validateWorkspaceStructure`:
 * setup's write-free validation of a manifest-missing folder.
 */
export async function ingestWorkspace(path: string, manifestSource?: string): Promise<Workspace> {
  const { violations, workspace } = await collectWorkspaceViolations(path, manifestSource);
  if (workspace !== undefined) return workspace;
  const fact: WorkspaceViolationsFact = {
    kind: "workspace-violations",
    workspace: path,
    violations,
  };
  throw new InstallerToolError(fact);
}

/** The collected outcome of one full Workspace ingestion run (#604). */
export interface WorkspaceViolationCollection {
  /** Every violation, in deterministic collection order; empty when valid. */
  readonly violations: readonly WorkspaceViolation[];
  /** The ingested Workspace; absent when any violation was collected. */
  readonly workspace?: Workspace;
}

/**
 * Collect every Workspace violation in one run (spec #593 DEC-009, #604):
 * each stage records what it finds and continues, so one run names the
 * complete repair list. Stage order is fixed (structure, then context,
 * profiles, skills, then Profile reference checks; sorted within each
 * stage), so the report is deterministic. Unexpected failures — unreadable
 * files, I/O errors — are not contract violations and propagate.
 */
export async function collectWorkspaceViolations(
  path: string,
  manifestSource?: string,
): Promise<WorkspaceViolationCollection> {
  const violations: WorkspaceViolation[] = [];
  const structure = await collectWorkspaceStructure(path, manifestSource);
  violations.push(...structure.violations);
  const contexts = new Map<string, ContextModule>();
  const profiles = new Map<string, Profile>();
  const skills = new Map<string, Skill>();

  if (structure.readableCategories.has("context")) {
    for (const name of await sourceFiles(join(path, "context"), ".md")) {
      const relativePath = `context/${name}`;
      try {
        addUnique(
          contexts,
          parseContextModule(await readFile(join(path, relativePath), "utf8"), relativePath),
          "Context Module",
          (existing) => existing.path,
        );
      } catch (error) {
        violations.push(collectedViolation(error));
      }
    }
  }

  // Profiles live directly in `profiles/` (spec #593 DEC-014, #598): each
  // Profile's ID is its top-level file name without `.yaml`, so nested
  // folders hold no Profiles. Every `.yaml` under a subdirectory is one
  // violation naming its path — a moved Profile is never silently ignored.
  // Other stray entries under `profiles/` are DEC-008's violations (#605).
  // Entries are visited in sorted order so the report is deterministic.
  if (structure.readableCategories.has("profiles")) {
    const profileEntries = (await readCategoryEntries(join(path, "profiles")))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of profileEntries) {
      if (entry.isFile() && entry.name.endsWith(".yaml")) {
        const relativePath = `profiles/${entry.name}`;
        try {
          addUnique(
            profiles,
            parseProfile(await readFile(join(path, relativePath), "utf8"), relativePath),
            "Profile",
            (existing) => existing.path,
          );
        } catch (error) {
          violations.push(collectedViolation(error));
        }
        continue;
      }
      if (entry.isDirectory()) {
        const nested = await findNestedProfileYaml(join(path, "profiles", entry.name), entry.name);
        if (nested !== undefined) {
          violations.push({ via: "ingestion", fact: { kind: "nested-profile", file: `profiles/${nested}` } });
        }
      }
    }
  }

  if (structure.readableCategories.has("skills")) {
    for (const name of await skillPaths(join(path, "skills"))) {
      const sourcePath = join(path, "skills", name);
      const relativePath = skillEntryRelativePath(path, sourcePath);
      // A retired Agent Profile Kit sidecar anywhere inside a Skill package is
      // one violation naming its file (spec #593 DEC-006): Profile lists are
      // the only source of what is installed, so the sidecar has no reader
      // left, and a nested copy would otherwise project into Host output.
      const nested = await findSkillSidecar(sourcePath, "");
      if (nested !== undefined) {
        violations.push({
          via: "ingestion",
          fact: { kind: "leftover-skill-sidecar", file: `skills/${name}/${nested}` },
        });
      }
      try {
        addUnique(
          skills,
          parseSkill(
            await readFile(join(sourcePath, SKILL_FILE_NAME), "utf8"),
            relativePath,
            sourcePath,
          ),
          "Skill",
          (existing) => skillEntryRelativePath(path, existing.path),
        );
      } catch (error) {
        violations.push(collectedViolation(error));
      }
    }
  }

  for (const profile of profiles.values()) {
    // At least one currently supported artifact category must be selected. No single
    // category (including Context) is mandatory; empty Profiles fail at ingestion.
    if (profile.context.length === 0 && profile.skills.length === 0) {
      violations.push({
        via: "ingestion",
        fact: {
          kind: "profile-without-artifacts",
          profile: profile.id,
          file: profile.path,
          availableContexts: [...contexts.keys()].sort(),
          availableSkills: [...skills.keys()].sort(),
        },
      });
    }
    for (const contextId of profile.context) {
      if (!contexts.has(contextId)) {
        violations.push({
          via: "ingestion",
          fact: {
            kind: "missing-context-reference",
            profile: profile.id,
            contextId,
            file: profile.path,
            available: [...contexts.keys()].sort(),
          },
        });
      }
    }
    for (const skillId of profile.skills) {
      if (!skills.has(skillId)) {
        violations.push({
          via: "ingestion",
          fact: {
            kind: "missing-skill-reference",
            profile: profile.id,
            skillId,
            file: profile.path,
            available: [...skills.keys()].sort(),
          },
        });
      }
    }
  }

  return {
    violations,
    ...(violations.length === 0 ? { workspace: { path, contexts, profiles, skills } } : {}),
  };
}
