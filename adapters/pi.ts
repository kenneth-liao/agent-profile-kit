import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";

import type { Skill } from "../schemas/skill.js";
import { composeContextEnvelope, type ContextModuleSource } from "./context-envelope.js";
import type {
  AdapterProjectPlan,
  ProposedProjectFileOutput,
  ProposedProjectOutput,
} from "./project-plan.js";

const execFileAsync = promisify(execFile);

export const PI_ADAPTER_VERSION = "pi-project-v1";
export const PI_HOST_VERSION = "native-project-append-system-v1";
export const PI_MINIMUM_CLI_VERSION = "0.82.1";
export const PI_CONTEXT_PATH = posix.join(".pi", "APPEND_SYSTEM.md");
export const PI_SKILL_UNSUPPORTED =
  "Pi Skill delivery is not supported in this ticket; wait for successor Pi Skill ticket #102 before selecting Skills for a Pi binding";

export const PI_CONTEXT_REQUIREMENTS = [
  "Pi loads project APPEND_SYSTEM.md as additive system Context",
  "Pi native trust and runtime overrides remain Host-owned",
] as const;

export type PiProjectPlan = AdapterProjectPlan;

export interface PiCapabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly requireContext?: boolean;
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
 * Skill delivery is intentionally unsupported until successor Pi Skill ticket #102.
 */
export async function assertPiProjectCapability(
  project: string,
  options: PiCapabilityOptions = {},
): Promise<void> {
  if (options.requireSkills) {
    throw new Error(PI_SKILL_UNSUPPORTED);
  }

  const version = await resolvePiCliVersion(options);
  assertPiCliVersionSupported(version);
  // Keep version probing ready for future Skill-only support; current Skill
  // selections fail above before this forward-compatible branch is reached.
  if (options.requireContext === false) return;

  const piPath = join(project, ".pi");
  const piKind = await pathKind(piPath);
  if (piKind !== "missing" && piKind !== "directory") {
    throw new Error(
      `Pi project surface cannot host outputs: ${piPath} is a ${piKind}, not a directory`,
    );
  }

  const contextPath = join(project, ...PI_CONTEXT_PATH.split("/"));
  const contextKind = await pathKind(contextPath);
  if (contextKind !== "missing" && contextKind !== "file") {
    throw new Error(
      `Pi append-system destination cannot host Context: ${contextPath} is a ${contextKind}, not a regular file`,
    );
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

/**
 * Pure Pi Adapter planner for Profile Context. Skills fail closed until
 * successor Pi Skill ticket #102 delivers Pi-native discovery and projection.
 */
export async function planPiProject(
  profileId: string,
  modules: readonly ContextModuleSource[],
  skills: readonly Skill[] = [],
): Promise<PiProjectPlan> {
  if (skills.length > 0) {
    throw new Error(PI_SKILL_UNSUPPORTED);
  }
  const outputs: readonly ProposedProjectOutput[] =
    modules.length > 0 ? [contextOutput(profileId, modules)] : [];
  return {
    host: "pi",
    hostVersion: PI_HOST_VERSION,
    outputs,
  };
}
