import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { lstat, readdir, readFile } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  parse as parsePath,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";

import { requireArtifactId } from "../schemas/dependencies.js";
import type { Skill } from "../schemas/skill.js";
import { composeContextEnvelope, type ContextModuleSource } from "./context-envelope.js";
import {
  planSkillPackageDirectory,
  skillsRequireDisabledModelInvocation,
  type SkillPackageProjection,
} from "./skill-package.js";
import type {
  AdapterProjectPlan,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";

const execFileAsync = promisify(execFile);

export const PI_ADAPTER_VERSION = "pi-project-v1";
export const PI_HOST_VERSION = "native-project-append-system-v1";
export const PI_HOST_VERSION_WITH_SKILLS = "native-project-skills-v1";
export const PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS =
  "native-project-append-system-skills-v1";
export const PI_MINIMUM_CLI_VERSION = "0.82.1";
export const PI_CONTEXT_PATH = posix.join(".pi", "APPEND_SYSTEM.md");
export const PI_DISABLED_MODEL_INVOCATION_UNSUPPORTED =
  "Pi Skill delivery cannot preserve disabled model invocation in this ticket; wait for successor Pi Skill ticket #104 before selecting Skills with disabled model invocation for a Pi binding";
export const PI_PROJECT_SKILLS_ROOT = posix.join(".pi", "skills");
export const PI_PERSONAL_SKILL_ROOTS = [
  posix.join(".pi", "agent", "skills"),
  posix.join(".agents", "skills"),
] as const;
export const PI_GLOBAL_SETTINGS_PATH = posix.join(".pi", "agent", "settings.json");
export const PI_PROJECT_SETTINGS_PATH = posix.join(".pi", "settings.json");

export const PI_CONTEXT_REQUIREMENTS = [
  "Pi loads project APPEND_SYSTEM.md as additive system Context",
  "Pi native trust and runtime overrides remain Host-owned",
] as const;

export type PiProjectPlan = AdapterProjectPlan;

export interface PiCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly projectBoundary?: string;
  readonly requireContext?: boolean;
  readonly requireDisabledModelInvocation?: boolean;
  readonly requireSkills?: boolean;
  readonly skillIds?: readonly string[];
  readonly resolveVersion?: () => Promise<string>;
}

export interface PiSkillOverlapOptions {
  readonly home?: string;
  readonly project: string;
  readonly projectBoundary?: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathKind(
  path: string,
): Promise<"missing" | "file" | "directory" | "symlink" | "other"> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isFile()) return "file";
    if (stats.isDirectory()) return "directory";
    return "other";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "missing";
    if (hasErrorCode(error, "ENOTDIR")) return "other";
    throw error;
  }
}

/** Return the first symlink below a trusted canonical base path, if any. */
async function symlinkAncestor(path: string, base: string): Promise<string | undefined> {
  const absolute = resolve(path);
  const canonicalBase = resolve(base);
  const descendant = relative(canonicalBase, absolute);
  if (descendant.startsWith("..") || isAbsolute(descendant)) return undefined;
  let current = canonicalBase;
  for (const component of descendant.split(sep).filter(Boolean)) {
    current = join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) return current;
      if (!stats.isDirectory() && current !== absolute) return undefined;
    } catch (error) {
      if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) return undefined;
      throw error;
    }
  }
  return undefined;
}

function piSkillOverlapBlocker(input: {
  readonly artifactId: string;
  readonly evidence: string;
  readonly proposedProjectPath: string;
}): string {
  return (
    `Pi Skill '${input.artifactId}' collides with selected Profile Skill: ` +
    `${input.evidence} would provide the same Host-visible identity as ` +
    `${input.proposedProjectPath}; remove or relocate the unmanaged Skill before applying`
  );
}

function piSkillInspectBlocker(path: string, detail: string): string {
  return (
    `Pi Skill discovery root at ${path} cannot be inspected sufficiently to prove absence ` +
    `of selected Skills (${detail}); remove the obstruction or make the path readable before applying`
  );
}

