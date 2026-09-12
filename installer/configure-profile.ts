import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseProfile, requireArtifactId } from "../schemas/context-profile.js";
import { ingestSelectedWorkspace } from "./local-configuration.js";
import { preserveSourceNewlines } from "./local-configuration-publication.js";
import { requireProfile } from "./profile-selection.js";
import { InstallerToolError } from "./tool-errors.js";
import { isMap, isSeq, parseDocument } from "yaml";

const PROFILE_EXTENSION = ".yaml";

export interface ConfigureProfileMembershipOptions {
  readonly home: string;
  /** Authored Profile name; must already exist (configure never creates). */
  readonly profile: string;
  /**
   * Requested full Context Module membership for the Profile. Present
   * replaces the category (present-with-zero-values empties it); omitted
   * leaves the category unchanged.
   */
  readonly contexts?: readonly string[];
  /** Requested full Skill membership; same present/omitted contract. */
  readonly skills?: readonly string[];
}

export interface ConfigureProfileMembershipResult {
  readonly id: string;
  /** Absolute path of the Profile file actually written (or read, when unchanged). */
  readonly path: string;
  readonly previousContexts: readonly string[];
  readonly previousSkills: readonly string[];
  readonly contexts: readonly string[];
  readonly skills: readonly string[];
  /** False when the requested membership already matched; nothing was written. */
  readonly changed: boolean;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Canonical membership order matches the sorted available-name guidance. */
function canonicalOrder(names: readonly string[]): readonly string[] {
  return [...names].sort();
}

function sameMembership(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * Change one Profile's Context and Skill membership through the single
 * validated publication path shared by the explicit and interactive
 * configure modes (spec #491 US-009, ticket #500). Each supplied category
 * replaces that category's membership; an omitted category is left
 * unchanged. Validation completes before any filesystem mutation, so an
 * invalid request leaves the Profile source byte-identical. Only the
 * `context`/`skills` value nodes of the canonical Profile file are
 * rewritten, preserving comments, key order, and the `id` line. Never
 * touches Local Configuration, Installation State, operation history, or
 * installed Project output: configure never installs or updates.
 */
export async function configureProfileMembership(
  options: ConfigureProfileMembershipOptions,
): Promise<ConfigureProfileMembershipResult> {
  const id = requireArtifactId(options.profile, "configure profile name");
  const workspace = await ingestSelectedWorkspace(options.home);
  const existing = requireProfile(workspace.profiles, id);

  const availableContexts = [...workspace.contexts.keys()].sort();
  const availableSkills = [...workspace.skills.keys()].sort();

  const nextContexts = options.contexts === undefined
    ? [...existing.context]
    : canonicalOrder(options.contexts);
  const nextSkills = options.skills === undefined
    ? [...existing.skills]
    : canonicalOrder(options.skills);

  if (nextContexts.length === 0 && nextSkills.length === 0) {
    throw new InstallerToolError({
      kind: "profile-without-artifacts",
      profile: id,
      availableContexts,
      availableSkills,
    });
  }
  const relativePath = `profiles/${id}${PROFILE_EXTENSION}`;
  if (options.contexts !== undefined) {
    for (const contextId of nextContexts) {
      if (!workspace.contexts.has(contextId)) {
        throw new InstallerToolError({
          kind: "missing-context-reference",
          profile: id,
          contextId,
          file: relativePath,
          available: availableContexts,
        });
      }
    }
  }
  if (options.skills !== undefined) {
    for (const skillId of nextSkills) {
      if (!workspace.skills.has(skillId)) {
        throw new InstallerToolError({
          kind: "missing-skill-reference",
          profile: id,
          skillId,
          file: relativePath,
          available: availableSkills,
        });
      }
    }
  }

  const profileFile = join(workspace.path, "profiles", `${id}${PROFILE_EXTENSION}`);
  const base = {
    id,
    path: profileFile,
    previousContexts: [...existing.context],
    previousSkills: [...existing.skills],
    contexts: nextContexts,
    skills: nextSkills,
  };

  // Per-category set comparison: an unchanged category keeps its authored
  // node (and hand ordering) byte-identical; only a changed set is
  // renormalized to canonical order.
  const contextsChanged = !sameMembership([...existing.context].sort(), nextContexts);
  const skillsChanged = !sameMembership([...existing.skills].sort(), nextSkills);
  if (!contextsChanged && !skillsChanged) {
    return { ...base, changed: false };
  }

  // Preflight the exact resulting membership through the canonical Profile
  // schema before any write, so invalid material (duplicated selections
  // included) can never be reported as success.
  const preflight = ["id: " + JSON.stringify(id)];
  preflight.push(nextContexts.length === 0 ? "context: []" : `context:\n${nextContexts.map((name) => `  - ${JSON.stringify(name)}\n`).join("")}`);
  preflight.push(nextSkills.length === 0 ? "skills: []" : `skills:\n${nextSkills.map((name) => `  - ${JSON.stringify(name)}\n`).join("")}`);
  parseProfile(`${preflight.join("\n")}\n`, relativePath);

  const entry = await lstat(profileFile).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw error;
  });
  // The symlink check precedes the regular-file check: lstat reports
  // isFile() false for links, so the order decides which refusal a
  // swapped-in link receives. Reachable only when the path changes
  // between ingestion and publication; the steady-state symlinked file
  // is invisible to ingestion and refuses earlier as a missing Profile.
  if (entry !== undefined && entry.isSymbolicLink()) {
    throw new InstallerToolError({
      kind: "profile-file-symlink",
      profile: id,
      path: profileFile,
    });
  }
  if (entry === undefined || !entry.isFile()) {
    throw new Error(
      `Profile '${id}' at ${profileFile} vanished before configure could save; re-run apkit configure profile ${id} to review the current membership`,
    );
  }
  const source = await readFile(profileFile, "utf8");

  // CST edit of only the changed membership nodes: comments, key order,
  // the `id` line, and unchanged categories survive byte-identical.
  const document = parseDocument(source);
  const contents: unknown = document.contents;
  if (!isMap(contents)) {
    throw new Error(`Profile ${profileFile} must be a mapping`);
  }
  const root = contents;
  const setMembership = (key: "context" | "skills", names: readonly string[]): void => {
    const node = root.get(key);
    if (!isSeq(node)) {
      throw new Error(`Profile ${profileFile} ${key} must be a sequence`);
    }
    const replacement = document.createNode(names.length === 0 ? [] : [...names]);
    if (isSeq(replacement) && names.length > 0) replacement.flow = false;
    root.set(key, replacement);
  };
  if (contextsChanged) setMembership("context", nextContexts);
  if (skillsChanged) setMembership("skills", nextSkills);
  const nextSource = preserveSourceNewlines(source, document.toString());

  // Changed-underfoot guard: refuse instead of overwriting a concurrent edit.
  const current = await readFile(profileFile, "utf8");
  if (current !== source) {
    throw new Error(
      `Profile ${profileFile} changed during configure; re-run apkit configure profile ${id} to review the current membership`,
    );
  }
  // Atomic replacement through a staging sibling: the staging file takes
  // the source mode so a rename never changes permissions, and every
  // failure removes it so no probe litters the profiles directory.
  const staging = `${profileFile}.apkit-configure-${process.pid}`;
  try {
    await writeFile(staging, nextSource);
    await chmod(staging, entry.mode & 0o777);
    await rename(staging, profileFile);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
  return { ...base, changed: true };
}
