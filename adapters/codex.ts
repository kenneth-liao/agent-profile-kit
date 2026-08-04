import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

import type { ModelInvocationPolicy, Skill } from "../schemas/skill.js";
import { composeContextEnvelope } from "./context-envelope.js";
import type {
  AdapterHostSetupStep,
  AdapterProjectPlan,
  ProposedDirectoryFileMember,
  ProposedDirectoryMember,
  ProposedProjectOutput,
} from "./project-plan.js";
import {
  DISABLED_MODEL_INVOCATION_REQUIREMENT,
  planSkillPackageDirectory,
  skillsRequireDisabledModelInvocation,
  type SkillPackageProjection,
} from "./skill-package.js";
import { parseTomlTable } from "./toml.js";

const execFileAsync = promisify(execFile);

export const CODEX_ADAPTER_VERSION = "codex-project-v2";

/**
 * Capability-contract token for Codex project Context via SessionStart hooks
 * with complete direct delivery and portable Skill package discovery under
 * `.agents/skills/` when no Skill requires disabled model invocation.
 */
export const CODEX_HOST_VERSION = "native-project-sessionstart-complete-context-v1";

/**
 * Capability-contract token when a selected Skill requires disabled model invocation.
 * Proven by Codex CLI version that honors `agents/openai.yaml`
 * `policy.allow_implicit_invocation`, plus SessionStart hooks for Context.
 */
export const CODEX_HOST_VERSION_WITH_INVOCATION =
  "native-project-sessionstart-complete-context-skills-invocation-v1";

/** Capability-contract token for Codex Skills-only installations. */
export const CODEX_SKILLS_HOST_VERSION = "native-project-skills-v1";

/** Capability-contract token for Codex Skills-only installations with invocation policy. */
export const CODEX_SKILLS_HOST_VERSION_WITH_INVOCATION =
  "native-project-skills-invocation-v1";

/**
 * Minimum Codex CLI version that passes complete SessionStart Context directly to the model.
 * Evidence: OpenAI added `additionalContextLimit` on command SessionStart handlers in
 * rust-v0.145.0 (https://github.com/openai/codex/releases/tag/rust-v0.145.0). The value
 * `0` is the Codex contract for unlimited direct delivery (not "none"). Earlier CLIs omit
 * the field and spill oversized hook output into a head-and-tail preview.
 */
export const CODEX_MINIMUM_CLI_VERSION_FOR_COMPLETE_CONTEXT = "0.145.0";

/**
 * Minimum Codex CLI version that enforces `policy.allow_implicit_invocation: false`.
 * Evidence: OpenAI added SkillPolicy / allow_implicit_invocation in
 * openai/codex#11244 (2026-02-10). Official tag rust-v0.98.0 has no support;
 * rust-v0.99.0 is the first stable release that contains the field in
 * codex-rs/core/src/skills/model.rs. Earlier CLIs may discover Skills under
 * `.agents/skills/` but treat implicit invocation as always allowed.
 */
export const CODEX_MINIMUM_CLI_VERSION_FOR_DISABLED_MODEL_INVOCATION = "0.99.0";

/** Codex Skill metadata path for Host-native invocation policy. */
export const CODEX_SKILL_OPENAI_YAML = "agents/openai.yaml";

/** Codex native project Skill discovery root (project-relative). */
export const CODEX_SKILLS_DISCOVERY_ROOT = posix.join(".agents", "skills");

export type CodexProjectPlan = AdapterProjectPlan;

export interface CodexCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** When true, prove Host can deliver complete SessionStart Context directly. */
  readonly requireContext?: boolean;
  /** When true, prove Host can enforce disabled model invocation. */
  readonly requireDisabledModelInvocation?: boolean;
  /** Injectable version probe for tests; defaults to `codex --version`. */
  readonly resolveVersion?: () => Promise<string>;
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

