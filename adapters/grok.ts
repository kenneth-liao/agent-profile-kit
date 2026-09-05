import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";

import type { CompleteHostAdapter } from "./adapter-contract.js";
import {
  CLAUDE_CONTEXT_REQUIREMENTS,
  CLAUDE_CONTEXT_RULE_PATH,
} from "./claude.js";
import { type ContextModuleSource } from "./context-envelope.js";
import {
  caughtCapabilityFailure,
  capabilityFailure,
  versionFloorCapabilityFailure,
  type AdapterCapabilityFailure,
} from "./capability.js";
import { invokeExecutable } from "./services/executable.js";
import { classifyFileSystemEntry } from "./services/project-surface.js";
import {
  compareCoreSemanticVersions,
  normalizeCoreSemanticVersion,
} from "./services/semantic-version.js";
import {
  identifierPart,
  type AdapterHostSetupStep,
  type AdapterDiagnosticWarning,
  type AdapterProjectPlan,
  type ProposedDirectoryFileMember,
  type ProposedDirectoryMember,
  type ProposedProjectFileOutput,
  type ProposedProjectOutput,
} from "./project-plan.js";
import {
  DEFAULT_ADAPTER_PLANNING_MATERIALS,
  DISABLED_MODEL_INVOCATION_REQUIREMENT,
  planSkillPackageDirectory,
  skillsRequireDisabledModelInvocation,
  type AdapterPlanningMaterials,
  type SkillPackageProjection,
} from "./skill-package.js";
import type { ModelInvocationPolicy, Skill } from "../schemas/skill.js";
export { GROK_ADAPTER_VERSION } from "./host-catalog.js";
import { parseTomlTable } from "./toml.js";

/**
 * Capability-contract token recorded in Installation Manifest host_versions after
 * the installed Grok CLI is proven to support always-scanned project rules under
 * `.grok/rules/` and machine-readable `grok inspect --json` configuration inspection.
 *
 * Context-only Profiles that select no Skills continue to record this contract.
 */
export const GROK_HOST_VERSION = "native-project-unscoped-rules-v1";

/**
 * Capability-contract token when the Profile selects portable Skills for Grok.
 * Proven by the same CLI floor as project-rules inspection plus native project
 * Skill discovery under `.grok/skills/`.
 */
export const GROK_HOST_VERSION_WITH_SKILLS = "native-project-unscoped-rules-skills-v1";

/**
 * Capability-contract token when a selected Skill requires disabled model invocation.
 * Grok honors top-level `disable-model-invocation` in project Skill frontmatter on the
 * same CLI floor that discovers `.grok/skills/`.
 */
export const GROK_HOST_VERSION_WITH_INVOCATION =
  "native-project-unscoped-rules-skills-invocation-v1";

/**
 * Minimum Grok CLI version that preserves the Grok project Capability Contract.
 * Evidence: Grok Build documents always-scanned project `.grok/rules/*.md`,
 * native project `.grok/skills/`, `disable-model-invocation`, and
 * `grok inspect --json` with `externalCompat` cells. Context planning fails
 * closed when that topology cannot be determined.
 */
export const GROK_MINIMUM_CLI_VERSION = "0.2.0";

/** Owned unscoped Grok project rule path (always-scanned `.grok/rules/*.md`). */
export const GROK_CONTEXT_RULE_PATH = posix.join(
  ".grok",
  "rules",
  "agent-profile-kit.md",
);

/** Grok native project Skill discovery root. */
export const GROK_SKILLS_DISCOVERY_ROOT = posix.join(".grok", "skills");

export type GrokProjectPlan = AdapterProjectPlan;

export interface GrokInspection {
  /** Whether Grok's Claude rules compatibility cell is enabled for this project. */
  readonly claudeRulesEnabled: boolean;
  /** Parsed Grok CLI semver from `grok version` / inspection. */
  readonly version: string;
}

