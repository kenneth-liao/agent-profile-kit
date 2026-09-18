import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";

import {
  type ContextModule,
  parseContextModule,
  parseProfileCollected,
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
 * undefined. Hidden entries are skipped without traversal (spec #593 DEC-008,
 * #605). Symlinked directories are not traversed: packages are read from
 * regular files and directories only.
 */
async function findSkillSidecar(directory: string, prefix: string): Promise<string | undefined> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of sorted) {
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.name === SKILL_PACKAGE_SIDECAR) return relative;
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      const nested = await findSkillSidecar(join(directory, entry.name), relative);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/**
 * Find every `.yaml` file under one `profiles/` subdirectory, depth-first in
 * sorted order; a subdirectory without one yields none. Every instance is a
 * `nested-profile` violation (spec #593 DEC-014, #598; collection extended to
 * all instances by #605), so a moved Profile is never silently ignored.
 * Hidden entries are skipped without traversal (spec #593 DEC-008, #605).
 * Symlinked directories are not traversed, matching the Skill-package
 * reader's regular-files-and-directories boundary.
 */
async function findNestedProfileYamls(directory: string, prefix: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return [];
    throw error;
  });
  const found: string[] = [];
  for (const entry of [...entries].sort(byEntryName)) {
    if (entry.name.startsWith(".")) continue;
    const relative = `${prefix}/${entry.name}`;
    if (entry.isFile() && entry.name.endsWith(".yaml")) {
      found.push(relative);
      continue;
    }
    if (entry.isDirectory()) {
      found.push(...(await findNestedProfileYamls(join(directory, entry.name), relative)));
    }
  }
  return found;
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