export function parseCodexHooksFeatureSetting(source: string, path: string): boolean | undefined {
  const features = parseTomlTable(source, `Codex configuration at ${path}`).features;
  if (features === undefined) return undefined;
  if (typeof features !== "object" || features === null || Array.isArray(features)) {
    throw new Error(`Codex configuration [features] at ${path} must be a TOML table`);
  }
  const mapping = features as Record<string, unknown>;
  const hooks = mapping.hooks;
  const codexHooks = mapping.codex_hooks;
  if (hooks !== undefined && typeof hooks !== "boolean") {
    throw new Error(`Codex [features].hooks at ${path} must be a boolean`);
  }
  if (codexHooks !== undefined && typeof codexHooks !== "boolean") {
    throw new Error(`Codex [features].codex_hooks at ${path} must be a boolean`);
  }
  return (hooks as boolean | undefined) ?? (codexHooks as boolean | undefined);
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

function resolveCodexHome(home: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(home, ".codex");
}

/**
 * Parse a Codex version from `codex --version` output into a core `MAJOR.MINOR.PATCH`.
 * Accepts an optional leading `codex-cli`/`codex` label, optional `v` prefix, optional
 * prerelease/build suffix on the triple, and an ignored trailing decoration
 * (e.g. `(rust-v0.145.0)`). Skips non-version leading lines. Rejects text that only
 * mentions a semver mid-line (e.g. `error: latest release is 0.145.0`).
 */
export function parseCodexCliVersion(source: string): string {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    const match = line.match(
      /^(?:(?:codex-cli|codex)\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?(?:\s+.*)?$/i,
    );
    if (match) {
      return `${match[1]}.${match[2]}.${match[3]}`;
    }
  }
  throw new Error(
    `Codex CLI version is unreadable from '${source.trim()}'; install a supported Codex release`,
  );
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

/** Assert a normalized core semver against the disabled-invocation floor. */
export function assertCodexCliVersionSupportsDisabledModelInvocation(version: string): void {
  if (compareSemver(version, CODEX_MINIMUM_CLI_VERSION_FOR_DISABLED_MODEL_INVOCATION) < 0) {
    throw new Error(
      `Codex CLI ${version} cannot enforce disabled model invocation via agents/openai.yaml policy.allow_implicit_invocation (requires ${CODEX_MINIMUM_CLI_VERSION_FOR_DISABLED_MODEL_INVOCATION}+); upgrade Codex before previewing or applying the Profile`,
    );
  }
}

/**
 * Resolve and normalize the Codex CLI version at one boundary.
 * Callers of assert helpers receive only this normalized core semver.
 */
async function resolveCodexCliVersion(
  options: CodexCapabilityOptions,
): Promise<string> {
  if (options.resolveVersion) return parseCodexCliVersion(await options.resolveVersion());
  try {
    const { stdout, stderr } = await execFileAsync("codex", ["--version"], {
      env: options.env ?? process.env,
      encoding: "utf8",
      timeout: 10_000,
    });
    return parseCodexCliVersion(`${stdout}\n${stderr}`);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        "Codex CLI was not found on PATH; install Codex and ensure `codex --version` works before previewing or applying Profiles that require Codex Host capabilities",
      );
    }
    if (error instanceof Error && "stdout" in error) {
      const stdout = String((error as { stdout?: unknown }).stdout ?? "");
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (stdout || stderr) {
        try {
          return parseCodexCliVersion(`${stdout}\n${stderr}`);
        } catch {
          // fall through
        }
      }
    }
    throw new Error(
      `Codex CLI version could not be detected (${error instanceof Error ? error.message : String(error)}); install a supported Codex release before previewing or applying Profiles that require Codex Host capabilities`,
    );
  }
}

export async function assertCodexProjectCapability(
  home: string,
  project: string,
  options: CodexCapabilityOptions = {},
): Promise<void> {
  // SessionStart configuration is advisory and is reported separately by
  // detectCodexProjectConfigurationWarnings. Capability preflight proves only
  // portable semantics that Codex must be able to represent.
  if (options.requireContext || options.requireDisabledModelInvocation) {
    const version = await resolveCodexCliVersion(options);
    // Check the higher Context floor first so a single upgrade message covers
    // Profiles that also need disabled model invocation (0.99.0 ⊂ 0.145.0+).
    if (options.requireContext) {
      assertCodexCliVersionSupportsCompleteContext(version);
    }
    if (options.requireDisabledModelInvocation) {
      assertCodexCliVersionSupportsDisabledModelInvocation(version);
    }
  }
}

/** Assert a normalized core semver against the complete-Context floor. */
export function assertCodexCliVersionSupportsCompleteContext(version: string): void {
  if (compareSemver(version, CODEX_MINIMUM_CLI_VERSION_FOR_COMPLETE_CONTEXT) < 0) {
    throw new Error(
      `Codex CLI ${version} cannot deliver complete Context through SessionStart hooks (requires ${CODEX_MINIMUM_CLI_VERSION_FOR_COMPLETE_CONTEXT}+); upgrade Codex before previewing or applying the Profile`,
    );
  }
}