export interface GrokCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Machine home used to resolve personal `~/.grok` when `GROK_HOME` is unset.
   * The Installer passes its isolated home so tests cannot see the real user profile.
   */
  readonly home?: string;
  /**
   * Injectable inspection probe for tests. Defaults to `grok version` plus
   * `grok inspect --json` run with cwd set to the bound project root.
   */
  readonly inspect?: () => Promise<GrokInspection>;
  /**
   * When false, skip unscoped project-rule surface preflight (Skills-only Profiles
   * that plan no Context rule). Defaults to true. CLI floor still applies when
   * Skills or disabled model invocation are required.
   */
  readonly requireContext?: boolean;
  /** When true, prove Host can enforce disabled model invocation. */
  readonly requireDisabledModelInvocation?: boolean;
  /** When true, prove native project Skill discovery surface is hostable. */
  readonly requireSkills?: boolean;
  /** Injectable version probe for tests; defaults to `grok version`. */
  readonly resolveVersion?: () => Promise<string>;
}

export interface GrokProjectPlanOptions {
  /**
   * True when Claude is also selected on the same Project Binding. When set and
   * Claude rules compatibility is enabled, Grok plans the Claude rule path so
   * Installer normalization coalesces one effective copy.
   */
  readonly claudeCoSelected?: boolean;
  /**
   * Effective Grok Claude rules compatibility cell. Defaults to true (Grok's
   * documented default) when omitted so pure planning without inspection still
   * matches typical Host configuration.
   */
  readonly claudeRulesEnabled?: boolean;
  /** Invocation-scoped Skill/Context materials; defaults to direct reads. */
  readonly materials?: AdapterPlanningMaterials;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseYaml(source: string, description: string): unknown {
  try {
    return parse(source);
  } catch {
    throw new Error(`${description} is invalid YAML`);
  }
}

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be a YAML mapping`);
  }
  return value as Record<string, unknown>;
}

function memberBytesAsString(bytes: string | Uint8Array): string {
  return typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
}

/** Parse the leading semver from `grok version` output (e.g. `grok 0.2.111 (…)`). */
export function parseGrokCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw capabilityFailure(
      "grok",
      "host",
      `Grok CLI version is unreadable from '${source.trim()}'`,
      "install a supported Grok Build release",
    );
  }
  return normalizeCoreSemanticVersion(match[1]!, match[2]!, match[3]!);
}

/**
 * Reject Grok CLI releases below the project Capability Contract floor.
 * Messaging reflects which surface is required when callers opt into Skills or
 * disabled model invocation.
 */
export function assertGrokCliVersionSupported(
  version: string,
  options: {
    readonly requireContext?: boolean;
    readonly requireDisabledModelInvocation?: boolean;
    readonly requireSkills?: boolean;
  } = {},
): void {
  if (compareCoreSemanticVersions(version, GROK_MINIMUM_CLI_VERSION) < 0) {
    if (options.requireDisabledModelInvocation) {
      throw versionFloorCapabilityFailure(
        "grok",
        `Grok CLI ${version} cannot enforce disabled model invocation via disable-model-invocation (requires ${GROK_MINIMUM_CLI_VERSION}+)`,
        "upgrade Grok Build before checking status or applying the Profile",
        GROK_MINIMUM_CLI_VERSION,
      );
    }
    if (options.requireSkills) {
      throw versionFloorCapabilityFailure(
        "grok",
        `Grok CLI ${version} does not support native project Skills (requires ${GROK_MINIMUM_CLI_VERSION}+)`,
        "upgrade Grok Build before checking status or applying the Profile",
        GROK_MINIMUM_CLI_VERSION,
      );
    }
    if (options.requireContext === false) {
      throw versionFloorCapabilityFailure(
        "grok",
        `Grok CLI ${version} does not support native project Skills (requires ${GROK_MINIMUM_CLI_VERSION}+)`,
        "upgrade Grok Build before checking status or applying the Profile",
        GROK_MINIMUM_CLI_VERSION,
      );
    }
    throw versionFloorCapabilityFailure(
      "grok",
      `Grok CLI ${version} does not support project rules inspection (requires ${GROK_MINIMUM_CLI_VERSION}+)`,
      "upgrade Grok Build before checking status or applying the Profile",
      GROK_MINIMUM_CLI_VERSION,
    );
  }
}

export async function resolveGrokCliVersion(options: GrokCapabilityOptions): Promise<string> {
  if (options.resolveVersion) return options.resolveVersion();
  try {
    const { stdout, stderr } = await invokeExecutable("grok", ["version"], {
      env: options.env ?? process.env,
      timeoutMs: 10_000,
    });
    return parseGrokCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw capabilityFailure(
        "grok",
        "host",
        "Grok CLI was not found on PATH",
        "install Grok Build and ensure `grok version` works before checking status or applying the Profile",
      );
    }
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stdout || stderr) {
        try {
          return parseGrokCliVersion(`${stdout}\n${stderr}`);
        } catch {
          // fall through
        }
      }
    }
    throw capabilityFailure(
      "grok",
      "host",
      `Grok CLI version could not be detected (${error instanceof Error ? error.message : String(error)})`,
      "install a supported Grok Build release before checking status or applying the Profile",
    );
  }
}

function resolveGrokHome(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): string {
  const configured = env.GROK_HOME?.trim();
  if (configured) return resolve(configured);
  // Prefer the Installer-supplied machine home (tests isolate this path).
  return join(home ?? env.HOME ?? homedir(), ".grok");
}

function expandUserPath(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): string {
  if (path === "~") return env.HOME?.trim() || home || homedir();
  if (path.startsWith("~/")) {
    return join(env.HOME?.trim() || home || homedir(), path.slice(2));
  }
  if (path.startsWith("/")) return path;
  // Relative config entries are resolved from GROK_HOME (config directory), not cwd.
  return resolve(resolveGrokHome(env, home), path);
}

function requireTomlStringArray(
  value: unknown,
  description: string,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(
      `Grok skills configuration ${description} must be an array of strings`,
    );
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `Grok skills configuration ${description} must be an array of strings`,
      );
    }
    items.push(entry);
  }
  return [...new Set(items)].sort();
}

/**
 * Normalize the safety-critical `[skills]` fields from user `config.toml`.
 * Uses a conforming TOML parser and fails closed on invalid syntax or types for
 * `disabled`, `ignore`, and `paths`. Other tables/keys are ignored.
 */
export function parseGrokSkillsConfigSection(source: string): {
  readonly disabled: readonly string[];
  readonly ignore: readonly string[];
  readonly paths: readonly string[];
} {
  const root = parseTomlTable(source, "Grok skills configuration");
  const skills = root.skills;
  if (skills === undefined) {
    return { disabled: [], ignore: [], paths: [] };
  }
  if (typeof skills !== "object" || skills === null || Array.isArray(skills)) {
    throw new Error("Grok skills configuration [skills] must be a table");
  }
  const table = skills as Record<string, unknown>;
  return {
    disabled: requireTomlStringArray(table.disabled, "[skills].disabled"),
    ignore: requireTomlStringArray(table.ignore, "[skills].ignore"),
    paths: requireTomlStringArray(table.paths, "[skills].paths"),
  };
}

async function readGrokSkillsConfig(
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): Promise<{
  readonly disabled: readonly string[];
  readonly ignore: readonly string[];
  readonly paths: readonly string[];
}> {
  const configPath = join(resolveGrokHome(env, home), "config.toml");
  try {
    const source = await readFile(configPath, "utf8");
    return parseGrokSkillsConfigSection(source);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return { disabled: [], ignore: [], paths: [] };
    }
    if (
      error instanceof Error &&
      error.message.startsWith("Grok skills configuration")
    ) {
      throw error;
    }
    throw new Error(
      `Grok skills configuration at ${configPath} could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** Report relevant Grok settings that directly disable planned project Skills. */
export async function detectGrokProjectConfigurationWarnings(
  skillIds: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly home?: string; readonly project: string },
): Promise<readonly AdapterDiagnosticWarning[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const configPath = join(resolveGrokHome(env, home), "config.toml");
  let config: Awaited<ReturnType<typeof readGrokSkillsConfig>>;
  try {
    config = await readGrokSkillsConfig(env, home);
  } catch (error) {
    return [
      {
        copyableValues: [configPath],
        parts: [
          `Grok configuration relevant to planned Skills at ${configPath} could not be read or parsed (${error instanceof Error ? error.message : String(error)}); generated Skills may not load until the configuration is repaired`,
        ],
      },
    ];
  }

  const warnings: AdapterDiagnosticWarning[] = [];
  const disabled = new Set(config.disabled);
  for (const skillId of [...new Set(skillIds)].sort()) {
    const managedDirectory = join(options.project, ...grokProjectSkillPath(skillId).split("/"));
    if (disabled.has(skillId)) {
      warnings.push(
        {
          copyableValues: [configPath, skillId],
          parts: [
            "Grok configuration at ",
            identifierPart(configPath),
            " lists planned Skill '",
            identifierPart(skillId),
            "' as disabled; generated Skill output may not load until it is enabled",
          ],
        },
      );
    }
    if (
      pathIsIgnored(managedDirectory, config.ignore, env, home) ||
      pathIsIgnored(join(managedDirectory, "SKILL.md"), config.ignore, env, home)
    ) {
      warnings.push(
        {
          copyableValues: [configPath, managedDirectory, skillId],
          parts: [
            "Grok configuration at ",
            identifierPart(configPath),
            " ignores planned Skill '",
            identifierPart(skillId),
            "' at ",
            identifierPart(managedDirectory),
            "; generated Skill output may not load until the ignore entry is removed",
          ],
        },
      );
    }
  }
  return warnings;
}

