import { chmod, lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseProfile, requireArtifactId } from "../schemas/context-profile.js";
import { ingestSelectedWorkspace } from "./local-configuration.js";
import { preserveSourceNewlines } from "./local-configuration-publication.js";
import { requireProfile } from "./profile-selection.js";
import { InstallerToolError } from "./tool-errors.js";
import { isMap, isSeq, parseDocument } from "yaml";

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

export interface ConfigureMembershipPlan {
  readonly nextContexts: readonly string[];
  readonly nextSkills: readonly string[];
  readonly contextsChanged: boolean;
  readonly skillsChanged: boolean;
}

/** The one membership plan both the CLI preview and the write path share. */
export function planConfigureMembership(input: {
  readonly profile: string;
  readonly file: string;
  readonly existingContexts: readonly string[];
  readonly existingSkills: readonly string[];
  readonly availableContexts: ReadonlySet<string>;
  readonly availableSkills: ReadonlySet<string>;
  readonly contexts?: readonly string[];
  readonly skills?: readonly string[];
}): ConfigureMembershipPlan {
  const availableContextNames = [...input.availableContexts].sort();
  const availableSkillNames = [...input.availableSkills].sort();
  const nextContexts = input.contexts === undefined
    ? [...input.existingContexts]
    : canonicalOrder(input.contexts);
  const nextSkills = input.skills === undefined
    ? [...input.existingSkills]
    : canonicalOrder(input.skills);
  if (nextContexts.length === 0 && nextSkills.length === 0) {
    throw new InstallerToolError({
      kind: "profile-without-artifacts",
      profile: input.profile,
      availableContexts: availableContextNames,
      availableSkills: availableSkillNames,
    });
  }
  if (input.contexts !== undefined) {
    for (const contextId of nextContexts) {
      if (!input.availableContexts.has(contextId)) {
        throw new InstallerToolError({
          kind: "missing-context-reference",
          profile: input.profile,
          contextId,
          file: input.file,
          available: availableContextNames,
        });
      }
    }
  }
  if (input.skills !== undefined) {
    for (const skillId of nextSkills) {
      if (!input.availableSkills.has(skillId)) {
        throw new InstallerToolError({
          kind: "missing-skill-reference",
          profile: input.profile,
          skillId,
          file: input.file,
          available: availableSkillNames,
        });
      }
    }
  }
  return {
    nextContexts,
    nextSkills,
    contextsChanged: input.contexts !== undefined
      && !sameMembership([...input.existingContexts].sort(), nextContexts),
    skillsChanged: input.skills !== undefined
      && !sameMembership([...input.existingSkills].sort(), nextSkills),
  };
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
  const plan = planConfigureMembership({
    profile: id,
    file: existing.path,
    existingContexts: existing.context,
    existingSkills: existing.skills,
    availableContexts: new Set(workspace.contexts.keys()),
    availableSkills: new Set(workspace.skills.keys()),
    ...(options.contexts === undefined ? {} : { contexts: options.contexts }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
  });
  const { nextContexts, nextSkills, contextsChanged, skillsChanged } = plan;
  const profileFile = join(workspace.path, existing.path);
  const base = {
    id,
    path: profileFile,
    previousContexts: [...existing.context],
    previousSkills: [...existing.skills],
    contexts: nextContexts,
    skills: nextSkills,
  };
  if (!contextsChanged && !skillsChanged) {
    return { ...base, changed: false };
  }

  // Preflight the exact resulting membership through the canonical Profile
  // schema before any write, so invalid material (duplicated selections
  // included) can never be reported as success.
  const preflight = ["id: " + JSON.stringify(id)];
  preflight.push(nextContexts.length === 0 ? "context: []" : `context:\n${nextContexts.map((name) => `  - ${JSON.stringify(name)}\n`).join("")}`);
  preflight.push(nextSkills.length === 0 ? "skills: []" : `skills:\n${nextSkills.map((name) => `  - ${JSON.stringify(name)}\n`).join("")}`);
  parseProfile(`${preflight.join("\n")}\n`, existing.path);

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

  // CST edit of the changed membership nodes. yaml Document.toString
  // normalizes quoting and indent of unrelated keys (same limitation as
  // publishBindingUnderLock host updates); comment text, key order, and
  // the id value survive. An unchanged category is not .set(), so its
  // membership set is untouched even when formatting around it reflows.
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
  const staging = join(
    dirname(profileFile),
    `.apkit-configure-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
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
