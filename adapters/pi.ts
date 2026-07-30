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

type PiSettingsScope = "global" | "project";
type PiDynamicResourceKey = "extensions" | "skills";

interface PiPackageSettings {
  readonly autoload: boolean;
  readonly extensions?: readonly string[];
  readonly skills?: readonly string[];
  readonly source: string;
}

interface PiSkillSettingsSource {
  readonly extensions: readonly string[];
  readonly packages: readonly PiPackageSettings[];
  readonly path: string;
  readonly scope: PiSettingsScope;
  readonly skills: readonly string[];
}

interface PiSkillSettingsIngestion {
  readonly blockers: readonly string[];
  readonly sources: readonly PiSkillSettingsSource[];
}

function piSkillSettingsBlocker(
  scope: PiSettingsScope,
  path: string,
  detail: string,
): string {
  return (
    `Pi Skill ${scope} settings at ${path} cannot be inspected sufficiently ` +
    `to prove static Skill discovery (${detail}); repair or remove the settings before applying`
  );
}

function normalizePiStringArray(
  settings: Readonly<Record<string, unknown>>,
  key: PiDynamicResourceKey,
  scope: PiSettingsScope,
  path: string,
  blockers: string[],
): readonly string[] {
  const value = settings[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    blockers.push(
      piSkillSettingsBlocker(scope, path, `${key} must be an array of path strings`),
    );
    return [];
  }
  return value;
}

function normalizePiPackageFilter(
  value: unknown,
  key: PiDynamicResourceKey,
  packageSource: string,
  scope: PiSettingsScope,
  path: string,
  blockers: string[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    blockers.push(
      piSkillSettingsBlocker(
        scope,
        path,
        `package ${JSON.stringify(packageSource)} ${key} must be an array of strings`,
      ),
    );
    return undefined;
  }
  return value;
}

function normalizePiPackages(
  settings: Readonly<Record<string, unknown>>,
  scope: PiSettingsScope,
  path: string,
  blockers: string[],
): readonly PiPackageSettings[] {
  const configured = settings.packages;
  if (configured === undefined) return [];
  if (!Array.isArray(configured)) {
    blockers.push(piSkillSettingsBlocker(scope, path, "packages must be an array"));
    return [];
  }

  const packages: PiPackageSettings[] = [];
  for (const entry of configured) {
    if (typeof entry === "string") {
      if (entry.length === 0) {
        blockers.push(
          piSkillSettingsBlocker(scope, path, "package source strings must not be empty"),
        );
        continue;
      }
      packages.push({ autoload: true, source: entry });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      blockers.push(
        piSkillSettingsBlocker(
          scope,
          path,
          "each package must be a source string or package filter object",
        ),
      );
      continue;
    }
    const packageFilter = entry as Record<string, unknown>;
    if (typeof packageFilter.source !== "string" || packageFilter.source.length === 0) {
      blockers.push(
        piSkillSettingsBlocker(
          scope,
          path,
          "each package filter object must have a non-empty source string",
        ),
      );
      continue;
    }
    if (
      packageFilter.autoload !== undefined &&
      typeof packageFilter.autoload !== "boolean"
    ) {
      blockers.push(
        piSkillSettingsBlocker(
          scope,
          path,
          `package ${JSON.stringify(packageFilter.source)} autoload must be boolean`,
        ),
      );
      continue;
    }
    const blockerCount = blockers.length;
    const extensions = normalizePiPackageFilter(
      packageFilter.extensions,
      "extensions",
      packageFilter.source,
      scope,
      path,
      blockers,
    );
    const skills = normalizePiPackageFilter(
      packageFilter.skills,
      "skills",
      packageFilter.source,
      scope,
      path,
      blockers,
    );
    if (blockers.length !== blockerCount) continue;
    packages.push({
      autoload: packageFilter.autoload !== false,
      ...(extensions === undefined ? {} : { extensions }),
      ...(skills === undefined ? {} : { skills }),
      source: packageFilter.source,
    });
  }
  return packages;
}

function normalizePiSkillSettings(
  settings: Readonly<Record<string, unknown>>,
  scope: PiSettingsScope,
  path: string,
): { readonly blockers: readonly string[]; readonly source: PiSkillSettingsSource } {
  const blockers: string[] = [];
  const extensions = normalizePiStringArray(settings, "extensions", scope, path, blockers);
  const skills = normalizePiStringArray(settings, "skills", scope, path, blockers);
  const packages = normalizePiPackages(settings, scope, path, blockers);
  return {
    blockers,
    source: { extensions, packages, path, scope, skills },
  };
}