function parseCompatCellEnabled(
  cells: unknown[],
  vendor: string,
  surface: string,
  description: string,
): boolean | undefined {
  const cell = cells.find((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const mapping = entry as Record<string, unknown>;
    return mapping.vendor === vendor && mapping.surface === surface;
  });
  if (!cell || typeof cell !== "object" || Array.isArray(cell)) return undefined;
  const enabled = (cell as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") {
    throw capabilityFailure(
      "grok",
      "project",
      `Grok inspect --json ${description} cell is unreadable`,
      "upgrade Grok Build before checking status or applying the Profile",
    );
  }
  return enabled;
}

/**
 * Parse Claude rules compatibility from `grok inspect --json` externalCompat cells.
 * Missing or unreadable cells fail closed so combined Claude/Grok bindings cannot
 * silently double-deliver Context.
 */
export function parseGrokInspectClaudeRulesEnabled(source: string): boolean {
  return parseGrokInspectDocument(source).claudeRulesEnabled;
}

/**
 * Parse the machine-readable Grok inspection document used for Context
 * compatibility planning.
 */
export function parseGrokInspectDocument(
  source: string,
  options: { readonly version?: string } = {},
): GrokInspection {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw capabilityFailure(
      "grok",
      "project",
      "Grok inspect --json output is not valid JSON",
      "upgrade Grok Build or fix the CLI before checking status or applying the Profile",
    );
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw capabilityFailure(
      "grok",
      "project",
      "Grok inspect --json output must be a JSON object",
      "upgrade Grok Build before checking status or applying the Profile",
    );
  }
  const root = document as Record<string, unknown>;
  const externalCompat = root.externalCompat;
  if (
    typeof externalCompat !== "object" ||
    externalCompat === null ||
    Array.isArray(externalCompat)
  ) {
    throw capabilityFailure(
      "grok",
      "project",
      "Grok inspect --json output is missing externalCompat",
      "upgrade Grok Build before checking status or applying the Profile",
    );
  }
  const cells = (externalCompat as Record<string, unknown>).cells;
  if (!Array.isArray(cells)) {
    throw capabilityFailure(
      "grok",
      "project",
      "Grok inspect --json externalCompat.cells must be an array",
      "upgrade Grok Build before checking status or applying the Profile",
    );
  }

  const claudeRulesEnabled = parseCompatCellEnabled(cells, "claude", "rules", "Claude rules compatibility");
  if (claudeRulesEnabled === undefined) {
    throw capabilityFailure(
      "grok",
      "project",
      "Grok inspect --json does not report the Claude rules compatibility cell",
      "upgrade Grok Build before checking status or applying the Profile",
    );
  }

  let version = options.version;
  if (version === undefined) {
    if (typeof root.grokVersion === "string" && root.grokVersion.trim()) {
      version = parseGrokCliVersion(root.grokVersion);
    } else {
      version = GROK_MINIMUM_CLI_VERSION;
    }
  }

  return { claudeRulesEnabled, version };
}

