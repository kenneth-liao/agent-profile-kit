import { execFile } from "node:child_process";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

import type { ModelInvocationPolicy, Skill } from "../schemas/skill.js";
import { composeContextEnvelope } from "./context-envelope.js";
import type {
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

const execFileAsync = promisify(execFile);

export const CODEX_ADAPTER_VERSION = "codex-project-v1";

/**
 * Capability-contract token for Codex project Context via SessionStart hooks and
 * portable Skill package discovery under `.agents/skills/` when no Skill requires
 * disabled model invocation.
 */
export const CODEX_HOST_VERSION = "native-project-sessionstart-v1";

/**
 * Capability-contract token when a selected Skill requires disabled model invocation.
 * Proven by Codex CLI version that honors `agents/openai.yaml`
 * `policy.allow_implicit_invocation`, plus SessionStart hooks for Context.
 */
export const CODEX_HOST_VERSION_WITH_INVOCATION =
  "native-project-sessionstart-skills-invocation-v1";

/**
 * Minimum Codex CLI version that enforces `policy.allow_implicit_invocation: false`.
 * Evidence: OpenAI Codex documents agents/openai.yaml invocation policy for Skill
 * packages; earlier releases discover Skills under `.agents/skills/` but treat
 * implicit invocation as always allowed, silently weakening explicit-only Skills.
 * Floor: first documented public SkillPolicy series supporting the field (0.72.0+).
 * Raise if field-level support evidence requires a higher version.
 */
export const CODEX_MINIMUM_CLI_VERSION_FOR_DISABLED_MODEL_INVOCATION = "0.72.0";

/** Codex Skill metadata path for Host-native invocation policy. */
export const CODEX_SKILL_OPENAI_YAML = "agents/openai.yaml";

export type CodexProjectPlan = AdapterProjectPlan;

export interface CodexCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
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

function hookFeatureSetting(source: string): boolean | undefined {
  const settings = new Map<string, boolean>();
  let section = "";
  for (const line of source.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      section = (header[1] ?? "").toLowerCase();
      continue;
    }
    const dotted = section === ""
      ? line.match(/^\s*features\.(hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/i)
      : undefined;
    const nested = section === "features"
      ? line.match(/^\s*(hooks|codex_hooks)\s*=\s*(true|false)\s*(?:#.*)?$/i)
      : undefined;
    const setting = dotted ?? nested;
    if (setting) settings.set((setting[1] ?? "").toLowerCase(), setting[2]?.toLowerCase() === "true");
  }
  return settings.get("hooks") ?? settings.get("codex_hooks");
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

/** Parse the leading semver from `codex --version` output (e.g. `codex-cli 0.144.4`). */
export function parseCodexCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw new Error(
      `Codex CLI version is unreadable from '${source.trim()}'; install a supported Codex release`,
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

export function assertCodexCliVersionSupportsDisabledModelInvocation(version: string): void {
  if (compareSemver(version, CODEX_MINIMUM_CLI_VERSION_FOR_DISABLED_MODEL_INVOCATION) < 0) {
    throw new Error(
      `Codex CLI ${version} cannot enforce disabled model invocation via agents/openai.yaml policy.allow_implicit_invocation (requires ${CODEX_MINIMUM_CLI_VERSION_FOR_DISABLED_MODEL_INVOCATION}+); upgrade Codex before previewing or applying the Profile`,
    );
  }
}

async function resolveCodexCliVersion(
  options: CodexCapabilityOptions,
): Promise<string> {
  if (options.resolveVersion) return options.resolveVersion();
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
        "Codex CLI was not found on PATH; install Codex and ensure `codex --version` works before previewing or applying Profiles that disable model invocation",
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
      `Codex CLI version could not be detected (${error instanceof Error ? error.message : String(error)}); install a supported Codex release before previewing or applying Profiles that disable model invocation`,
    );
  }
}

export async function assertCodexProjectCapability(
  home: string,
  project: string,
  options: CodexCapabilityOptions = {},
): Promise<void> {
  const [globalConfig, projectConfig] = await Promise.all([
    readOptional(join(home, ".codex", "config.toml")),
    readOptional(join(project, ".codex", "config.toml")),
  ]);
  const globalPath = join(home, ".codex", "config.toml");
  const projectPath = join(project, ".codex", "config.toml");
  const globalSetting = hookFeatureSetting(globalConfig);
  const projectSetting = hookFeatureSetting(projectConfig);
  const effectiveSetting = projectSetting ?? globalSetting;
  if (effectiveSetting !== true) {
    const configuredBy = projectSetting !== undefined
      ? projectPath
      : globalSetting !== undefined
        ? globalPath
        : undefined;
    throw new Error(
      `Codex SessionStart hooks are not enabled${configuredBy ? ` by ${configuredBy}` : ""}; set [features].hooks = true in ${projectPath} or ${globalPath} before previewing or applying the Profile`,
    );
  }

  if (options.requireDisabledModelInvocation) {
    const version = await resolveCodexCliVersion(options);
    assertCodexCliVersionSupportsDisabledModelInvocation(version);
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
            matcher: "startup|resume|clear|compact",
            hooks: [{ command: sessionStartCommandFor(contextPath), type: "command" }],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

export async function planCodexProject(
  profileId: string,
  modules: readonly { readonly id: string; readonly content: string }[],
  skills: readonly Skill[] = [],
  options: { readonly contextPath?: string } = {},
): Promise<CodexProjectPlan> {
  const contextPath = options.contextPath ?? DEFAULT_CONTEXT_PATH;
  const skillOutputs = await Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSkillPackageDirectory(
          skill,
          ".agents/skills",
          ["Codex discovers Skill package through native project .agents/skills"],
          CODEX_SKILL_PROJECTION,
        ),
      ),
  );
  const outputs: ProposedProjectOutput[] = [
    {
      bytes: composeContextEnvelope(profileId, modules),
      mode: 0o644,
      path: join(".agent-profile-kit", "codex", "context.md"),
      requirements: ["Codex SessionStart prints composed Context"],
      type: "file",
    },
    {
      bytes: hooks(contextPath),
      mode: 0o644,
      path: join(".codex", "hooks.json"),
      requirements: ["Codex SessionStart runs on startup, resume, clear, and compact"],
      type: "file",
    },
    ...skillOutputs,
  ];
  return {
    host: "codex",
    hostVersion: skillsRequireDisabledModelInvocation(skills)
      ? CODEX_HOST_VERSION_WITH_INVOCATION
      : CODEX_HOST_VERSION,
    outputs,
  };
}

export function sessionStartCommand(): string {
  return sessionStartCommandFor(DEFAULT_CONTEXT_PATH);
}
