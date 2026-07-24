import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";

import {
  CLAUDE_CONTEXT_REQUIREMENTS,
  CLAUDE_CONTEXT_RULE_PATH,
} from "./claude.js";
import { composeContextEnvelope, type ContextModuleSource } from "./context-envelope.js";
import type {
  AdapterProjectPlan,
  ProposedProjectFileOutput,
} from "./project-plan.js";

const execFileAsync = promisify(execFile);

export const GROK_ADAPTER_VERSION = "grok-project-v1";

/**
 * Capability-contract token recorded in Installation Manifest host_versions after
 * the installed Grok CLI is proven to support always-scanned project rules under
 * `.grok/rules/` and machine-readable `grok inspect --json` configuration inspection.
 *
 * Skills are intentionally outside this contract until portable Grok Skill delivery
 * ships (successor ticket).
 */
export const GROK_HOST_VERSION = "native-project-unscoped-rules-v1";

/**
 * Minimum Grok CLI version that preserves the Grok project Capability Contract.
 * Evidence: Grok Build documents always-scanned project `.grok/rules/*.md` and
 * `grok inspect --json` with `externalCompat` cells for Claude rules compatibility.
 * Releases that cannot report that surface fail closed at inspection instead of
 * weakening delivery.
 */
export const GROK_MINIMUM_CLI_VERSION = "0.2.0";

/** Owned unscoped Grok project rule path (always-scanned `.grok/rules/*.md`). */
export const GROK_CONTEXT_RULE_PATH = posix.join(
  ".grok",
  "rules",
  "agent-profile-kit.md",
);

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
   * Injectable inspection probe for tests. Defaults to `grok version` plus
   * `grok inspect --json` run with cwd set to the bound project root.
   */
  readonly inspect?: () => Promise<GrokInspection>;
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