/** Report relevant Codex configuration that may prevent planned Context loading. */
export async function detectCodexProjectConfigurationWarnings(
  home: string,
  project: string,
  options: Pick<CodexCapabilityOptions, "env"> = {},
): Promise<readonly string[]> {
  const globalPath = join(resolveCodexHome(home, options.env), "config.toml");
  const projectPath = join(project, ".codex", "config.toml");
  try {
    const projectSetting = parseCodexHooksFeatureSetting(
      await readOptional(projectPath),
      projectPath,
    );
    if (projectSetting === true) return [];
    if (projectSetting === false) {
      return [
        `Codex SessionStart hooks are not enabled by ${projectPath}; generated Profile Context may not load until [features].hooks = true is set there`,
      ];
    }
    const globalSetting = parseCodexHooksFeatureSetting(
      await readOptional(globalPath),
      globalPath,
    );
    if (globalSetting !== false) return [];
    return [
      `Codex SessionStart hooks are not enabled by ${globalPath}; generated Profile Context may not load until [features].hooks = true is set in ${projectPath} or ${globalPath}`,
    ];
  } catch (error) {
    return [
      `Codex configuration relevant to planned SessionStart Context could not be read or parsed (${error instanceof Error ? error.message : String(error)}); generated Profile Context may not load until the configuration is repaired`,
    ];
  }
}

function readAllowImplicitInvocation(
  document: Record<string, unknown>,
  skillId: string,
): boolean | undefined {
  if (!("policy" in document)) return undefined;
  const policy = document.policy;
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) {
    throw new Error(
      `Skill '${skillId}' ${CODEX_SKILL_OPENAI_YAML} policy must be a YAML mapping`,
    );
  }
  const mapping = policy as Record<string, unknown>;
  if (!("allow_implicit_invocation" in mapping)) return undefined;
  const value = mapping.allow_implicit_invocation;
  if (typeof value !== "boolean") {
    throw new Error(
      `Skill '${skillId}' ${CODEX_SKILL_OPENAI_YAML} policy.allow_implicit_invocation must be a boolean`,
    );
  }
  return value;
}

/**
 * Coalesce or reject Codex-native invocation policy against the trusted Skill policy.
 * Equivalent policies coalesce; conflicting authorities fail before writes.
 */
export function coalesceCodexInvocationPolicy(
  skillId: string,
  modelInvocation: ModelInvocationPolicy,
  existingOpenAiYaml: string | undefined,
): { readonly action: "leave"; readonly bytes?: string } | { readonly action: "write"; readonly bytes: string } {
  let document: Record<string, unknown> = {};
  let existingAllow: boolean | undefined;
  if (existingOpenAiYaml !== undefined) {
    document = requireMapping(
      parseYaml(existingOpenAiYaml, `Skill '${skillId}' ${CODEX_SKILL_OPENAI_YAML}`),
      `Skill '${skillId}' ${CODEX_SKILL_OPENAI_YAML}`,
    );
    existingAllow = readAllowImplicitInvocation(document, skillId);
  }

  if (modelInvocation === "disabled") {
    if (existingAllow === true) {
      throw new Error(
        `Skill '${skillId}' has conflicting model-invocation authorities: canonical policy is disabled but ${CODEX_SKILL_OPENAI_YAML} sets policy.allow_implicit_invocation: true`,
      );
    }
    if (existingAllow === false && existingOpenAiYaml !== undefined) {
      return { action: "leave", bytes: existingOpenAiYaml };
    }
    const policy =
      typeof document.policy === "object" && document.policy !== null && !Array.isArray(document.policy)
        ? { ...(document.policy as Record<string, unknown>) }
        : {};
    policy.allow_implicit_invocation = false;
    document.policy = policy;
    return { action: "write", bytes: `${stringify(document).trimEnd()}\n` };
  }

  if (existingAllow === false) {
    throw new Error(
      `Skill '${skillId}' has conflicting model-invocation authorities: canonical policy is allowed but ${CODEX_SKILL_OPENAI_YAML} sets policy.allow_implicit_invocation: false`,
    );
  }
  if (existingOpenAiYaml === undefined) {
    return { action: "leave" };
  }
  return { action: "leave", bytes: existingOpenAiYaml };
}

/** Codex-owned Skill package projection (Host-native model-invocation mapping). */
export function projectCodexSkillMembers(
  skill: Skill,
  members: readonly ProposedDirectoryMember[],
): readonly ProposedDirectoryMember[] {
  const existingOpenAi = members.find(
    (member): member is ProposedDirectoryFileMember =>
      member.type === "file" && member.path === CODEX_SKILL_OPENAI_YAML,
  );
  const decision = coalesceCodexInvocationPolicy(
    skill.id,
    skill.modelInvocation,
    existingOpenAi === undefined ? undefined : memberBytesAsString(existingOpenAi.bytes),
  );

  if (decision.action === "leave") {
    return members;
  }

  const withoutOpenAi = members.filter((member) => member.path !== CODEX_SKILL_OPENAI_YAML);
  const hasAgentsDir = withoutOpenAi.some(
    (member) => member.type === "directory" && member.path === "agents",
  );
  const next: ProposedDirectoryMember[] = [...withoutOpenAi];
  if (!hasAgentsDir) {
    next.push({ mode: 0o755, path: "agents", type: "directory" });
  }
  next.push({
    bytes: decision.bytes,
    mode: existingOpenAi?.mode ?? 0o644,
    path: CODEX_SKILL_OPENAI_YAML,
    type: "file",
  });
  return next.sort((left, right) => left.path.localeCompare(right.path));
}

