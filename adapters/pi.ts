import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { lstat, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";

import type { ModelInvocationPolicy, Skill } from "../schemas/skill.js";
import { type ContextModuleSource } from "./context-envelope.js";
import { capabilityFailure } from "./capability.js";
import {
  DEFAULT_ADAPTER_PLANNING_MATERIALS,
  DISABLED_MODEL_INVOCATION_REQUIREMENT,
  planSkillPackageDirectory,
  skillsRequireDisabledModelInvocation,
  type AdapterPlanningMaterials,
  type SkillPackageProjection,
} from "./skill-package.js";
import type {
  AdapterHostSetupStep,
  AdapterDiagnosticWarning,
  AdapterProjectPlan,
  ProposedDirectoryFileMember,
  ProposedDirectoryMember,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";

const execFileAsync = promisify(execFile);

export const PI_ADAPTER_VERSION = "pi-project-v1";
export const PI_HOST_VERSION = "native-project-append-system-v1";
export const PI_HOST_VERSION_WITH_SKILLS = "native-project-skills-v1";
export const PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS =
  "native-project-append-system-skills-v1";
/**
 * Pi 0.82.1+ enforces these contracts: `disable-model-invocation: true`
 * hides a Skill from the model's system prompt while explicit `/skill:<name>`
 * activation remains available. Pi introduced this behavior in 0.50.0, so the
 * adapter's 0.82.1 floor includes it.
 * Evidence: https://pi.dev/docs/latest/skills and
 * https://pi.dev/news/releases/0.50.0
 */
export const PI_HOST_VERSION_WITH_INVOCATION =
  "native-project-skills-invocation-v1";
export const PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION =
  "native-project-append-system-skills-invocation-v1";
export const PI_MINIMUM_CLI_VERSION = "0.82.1";
export const PI_CONTEXT_PATH = posix.join(".pi", "APPEND_SYSTEM.md");
export const PI_PROJECT_SKILLS_ROOT = posix.join(".pi", "skills");
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
  readonly requireContext?: boolean;
  readonly requireDisabledModelInvocation?: boolean;
  readonly requireSkills?: boolean;
  readonly resolveVersion?: () => Promise<string>;
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

interface PiSkillFrontmatter {
  readonly body: string;
  readonly header: Record<string, unknown>;
}

function originalOffsetForNormalizedOffset(source: string, target: number): number {
  let originalOffset = 0;
  let normalizedOffset = 0;
  while (originalOffset < source.length && normalizedOffset < target) {
    if (source[originalOffset] === "\r") {
      originalOffset += 1;
      if (source[originalOffset] === "\n") originalOffset += 1;
    } else {
      originalOffset += 1;
    }
    normalizedOffset += 1;
  }
  return originalOffset;
}

function parsePiSkillFrontmatter(source: string, path: string): PiSkillFrontmatter {
  const withoutBom = source.replace(/^\uFEFF/, "");
  const normalized = withoutBom.replace(/\r\n?/g, "\n");
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
  return {
    body: withoutBom.slice(originalOffsetForNormalizedOffset(withoutBom, closing + delimiter.length)),
    header: header as Record<string, unknown>,
  };
}

type PiSettingsScope = "global" | "project";

/** Report malformed or unreadable Pi settings relevant to Skill loading. */
export async function detectPiSkillSettingsWarnings(
  options: { readonly home?: string; readonly project: string },
): Promise<readonly AdapterDiagnosticWarning[]> {
  const home = resolve(options.home ?? homedir());
  const project = resolve(options.project);
  const inputs = [
    {
      path: join(home, ...PI_GLOBAL_SETTINGS_PATH.split("/")),
      scope: "global" as const,
    },
    {
      path: join(project, ...PI_PROJECT_SETTINGS_PATH.split("/")),
      scope: "project" as const,
    },
  ];
  const warnings: AdapterDiagnosticWarning[] = [];

  const warn = (scope: PiSettingsScope, path: string, detail: string): void => {
    warnings.push(
      {
        copyableValues: [path],
        message: `Pi ${scope} settings relevant to planned Skills at ${path} could not be read or parsed (${detail}); generated Skills may not load until the configuration is repaired`,
      },
    );
  };

  for (const input of inputs) {
    try {
      const parsed: unknown = JSON.parse(await readFile(input.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        warn(input.scope, input.path, "settings JSON must be an object");
        continue;
      }
      const skills = (parsed as Record<string, unknown>).skills;
      if (skills === undefined) continue;
      if (!Array.isArray(skills) || skills.some((entry) => typeof entry !== "string")) {
        warn(input.scope, input.path, "skills must be an array of path strings");
      }
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      warn(input.scope, input.path, error instanceof Error ? error.message : String(error));
    }
  }

  const unique = new Map(warnings.map((warning) => [warning.message, warning]));
  return [...unique.values()].sort((left, right) => left.message.localeCompare(right.message));
}

/** Parse the leading semver from `pi --version` output. */
export function parsePiCliVersion(source: string): string {
  const match = source.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    throw capabilityFailure(
      "pi",
      `Pi CLI version is unreadable from '${source.trim()}'`,
      `install Pi ${PI_MINIMUM_CLI_VERSION}+ and ensure \`pi --version\` works before previewing or applying the Profile`,
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

export function assertPiCliVersionSupported(
  version: string,
  options: { readonly requireDisabledModelInvocation?: boolean } = {},
): void {
  if (compareSemver(version, PI_MINIMUM_CLI_VERSION) < 0) {
    if (options.requireDisabledModelInvocation) {
      throw capabilityFailure(
        "pi",
        `Pi CLI ${version} cannot enforce disabled model invocation via disable-model-invocation (requires ${PI_MINIMUM_CLI_VERSION}+)`,
        "upgrade Pi before previewing or applying the Profile",
      );
    }
    throw capabilityFailure(
      "pi",
      `Pi CLI ${version} does not support project APPEND_SYSTEM.md Context discovery (requires ${PI_MINIMUM_CLI_VERSION}+)`,
      "upgrade Pi before previewing or applying the Profile",
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
      throw capabilityFailure(
        "pi",
        "Pi CLI was not found on PATH",
        "install Pi and ensure `pi --version` works before previewing or applying the Profile",
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
    throw capabilityFailure(
      "pi",
      `Pi CLI version could not be detected (${error instanceof Error ? error.message : String(error)})`,
      `install Pi ${PI_MINIMUM_CLI_VERSION}+ before previewing or applying the Profile`,
    );
  }
}

/**
 * Complete normalized machine-level requirements that affect the Pi CLI probe
 * result. Callers route identical requirement sets through one probe per
 * invocation so distinct sets cannot reuse incompatible evidence.
 */
export function piMachineRequirements(options: {
  readonly requireDisabledModelInvocation?: boolean;
}): Readonly<Record<string, boolean>> {
  return {
    requireDisabledModelInvocation: options.requireDisabledModelInvocation === true,
  };
}

/**
 * Resolve and validate the Pi CLI version at one machine-level boundary.
 * Runs the `pi --version` executable at most once per unique requirement set
 * per invocation when routed through the invocation-scoped planning context.
 * Returns the normalized core semver or throws a capability failure for
 * missing, unreadable, or outdated Host executables.
 */
export async function probePiMachineCapability(
  options: PiCapabilityOptions,
): Promise<string> {
  const version = await resolvePiCliVersion(options);
  assertPiCliVersionSupported(version, {
    ...(options.requireDisabledModelInvocation
      ? { requireDisabledModelInvocation: true }
      : {}),
  });
  return version;
}

/**
 * Reject Pi project surfaces that cannot host planned outputs. The CLI floor
 * is proven by the machine-level probe; this checks only Project-specific paths
 * and still runs for every affected Project.
 */
export async function assertPiProjectSurface(
  project: string,
  options: {
    readonly requireContext?: boolean;
    readonly requireSkills?: boolean;
  } = {},
): Promise<void> {
  const piPath = join(project, ".pi");
  const piKind = await pathKind(piPath);
  if (piKind !== "missing" && piKind !== "directory") {
    const problem = `Pi project surface cannot host outputs: ${piPath} is a ${piKind}, not a directory`;
    throw capabilityFailure(
      "pi",
      problem,
      "ensure the Pi project surface is a directory, then retry",
      [{ kind: "path", value: piPath }],
      problem,
    );
  }

  if (options.requireSkills) {
    const skillsPath = join(project, ".pi", "skills");
    const skillsKind = await pathKind(skillsPath);
    if (skillsKind !== "missing" && skillsKind !== "directory") {
      const problem = `Pi project surface cannot host Skills: ${skillsPath} is a ${skillsKind}, not a directory`;
      throw capabilityFailure(
        "pi",
        problem,
        "ensure the Pi Skills surface is a directory, then retry",
        [{ kind: "path", value: skillsPath }],
        problem,
      );
    }
  }

  if (options.requireContext !== false) {
    const contextPath = join(project, ...PI_CONTEXT_PATH.split("/"));
    const contextKind = await pathKind(contextPath);
    if (contextKind !== "missing" && contextKind !== "file") {
      const problem =
        `Pi append-system destination cannot host Context: ${contextPath} is a ${contextKind}, not a regular file`;
      throw capabilityFailure(
        "pi",
        problem,
        "ensure the Pi Context destination is a regular file, then retry",
        [{ kind: "path", value: contextPath }],
        problem,
      );
    }
  }
}

/** Prove the Pi project surface needed by the selected Profile before writes. */
export async function assertPiProjectCapability(
  project: string,
  options: PiCapabilityOptions = {},
): Promise<void> {
  await probePiMachineCapability(options);
  await assertPiProjectSurface(project, options);
}

function contextOutput(
  profileId: string,
  modules: readonly ContextModuleSource[],
  materials: AdapterPlanningMaterials,
): ProposedProjectFileOutput {
  return {
    bytes: materials.composeContext(profileId, modules),
    mode: 0o644,
    origins: modules.map((module) => ({ id: module.id, type: "context" as const })),
    path: PI_CONTEXT_PATH,
    requirements: [...PI_CONTEXT_REQUIREMENTS],
    type: "file",
  };
}

const PI_SKILL_PROJECTION: SkillPackageProjection = {
  projectMembers: projectPiSkillMembers,
  requirements: piSkillRequirements,
};

/** Emit Pi-native SKILL.md frontmatter for one portable model-invocation policy. */
export function emitPiSkillMarkdown(
  skillId: string,
  source: string,
  modelInvocation: ModelInvocationPolicy,
): string {
  if (modelInvocation === "allowed") return source;

  const delimiter = "---\n";
  const { body, header: mapping } = parsePiSkillFrontmatter(
    source,
    `'${skillId}' SKILL.md`,
  );
  if (mapping.name !== skillId) {
    throw new Error(
      `Skill '${skillId}' SKILL.md name must remain the canonical Artifact ID '${skillId}'`,
    );
  }
  mapping["disable-model-invocation"] = true;
  return `${delimiter}${stringify(mapping).trimEnd()}\n---\n${body}`;
}

/** Project one Pi Skill package while translating only its invocation policy. */
export function projectPiSkillMembers(
  skill: Skill,
  members: readonly ProposedDirectoryMember[],
): readonly ProposedDirectoryMember[] {
  if (skill.modelInvocation === "allowed") return members;
  return members.map((member) => {
    if (member.type !== "file" || member.path !== "SKILL.md") return member;
    const projected: ProposedDirectoryFileMember = {
      ...member,
      bytes: emitPiSkillMarkdown(
        skill.id,
        typeof member.bytes === "string" ? member.bytes : Buffer.from(member.bytes).toString("utf8"),
        skill.modelInvocation,
      ),
    };
    return projected;
  });
}

export function piSkillRequirements(
  skill: Skill,
  base: readonly string[],
): readonly string[] {
  if (skill.modelInvocation !== "disabled") return base;
  return [
    ...base,
    DISABLED_MODEL_INVOCATION_REQUIREMENT,
    "Pi disable-model-invocation frontmatter enforces disabled model invocation",
  ];
}

function skillOutputs(
  skills: readonly Skill[],
  materials: AdapterPlanningMaterials,
) {
  return Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSkillPackageDirectory(
          skill,
          PI_PROJECT_SKILLS_ROOT,
          ["Pi discovers Skill package through native project .pi/skills"],
          PI_SKILL_PROJECTION,
          materials,
        ),
      ),
  );
}

/** Pure Pi Adapter planner for Profile Context and portable Skills. */
export async function planPiProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  skills: readonly Skill[] = [],
  options: { readonly materials?: AdapterPlanningMaterials } = {},
): Promise<PiProjectPlan> {
  const materials = options.materials ?? DEFAULT_ADAPTER_PLANNING_MATERIALS;
  const packages = await skillOutputs(skills, materials);
  const outputs: readonly ProposedProjectOutput[] = modules.length > 0
    ? [contextOutput(profileId, modules, materials), ...packages]
    : packages;
  const setupSteps: readonly AdapterHostSetupStep[] = outputs.length > 0
    ? [{
        consequence: "The Profile does not load until the project is trusted.",
        kind: "trust-required",
        message: "Trust the bound project in Pi.",
        provenance: "standing",
      }]
    : [];
  return {
    host: "pi",
    hostVersion: skills.length > 0
      ? skillsRequireDisabledModelInvocation(skills)
        ? modules.length > 0
          ? PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION
          : PI_HOST_VERSION_WITH_INVOCATION
        : modules.length > 0
          ? PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS
          : PI_HOST_VERSION_WITH_SKILLS
      : PI_HOST_VERSION,
    outputs,
    setupSteps,
  };
}