function parsePiSkillIdentity(source: string, path: string): string {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const delimiter = "---\n";
  if (!normalized.startsWith(delimiter)) {
    throw new Error(`Skill ${path} must start with YAML frontmatter`);
  }
  const closing = normalized.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw new Error(`Skill ${path} must close its YAML frontmatter`);
  }
  let header: unknown;
  try {
    header = parse(normalized.slice(delimiter.length, closing));
  } catch {
    throw new Error(`Skill ${path} frontmatter is invalid YAML`);
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new Error(`Skill ${path} frontmatter must be a YAML mapping`);
  }
  return requireArtifactId(
    (header as Record<string, unknown>).name,
    `Skill ${path} name`,
  );
}

function managedPiSkillPath(project: string, skillId: string): string {
  return resolve(project, ...PI_PROJECT_SKILLS_ROOT.split("/"), skillId);
}

function isManagedPiSkillPath(project: string, skillId: string, candidate: string): boolean {
  return resolve(candidate) === managedPiSkillPath(project, skillId);
}

interface PiSkillDiscoveryRoot {
  readonly label: string;
  readonly path: string;
  /** Existing `.md` files at this root are individual Pi Skills. */
  readonly directMarkdown: boolean;
  /** Trusted path immediately above the root; system-level symlinks are outside the proof. */
  readonly symlinkBase: string;
}