/**
 * Read-only Grok configuration inspection for Claude rules compatibility and Skill discovery.
 * Does not prove CLI version floor or project surface hostability.
 */
export async function inspectGrokProject(
  project: string,
  options: GrokCapabilityOptions = {},
): Promise<GrokInspection> {
  if (options.inspect) return options.inspect();
  const env = options.env ?? process.env;
  const version = options.resolveVersion
    ? await options.resolveVersion()
    : await resolveGrokCliVersion(options);
  try {
    const { stdout } = await invokeExecutable("grok", ["inspect", "--json"], {
      cwd: project,
      env,
      timeoutMs: 15_000,
    });
    // Parse machine-readable stdout only; stderr diagnostics must not corrupt JSON.
    return parseGrokInspectDocument(stdout, { version });
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw capabilityFailure(
        "grok",
        "host",
        "Grok CLI was not found on PATH",
        "install Grok Build and ensure `grok inspect --json` works before checking status or applying the Profile",
      );
    }
    if (error instanceof Error && error.message.startsWith("Grok inspect")) {
      throw error;
    }
    // Non-zero exit may still carry usable JSON on stdout.
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      if (stdout.trim()) {
        try {
          return parseGrokInspectDocument(stdout, { version });
        } catch (parseError) {
          if (
            parseError instanceof Error &&
            parseError.message.startsWith("Grok inspect")
          ) {
            throw parseError;
          }
        }
      }
    }
    throw capabilityFailure(
      "grok",
      "project",
      `Grok project inspection failed (${error instanceof Error ? error.message : String(error)})`,
      "ensure `grok inspect --json` works in the bound project before checking status or applying the Profile",
    );
  }
}

