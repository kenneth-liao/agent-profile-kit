import { spawn } from "node:child_process";

const CONTEXT_PROBE = "agent-profile-kit capability probe";

export interface CodexCapability {
  readonly version: string;
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
  return { version };
}

export const codexContextOverride = (context: string): string =>
  `developer_instructions=${JSON.stringify(context)}`;

export async function runCodex(
  arguments_: readonly string[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", arguments_, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
}
