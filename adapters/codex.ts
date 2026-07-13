import { join } from "node:path";
import { readFile } from "node:fs/promises";

export const CODEX_ADAPTER_VERSION = "codex-project-v1";
export const CODEX_HOST_VERSION = "native-project-sessionstart-v1";

export interface ProposedProjectOutput {
  readonly bytes: string;
  readonly mode: number;
  readonly path: string;
}

export interface CodexProjectPlan {
  readonly hostVersion: string;
  readonly outputs: readonly ProposedProjectOutput[];
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function hooksDisabled(source: string): boolean {
  if (/^\s*features\.(?:hooks|codex_hooks)\s*=\s*false\s*(?:#.*)?$/m.test(source)) {
    return true;
  }
  let section = "";
  for (const line of source.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      section = header[1] ?? "";
      continue;
    }
    if (
      section === "features" &&
      /^\s*(?:hooks|codex_hooks)\s*=\s*false\s*(?:#.*)?$/i.test(line)
    ) {
      return true;
    }
  }
  return false;
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
  const disabledBy = globalConfig && hooksDisabled(globalConfig)
    ? join(home, ".codex", "config.toml")
    : projectConfig && hooksDisabled(projectConfig)
      ? join(project, ".codex", "config.toml")
      : undefined;
  if (disabledBy) {
    throw new Error(
      `Codex SessionStart hooks are disabled by ${disabledBy}; enable [features].hooks before applying the Profile`,
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

function contextSnapshot(profileId: string, modules: readonly { readonly id: string; readonly content: string }[]): string {
  const sections = modules.map((module) => {
    const body = module.content.endsWith("\n") ? module.content : `${module.content}\n`;
    return `<!-- Context Module: ${module.id} -->\n${body}<!-- End Context Module: ${module.id} -->`;
  });
  return [
    "# Agent Profile Kit Context",
    "",
    `Profile: ${profileId}`,
    "",
    "This Context is reusable Profile material. Repository-owned project instructions, including AGENTS.md, take precedence when they conflict with this material.",
    "",
    ...sections,
  ].join("\n").replace(/\n?$/, "\n");
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

export function planCodexProject(
  profileId: string,
  modules: readonly { readonly id: string; readonly content: string }[],
  options: { readonly contextPath?: string } = {},
): CodexProjectPlan {
  const contextPath = options.contextPath ?? DEFAULT_CONTEXT_PATH;
  return {
    hostVersion: CODEX_HOST_VERSION,
    outputs: [
      {
        bytes: contextSnapshot(profileId, modules),
        mode: 0o644,
        path: join(".agent-profile-kit", "codex", "context.md"),
      },
      {
        bytes: hooks(contextPath),
        mode: 0o644,
        path: join(".codex", "hooks.json"),
      },
    ],
  };
}

export function sessionStartCommand(): string {
  return sessionStartCommandFor(DEFAULT_CONTEXT_PATH);
}
