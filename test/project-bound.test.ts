import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cliPath = join(repositoryRoot, "dist", "cli.js");
const temporaryDirectories: string[] = [];

beforeAll(() => {
  execFileSync("bun", ["run", "build"], { cwd: repositoryRoot, stdio: "inherit" });
});

afterAll(() => {
  for (const directory of temporaryDirectories) {
    execFileSync("rm", ["-rf", directory]);
  }
});

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-project-bound-"));
  temporaryDirectories.push(home);
  return home;
}

function runCli(home: string, ...arguments_: string[]) {
  return spawnSync(process.env.NODE_BINARY ?? "node", [cliPath, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

describe("project-bound initialization", () => {
  test("init creates empty Local Configuration alongside the Workspace", () => {
    const home = isolatedHome();
    const result = runCli(home, "init");
    const config = join(home, ".agents", "agent-profile-kit", "config.yaml");

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(config)).toBe(true);
    expect(readFileSync(config, "utf8")).toBe("schema_version: 1\nbindings: []\n");
  });
});
