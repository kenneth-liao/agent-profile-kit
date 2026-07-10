import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const CONTEXT_PROBE = "agent-profile-kit capability probe";

export interface CodexCapability {
  readonly skills?: readonly { readonly name: string; readonly path: string }[];
  readonly version: string;
}

async function repositoryRoot(workingDirectory: string): Promise<string> {
  let start: string;
  try {
    start = await realpath(workingDirectory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    start = resolve(workingDirectory);
  }
  let directory = start;
  while (true) {
    try {
      await lstat(join(directory, ".git"));
      return directory;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
}

export async function codexSkillRoots(
  home: string,
  workingDirectory: string,
): Promise<readonly string[]> {
  const roots = [
    join(home, ".agents", "skills"),
    join(process.env.CODEX_HOME ?? join(home, ".codex"), "skills"),
    "/etc/codex/skills",
  ];
  const root = await repositoryRoot(workingDirectory);
  let directory = root;
  try {
    directory = await realpath(workingDirectory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  while (true) {
    roots.push(join(directory, ".agents", "skills"));
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...new Set(roots.map((root) => resolve(root)))];
}

interface CommandResult {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

async function executeCodex(arguments_: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stderr, stdout }));
  });
}

function probeIsVisibleToCodex(source: string, expectedText: string): boolean {
  let messages: unknown;
  try {
    messages = JSON.parse(source);
  } catch {
    return false;
  }
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "developer" &&
        "content" in message &&
        Array.isArray(message.content) &&
        message.content.some(
          (content: unknown) =>
            typeof content === "object" &&
            content !== null &&
            "text" in content &&
            content.text === expectedText,
        ),
    )
  );
}

function discoveredFileSkills(source: string): readonly { readonly name: string; readonly path: string }[] {
  let messages: unknown;
  try {
    messages = JSON.parse(source);
  } catch {
    return [];
  }
  if (!Array.isArray(messages)) return [];
  const skills: { name: string; path: string }[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null || !("content" in message)) continue;
    if (!Array.isArray(message.content)) continue;
    for (const content of message.content) {
      if (typeof content !== "object" || content === null || !("text" in content)) continue;
      if (typeof content.text !== "string" || !content.text.includes("<skills_instructions>")) continue;
      for (const line of content.text.split("\n")) {
        if (!line.startsWith("- ") || !line.endsWith(")")) continue;
        const delimiter = line.indexOf(": ", 2);
        const locator = line.lastIndexOf(" (file: ");
        if (delimiter < 0 || locator < 0) continue;
        skills.push({ name: line.slice(2, delimiter), path: line.slice(locator + 8, -1) });
      }
    }
  }
  return skills;
}

export async function detectCodexCapability(): Promise<CodexCapability> {
  let versionResult: CommandResult;
  let probeResult: CommandResult;
  try {
    versionResult = await executeCodex(["--version"]);
    probeResult = await executeCodex([
      "debug",
      "prompt-input",
      "-c",
      `developer_instructions=${JSON.stringify(CONTEXT_PROBE)}`,
    ]);
  } catch (error) {
    throw new Error(
      `Codex capability detection failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const version = versionResult.stdout.trim();
  if (versionResult.exitCode !== 0 || version.length === 0) {
    throw new Error(
      `Codex capability detection failed while reading its version: ${versionResult.stderr.trim()}`,
    );
  }
  if (probeResult.exitCode !== 0 || !probeIsVisibleToCodex(probeResult.stdout, CONTEXT_PROBE)) {
    throw new Error(
      "Codex does not support the required per-process developer instructions surface",
    );
  }
  return { skills: discoveredFileSkills(probeResult.stdout), version };
}

export const codexContextOverride = (context: string): string =>
  `developer_instructions=${JSON.stringify(context)}`;

export const codexSkillsOverride = (
  skillPaths: readonly { readonly enabled: boolean; readonly path: string }[],
): string =>
  `skills.config=[${skillPaths
    .map(({ enabled, path }) => `{path=${JSON.stringify(path)},enabled=${enabled}}`)
    .join(",")}]`;

export interface RunningCodex {
  readonly completion: Promise<number>;
}

export async function startCodexWithLease(
  arguments_: readonly string[],
  leasePath: string,
): Promise<RunningCodex> {
  const child = spawn(
    "/usr/bin/lockf",
    [
      "-s",
      "-t",
      "30",
      "-k",
      leasePath,
      "/bin/sh",
      "-c",
      'printf ready >&3; exec codex "$@"',
      "agent-profile-kit-codex",
      ...arguments_,
    ],
    { stdio: ["inherit", "inherit", "inherit", "pipe"] },
  );
  const completion = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  await new Promise<void>((resolve, reject) => {
    const handshake = child.stdio[3];
    if (!handshake || !("once" in handshake)) {
      reject(new Error("Codex lease process did not expose its readiness pipe"));
      return;
    }
    handshake.once("data", (chunk: Buffer) => {
      if (chunk.toString().startsWith("ready")) resolve();
      else reject(new Error("Codex lease process returned an invalid readiness handshake"));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      reject(new Error(`Codex lease process exited before launch with status ${code ?? 1}`));
    });
  });
  return { completion };
}
