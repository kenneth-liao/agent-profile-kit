import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { resolveProfile } from "../installer/resolve-profile.js";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "apkit-resolve-profile-"));
}


function scaffoldWorkspace(
  home: string,
  options: {
    readonly contextDependencies?: Record<string, string>;
    readonly skills?: readonly { readonly id: string }[];
  } = {},
): string {
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  mkdirSync(join(workspace, "context"), { recursive: true });
  mkdirSync(join(workspace, "skills", "primary"), { recursive: true });
  mkdirSync(join(workspace, "skills", "other"), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext: [team-rules]\nskills: [primary]\n",
  );
  for (const [name, dependencies] of Object.entries(options.contextDependencies ?? {})) {
    writeFileSync(
      join(workspace, "context", `${name}.md`),
      `---\nid: ${name}\ndependencies:\n${dependencies}---\n\n# ${name}\n`,
    );
  }
  writeFileSync(
    join(workspace, "context", "bare.md"),
    "---\nid: bare\n---\n\n# bare\n",
  );
  for (const skill of options.skills ?? [{ id: "primary" }, { id: "other" }]) {
    mkdirSync(join(workspace, "skills", skill.id), { recursive: true });
    writeFileSync(
      join(workspace, "skills", skill.id, "SKILL.md"),
      `---\nname: ${skill.id}\ndescription: Does ${skill.id} work.\n---\n\n# ${skill.id}\n`,
    );
  }
  return workspace;
}

describe("Profile-only artifact resolution (spec #593 DEC-006, #596)", () => {
  test("a Profile resolves exactly its listed Context Modules and Skills, in authored order", () => {
    const profile = {
      context: ["bare", "team-rules"],
      id: "coding",
      path: "profiles/coding.yaml",
      skills: ["other", "primary"],
    };
    const contexts = new Map([
      ["team-rules", { content: "# team\n", id: "team-rules", path: "context/team-rules.md" }],
      ["bare", { content: "# bare\n", id: "bare", path: "context/bare.md" }],
    ]);
    const skills = new Map([
      ["primary", { id: "primary", modelInvocation: "allowed" as const, path: "/w/skills/primary" }],
      ["other", { id: "other", modelInvocation: "allowed" as const, path: "/w/skills/other" }],
    ]);
    const resolved = resolveProfile(profile, contexts, skills);
    expect(resolved.contexts.map((context) => context.id)).toEqual(["bare", "team-rules"]);
    expect(resolved.skills.map((skill) => skill.id)).toEqual(["other", "primary"]);
    expect(resolved.artifacts.map((artifact) => artifact.reference.id)).toEqual([
      "bare",
      "team-rules",
      "other",
      "primary",
    ]);
  });

  test("dangling Context Module dependency declarations stay valid and have no effect", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home, {
        contextDependencies: {
          "team-rules": "  - type: context\n    id: no-such-module\n",
        },
      });
      const ingested = await ingestWorkspace(workspace);
      expect([...ingested.contexts.keys()]).toEqual(["bare", "team-rules"]);
      const profile = ingested.profiles.get("coding");
      expect(profile).toBeDefined();
      const resolved = resolveProfile(profile!, ingested.contexts, ingested.skills);
      expect(resolved.contexts.map((context) => context.id)).toEqual(["team-rules"]);
      expect(resolved.skills.map((skill) => skill.id)).toEqual(["primary"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});