/** The one entry-name comparator for the deterministic collected report. */
function byEntryName(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

/**
 * One non-hidden stray entry found by {@link collectStrayEntries}: a regular
 * file or symlink that its folder's rule rejects (spec #593 DEC-008, #605).
 */
interface StrayEntry {
  readonly relative: string;
  readonly symlink: boolean;
}

/**
 * Walk one directory depth-first in sorted order, collecting every non-hidden
 * entry that `isStray` rejects (spec #593 DEC-008, #605). Hidden entries are
 * skipped without traversal; real directories always recurse and are never
 * themselves strays; symlinks are judged at the entry itself and never
 * followed. Empty folders therefore violate nothing: DEC-008's rules bind
 * files.
 */
async function collectStrayEntries(
  directory: string,
  prefix: string,
  isStray: (entry: Dirent) => boolean,
): Promise<readonly StrayEntry[]> {
  const entries = (await readCategoryEntries(directory)).sort(byEntryName);
  const strays: StrayEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix.length === 0 ? entry.name : `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      strays.push(
        ...(await collectStrayEntries(join(directory, entry.name), `${relative}/`, isStray)),
      );
      continue;
    }
    if (isStray(entry)) strays.push({ relative, symlink: entry.isSymbolicLink() });
  }
  return strays.sort((left, right) => left.relative.localeCompare(right.relative));
}

/** The classification of one `skills/` subtree (spec #593 DEC-008, #605). */
interface SkillTerritoryWalk {
  /** Skill-package directories, workspace-relative to the category, sorted. */
  readonly packages: readonly string[];
  /** Non-hidden entries in non-package territory, sorted. */
  readonly strays: readonly StrayEntry[];
}

/**
 * Walk one `skills/` subtree in sorted order, classifying territory (spec #593
 * DEC-008, #605). A real directory directly containing a regular `SKILL.md` is
 * a Skill package: its path is collected exactly as before, its subtree stays
 * package territory (nested-package detection keeps its current semantics),
 * and a real directory without one is a grouping folder that recurses with the
 * same classification. Hidden entries are skipped without traversal. In
 * non-package territory every non-hidden regular file or symlink is a stray;
 * package territory has no per-file rule, so Skill Resources stay valid.
 */
async function walkSkillsTerritory(
  directory: string,
  prefix: string,
  insidePackage: boolean,
): Promise<SkillTerritoryWalk> {
  const entries = (await readCategoryEntries(directory)).sort(byEntryName);
  const packages: string[] = [];
  const strays: StrayEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      const children = await readdir(join(directory, entry.name), { withFileTypes: true });
      const isPackage = children.some((child) => child.isFile() && child.name === SKILL_FILE_NAME);
      if (isPackage) packages.push(relative);
      const nested = await walkSkillsTerritory(
        join(directory, entry.name),
        relative,
        insidePackage || isPackage,
      );
      packages.push(...nested.packages);
      strays.push(...nested.strays);
      continue;
    }
    if (!insidePackage) strays.push({ relative, symlink: entry.isSymbolicLink() });
  }
  return { packages: packages.sort((left, right) => left.localeCompare(right)), strays: strays.sort((left, right) => left.relative.localeCompare(right.relative)) };
}

/**
 * The stray-file fact for one collected entry (spec #593 DEC-008, #605):
 * `symlink` is set only when true, so file strays carry no flag noise.
 */
function strayViolation(
  kind: "stray-context-file" | "stray-skill-file" | "stray-profile-file",
  file: string,
  symlink: boolean,
): WorkspaceViolation {
  return {
    via: "ingestion",
    fact: { kind, file, ...(symlink ? { symlink: true } : {}) },
  };
}

/**
 * The one acceptance predicate for a Context Module entry: a regular file
 * whose name ends in `.md` (spec #593 DEC-008, #600). One home shared by the
 * collector that ingests and the stray check that rejects, so the rule cannot
 * drift between what is read and what is reported.
 */
function isRegularMarkdownEntry(entry: Dirent): boolean {
  return entry.isFile() && entry.name.endsWith(".md");
}

/**
 * Collect the Context Module files under one directory, depth-first in sorted
 * order, skipping hidden entries without traversal (spec #593 DEC-008, #605).
 * Acceptance is {@link isRegularMarkdownEntry}; strays are reported separately
 * by the stray walk.
 */
async function sourceFiles(directory: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readCategoryEntries(directory);
  const files = await Promise.all(
    entries.map(async (entry) => {
      // Hidden files and folders are ignored everywhere (spec #593 DEC-008, #605).
      if (entry.name.startsWith(".")) return [];
      const relativePath = join(prefix, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(join(directory, entry.name), relativePath);
      }
      return isRegularMarkdownEntry(entry) ? [relativePath] : [];
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
  const collection = await collectWorkspaceViolations(path, manifestSource);
  if (collection.outcome === "valid") return collection.workspace;
  throw workspaceViolationsError(path, collection.violations);
}

/** The one aggregate rejection for an invalid Workspace: the complete collected list. */
function workspaceViolationsError(path: string, violations: readonly WorkspaceViolation[]): InstallerToolError {
  const fact: WorkspaceViolationsFact = {
    kind: "workspace-violations",
    workspace: path,
    violations,
  };
  return new InstallerToolError(fact);
}

/** One Profile's missing references, grouped for lifecycle Blocker evidence (#606). */
export interface BrokenProfileReference {
  readonly profile: string;
  /** Workspace-relative Profile file that authored the invalid references. */
  readonly file: string;
  /** Sorted Context Module Artifact IDs the Profile names but the Workspace lacks. */
  readonly missingContexts: readonly string[];
  /** Sorted Skill Artifact IDs the Profile names but the Workspace lacks. */
  readonly missingSkills: readonly string[];
}

/**
 * Whether one collected violation is a Profile reference violation (spec #593
 * DEC-009 project scope, #606). #604's collecting parser is the one
 * classification home: this predicate only reuses its `missing-context-reference`
 * and `missing-skill-reference` ingestion facts, so the reference/artifact
 * distinction cannot drift between validation and lifecycle blocking.
 */
export function isProfileReferenceViolation(violation: WorkspaceViolation): boolean {
  return violation.via === "ingestion" &&
    (violation.fact.kind === "missing-context-reference" ||
      violation.fact.kind === "missing-skill-reference");
}

/**
 * The tolerant lifecycle ingestion outcome (spec #593 US-007, #606): the
 * Workspace plus the grouped missing references of every broken Profile.
 */
export interface TolerantWorkspaceIngestion {
  readonly workspace: Workspace;
  /** One grouped fact per broken Profile, sorted by Profile ID. */
  readonly brokenProfiles: readonly BrokenProfileReference[];
  /** The original collected reference facts, verbatim from the #604 parser. */
  readonly referenceViolations: readonly WorkspaceViolation[];
}

/**
 * Ingest a Workspace for the lifecycle commands (spec #593 DEC-009 project
 * scope, #606): Profile reference violations do not invalidate the Workspace —
 * the commands block only the Projects bound to the broken Profile — while
 * every other violation keeps the Workspace invalid for every command and
 * throws the identical aggregate fact strict {@link ingestWorkspace} throws.
 * The classification itself is never re-derived here: #604's collected facts
 * are partitioned by {@link isProfileReferenceViolation}.
 */
export async function ingestWorkspaceToleratingReferenceViolations(
  path: string,
): Promise<TolerantWorkspaceIngestion> {
  const contents = await collectWorkspaceContents(path);
  const referenceViolations = contents.violations.filter(isProfileReferenceViolation);
  if (contents.violations.length === 0) {
    return {
      workspace: { path, contexts: contents.contexts, profiles: contents.profiles, skills: contents.skills },
      brokenProfiles: [],
      referenceViolations: [],
    };
  }
  if (referenceViolations.length !== contents.violations.length) {
    throw workspaceViolationsError(path, contents.violations);
  }
  const broken = new Map<string, {
    file: string;
    missingContexts: Set<string>;
    missingSkills: Set<string>;
  }>();
  for (const violation of referenceViolations) {
    if (violation.via !== "ingestion") continue;
    const fact = violation.fact;
    if (fact.kind !== "missing-context-reference" && fact.kind !== "missing-skill-reference") continue;
    let entry = broken.get(fact.profile);
    if (entry === undefined) {
      entry = { file: fact.file, missingContexts: new Set(), missingSkills: new Set() };
      broken.set(fact.profile, entry);
    }
    if (fact.kind === "missing-context-reference") {
      entry.missingContexts.add(fact.contextId);
    } else {
      entry.missingSkills.add(fact.skillId);
    }
  }
  const brokenProfiles = [...broken.entries()].map(([profile, entry]) => ({
    profile,
    file: entry.file,
    missingContexts: [...entry.missingContexts].sort(),
    missingSkills: [...entry.missingSkills].sort(),
  }));
  brokenProfiles.sort((left, right) => left.profile.localeCompare(right.profile));
  return {
    workspace: { path, contexts: contents.contexts, profiles: contents.profiles, skills: contents.skills },
    brokenProfiles,
    referenceViolations,
  };
}

/**
 * The collected outcome of one full Workspace ingestion run (#604): either a
 * fully ingested Workspace or the complete violation list — never both.
 */
export type WorkspaceViolationCollection =
  | { readonly outcome: "valid"; readonly workspace: Workspace }
  | { readonly outcome: "invalid"; readonly violations: readonly WorkspaceViolation[] };

/**
 * The internal collection result: the complete violation list plus every
 * parsed artifact map, so tolerant lifecycle ingestion (#606) can build the
 * lenient Workspace when only Profile reference violations were collected.
 */
interface CollectedWorkspaceContents {
  readonly violations: readonly WorkspaceViolation[];
  readonly contexts: ReadonlyMap<string, ContextModule>;
  readonly profiles: ReadonlyMap<string, Profile>;
  readonly skills: ReadonlyMap<string, Skill>;
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
  const contents = await collectWorkspaceContents(path, manifestSource);
  return contents.violations.length === 0
    ? {
      outcome: "valid",
      workspace: {
        path,
        contexts: contents.contexts,
        profiles: contents.profiles,
        skills: contents.skills,
      },
    }
    : { outcome: "invalid", violations: contents.violations };
}

async function collectWorkspaceContents(
  path: string,
  manifestSource?: string,
): Promise<CollectedWorkspaceContents> {
  const violations: WorkspaceViolation[] = [];
  /** Profile files whose field-level problems were recorded this run. */
  let lenientProfilePaths: ReadonlySet<string> = new Set();
  const structure = await collectWorkspaceStructure(path, manifestSource);
  violations.push(...structure.violations);
  const contexts = new Map<string, ContextModule>();
  const profiles = new Map<string, Profile>();
  const skills = new Map<string, Skill>();

  if (structure.readableCategories.has("context")) {
    for (const name of await sourceFiles(join(path, "context"))) {
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
    // Stray entries (spec #593 DEC-008, #605): under `context/` every
    // non-hidden entry must be a regular `.md` file, so anything else —
    // including a symlink, which is never followed — is one violation naming
    // its path. `.md` collection above already ignores everything else.
    for (const stray of await collectStrayEntries(
      join(path, "context"),
      "",
      (entry) => !isRegularMarkdownEntry(entry),
    )) {
      violations.push(strayViolation("stray-context-file", `context/${stray.relative}`, stray.symlink));
    }
  }

  // Profiles live directly in `profiles/` (spec #593 DEC-014, #598): each
  // Profile's ID is its top-level file name without `.yaml`, so nested
  // folders hold no Profiles. Every `.yaml` under a subdirectory is one
  // violation naming its path — a moved Profile is never silently ignored.
  // Other stray entries under `profiles/` are DEC-008's violations (#605):
  // every non-hidden file must be a `.yaml` Profile directly under
  // `profiles/`, including under subfolders, and a symlink is never followed.
  // Hidden entries are ignored without traversal (DEC-008). Entries are
  // visited in sorted order so the report is deterministic.
  if (structure.readableCategories.has("profiles")) {
    const profileEntries = (await readCategoryEntries(join(path, "profiles"))).sort(byEntryName);
    // Profiles whose field-level problems were recorded still register when
    // their lists stayed readable, so their references are checked in the
    // same run (spec #593 DEC-009, #604, PR #622 INT-1); the reported ID is
    // the file name, never an authored `id` field.
    const lenientProfiles = new Set<string>();
    for (const entry of profileEntries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isFile() && entry.name.endsWith(".yaml")) {
        const relativePath = `profiles/${entry.name}`;
        try {
          const collected = parseProfileCollected(
            await readFile(join(path, relativePath), "utf8"),
            relativePath,
          );
          violations.push(...collected.violations.map((detail) => ({ via: "artifact", detail }) as const));
          if (collected.profile !== undefined) {
            if (collected.violations.length > 0) lenientProfiles.add(collected.profile.path);
            addUnique(
              profiles,
              collected.profile,
              "Profile",
              (existing) => existing.path,
            );
          }
        } catch (error) {
          violations.push(collectedViolation(error));
        }
        continue;
      }
      if (entry.isDirectory()) {
        for (const nested of await findNestedProfileYamls(join(path, "profiles", entry.name), entry.name)) {
          violations.push({ via: "ingestion", fact: { kind: "nested-profile", file: `profiles/${nested}` } });
        }
        // Under `profiles/` every non-hidden file must be a `.yaml` Profile
        // (spec #593 DEC-008, #605): a non-`.yaml` file or symlink inside a
        // subfolder is a stray; nested `.yaml` files were handled above, and
        // an empty subfolder violates nothing.
        for (const stray of await collectStrayEntries(
          join(path, "profiles", entry.name),
          `${entry.name}/`,
          (candidate) => !(candidate.isFile() && candidate.name.endsWith(".yaml")),
        )) {
          violations.push(strayViolation("stray-profile-file", `profiles/${stray.relative}`, stray.symlink));
        }
        continue;
      }
      // A non-hidden regular file that is not `.yaml` — including `.yml`,
      // which DEC-008 does not accept — or a symlink (never followed).
      violations.push(
        strayViolation("stray-profile-file", `profiles/${entry.name}`, entry.isSymbolicLink()),
      );
    }
    lenientProfilePaths = lenientProfiles;
  }

  if (structure.readableCategories.has("skills")) {
    const walk = await walkSkillsTerritory(join(path, "skills"), "", false);
    // Under `skills/` every non-hidden entry must belong to a Skill package
    // (spec #593 DEC-008, #605): a regular file or symlink in non-package
    // territory is one violation naming its path; package territory has no
    // per-file rule.
    for (const stray of walk.strays) {
      violations.push(strayViolation("stray-skill-file", `skills/${stray.relative}`, stray.symlink));
    }
    for (const name of walk.packages) {
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
    // A Profile whose field-level problems were already reported skips this
    // shape check — its parse violations are the report, and its lists may
    // not have been fully readable (spec #593 DEC-009, #604).
    if (
      !lenientProfilePaths.has(profile.path) &&
      profile.context.length === 0 &&
      profile.skills.length === 0
    ) {
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
    contexts,
    profiles,
    skills,
  };
}