function piProjectSkillRoots(
  project: string,
  projectBoundary?: string,
): readonly PiSkillDiscoveryRoot[] {
  const canonicalProject = resolve(project);
  const boundary = resolve(projectBoundary ?? parsePath(canonicalProject).root);
  const boundaryRelative = relative(boundary, canonicalProject);
  if (
    boundaryRelative.startsWith("..") ||
    isAbsolute(boundaryRelative)
  ) {
    throw new Error(
      `Pi project Skill discovery boundary ${boundary} does not contain bound project ${canonicalProject}`,
    );
  }
  const roots: PiSkillDiscoveryRoot[] = [
    {
      label: "bound-project .pi/skills",
      path: join(canonicalProject, ...PI_PROJECT_SKILLS_ROOT.split("/")),
      directMarkdown: true,
      symlinkBase: canonicalProject,
    },
  ];
  let current = canonicalProject;
  while (true) {
    roots.push({
      label: `${current === canonicalProject ? "bound-project" : "ancestor"} .agents/skills`,
      path: join(current, ".agents", "skills"),
      directMarkdown: false,
      symlinkBase: current,
    });
    if (current === boundary) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

async function scanPiSkillRootForSelected(
  root: string,
  selected: ReadonlySet<string>,
  project: string,
  blockers: string[],
  label: string,
  base: string,
  directMarkdown: boolean,
): Promise<void> {
  try {
    const symlink = await symlinkAncestor(root, base);
    if (symlink !== undefined) {
      blockers.push(piSkillInspectBlocker(root, `path contains unprovable symlink ${symlink}`));
      return;
    }
  } catch (error) {
    blockers.push(piSkillInspectBlocker(root, error instanceof Error ? error.message : String(error)));
    return;
  }
  let kind: Awaited<ReturnType<typeof pathKind>>;
  try {
    kind = await pathKind(root);
  } catch (error) {
    blockers.push(piSkillInspectBlocker(root, error instanceof Error ? error.message : String(error)));
    return;
  }
  if (kind === "missing") return;
  if (kind !== "directory") {
    blockers.push(piSkillInspectBlocker(root, `path is a ${kind}, not a directory`));
    return;
  }

  const visited = new Set<string>();
  const managedDestination = (candidate: string): boolean =>
    [...selected].some((skillId) => isManagedPiSkillPath(project, skillId, candidate));

  const inspectIdentity = async (identityPath: string, evidencePath: string): Promise<void> => {
    let identity: string;
    try {
      identity = parsePiSkillIdentity(await readFile(identityPath, "utf8"), identityPath);
    } catch (error) {
      blockers.push(
        piSkillInspectBlocker(
          identityPath,
          `unreadable or malformed Host-visible identity (${error instanceof Error ? error.message : String(error)})`,
        ),
      );
      return;
    }
    if (!selected.has(identity)) return;
    blockers.push(
      piSkillOverlapBlocker({
        artifactId: identity,
        evidence: `${label} at ${evidencePath}`,
        proposedProjectPath: join(project, ...PI_PROJECT_SKILLS_ROOT.split("/"), identity),
      }),
    );
  };

  const visit = async (directory: string, isRoot: boolean): Promise<void> => {
    const canonicalDirectory = resolve(directory);
    if (visited.has(canonicalDirectory)) return;
    visited.add(canonicalDirectory);

    try {
      const symlink = await symlinkAncestor(canonicalDirectory, base);
      if (symlink !== undefined) {
        blockers.push(piSkillInspectBlocker(canonicalDirectory, `path contains unprovable symlink ${symlink}`));
        return;
      }
    } catch (error) {
      blockers.push(piSkillInspectBlocker(canonicalDirectory, error instanceof Error ? error.message : String(error)));
      return;
    }

    let entries: string[];
    try {
      entries = await readdir(canonicalDirectory);
    } catch (error) {
      blockers.push(piSkillInspectBlocker(canonicalDirectory, error instanceof Error ? error.message : String(error)));
      return;
    }

    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
      const candidate = join(canonicalDirectory, entry);
      let kind: Awaited<ReturnType<typeof pathKind>>;
      try {
        kind = await pathKind(candidate);
      } catch (error) {
        blockers.push(piSkillInspectBlocker(candidate, error instanceof Error ? error.message : String(error)));
        continue;
      }
      if (kind === "symlink") {
        blockers.push(piSkillInspectBlocker(candidate, `${label} contains an unprovable symlink`));
        continue;
      }
      if (kind === "directory") {
        if (managedDestination(candidate)) {
          // The package root's own identity is Installer-owned, but Pi scans
          // nested directories recursively, so keep proving nested identities.
          await visit(candidate, false);
          continue;
        }
        const skillMd = join(candidate, "SKILL.md");
        let skillKind: Awaited<ReturnType<typeof pathKind>>;
        try {
          skillKind = await pathKind(skillMd);
        } catch (error) {
          blockers.push(piSkillInspectBlocker(skillMd, error instanceof Error ? error.message : String(error)));
          continue;
        }
        if (skillKind === "symlink") {
          blockers.push(piSkillInspectBlocker(skillMd, `${label} contains an unprovable symlink`));
        } else if (skillKind === "file") {
          await inspectIdentity(skillMd, candidate);
        } else if (skillKind !== "missing") {
          blockers.push(piSkillInspectBlocker(skillMd, `SKILL.md is a ${skillKind}, not a file`));
        }
        await visit(candidate, false);
        continue;
      }
      if (isRoot && directMarkdown && kind === "file" && entry.toLowerCase().endsWith(".md")) {
        await inspectIdentity(candidate, candidate);
      }
    }
  };

  await visit(root, true);
}

/**
 * Fail closed when selected Skill identities are already visible through Pi's
 * static personal or project discovery roots. Missing roots are empty; the
 * Installer-owned `.pi/skills/<Artifact ID>` destination is exempt for re-apply.
 */
export async function detectPiSkillDiscoveryOverlaps(
  skillIds: readonly string[],
  options: PiSkillOverlapOptions,
): Promise<readonly string[]> {
  if (skillIds.length === 0) return [];
  const selected = new Set(skillIds);
  const blockers: string[] = [];
  const home = resolve(options.home ?? homedir());
  const project = resolve(options.project);
  const roots = [
    ...PI_PERSONAL_SKILL_ROOTS.map((relativeRoot) => ({
      label: `personal ${relativeRoot}`,
      path: join(home, ...relativeRoot.split("/")),
      symlinkBase: home,
      directMarkdown: relativeRoot === posix.join(".pi", "agent", "skills"),
    })),
    ...piProjectSkillRoots(project, options.projectBoundary),
  ];
  const seen = new Set<string>();
  for (const root of roots) {
    const canonicalRoot = resolve(root.path);
    if (seen.has(canonicalRoot)) continue;
    seen.add(canonicalRoot);
    await scanPiSkillRootForSelected(
      canonicalRoot,
      selected,
      project,
      blockers,
      root.label,
      root.symlinkBase,
      root.directMarkdown,
    );
  }
  return [...new Set(blockers)].sort();
}

/**
 * The first Pi Skill slice is safe only when no settings surface can add dynamic
 * Skill contributors. Settings-aware ingestion belongs to successor ticket #103;
 * an existing or unprovable surface therefore blocks the complete installation.
 */
export async function detectPiSkillSettingsBlockers(
  options: { readonly home?: string; readonly project: string },
): Promise<readonly string[]> {
  const home = resolve(options.home ?? homedir());
  const project = resolve(options.project);
  const paths = [
    { label: "global", path: join(home, ...PI_GLOBAL_SETTINGS_PATH.split("/")) },
    { label: "project", path: join(project, ...PI_PROJECT_SETTINGS_PATH.split("/")) },
  ];
  const blockers: string[] = [];
  for (const setting of paths) {
    try {
      const symlink = await symlinkAncestor(
        setting.path,
        setting.label === "global" ? home : project,
      );
      if (symlink !== undefined) {
        blockers.push(
          `Pi Skill ${setting.label} settings at ${setting.path} cannot be inspected sufficiently ` +
          `because path component ${symlink} is a symlink; remove the obstruction or wait for ` +
          "settings-aware Pi Skill preflight #103",
        );
        continue;
      }
    } catch (error) {
      blockers.push(
        `Pi Skill ${setting.label} settings at ${setting.path} cannot be inspected sufficiently ` +
        `to prove static Skill discovery (${error instanceof Error ? error.message : String(error)}); ` +
        "remove the obstruction or wait for settings-aware Pi Skill preflight #103",
      );
      continue;
    }
    let kind: Awaited<ReturnType<typeof pathKind>>;
    try {
      kind = await pathKind(setting.path);
    } catch (error) {
      blockers.push(
        `Pi Skill ${setting.label} settings at ${setting.path} cannot be inspected sufficiently ` +
        `to prove static Skill discovery (${error instanceof Error ? error.message : String(error)}); ` +
        "remove the obstruction or wait for settings-aware Pi Skill preflight #103",
      );
      continue;
    }
    if (kind === "missing") continue;
    blockers.push(
      `Pi Skill ${setting.label} settings at ${setting.path} are present (${kind}); ` +
      "the first static-only slice cannot prove that configuration adds no Skill contributors; " +
      "remove the settings surface or wait for settings-aware Pi Skill preflight #103",
    );
  }
  return [...new Set(blockers)].sort();
}

/** Parse the leading semver from `pi --version` output. */
export function parsePiCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(
      `Pi CLI version is unreadable from '${source.trim()}'; install Pi ${PI_MINIMUM_CLI_VERSION}+ and ensure \`pi --version\` works before previewing or applying the Profile`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

export function assertPiCliVersionSupported(version: string): void {
  if (compareSemver(version, PI_MINIMUM_CLI_VERSION) < 0) {
    throw new Error(
      `Pi CLI ${version} does not support project APPEND_SYSTEM.md Context discovery (requires ${PI_MINIMUM_CLI_VERSION}+); upgrade Pi before previewing or applying the Profile`,
    );
  }
}

async function resolvePiCliVersion(options: PiCapabilityOptions): Promise<string> {
  if (options.resolveVersion) return parsePiCliVersion(await options.resolveVersion());
  try {
    const { stdout, stderr } = await execFileAsync("pi", ["--version"], {
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    return parsePiCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        "Pi CLI was not found on PATH; install Pi and ensure `pi --version` works before previewing or applying the Profile",
      );
    }
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stdout || stderr) {
        try {
          return parsePiCliVersion(`${stdout}\n${stderr}`);
        } catch {
          // Fall through to the generic capability failure below.
        }
      }
    }
    throw new Error(
      `Pi CLI version could not be detected (${error instanceof Error ? error.message : String(error)}); install Pi ${PI_MINIMUM_CLI_VERSION}+ before previewing or applying the Profile`,
    );
  }
}