/**
 * Infer whether a prior Profile Installation used Claude rules coalescing.
 * Dual Claude+Grok rule paths mean compatibility was disabled; Claude path only
 * with both Hosts recorded means compatibility was enabled.
 */
export function inferGrokClaudeRulesEnabledFromOutputs(
  hosts: readonly string[],
  outputPaths: readonly string[],
): boolean | undefined {
  if (!hosts.includes("claude") || !hosts.includes("grok")) return undefined;
  const paths = new Set(outputPaths);
  const hasClaudeRule = paths.has(CLAUDE_CONTEXT_RULE_PATH);
  const hasGrokRule = paths.has(GROK_CONTEXT_RULE_PATH);
  if (hasClaudeRule && hasGrokRule) return false;
  if (hasClaudeRule && !hasGrokRule) return true;
  if (!hasClaudeRule && hasGrokRule) return false;
  return undefined;
}

/**
 * Reject project surfaces or Host installs that cannot host Grok project outputs.
 * Proves CLI floor, inspectable configuration, and that required `.grok` surfaces
 * can host outputs. Authentication, trust, and unrelated Host configuration are
 * never inspected or written.
 */
/**
 * Complete normalized machine-level requirements that affect the Grok CLI probe
 * result. Callers route identical requirement sets through one probe per
 * invocation so distinct sets cannot reuse incompatible evidence.
 */
export function grokMachineRequirements(options: {
  readonly requireContext?: boolean;
  readonly requireSkills?: boolean;
  readonly requireDisabledModelInvocation?: boolean;
}): Readonly<Record<string, boolean>> {
  return {
    requireContext: options.requireContext !== false,
    requireSkills: options.requireSkills === true,
    requireDisabledModelInvocation: options.requireDisabledModelInvocation === true,
  };
}

/**
 * Resolve and validate the Grok CLI version at one machine-level boundary.
 * Runs the `grok version` executable at most once per unique requirement set
 * per invocation when routed through the invocation-scoped planning context.
 * Returns the normalized core semver or throws a capability failure for
 * missing, unreadable, or outdated Host executables.
 */
export async function probeGrokMachineCapability(
  options: GrokCapabilityOptions,
): Promise<string> {
  const requireContext = options.requireContext !== false;
  const requireSkills = options.requireSkills === true;
  const version = await resolveGrokCliVersion(options);
  assertGrokCliVersionSupported(version, {
    requireContext,
    requireSkills,
    ...(options.requireDisabledModelInvocation
      ? { requireDisabledModelInvocation: true }
      : {}),
  });
  return version;
}