async function ingestPiSkillSettings(
  options: { readonly home?: string; readonly project: string },
): Promise<PiSkillSettingsIngestion> {
  const home = resolve(options.home ?? homedir());
  const project = resolve(options.project);
  const inputs = [
    {
      base: home,
      path: join(home, ...PI_GLOBAL_SETTINGS_PATH.split("/")),
      scope: "global",
    },
    {
      base: project,
      path: join(project, ...PI_PROJECT_SETTINGS_PATH.split("/")),
      scope: "project",
    },
  ] as const;
  const blockers: string[] = [];
  const sources: PiSkillSettingsSource[] = [];

  for (const input of inputs) {
    try {
      const symlink = await symlinkAncestor(input.path, input.base);
      if (symlink !== undefined) {
        blockers.push(
          piSkillSettingsBlocker(
            input.scope,
            input.path,
            `path component ${symlink} is an unprovable symlink`,
          ),
        );
        continue;
      }

      const kind = await pathKind(input.path);
      if (kind === "missing") {
        sources.push({
          extensions: [],
          packages: [],
          path: input.path,
          scope: input.scope,
          skills: [],
        });
        continue;
      }
      if (kind !== "file") {
        blockers.push(
          piSkillSettingsBlocker(input.scope, input.path, `path is a ${kind}, not a regular file`),
        );
        continue;
      }

      const parsed: unknown = JSON.parse(await readFile(input.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        blockers.push(
          piSkillSettingsBlocker(input.scope, input.path, "settings JSON must be an object"),
        );
        continue;
      }
      const normalized = normalizePiSkillSettings(
        parsed as Record<string, unknown>,
        input.scope,
        input.path,
      );
      blockers.push(...normalized.blockers);
      sources.push(normalized.source);
    } catch (error) {
      blockers.push(
        piSkillSettingsBlocker(
          input.scope,
          input.path,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  return { blockers: [...new Set(blockers)].sort(), sources };
}

function configuredPiResourceBlockers(
  source: PiSkillSettingsSource,
  key: PiDynamicResourceKey,
): readonly string[] {
  const entries = source[key];
  if (entries.length === 0) return [];
  if (entries.some((entry) => entry.startsWith("!") || entry.startsWith("-"))) {
    return [
      `Pi Skill ${source.scope} settings at ${source.path} configure ${key} exclusion ` +
      `${JSON.stringify(entries)}; ignored paths make the static inventory unprovable, so ` +
      `remove the ${key} overrides before applying`,
    ];
  }
  return [
    `Pi Skill ${source.scope} settings at ${source.path} configure ${key} ` +
    `${JSON.stringify(entries)}, which can add or alter Host-visible Skill paths; ` +
    `remove the configured ${key === "skills" ? "Skill paths" : "extensions"} before applying`,
  ];
}

interface PiConfiguredPackage extends PiPackageSettings {
  readonly settingsSource: PiSkillSettingsSource;
}

const PI_PACKAGE_DYNAMIC_RESOURCE_KEYS = ["skills", "extensions"] as const;

function configuredPiPackageBlockers(
  sources: readonly PiSkillSettingsSource[],
): readonly string[] {
  const blockers: string[] = [];
  const packages: PiConfiguredPackage[] = sources.flatMap((settingsSource) =>
    settingsSource.packages.map((entry) => ({ ...entry, settingsSource })),
  );
  const projectSourceCounts = new Map<string, number>();
  for (const entry of packages) {
    if (entry.settingsSource.scope !== "project") continue;
    projectSourceCounts.set(
      entry.source,
      (projectSourceCounts.get(entry.source) ?? 0) + 1,
    );
  }
  for (const [source, count] of projectSourceCounts) {
    if (count < 2) continue;
    const projectSettings = packages.find(
      (entry) =>
        entry.settingsSource.scope === "project" &&
        entry.source === source,
    )?.settingsSource;
    if (projectSettings !== undefined) {
      blockers.push(
        `Pi Skill project settings at ${projectSettings.path} have ambiguous duplicate ` +
        `package precedence for ${JSON.stringify(source)}; keep one package entry per source before applying`,
      );
    }
  }
  const projectPackages = packages.filter(
    (entry) => entry.settingsSource.scope === "project",
  );
  // Conservative Pi precedence approximation: only one unique, enabled npm:
  // project entry is treated as replacing the same global source. Multiple
  // entries and scope-relative local sources stay unprovable and fail closed.
  const replacedGlobalSources = new Set(
    projectPackages
      .filter(
        (entry) =>
          projectPackages.length === 1 &&
          entry.autoload &&
          entry.source.startsWith("npm:") &&
          projectSourceCounts.get(entry.source) === 1,
      )
      .map((entry) => entry.source),
  );

  for (const entry of packages) {
    if (
      entry.settingsSource.scope === "global" &&
      replacedGlobalSources.has(entry.source)
    ) {
      continue;
    }
    if (
      entry.autoload &&
      entry.extensions === undefined &&
      entry.skills === undefined
    ) {
      blockers.push(
        `Pi Skill ${entry.settingsSource.scope} settings at ${entry.settingsSource.path} configure package ` +
        `${JSON.stringify(entry.source)}, which can contribute Host-visible Skills or extensions; ` +
        "use an object package entry with both skills: [] and extensions: [] before applying",
      );
      continue;
    }
    const canContribute = PI_PACKAGE_DYNAMIC_RESOURCE_KEYS.some((key) => {
      const patterns = entry[key];
      return !entry.autoload
        ? (patterns?.length ?? 0) > 0
        : patterns === undefined || patterns.length > 0;
    });
    if (canContribute) {
      blockers.push(
        `Pi Skill ${entry.settingsSource.scope} settings at ${entry.settingsSource.path} configure package ` +
        `${JSON.stringify(entry.source)} with Skill or extension loading that cannot be ` +
        "proven static; set both skills: [] and extensions: [] before applying",
      );
    }
  }
  return blockers;
}

export async function detectPiSkillSettingsBlockers(
  options: { readonly home?: string; readonly project: string },
): Promise<readonly string[]> {
  const ingestion = await ingestPiSkillSettings(options);
  const blockers = [...ingestion.blockers];
  for (const source of ingestion.sources) {
    blockers.push(...configuredPiResourceBlockers(source, "skills"));
    blockers.push(...configuredPiResourceBlockers(source, "extensions"));
  }
  blockers.push(...configuredPiPackageBlockers(ingestion.sources));
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