/**
 * Prove the Pi project surface needed by the selected Profile before writes.
 * Skill discovery and settings-aware checks are added below as one Adapter-owned
 * capability boundary; disabled model invocation remains deferred to #104.
 */
export async function assertPiProjectCapability(
  project: string,
  options: PiCapabilityOptions = {},
): Promise<void> {
  if (options.requireDisabledModelInvocation) {
    throw new Error(PI_DISABLED_MODEL_INVOCATION_UNSUPPORTED);
  }

  const version = await resolvePiCliVersion(options);
  assertPiCliVersionSupported(version);
  const piPath = join(project, ".pi");
  const piKind = await pathKind(piPath);
  if (piKind !== "missing" && piKind !== "directory") {
    throw new Error(
      `Pi project surface cannot host outputs: ${piPath} is a ${piKind}, not a directory`,
    );
  }

  if (options.requireSkills) {
    const skillsPath = join(project, ".pi", "skills");
    const skillsKind = await pathKind(skillsPath);
    if (skillsKind !== "missing" && skillsKind !== "directory") {
      throw new Error(
        `Pi project surface cannot host Skills: ${skillsPath} is a ${skillsKind}, not a directory`,
      );
    }
    const settingsBlockers = await detectPiSkillSettingsBlockers({
      project,
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    if (settingsBlockers.length > 0) throw new Error(settingsBlockers.join("\n"));
  }

  if (options.requireContext !== false) {
    const contextPath = join(project, ...PI_CONTEXT_PATH.split("/"));
    const contextKind = await pathKind(contextPath);
    if (contextKind !== "missing" && contextKind !== "file") {
      throw new Error(
        `Pi append-system destination cannot host Context: ${contextPath} is a ${contextKind}, not a regular file`,
      );
    }
  }

  if (options.requireSkills) {
    const overlaps = await detectPiSkillDiscoveryOverlaps(options.skillIds ?? [], {
      project,
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.projectBoundary === undefined ? {} : { projectBoundary: options.projectBoundary }),
    });
    if (overlaps.length > 0) throw new Error(overlaps.join("\n"));
  }
}

function contextOutput(
  profileId: string,
  modules: readonly ContextModuleSource[],
): ProposedProjectFileOutput {
  return {
    bytes: composeContextEnvelope(profileId, modules),
    mode: 0o644,
    path: PI_CONTEXT_PATH,
    requirements: [...PI_CONTEXT_REQUIREMENTS],
    type: "file",
  };
}

const PI_SKILL_PROJECTION: SkillPackageProjection = {
  projectMembers: (_skill, members) => members,
  requirements: (_skill, base) => base,
};

function skillOutputs(skills: readonly Skill[]) {
  return Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSkillPackageDirectory(
          skill,
          PI_PROJECT_SKILLS_ROOT,
          ["Pi discovers Skill package through native project .pi/skills"],
          PI_SKILL_PROJECTION,
        ),
      ),
  );
}

/**
 * Pure Pi Adapter planner for Profile Context and allowed-invocation Skills.
 * Disabled model invocation remains deferred to successor ticket #104.
 */
export async function planPiProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  skills: readonly Skill[] = [],
): Promise<PiProjectPlan> {
  if (skillsRequireDisabledModelInvocation(skills)) {
    throw new Error(PI_DISABLED_MODEL_INVOCATION_UNSUPPORTED);
  }
  const packages = await skillOutputs(skills);
  const outputs: readonly ProposedProjectOutput[] = modules.length > 0
    ? [contextOutput(profileId, modules), ...packages]
    : packages;
  return {
    host: "pi",
    hostVersion: skills.length > 0
      ? modules.length > 0
        ? PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS
        : PI_HOST_VERSION_WITH_SKILLS
      : PI_HOST_VERSION,
    outputs,
  };
}
