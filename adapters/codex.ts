import { join } from "node:path";
import { readFile } from "node:fs/promises";

import type { Skill } from "../schemas/skill.js";
import { composeContextEnvelope } from "./context-envelope.js";
import type {
  AdapterProjectPlan,
  ProposedProjectOutput,
} from "./project-plan.js";
import { planSkillPackageDirectory } from "./skill-package.js";

export const CODEX_ADAPTER_VERSION = "codex-project-v1";
export const CODEX_HOST_VERSION = "native-project-sessionstart-v1";

export type CodexProjectPlan = AdapterProjectPlan;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
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

export async function assertCodexProjectCapability(
  home: string,
  project: string,
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
}

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
          "codex",
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
    hostVersion: CODEX_HOST_VERSION,
    outputs,
  };
}

export function sessionStartCommand(): string {
  return sessionStartCommandFor(DEFAULT_CONTEXT_PATH);
}
