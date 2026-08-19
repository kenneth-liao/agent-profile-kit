import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";

import type { Skill } from "../schemas/skill.js";
import {
  composeContextEnvelope,
  composeContextModuleBoundary,
  type ContextModuleSource,
} from "./context-envelope.js";
import { capabilityFailure } from "./capability.js";
import type {
  AdapterHostSetupStep,
  AdapterProjectPlan,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";

const execFileAsync = promisify(execFile);

export const ANTIGRAVITY_ADAPTER_VERSION = "antigravity-project-v1";
/** Capability Contract for complete always-on project Context rules. */
export const ANTIGRAVITY_HOST_VERSION = "native-project-always-on-rules-v1";
export const ANTIGRAVITY_MINIMUM_CLI_VERSION = "1.1.13";
export const ANTIGRAVITY_RULE_CHARACTER_LIMIT = 12_000;
export const ANTIGRAVITY_CONTEXT_RULES_ROOT = posix.join(".agents", "rules");
export const ANTIGRAVITY_CONTEXT_REQUIREMENTS = [
  "Antigravity loads always-on Profile Context from native project .agents/rules",
  "Antigravity rule content remains subordinate to repository-owned instructions",
] as const;

const ANTIGRAVITY_RULE_FRONTMATTER = "---\ntrigger: always_on\n---\n\n";
const ANTIGRAVITY_RULE_PREFIX = "agent-profile-kit";
const ANTIGRAVITY_RULE_SEQUENCE_WIDTH = 3;

export type AntigravityProjectPlan = AdapterProjectPlan;

export interface AntigravityCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable version probe for tests; defaults to `agy --version`. */
  readonly resolveVersion?: () => Promise<string>;
  /** Whether the selected Profile requires Context rules. Defaults to true. */
  readonly requireContext?: boolean;
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

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}

/** Parse the leading semver from `agy --version` output. */
export function parseAntigravityCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw capabilityFailure(
      "antigravity",
      `Antigravity CLI version is unreadable from '${source.trim()}'`,
      `install Antigravity CLI ${ANTIGRAVITY_MINIMUM_CLI_VERSION}+ and ensure \`agy --version\` works before previewing or applying the Profile`,
    );
  }
  return `${match[1]}.${match[2]}.${match[3]}`;
}

/** Reject CLI versions that cannot preserve Antigravity project rules. */
export function assertAntigravityCliVersionSupported(version: string): void {
  if (compareSemver(version, ANTIGRAVITY_MINIMUM_CLI_VERSION) < 0) {
    throw capabilityFailure(
      "antigravity",
      `Antigravity CLI ${version} does not support native project always-on rules (requires ${ANTIGRAVITY_MINIMUM_CLI_VERSION}+)`,
      "upgrade Antigravity CLI before previewing or applying the Profile",
    );
  }
}

async function resolveAntigravityCliVersion(
  options: AntigravityCapabilityOptions,
): Promise<string> {
  if (options.resolveVersion) return parseAntigravityCliVersion(await options.resolveVersion());
  try {
    const { stdout, stderr } = await execFileAsync("agy", ["--version"], {
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    return parseAntigravityCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw capabilityFailure(
        "antigravity",
        "Antigravity CLI was not found on PATH",
        `install Antigravity CLI ${ANTIGRAVITY_MINIMUM_CLI_VERSION}+ and ensure \`agy --version\` works before previewing or applying the Profile`,
      );
    }
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stdout || stderr) {
        try {
          return parseAntigravityCliVersion(`${stdout}\n${stderr}`);
        } catch {
          // Fall through to the generic capability failure below.
        }
      }
    }
    throw capabilityFailure(
      "antigravity",
      `Antigravity CLI version could not be detected (${error instanceof Error ? error.message : String(error)})`,
      `install Antigravity CLI ${ANTIGRAVITY_MINIMUM_CLI_VERSION}+ before previewing or applying the Profile`,
    );
  }
}

/** Complete machine-level requirements for the Antigravity CLI probe. */
export function antigravityMachineRequirements(options: {
  readonly requireContext?: boolean;
}): Readonly<Record<string, boolean>> {
  return {
    requireContext: options.requireContext !== false,
  };
}

/** Resolve and validate Antigravity CLI capability evidence. */
export async function probeAntigravityMachineCapability(
  options: AntigravityCapabilityOptions = {},
): Promise<string> {
  const version = await resolveAntigravityCliVersion(options);
  assertAntigravityCliVersionSupported(version);
  return version;
}

function surfaceFailure(
  project: string,
  path: string,
  kind: string,
  requirement: string,
): ReturnType<typeof capabilityFailure> {
  const problem = `Antigravity project surface cannot host ${requirement}: ${path} is a ${kind}, not a directory`;
  return capabilityFailure(
    "antigravity",
    problem,
    `ensure the Antigravity ${requirement} surface is a directory, then retry`,
    [{ kind: "path", value: join(project, path) }],
    problem,
  );
}

