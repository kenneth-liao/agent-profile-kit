import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { lstat, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import type { Skill } from "../schemas/skill.js";
import type { CompleteHostAdapter } from "./adapter-contract.js";
export { PI_ADAPTER_VERSION } from "./host-catalog.js";
import { type ContextModuleSource } from "./context-envelope.js";
import {
  caughtCapabilityFailure,
  capabilityFailure,
  versionFloorCapabilityFailure,
  type AdapterCapabilityFailure,
} from "./capability.js";
import {
  planSharedSkillPackageDirectory,
  SHARED_SKILLS_DISCOVERY_ROOT,
  SHARED_SKILL_DISCOVERY_REQUIREMENT,
} from "./shared-skill.js";
import {
  DEFAULT_ADAPTER_PLANNING_MATERIALS,
  skillsRequireDisabledModelInvocation,
  type AdapterPlanningMaterials,
} from "./skill-package.js";
import type {
  AdapterHostSetupStep,
  AdapterDiagnosticWarning,
  AdapterProjectPlan,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";

const execFileAsync = promisify(execFile);

export const PI_HOST_VERSION = "native-project-append-system-v1";
/** Capability Contracts for Pi's complete qualified shared Skill package. */
export const PI_HOST_VERSION_WITH_SKILLS = "native-project-shared-skills-v1";
export const PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS =
  "native-project-append-system-shared-skills-v1";
/**
 * Pi 0.82.1+ enforces these contracts: `disable-model-invocation: true`
 * hides a Skill from the model's system prompt while explicit `/skill:<name>`
 * activation remains available. Pi introduced this behavior in 0.50.0, so the
 * adapter's 0.82.1 floor includes it.
 * Evidence: https://pi.dev/docs/latest/skills and
 * https://pi.dev/news/releases/0.50.0
 */
export const PI_HOST_VERSION_WITH_INVOCATION =
  "native-project-shared-skills-invocation-v1";
export const PI_HOST_VERSION_WITH_CONTEXT_AND_SKILLS_INVOCATION =
  "native-project-append-system-shared-skills-invocation-v1";
export const PI_MINIMUM_CLI_VERSION = "0.82.1";
export const PI_CONTEXT_PATH = posix.join(".pi", "APPEND_SYSTEM.md");
/** Pi discovers Profile Skills through the qualified shared project surface. */
export const PI_PROJECT_SKILLS_ROOT = SHARED_SKILLS_DISCOVERY_ROOT;
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
      "host",
      `Pi CLI version is unreadable from '${source.trim()}'`,
      `install Pi ${PI_MINIMUM_CLI_VERSION}+ and ensure \`pi --version\` works before checking status or applying the Profile`,
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
      throw versionFloorCapabilityFailure(
        "pi",
        `Pi CLI ${version} cannot enforce disabled model invocation via disable-model-invocation (requires ${PI_MINIMUM_CLI_VERSION}+)`,
        "upgrade Pi before checking status or applying the Profile",
        PI_MINIMUM_CLI_VERSION,
      );
    }
    throw versionFloorCapabilityFailure(
      "pi",
      `Pi CLI ${version} does not support project APPEND_SYSTEM.md Context discovery (requires ${PI_MINIMUM_CLI_VERSION}+)`,
      "upgrade Pi before checking status or applying the Profile",
      PI_MINIMUM_CLI_VERSION,
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
        "host",
        "Pi CLI was not found on PATH",
        "install Pi and ensure `pi --version` works before checking status or applying the Profile",
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
      "host",
      `Pi CLI version could not be detected (${error instanceof Error ? error.message : String(error)})`,
      `install Pi ${PI_MINIMUM_CLI_VERSION}+ before checking status or applying the Profile`,
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
  if (options.requireSkills) {
    const agentsPath = join(project, ".agents");
    const agentsKind = await pathKind(agentsPath);
    if (agentsKind !== "missing" && agentsKind !== "directory") {
      const problem = `Pi shared project surface cannot host Skills: ${agentsPath} is a ${agentsKind}, not a directory`;
      throw capabilityFailure(
        "pi",
        "project",
        problem,
        "ensure the shared .agents project surface is a directory, then retry",
        [{ kind: "path", value: agentsPath }],
        problem,
      );
    }
    const skillsPath = join(project, ...PI_PROJECT_SKILLS_ROOT.split("/"));
    const skillsKind = await pathKind(skillsPath);
    if (skillsKind !== "missing" && skillsKind !== "directory") {
      const problem = `Pi shared project surface cannot host Skills: ${skillsPath} is a ${skillsKind}, not a directory`;
      throw capabilityFailure(
        "pi",
        "project",
        problem,
        "ensure the shared .agents/skills surface is a directory, then retry",
        [{ kind: "path", value: skillsPath }],
        problem,
      );
    }
  }

  if (options.requireContext !== false) {
    const piPath = join(project, ".pi");
    const piKind = await pathKind(piPath);
    if (piKind !== "missing" && piKind !== "directory") {
      const problem = `Pi project surface cannot host outputs: ${piPath} is a ${piKind}, not a directory`;
      throw capabilityFailure(
        "pi",
        "project",
        problem,
        "ensure the Pi project surface is a directory, then retry",
        [{ kind: "path", value: piPath }],
        problem,
      );
    }
    const contextPath = join(project, ...PI_CONTEXT_PATH.split("/"));
    const contextKind = await pathKind(contextPath);
    if (contextKind !== "missing" && contextKind !== "file") {
      const problem =
        `Pi append-system destination cannot host Context: ${contextPath} is a ${contextKind}, not a regular file`;
      throw capabilityFailure(
        "pi",
        "project",
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

function skillOutputs(
  skills: readonly Skill[],
  materials: AdapterPlanningMaterials,
) {
  return Promise.all(
    [...skills]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) =>
        planSharedSkillPackageDirectory(
          skill,
          [SHARED_SKILL_DISCOVERY_REQUIREMENT],
          "pi",
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

export const piAdapter = {
  host: "pi",
  async planProject(input, services) {
    const requireContext = input.resolvedContexts.length > 0;
    const requireSkills = input.resolvedSkills.length > 0;
    const requireDisabledModelInvocation = skillsRequireDisabledModelInvocation(
      input.resolvedSkills,
    );
    const capabilityFailures: AdapterCapabilityFailure[] = [];
    if (input.checkHostCapability) {
      try {
        await services.probeMachineCapability(
          piMachineRequirements({ requireDisabledModelInvocation }),
          () => probePiMachineCapability({
            ...(input.env === undefined ? {} : { env: input.env }),
            home: input.home,
            requireContext,
            requireDisabledModelInvocation,
            requireSkills,
          }),
        );
      } catch (error) {
        capabilityFailures.push(caughtCapabilityFailure("pi", "host", error));
      }
      // The Project surface is independent of the CLI probe: an obstructed
      // surface is Project-specific evidence even when the CLI also failed.
      try {
        await assertPiProjectSurface(input.project, {
          requireContext,
          requireSkills,
        });
      } catch (error) {
        capabilityFailures.push(caughtCapabilityFailure("pi", "project", error));
      }
    }

    const diagnostics = requireSkills
      ? await detectPiSkillSettingsWarnings({
          home: input.home,
          project: input.project,
        })
      : [];
    const plan = await services.planProjection(
      {
        host: "pi",
        options: {},
        profileId: input.profileId,
        resolvedContexts: input.resolvedContexts,
        resolvedSkills: input.resolvedSkills,
      },
      () => planPiProject(
        input.profileId,
        input.resolvedContexts,
        input.resolvedSkills,
        { materials: services.materials },
      ),
    );
    return { capabilityFailures, diagnostics, plan };
  },
} satisfies CompleteHostAdapter;