export function codexSkillRequirements(
  skill: Skill,
  base: readonly string[],
): readonly string[] {
  if (skill.modelInvocation !== "disabled") return base;
  return [
    ...base,
    DISABLED_MODEL_INVOCATION_REQUIREMENT,
    "Codex agents/openai.yaml policy.allow_implicit_invocation enforces disabled model invocation",
  ];
}

const CODEX_SKILL_PROJECTION: SkillPackageProjection = {
  projectMembers: projectCodexSkillMembers,
  requirements: codexSkillRequirements,
};

const DEFAULT_CONTEXT_PATH = ".agent-profile-kit/codex/context.md";

function shellDoubleQuote(value: string): string {
  return value.replace(/["\\$`]/g, "\\$&");
}

function sessionStartCommandFor(contextPath: string): string {
  return `root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; cat "$root/${shellDoubleQuote(contextPath)}"`;
}

function hooks(contextPath: string): string {
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|clear|compact",
            hooks: [{
              additionalContextLimit: 0,
              command: sessionStartCommandFor(contextPath),
              type: "command",
            }],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

function contextSetupSteps(requiresBoundRootLaunch = false): readonly AdapterHostSetupStep[] {
  const steps: AdapterHostSetupStep[] = [
    {
      consequence: "Declining the hook prevents Profile Context from loading.",
      kind: "approval-required",
      message: "Review and approve the generated SessionStart hook when Codex asks.",
    },
    {
      consequence: "Profile Context does not load until the project is trusted.",
      kind: "trust-required",
      message: "Trust the bound project in Codex.",
    },
  ];
  if (requiresBoundRootLaunch) {
    steps.push({
      consequence: "Launching from a descendant prevents Profile Context from loading.",
      kind: "launch-constraint",
      message: "Launch Codex from the exact bound project root:",
      path: "bound-project",
    });
  }
  return steps;
}

export async function planCodexProject(
  profileId: string,
  modules: readonly { readonly id: string; readonly content: string }[],
  skills: readonly Skill[] = [],
  options: {
    readonly contextPath?: string;
    readonly requiresBoundRootLaunch?: boolean;
  } = {},
): Promise<CodexProjectPlan> {
  const skillOutputs = await Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSkillPackageDirectory(
          skill,
          CODEX_SKILLS_DISCOVERY_ROOT,
          ["Codex discovers Skill package through native project .agents/skills"],
          CODEX_SKILL_PROJECTION,
        ),
      ),
  );
  const outputs: ProposedProjectOutput[] = [...skillOutputs];
  // Omit Context machinery entirely when the Profile selects no Context Modules.
  // Do not invent an empty Context snapshot or hooks.json.
  if (modules.length > 0) {
    const contextPath = options.contextPath ?? DEFAULT_CONTEXT_PATH;
    outputs.unshift(
      {
        bytes: composeContextEnvelope(profileId, modules),
        mode: 0o644,
        path: join(".agent-profile-kit", "codex", "context.md"),
        requirements: ["Codex SessionStart delivers complete composed Context"],
        type: "file",
      },
      {
        bytes: hooks(contextPath),
        mode: 0o644,
        path: join(".codex", "hooks.json"),
        requirements: [
          "Codex SessionStart runs on startup, clear, and compact",
          "Codex SessionStart passes complete additionalContext directly to the model",
        ],
        type: "file",
      },
    );
  }
  return {
    host: "codex",
    hostVersion: skillsRequireDisabledModelInvocation(skills)
      ? modules.length > 0
        ? CODEX_HOST_VERSION_WITH_INVOCATION
        : CODEX_SKILLS_HOST_VERSION_WITH_INVOCATION
      : modules.length > 0
        ? CODEX_HOST_VERSION
        : CODEX_SKILLS_HOST_VERSION,
    outputs,
    setupSteps: modules.length > 0
      ? contextSetupSteps(options.requiresBoundRootLaunch)
      : [],
  };
}

export function sessionStartCommand(): string {
  return sessionStartCommandFor(DEFAULT_CONTEXT_PATH);
}