/**
 * Reject Grok project surfaces that cannot host planned outputs and resolve
 * Project-specific Claude rules compatibility topology. The CLI floor is proven
 * by the machine-level probe; `grok inspect --json` and path checks remain
 * Project-specific and still run for every affected Project.
 */
export async function assertGrokProjectSurface(
  project: string,
  version: string,
  options: GrokCapabilityOptions = {},
): Promise<GrokInspection> {
  const requireContext = options.requireContext !== false;
  const requireSkills = options.requireSkills === true;
  const inspection = requireContext
    ? await inspectGrokProject(project, {
        ...options,
        resolveVersion: async () => version,
      })
    : { claudeRulesEnabled: true, version };

  const grokPath = join(project, ".grok");
  const grokKind = await classifyFileSystemEntry(grokPath);
  if (grokKind !== "missing" && grokKind !== "directory") {
    const problem =
      `Grok project surface cannot host outputs: ${grokPath} is a ${grokKind}, not a directory`;
    throw capabilityFailure(
      "grok",
      "project",
      problem,
      "ensure the Grok project surface is a directory, then retry",
      [{ kind: "path", value: grokPath }],
      [
        "Grok project surface cannot host outputs: ",
        identifierPart(grokPath),
        ` is a ${grokKind}, not a directory`,
      ],
    );
  }

  if (requireSkills) {
    const skillsPath = join(project, ".grok", "skills");
    const skillsKind = await classifyFileSystemEntry(skillsPath);
    if (skillsKind !== "missing" && skillsKind !== "directory") {
      const problem =
        `Grok project surface cannot host Skills: ${skillsPath} is a ${skillsKind}, not a directory`;
      throw capabilityFailure(
        "grok",
        "project",
        problem,
        "ensure the Grok Skills surface is a directory, then retry",
        [{ kind: "path", value: skillsPath }],
        [
          "Grok project surface cannot host Skills: ",
          identifierPart(skillsPath),
          ` is a ${skillsKind}, not a directory`,
        ],
      );
    }
  }

  // Skills-only Profiles do not write unscoped rules; skip the rules surface then.
  if (requireContext) {
    const rulesPath = join(project, ".grok", "rules");
    const rulesKind = await classifyFileSystemEntry(rulesPath);
    if (rulesKind !== "missing" && rulesKind !== "directory") {
      const problem =
        `Grok project surface cannot host unscoped rules: ${rulesPath} is a ${rulesKind}, not a directory`;
      throw capabilityFailure(
        "grok",
        "project",
        problem,
        "ensure the Grok rules surface is a directory, then retry",
        [{ kind: "path", value: rulesPath }],
        [
          "Grok project surface cannot host unscoped rules: ",
          identifierPart(rulesPath),
          ` is a ${rulesKind}, not a directory`,
        ],
      );
    }
  }

  return inspection;
}

/**
 * Reject project surfaces or Host installs that cannot host Grok project outputs.
 * Proves CLI floor, inspectable configuration, and that required `.grok` surfaces
 * can host outputs. Authentication, trust, and unrelated Host configuration are
 * never inspected or written.
 */
export async function assertGrokProjectCapability(
  project: string,
  options: GrokCapabilityOptions = {},
): Promise<GrokInspection> {
  const version = await probeGrokMachineCapability(options);
  return assertGrokProjectSurface(project, version, options);
}

/**
 * Choose the project-relative Context rule path for a Grok plan.
 * When Claude is co-selected and Grok loads Claude project rules, emit the Claude
 * path so global Installer normalization coalesces one effective copy.
 */
export function resolveGrokContextRulePath(options: GrokProjectPlanOptions = {}): string {
  const claudeCoSelected = options.claudeCoSelected === true;
  const claudeRulesEnabled = options.claudeRulesEnabled !== false;
  if (claudeCoSelected && claudeRulesEnabled) {
    return CLAUDE_CONTEXT_RULE_PATH;
  }
  return GROK_CONTEXT_RULE_PATH;
}

