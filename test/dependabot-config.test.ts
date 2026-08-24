import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("proposes one weekly npm group and one weekly GitHub Actions group through normal CI", () => {
  const dependabot = parse(
    readFileSync(resolve(repositoryRoot, ".github/dependabot.yml"), "utf8"),
  ) as {
    version?: number;
    updates?: Array<{
      "package-ecosystem"?: string;
      directory?: string;
      schedule?: { interval?: string };
      groups?: Record<string, { patterns?: string[] }>;
    }>;
  };
  const ci = parse(
    readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8"),
  ) as { on?: { pull_request?: unknown } };

  expect(dependabot.version).toBe(2);
  expect(dependabot.updates).toEqual([
    {
      "package-ecosystem": "npm",
      directory: "/",
      schedule: { interval: "weekly" },
      groups: {
        "npm-dependencies": { patterns: ["*"] },
      },
    },
    {
      "package-ecosystem": "github-actions",
      directory: "/",
      schedule: { interval: "weekly" },
      groups: {
        "github-actions": { patterns: ["*"] },
      },
    },
  ]);
  expect(ci.on?.pull_request).toBeDefined();
});
