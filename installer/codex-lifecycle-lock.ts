import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

function lockPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", ".codex-lifecycle.lock");
}

async function acquireLock(path: string): Promise<ReturnType<typeof spawn>> {
  const child = spawn(
    "/usr/bin/lockf",
    ["-s", "-t", "30", "-k", path, "/bin/sh", "-c", "printf ready; cat >/dev/null"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.once("data", (chunk: Buffer) => {
      if (chunk.toString().startsWith("ready")) resolve();
      else reject(new Error(`Codex lifecycle lock returned an invalid handshake at ${path}`));
    });
    child.once("error", reject);
    child.once("close", (code) => {
      reject(
        new Error(
          `Timed out waiting for Codex lifecycle lock at ${path}${stderr.trim() ? `: ${stderr.trim()}` : ""} (exit ${code ?? 1})`,
        ),
      );
    });
  });
  return child;
}

async function releaseLock(child: ReturnType<typeof spawn>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Codex lifecycle lock release failed with exit ${code ?? 1}`));
    });
  });
  if (!child.stdin) throw new Error("Codex lifecycle lock did not expose its release pipe");
  child.stdin.end();
  await closed;
}

export async function withCodexLifecycleLock<T>(
  home: string,
  operation: () => Promise<T>,
): Promise<T> {
  await mkdir(join(home, ".agents", "agent-profile-kit"), { recursive: true });
  const child = await acquireLock(lockPath(home));
  try {
    return await operation();
  } finally {
    await releaseLock(child);
  }
}