/** Reject required Antigravity project surfaces that are not real directories. */
export async function assertAntigravityProjectSurface(
  project: string,
  options: { readonly requireContext?: boolean } = {},
): Promise<void> {
  if (options.requireContext === false) return;

  const agentsPath = join(project, ".agents");
  const agentsKind = await pathKind(agentsPath);
  if (agentsKind !== "missing" && agentsKind !== "directory") {
    throw surfaceFailure(project, ".agents", agentsKind, "Context");
  }

  const rulesPath = join(project, ...ANTIGRAVITY_CONTEXT_RULES_ROOT.split("/"));
  const rulesKind = await pathKind(rulesPath);
  if (rulesKind !== "missing" && rulesKind !== "directory") {
    throw surfaceFailure(project, ANTIGRAVITY_CONTEXT_RULES_ROOT, rulesKind, "Context rules");
  }
}

/** Prove the Antigravity CLI and project surfaces needed by the selected Profile. */
export async function assertAntigravityProjectCapability(
  project: string,
  options: AntigravityCapabilityOptions = {},
): Promise<void> {
  await probeAntigravityMachineCapability(options);
  await assertAntigravityProjectSurface(project, options);
}

function ruleCharacterCount(source: string): number {
  return [...source].length;
}

function rulePath(index: number, moduleId?: string): string {
  const numericSequence = String(index * 10);
  if (numericSequence.length > ANTIGRAVITY_RULE_SEQUENCE_WIDTH) {
    const problem =
      `Antigravity rule sequence '${numericSequence}' cannot preserve stable lexical order within ${ANTIGRAVITY_RULE_SEQUENCE_WIDTH}-digit rule names`;
    throw capabilityFailure(
      "antigravity",
      problem,
      "select fewer Context Modules and retry",
      [],
      problem,
    );
  }
  const sequence = numericSequence.padStart(ANTIGRAVITY_RULE_SEQUENCE_WIDTH, "0");
  return posix.join(
    ANTIGRAVITY_CONTEXT_RULES_ROOT,
    `${ANTIGRAVITY_RULE_PREFIX}-${sequence}-${moduleId ?? "envelope"}.md`,
  );
}

function ruleBytes(body: string): string {
  const content = body.endsWith("\n") ? body : `${body}\n`;
  return `${ANTIGRAVITY_RULE_FRONTMATTER}${content}`;
}

function assertRuleSize(path: string, bytes: string): void {
  if (ruleCharacterCount(bytes) <= ANTIGRAVITY_RULE_CHARACTER_LIMIT) return;
  const problem = `Antigravity rule '${path}' is ${ruleCharacterCount(bytes)} characters, exceeding the ${ANTIGRAVITY_RULE_CHARACTER_LIMIT}-character limit`;
  throw capabilityFailure(
    "antigravity",
    problem,
    "shorten the selected Context Module so its complete always-on rule fits, then retry",
    [{ kind: "path", value: path }],
    problem,
  );
}

function envelopeOutput(
  profileId: string,
): ProposedProjectFileOutput {
  const path = rulePath(0);
  const bytes = ruleBytes(composeContextEnvelope(profileId, []));
  assertRuleSize(path, bytes);
  return {
    bytes,
    mode: 0o644,
    origins: [],
    path,
    requirements: [...ANTIGRAVITY_CONTEXT_REQUIREMENTS],
    type: "file",
  };
}

function moduleOutput(
  module: ContextModuleSource,
  index: number,
): ProposedProjectFileOutput {
  const path = rulePath(index, module.id);
  const bytes = ruleBytes(composeContextModuleBoundary(module));
  assertRuleSize(path, bytes);
  return {
    bytes,
    mode: 0o644,
    origins: [{ id: module.id, type: "context" }],
    path,
    requirements: [
      ...ANTIGRAVITY_CONTEXT_REQUIREMENTS,
      `Antigravity preserves complete Context Module '${module.id}' in one always-on rule`,
    ],
    type: "file",
  };
}

/**
 * Pure Antigravity Adapter planner for Profile Context. Antigravity Skill
 * delivery is qualified by the follow-up Host integration ticket, so a Profile
 * selecting Skills is rejected rather than silently omitting them.
 */
export async function planAntigravityProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  skills: readonly Skill[],
): Promise<AntigravityProjectPlan> {
  if (skills.length > 0) {
    throw capabilityFailure(
      "antigravity",
      "Antigravity Skill delivery is not supported by this Adapter",
      "remove Antigravity from the binding or select a Context-only Profile, then retry",
    );
  }

  const outputs: readonly ProposedProjectOutput[] = modules.length === 0
    ? []
    : [envelopeOutput(profileId), ...modules.map((module, index) => moduleOutput(module, index + 1))];
  const setupSteps: readonly AdapterHostSetupStep[] = outputs.length > 0
    ? [{
        consequence: "The Profile does not load until the project is trusted.",
        kind: "trust-required",
        message: "Trust the bound project in Antigravity.",
        provenance: "standing",
      }]
    : [];
  return {
    host: "antigravity",
    hostVersion: ANTIGRAVITY_HOST_VERSION,
    outputs,
    setupSteps,
  };
}
