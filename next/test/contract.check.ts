import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkspace, WARNINGS } from "../src/workspace.js";
import { tempDir, writeTree } from "./fixtures.js";

// The Workspace contract is the one home for the format's rules (ISC-35, ISC-36, ISC-85).
const CONTRACT = await readFile(join(import.meta.dir, "..", "docs", "workspace-contract.md"), "utf8");

/** The text of one `## ` section of the contract. */
function section(title: string): string {
  const found = CONTRACT.split(/^## /m).find((part) => part.startsWith(`${title}\n`));
  if (found === undefined) throw new Error(`The contract has no '## ${title}' section.`);
  return found;
}

/** The codes in the first column of a section's table. */
const tableCodes = (title: string) => [...section(title).matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1] as string).sort();

interface Example {
  readonly title: string;
  readonly files: Record<string, string>;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Each `### ` example: `<!-- path -->` then one code block per file, and `<!-- expects errors|warnings: a, b -->`. */
function examples(): Example[] {
  return section("Examples")
    .split(/^### /m)
    .slice(1)
    .map((part) => {
      const [title, ...lines] = part.split("\n") as [string, ...string[]];
      const files: Record<string, string> = {};
      const expects = { errors: [] as string[], warnings: [] as string[] };
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        const expected = /^<!-- expects (errors|warnings): (.+) -->$/.exec(line);
        if (expected) {
          expects[expected[1] as "errors" | "warnings"] = (expected[2] as string).split(",").map((code) => code.trim());
          continue;
        }
        const path = /^<!-- (.+) -->$/.exec(line);
        if (!path) continue;
        if (!lines[i + 1]?.startsWith("```")) throw new Error(`${title}: ${path[1]} is not followed by a code block.`);
        const end = lines.findIndex((other, index) => index > i + 1 && other.startsWith("```"));
        files[path[1] as string] = lines.slice(i + 2, end).map((text) => `${text}\n`).join("");
        i = end;
      }
      return { title, files, ...expects };
    });
}

describe("the Workspace contract", () => {
  test("states every code validation reports, as an error or a warning", async () => {
    const source = await readFile(join(import.meta.dir, "..", "src", "workspace.ts"), "utf8");
    const emitted = [...new Set([...source.matchAll(/add\(\s*"([a-z-]+)"/g)].map((m) => m[1] as string))];
    expect(tableCodes("Errors")).toEqual(emitted.filter((code) => !WARNINGS.has(code)).sort());
    expect(tableCodes("Warnings")).toEqual([...WARNINGS].sort());
  });

  test("states no rule for a retired feature", () => {
    expect(CONTRACT).not.toMatch(/sidecar|agent-profile-kit\.yaml|metadata\.agent-profile-kit|model-invocation:\s*(explicit|disabled)|dependencies|`id`/i);
  });

  test("has valid and invalid examples", () => {
    const titles = examples().map((example) => example.title);
    expect(titles.some((title) => title.startsWith("Valid: "))).toBe(true);
    expect(titles.some((title) => title.startsWith("Invalid: "))).toBe(true);
    expect(titles.every((title) => /^(Valid|Invalid): /.test(title))).toBe(true);
  });

  for (const example of examples()) {
    test(`${example.title} validates as the contract says`, async () => {
      const root = await tempDir("contract");
      await writeTree(root, example.files);
      const workspace = await loadWorkspace(root);
      const codes = (found: readonly { code: string }[]) => [...new Set(found.map((v) => v.code))].sort();
      expect(example.errors.length > 0).toBe(example.title.startsWith("Invalid: "));
      expect(codes(workspace.violations)).toEqual([...example.errors].sort());
      expect(codes(workspace.warnings)).toEqual([...example.warnings].sort());
    });
  }
});