function contextRule(
  profileId: string,
  modules: readonly ContextModuleSource[],
  path: string,
  materials: AdapterPlanningMaterials,
): ProposedProjectFileOutput {
  // When sharing Claude's rule path, emit the same requirements Claude plans so
  // Installer normalization can coalesce one physical output for both Hosts.
  const requirements =
    path === CLAUDE_CONTEXT_RULE_PATH
      ? [...CLAUDE_CONTEXT_REQUIREMENTS]
      : [
          "Grok loads unscoped project rule as additive Profile Context",
          "Grok discovers owned rule through native project .grok/rules",
        ];
  return {
    bytes: materials.composeContext(profileId, modules),
    mode: 0o644,
    origins: modules.map((module) => ({ id: module.id, type: "context" as const })),
    path,
    requirements,
    type: "file",
  };
}

/** Project-relative managed Skill package path for a selected Artifact ID. */
export function grokProjectSkillPath(skillId: string): string {
  return posix.join(GROK_SKILLS_DISCOVERY_ROOT, skillId);
}

/** Emit Grok Host SKILL.md with disable-model-invocation when policy is disabled. */
export function emitGrokSkillMarkdown(
  skillId: string,
  source: string,
  modelInvocation: ModelInvocationPolicy,
): string {
  if (modelInvocation === "allowed") return source;

  const delimiter = "---\n";
  if (!source.startsWith(delimiter)) {
    throw new Error(`Skill '${skillId}' SKILL.md must start with YAML frontmatter`);
  }
  const closing = source.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw new Error(`Skill '${skillId}' SKILL.md must close its YAML frontmatter`);
  }
  const header = requireMapping(
    parseYaml(
      source.slice(delimiter.length, closing),
      `Skill '${skillId}' SKILL.md frontmatter`,
    ),
    `Skill '${skillId}' SKILL.md frontmatter`,
  );
  header["disable-model-invocation"] = true;
  const body = source.slice(closing + delimiter.length);
  return `${delimiter}${stringify(header).trimEnd()}\n---\n${body}`;
}

/** Grok-owned Skill package projection (Host-native model-invocation mapping). */
export function projectGrokSkillMembers(
  skill: Skill,
  members: readonly ProposedDirectoryMember[],
): readonly ProposedDirectoryMember[] {
  return members.map((member) => {
    if (member.type !== "file" || member.path !== "SKILL.md") return member;
    const projected: ProposedDirectoryFileMember = {
      ...member,
      bytes: emitGrokSkillMarkdown(
        skill.id,
        memberBytesAsString(member.bytes),
        skill.modelInvocation,
      ),
    };
    return projected;
  });
}

export function grokSkillRequirements(
  skill: Skill,
  base: readonly string[],
): readonly string[] {
  if (skill.modelInvocation !== "disabled") return base;
  return [
    ...base,
    DISABLED_MODEL_INVOCATION_REQUIREMENT,
    "Grok disable-model-invocation frontmatter enforces disabled model invocation",
  ];
}

const GROK_SKILL_PROJECTION: SkillPackageProjection = {
  projectMembers: projectGrokSkillMembers,
  requirements: grokSkillRequirements,
};

function normalizePathForCompare(path: string): string {
  return resolve(path);
}

function pathIsIgnored(
  candidate: string,
  ignorePaths: readonly string[],
  env: NodeJS.ProcessEnv,
  home?: string,
): boolean {
  const actual = normalizePathForCompare(candidate);
  for (const raw of ignorePaths) {
    const ignore = normalizePathForCompare(expandUserPath(raw, env, home));
    if (actual === ignore || actual.startsWith(`${ignore}${sep}`)) return true;
  }
  return false;
}

/**
 * Pure Grok Adapter planner for Profile Context and portable Skills.
 * Does not write filesystem state or coordinate with other Adapters.
 */