/** Parse the leading semver from `grok version` output (e.g. `grok 0.2.111 (…)`). */
export function parseGrokCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(
      `Grok CLI version is unreadable from '${source.trim()}'; install a supported Grok Build release`,
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

/** Reject Grok CLI releases below the project-rules Capability Contract floor. */
export function assertGrokCliVersionSupported(version: string): void {
  if (compareSemver(version, GROK_MINIMUM_CLI_VERSION) < 0) {
    throw new Error(
      `Grok CLI ${version} does not support project rules inspection (requires ${GROK_MINIMUM_CLI_VERSION}+); upgrade Grok Build before previewing or applying the Profile`,
    );
  }
}

async function resolveGrokCliVersion(options: GrokCapabilityOptions): Promise<string> {
  if (options.resolveVersion) return options.resolveVersion();
  try {
    const { stdout, stderr } = await execFileAsync("grok", ["version"], {
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    return parseGrokCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        "Grok CLI was not found on PATH; install Grok Build and ensure `grok version` works before previewing or applying the Profile",
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
    throw new Error(
      `Grok CLI version could not be detected (${error instanceof Error ? error.message : String(error)}); install a supported Grok Build release before previewing or applying the Profile`,
    );
  }
}

/**
 * Parse Claude rules compatibility from `grok inspect --json` externalCompat cells.
 * Missing or unreadable cells fail closed so combined Claude/Grok bindings cannot
 * silently double-deliver Context.
 */
export function parseGrokInspectClaudeRulesEnabled(source: string): boolean {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error(
      "Grok inspect --json output is not valid JSON; upgrade Grok Build or fix the CLI before previewing or applying the Profile",
    );
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(
      "Grok inspect --json output must be a JSON object; upgrade Grok Build before previewing or applying the Profile",
    );
  }
  const root = document as Record<string, unknown>;
  const externalCompat = root.externalCompat;
  if (
    typeof externalCompat !== "object" ||
    externalCompat === null ||
    Array.isArray(externalCompat)
  ) {
    throw new Error(
      "Grok inspect --json output is missing externalCompat; upgrade Grok Build before previewing or applying the Profile",
    );
  }
  const cells = (externalCompat as Record<string, unknown>).cells;
  if (!Array.isArray(cells)) {
    throw new Error(
      "Grok inspect --json externalCompat.cells must be an array; upgrade Grok Build before previewing or applying the Profile",
    );
  }
  const claudeRules = cells.find((cell) => {
    if (typeof cell !== "object" || cell === null || Array.isArray(cell)) return false;
    const mapping = cell as Record<string, unknown>;
    return mapping.vendor === "claude" && mapping.surface === "rules";
  });
  if (!claudeRules || typeof claudeRules !== "object" || Array.isArray(claudeRules)) {
    throw new Error(
      "Grok inspect --json does not report the Claude rules compatibility cell; upgrade Grok Build before previewing or applying the Profile",
    );
  }
  const enabled = (claudeRules as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") {
    throw new Error(
      "Grok inspect --json Claude rules compatibility cell is unreadable; upgrade Grok Build before previewing or applying the Profile",
    );
  }
  return enabled;
}

/**
 * Read-only Grok configuration inspection for Claude rules compatibility.
 * Does not prove CLI version floor or project surface hostability.
 */
export async function inspectGrokProject(
  project: string,
  options: GrokCapabilityOptions = {},
): Promise<GrokInspection> {
  if (options.inspect) return options.inspect();
  const version = options.resolveVersion
    ? await options.resolveVersion()
    : await resolveGrokCliVersion(options);
  try {
    const { stdout } = await execFileAsync("grok", ["inspect", "--json"], {
      cwd: project,
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: 15_000,
    });
    // Parse machine-readable stdout only; stderr diagnostics must not corrupt JSON.
    const claudeRulesEnabled = parseGrokInspectClaudeRulesEnabled(stdout);
    return { claudeRulesEnabled, version };
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        "Grok CLI was not found on PATH; install Grok Build and ensure `grok inspect --json` works before previewing or applying the Profile",
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
          const claudeRulesEnabled = parseGrokInspectClaudeRulesEnabled(stdout);
          return { claudeRulesEnabled, version };
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message.startsWith("Grok inspect")) {
            throw parseError;
          }
        }
      }
    }
    throw new Error(
      `Grok project inspection failed (${error instanceof Error ? error.message : String(error)}); ensure \`grok inspect --json\` works in the bound project before previewing or applying the Profile`,
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
 * Reject project surfaces or Host installs that cannot host Grok Context output.
 * Proves CLI floor, inspectable Claude rules compatibility, and that `.grok` /
 * `.grok/rules` can host an unscoped rule. Authentication, trust, and unrelated
 * Host configuration are never inspected or written.
 */
export async function assertGrokProjectCapability(
  project: string,
  options: GrokCapabilityOptions = {},
): Promise<GrokInspection> {
  const version = await resolveGrokCliVersion(options);
  assertGrokCliVersionSupported(version);
  const inspection = await inspectGrokProject(project, {
    ...options,
    resolveVersion: async () => version,
  });

  const grokPath = join(project, ".grok");
  const grokKind = await pathKind(grokPath);
  if (grokKind !== "missing" && grokKind !== "directory") {
    throw new Error(
      `Grok project surface cannot host outputs: ${grokPath} is a ${grokKind}, not a directory`,
    );
  }

  const rulesPath = join(project, ".grok", "rules");
  const rulesKind = await pathKind(rulesPath);
  if (rulesKind !== "missing" && rulesKind !== "directory") {
    throw new Error(
      `Grok project surface cannot host unscoped rules: ${rulesPath} is a ${rulesKind}, not a directory`,
    );
  }

  return inspection;
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
    bytes: composeContextEnvelope(profileId, modules),
    mode: 0o644,
    path,
    requirements,
    type: "file",
  };
}

/**
 * Pure Grok Adapter planner for Profile Context.
 * Does not write filesystem state, plan Skills, or coordinate with other Adapters.
 * Portable Grok Skill delivery is intentionally unsupported until a successor ticket.
 */
export async function planGrokProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  options: GrokProjectPlanOptions = {},
): Promise<GrokProjectPlan> {
  const path = resolveGrokContextRulePath(options);
  // Omit the Context rule when the Profile selects no Context Modules.
  const outputs = modules.length > 0 ? [contextRule(profileId, modules, path)] : [];
  return {
    host: "grok",
    hostVersion: GROK_HOST_VERSION,
    outputs,
  };
}

/** Blocker when a Grok binding resolves any Skills before Grok Skill support exists. */
export function grokSkillsUnsupportedBlocker(project: string): string {
  return (
    `${project}: Grok portable Skill delivery is not supported yet; remove Skills from the ` +
    `selected Profile or drop the Grok Host binding before previewing or applying`
  );
}
