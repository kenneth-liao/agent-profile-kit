import { lstat, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  LOCAL_CONFIGURATION_FILE,
  requireCurrentLocalConfiguration,
  requireCurrentWorkspaceSelection,
  parseLocalConfiguration,
  parseLocalConfigurationSelection,
  type LocalConfiguration,
  type ParsedCurrentLocalConfiguration,
  type ParsedLocalConfiguration,
  type ParsedProjectBinding,
  type ProjectBinding,
} from "../schemas/local-configuration.js";
import { ingestWorkspace, type Workspace } from "./ingest-workspace.js";
import { COMMAND_NAME } from "./version.js";
import { requireProfile } from "./profile-selection.js";
import { validateWorkspaceStructure } from "./workspace.js";

export function localConfigurationPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", LOCAL_CONFIGURATION_FILE);
}

export function stateDirectory(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "state");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export function requireCurrentApplicationConfiguration(
  parsed: ParsedLocalConfiguration,
  path: string,
): ParsedCurrentLocalConfiguration {
  return requireCurrentLocalConfiguration(parsed, path, `${COMMAND_NAME} init`);
}

/**
 * Expand an absolute or home-relative machine path. Wildcards and other relative
 * forms are invalid. Shared by Project Binding roots and the authored Workspace path.
 */
export function expandConfiguredPath(
  value: string,
  home: string,
  description: string,
  field: string,
): string {
  if (
    value.includes("*") ||
    value.includes("?") ||
    value.includes("[") ||
    value.includes("]")
  ) {
    throw new Error(
      `${description} ${field} must be an explicit directory path without wildcards`,
    );
  }
  if (value === "~") return home;
  if (value.startsWith("~/")) return join(home, value.slice(2));
  if (!isAbsolute(value)) {
    throw new Error(
      `${description} ${field} must be an absolute path or home-relative path beginning with ~/`,
    );
  }
  return value;
}