export async function planGrokProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  skills: readonly Skill[] = [],
  options: GrokProjectPlanOptions = {},
): Promise<GrokProjectPlan> {
  const materials = options.materials ?? DEFAULT_ADAPTER_PLANNING_MATERIALS;
  const path = resolveGrokContextRulePath(options);
  const skillOutputs = await Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSkillPackageDirectory(
          skill,
          GROK_SKILLS_DISCOVERY_ROOT,
          ["Grok discovers Skill package through native project .grok/skills"],
          GROK_SKILL_PROJECTION,
          materials,
        ),
      ),
  );
  // Omit the Context rule when the Profile selects no Context Modules.
  const outputs: ProposedProjectOutput[] =
    modules.length > 0
      ? [contextRule(profileId, modules, path, materials), ...skillOutputs]
      : [...skillOutputs];
  const setupSteps: readonly AdapterHostSetupStep[] =
    modules.length > 0 && path === CLAUDE_CONTEXT_RULE_PATH
      ? [{
          kind: "shared-path",
          message:
            `Grok uses Profile Context from Claude's shared rule path: ${CLAUDE_CONTEXT_RULE_PATH}.`,
          provenance: "standing",
        }]
      : [];
  return {
    host: "grok",
    hostVersion: skillsRequireDisabledModelInvocation(skills)
      ? GROK_HOST_VERSION_WITH_INVOCATION
      : skills.length > 0
        ? GROK_HOST_VERSION_WITH_SKILLS
        : GROK_HOST_VERSION,
    outputs,
    setupSteps,
  };
}

export const grokAdapter = {
  host: "grok",
  async planProject(input, services) {
    const requireContext = input.resolvedContexts.length > 0;
    const requireSkills = input.resolvedSkills.length > 0;
    const requireDisabledModelInvocation = skillsRequireDisabledModelInvocation(
      input.resolvedSkills,
    );
    const capabilityOptions = {
      ...(input.env === undefined ? {} : { env: input.env }),
      home: input.home,
      requireContext,
      requireDisabledModelInvocation,
      requireSkills,
    };
    const capabilityFailures: AdapterCapabilityFailure[] = [];
    let inspection: GrokInspection | undefined;

    if (input.checkHostCapability) {
      let version: string | undefined;
      try {
        version = await services.probeMachineCapability(
          grokMachineRequirements({
            requireContext,
            requireDisabledModelInvocation,
            requireSkills,
          }),
          () => probeGrokMachineCapability(capabilityOptions),
        );
      } catch (error) {
        capabilityFailures.push(caughtCapabilityFailure("grok", "host", error));
      }
      // Project inspection and surface checks need the resolved CLI version,
      // so they run only when the machine probe succeeded; their failures are
      // Project-specific evidence even when they carry no path affected item.
      if (version !== undefined) {
        try {
          inspection = await assertGrokProjectSurface(input.project, version, capabilityOptions);
        } catch (error) {
          capabilityFailures.push(caughtCapabilityFailure("grok", "project", error));
        }
      }
    }

    const diagnostics = requireSkills
      ? await detectGrokProjectConfigurationWarnings(
          input.resolvedSkills.map((skill) => skill.id),
          { home: input.home, project: input.project },
        )
      : [];
    const claudeCoSelected = input.selectedHosts.includes("claude");
    let claudeRulesEnabled = inspection?.claudeRulesEnabled;
    if (requireContext && claudeRulesEnabled === undefined && claudeCoSelected) {
      const previous = input.previousInstallation;
      claudeRulesEnabled = previous
        ? inferGrokClaudeRulesEnabledFromOutputs(
            previous.hosts,
            previous.outputs.map((output) => output.path),
          )
        : undefined;
    }
    const effectiveClaudeRulesEnabled = claudeRulesEnabled ?? true;
    const plan = await services.planProjection(
      {
        host: "grok",
        options: { claudeCoSelected, claudeRulesEnabled: effectiveClaudeRulesEnabled },
        profileId: input.profileId,
        resolvedContexts: input.resolvedContexts,
        resolvedSkills: input.resolvedSkills,
      },
      () => planGrokProject(
        input.profileId,
        input.resolvedContexts,
        input.resolvedSkills,
        {
          claudeCoSelected,
          claudeRulesEnabled: effectiveClaudeRulesEnabled,
          materials: services.materials,
        },
      ),
    );
    return { capabilityFailures, diagnostics, plan };
  },
} satisfies CompleteHostAdapter;