function isSameOrDescendant(path: string, ancestor: string): boolean {
  const relativePath = relative(ancestor, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export async function canonicalizePathForComparison(path: string): Promise<string> {
  const original = resolve(path);
  let candidate = original;
  const suffix: string[] = [];

  while (true) {
    try {
      const canonical = await realpath(candidate);
      return suffix.reduceRight((parent, segment) => join(parent, segment), canonical);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT") && !hasErrorCode(error, "ENOTDIR")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) return original;
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Keep canonical Workspace source separate from machine-local configuration and
 * disposable installation state, including when either side is reached through
 * a symlink alias or a not-yet-created path.
 */
export async function assertWorkspaceSelectionSeparation(
  home: string,
  destination: string,
  authored: string,
  description: string,
): Promise<void> {
  const reservedPaths = [
    { label: "Local Configuration", path: localConfigurationPath(home) },
    { label: "installation state", path: stateDirectory(home) },
  ] as const;
  const canonicalDestination = await canonicalizePathForComparison(destination);
  const canonicalReservedPaths = await Promise.all(
    reservedPaths.map(async (reserved) => ({
      ...reserved,
      path: await canonicalizePathForComparison(reserved.path),
    })),
  );
  const conflict = canonicalReservedPaths.find(
    (reserved) =>
      isSameOrDescendant(canonicalDestination, reserved.path) ||
      isSameOrDescendant(reserved.path, canonicalDestination),
  );
  if (conflict !== undefined) {
    throw new Error(
      `${description} workspace '${authored}' is reserved for ${conflict.label} at ${conflict.path}`,
    );
  }
}

export async function requireExistingDirectory(
  expanded: string,
  authored: string,
  description: string,
  field: string,
): Promise<string> {
  let entryStats;
  try {
    entryStats = await lstat(expanded);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        `${description} ${field} '${authored}' must be an existing directory`,
      );
    }
    throw error;
  }

  let stats;
  try {
    stats = await stat(expanded);
  } catch (error) {
    if (entryStats.isSymbolicLink() && hasErrorCode(error, "ENOENT")) {
      const recovery =
        field === "workspace"
          ? "restore its target or choose an existing Workspace directory"
          : "restore its target or choose an existing directory";
      throw new Error(
        `${description} ${field} '${authored}' is a dangling symlink; ${recovery}`,
      );
    }
    throw error;
  }

  if (!stats.isDirectory()) {
    throw new Error(
      `${description} ${field} '${authored}' must be an existing directory`,
    );
  }
  return realpath(expanded);
}

/** Canonical absolute directory for a Project Binding root (authored spelling separate). */
export async function normalizeProject(
  project: string,
  home: string,
  description: string,
): Promise<string> {
  const expanded = expandConfiguredPath(project, home, description, "project");
  return requireExistingDirectory(expanded, project, description, "project");
}

/**
 * Resolve the Workspace directory from Local Configuration.
 * The explicit authored path is the only selection input. Returns the canonical
 * (realpath) directory after structural validation.
 */
export async function resolveWorkspaceRoot(
  home: string,
  authored: string,
  configPath: string,
): Promise<{ readonly authored: string; readonly path: string }> {
  const description = `Local Configuration ${configPath}`;
  const expanded = expandConfiguredPath(authored, home, description, "workspace");
  await assertWorkspaceSelectionSeparation(home, expanded, authored, description);
  const canonical = await requireExistingDirectory(
    expanded,
    authored,
    description,
    "workspace",
  );

  try {
    await validateWorkspaceStructure(canonical);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${description} workspace '${authored}' is not a valid Agent Profile Kit Workspace: ${detail}`,
    );
  }

  return { authored, path: canonical };
}

export interface IngestedProjectBinding {
  readonly index: number;
  readonly project: string;
  readonly profile: string;
  readonly hosts: ParsedProjectBinding["hosts"];
  readonly canonicalProject?: string;
  readonly expandedProject?: string;
  readonly missing: boolean;
  readonly problem?: string;
}

export interface IngestedApplicationSource {
  readonly bindings: readonly IngestedProjectBinding[];
  readonly schemaVersion: 2;
  readonly workspace: string;
  readonly workspaceModel: Workspace;
}

/**
 * Typed reason a Project target was rejected before scoped lifecycle planning
 * or writes. Every case is a typed fact; the Installer authors no sentence.
 * Presentation owns every rendered sentence, canonical on machine surfaces and
 * newcomer-worded on human surfaces.
 */
export type ProjectTargetErrorReason =
  | { readonly case: "ambiguous-target"; readonly command: "apply" | "status"; readonly target: string }
  | { readonly case: "dangling-symlink-target"; readonly command: "apply" | "status"; readonly target: string }
  | { readonly case: "missing-target"; readonly command: "apply" | "status"; readonly target: string }
  | { readonly case: "relative-target"; readonly command: "apply" | "status"; readonly target: string }
  | { readonly case: "unbound-target"; readonly command: "apply" | "status"; readonly target: string }
  | { readonly case: "wildcard-target"; readonly command: "apply" | "status"; readonly target: string };

/** Focused user-input failure raised before scoped lifecycle planning or writes. */
export class ProjectTargetError extends Error {
  readonly reason: ProjectTargetErrorReason;

  constructor(reason: ProjectTargetErrorReason) {
    super(`project target rejected: ${reason.case}`);
    this.name = "ProjectTargetError";
    this.reason = reason;
  }
}

/** One normalized lifecycle selection boundary for Project Bindings. */
export type ProjectBindingSelection =
  | { readonly kind: "all" }
  | {
      readonly command: "apply" | "status";
      readonly kind: "project";
      readonly match: "containing" | "exact";
      readonly target: string;
    };

async function selectParsedProjectBindings(
  home: string,
  bindings: readonly ParsedProjectBinding[],
  path: string,
  selection: ProjectBindingSelection,
): Promise<readonly ParsedProjectBinding[]> {
  if (selection.kind === "all") return bindings;

  const command = selection.command;
  const target = selection.target;
  // The Project-target boundary classifies rejections as typed facts so no
  // Installer-authored sentence is needed: shape checks first, then existence.
  if (["*", "?", "[", "]"].some((wildcard) => target.includes(wildcard))) {
    throw new ProjectTargetError({ case: "wildcard-target", command, target });
  }
  if (target !== "~" && !target.startsWith("~/") && !isAbsolute(target)) {
    throw new ProjectTargetError({ case: "relative-target", command, target });
  }
  const expandedTarget = expandConfiguredPath(target, home, `${COMMAND_NAME} ${command} Project target`, "project");
  let canonicalTarget: string;
  try {
    const entryStats = await lstat(expandedTarget);
    let followedStats;
    try {
      // Directory membership follows symlinks: a final symlink to a directory
      // is a valid target, and only a dangling symlink is dangling.
      followedStats = await stat(expandedTarget);
    } catch (error) {
      if (entryStats.isSymbolicLink() && hasErrorCode(error, "ENOENT")) {
        throw new ProjectTargetError({ case: "dangling-symlink-target", command, target });
      }
      throw error;
    }
    if (!followedStats.isDirectory()) {
      throw new ProjectTargetError({ case: "missing-target", command, target });
    }
    canonicalTarget = await realpath(expandedTarget);
  } catch (error) {
    if (error instanceof ProjectTargetError) throw error;
    if (hasErrorCode(error, "ENOENT")) {
      throw new ProjectTargetError({ case: "missing-target", command, target });
    }
    throw error;
  }
  const matches: ParsedProjectBinding[] = [];
  for (const [index, binding] of bindings.entries()) {
    try {
      const expanded = expandConfiguredPath(
        binding.project,
        home,
        `Local Configuration ${path} bindings[${index}]`,
        "project",
      );
      const canonical = await realpath(expanded);
      const matched = selection.match === "exact"
        ? canonical === canonicalTarget
        : isSameOrDescendant(canonicalTarget, canonical);
      if (matched) matches.push(binding);
    } catch {
      // An unrelated missing or invalid Project must not prevent scoped work.
    }
  }

  if (matches.length === 0) {
    throw new ProjectTargetError({
      case: "unbound-target",
      command: selection.command,
      target: selection.target,
    });
  }
  if (matches.length > 1) {
    throw new ProjectTargetError({
      case: "ambiguous-target",
      command: selection.command,
      target: selection.target,
    });
  }
  return matches;
}

async function isMissingPath(expanded: string): Promise<boolean> {
  try {
    await lstat(expanded);
    return false;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ProjectBindingNormalizationMode =
  | {
      readonly allowMissingProjects: boolean;
      readonly kind: "application";
      readonly profiles: ReadonlyMap<string, unknown>;
    }
  | { readonly kind: "inventory" };

async function ingestWorkspaceFromConfiguration(
  home: string,
  authored: string,
  path: string,
): Promise<Workspace> {
  const resolved = await resolveWorkspaceRoot(home, authored, path);
  return ingestWorkspace(resolved.path);
}

/**
 * Normalize the Project Binding portion of Local Configuration once. Full
 * application ingestion validates every path and Profile; inventory retains
 * per-binding path problems so one stale record cannot hide the rest.
 */
async function normalizeProjectBindings(
  home: string,
  parsedBindings: readonly ParsedProjectBinding[],
  path: string,
  mode: ProjectBindingNormalizationMode,
): Promise<readonly IngestedProjectBinding[]> {
  const roots = new Set<string>();
  const missingProjects = new Set<string>();
  const bindings: IngestedProjectBinding[] = [];

  for (const [index, binding] of parsedBindings.entries()) {
    const description = `Local Configuration ${path} bindings[${index}]`;
    let expandedProject: string | undefined;
    let canonicalProject: string | undefined;
    let missing = false;
    let problem: string | undefined;

    try {
      expandedProject = expandConfiguredPath(binding.project, home, description, "project");
    } catch (error) {
      if (mode.kind === "application") throw error;
      problem = errorMessage(error);
    }

    if (expandedProject !== undefined) {
      try {
        canonicalProject = await requireExistingDirectory(
          expandedProject,
          binding.project,
          description,
          "project",
        );
      } catch (error) {
        if (mode.kind === "inventory") {
          problem = errorMessage(error);
        } else {
          if (
            !mode.allowMissingProjects ||
            !(await isMissingPath(expandedProject))
          ) {
            throw error;
          }
          missing = true;
        }
      }
    }

    if (canonicalProject !== undefined) {
      if (roots.has(canonicalProject)) {
        const duplicate =
          `${description} project resolves to duplicate canonical root '${canonicalProject}'`;
        if (mode.kind === "application") throw new Error(duplicate);
        canonicalProject = undefined;
        problem = duplicate;
      } else {
        roots.add(canonicalProject);
      }
    } else if (missing) {
      if (missingProjects.has(binding.project)) {
        throw new Error(
          `${description} duplicates missing project path '${binding.project}'`,
        );
      }
      missingProjects.add(binding.project);
    }

    if (mode.kind === "application") requireProfile(mode.profiles, binding.profile);
    bindings.push({
      index,
      project: binding.project,
      profile: binding.profile,
      hosts: binding.hosts,
      ...(canonicalProject === undefined ? {} : { canonicalProject }),
      ...(expandedProject === undefined ? {} : { expandedProject }),
      missing,
      ...(problem === undefined ? {} : { problem }),
    });
  }

  return bindings;
}

/**
 * Trusted Local Configuration + Workspace model from an exact source snapshot.
 * Missing project roots can be retained as explicit recovery candidates for
 * recording commands; all other path, Profile, and duplicate-root invariants
 * remain shared with desired-state ingestion.
 */
export async function ingestApplicationModelFromSource(
  home: string,
  source: string,
  path: string = localConfigurationPath(home),
  options: { readonly allowMissingProjects?: boolean } = {},
): Promise<IngestedApplicationSource> {
  const parsed = requireCurrentApplicationConfiguration(
    parseLocalConfiguration(source, path),
    path,
  );
  return ingestParsedApplicationModel(home, parsed, parsed.bindings, path, options);
}

async function ingestParsedApplicationModel(
  home: string,
  parsed: ParsedCurrentLocalConfiguration,
  bindingsToNormalize: readonly ParsedProjectBinding[],
  path: string,
  options: { readonly allowMissingProjects?: boolean } = {},
): Promise<IngestedApplicationSource> {
  const workspaceModel = await ingestWorkspaceFromConfiguration(home, parsed.workspace, path);
  const bindings = await normalizeProjectBindings(home, bindingsToNormalize, path, {
    allowMissingProjects: options.allowMissingProjects ?? false,
    kind: "application",
    profiles: workspaceModel.profiles,
  });
  return {
    bindings,
    schemaVersion: parsed.schemaVersion,
    workspace: parsed.workspace,
    workspaceModel,
  };
}

/**
 * Strict desired-state ingestion. Recording commands may opt into the shared
 * missing-path model above, but normal reconciliation still rejects stale roots.
 */
export async function ingestApplicationFromSource(
  home: string,
  source: string,
  path: string = localConfigurationPath(home),
  selection: ProjectBindingSelection = { kind: "all" },
): Promise<{
  readonly configuration: LocalConfiguration;
  readonly workspace: Workspace;
}> {
  const parsed = requireCurrentApplicationConfiguration(
    parseLocalConfiguration(source, path),
    path,
  );
  const selectedBindings = await selectParsedProjectBindings(
    home,
    parsed.bindings,
    path,
    selection,
  );
  const model = await ingestParsedApplicationModel(home, parsed, selectedBindings, path);
  return {
    configuration: {
      bindings: model.bindings.map((binding) => ({
        canonicalProject: binding.canonicalProject!,
        project: binding.project,
        profile: binding.profile,
        hosts: binding.hosts,
      })),
      path,
      schemaVersion: model.schemaVersion,
      workspace: model.workspace,
    },
    workspace: model.workspaceModel,
  };
}

/**
 * Configuration-only Project Binding model. It parses and normalizes Local
 * Configuration without resolving the selected Workspace or reading its
 * artifacts, so inventory cannot turn unrelated Workspace state into a
 * Project-inventory failure.
 */
export async function ingestProjectBindingsFromSource(
  home: string,
  source: string,
  path: string = localConfigurationPath(home),
): Promise<readonly IngestedProjectBinding[]> {
  const parsed = requireCurrentApplicationConfiguration(
    parseLocalConfiguration(source, path),
    path,
  );
  return normalizeProjectBindings(home, parsed.bindings, path, { kind: "inventory" });
}

export async function readLocalConfigurationSource(
  home: string,
): Promise<{ readonly path: string; readonly source: string }> {
  const path = localConfigurationPath(home);
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(`Local Configuration is missing at ${path}; run ${COMMAND_NAME} init`);
    }
    throw error;
  }
  return { path, source };
}

export async function ingestProjectBindings(
  home: string,
): Promise<readonly IngestedProjectBinding[]> {
  const { path, source } = await readLocalConfigurationSource(home);
  return ingestProjectBindingsFromSource(home, source, path);
}

/**
 * Read the selected Workspace through the shared Local Configuration boundary.
 * Inventory callers intentionally stop here so bound Project roots and Hosts
 * are never inspected while Workspace source is normalized.
 */
export async function ingestSelectedWorkspace(home: string): Promise<Workspace> {
  const { path, source } = await readLocalConfigurationSource(home);
  const parsed = parseLocalConfigurationSelection(source, path);
  const workspace = requireCurrentWorkspaceSelection(
    parsed,
    path,
    `${COMMAND_NAME} init`,
  );
  return ingestWorkspaceFromConfiguration(home, workspace, path);
}

/**
 * Shared desired-state ingestion boundary: resolve Local Configuration first so
 * validate/status/apply select the same explicitly configured Workspace.
 * `init` reuses `resolveWorkspaceRoot` separately; `uninstall` does not call
 * this path.
 */
export async function ingestApplication(
  home: string,
  selection: ProjectBindingSelection = { kind: "all" },
): Promise<{
  readonly configuration: LocalConfiguration;
  readonly workspace: Workspace;
}> {
  const { path, source } = await readLocalConfigurationSource(home);
  return ingestApplicationFromSource(home, source, path, selection);
}
