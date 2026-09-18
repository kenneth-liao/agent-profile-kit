import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import type { InstallerToolErrorFact } from "../installer/tool-errors.js";
import { formatWorkspaceIngestionErrorDiagnostic, formatWorkspaceArtifactError } from "../cli/error-wording.js";
import type { WorkspaceArtifactRejectionReason } from "../schemas/schema-rejections.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import { composeContextEnvelope } from "../adapters/context-envelope.js";
import { planAntigravityProject } from "../adapters/antigravity.js";
import { planClaudeProject, CLAUDE_CONTEXT_RULE_PATH } from "../adapters/claude.js";
import { planCodexProject } from "../adapters/codex.js";
import { planGrokProject, GROK_CONTEXT_RULE_PATH } from "../adapters/grok.js";
import { planOpenCodeProject, OPENCODE_CONTEXT_PATH } from "../adapters/opencode.js";
import { planPiProject, PI_CONTEXT_PATH } from "../adapters/pi.js";
import { normalizeAdapterPlans } from "../installer/project-plan.js";

/**
 * Context Module identity is its path under `context/` without `.md`, with
 * `/` between folders (spec #593 DEC-004, #600). apkit reads no Context
 * frontmatter and requires none (DEC-005): each file's bytes are the Context
 * and are delivered as written after the envelope header.
 */

function scaffoldWorkspace(home: string): string {
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  mkdirSync(join(workspace, "context"), { recursive: true });
  mkdirSync(join(workspace, "skills"), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
  return workspace;
}

function writeMinimalSkill(workspace: string, id: string): void {
  mkdirSync(join(workspace, "skills", id), { recursive: true });
  writeFileSync(
    join(workspace, "skills", id, "SKILL.md"),
    `---\nname: ${id}\ndescription: Describes ${id}.\n---\n\n${id} body.\n`,
  );
}

async function ingestionFact(workspace: string): Promise<Record<string, unknown>> {
  try {
    await ingestWorkspace(workspace);
  } catch (error) {
    if (error instanceof InstallerToolError) return error.fact as Record<string, unknown>;
    if (error instanceof SchemaRejectionError) {
      return error.reason.detail as Record<string, unknown>;
    }
    throw error;
  }
  throw new Error("expected ingestWorkspace to reject the workspace");
}

/** Cast one captured schema-rejection detail to the workspace-artifact wording input. */
function reasonFor(detail: Record<string, unknown>): WorkspaceArtifactRejectionReason {
  return detail as WorkspaceArtifactRejectionReason;
}

describe("Context Module identity by path (spec #593 DEC-004/005, #600)", () => {
  test("a nested Markdown file ingests with its path-derived ID and arbitrary frontmatter has no effect", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-context-identity-"));
    try {
      const workspace = scaffoldWorkspace(home);
      mkdirSync(join(workspace, "context", "engineering"), { recursive: true });
      const bytes = "---\nid: something-else\ntitle: arbitrary\n---\nReview findings body.\n";
      writeFileSync(join(workspace, "context", "engineering", "review-findings.md"), bytes);
      writeMinimalSkill(workspace, "review-pr");
      writeFileSync(
        join(workspace, "profiles", "coding.yaml"),
        "context:\n  - engineering/review-findings\nskills:\n  - review-pr\n",
      );
      const ingested = await ingestWorkspace(workspace);
      expect([...ingested.contexts.keys()]).toEqual(["engineering/review-findings"]);
      const module = ingested.contexts.get("engineering/review-findings")!;
      // The ID comes from the path, never from frontmatter.
      expect(module.id).toBe("engineering/review-findings");
      expect(module.path).toBe("context/engineering/review-findings.md");
      // The complete file bytes are the Context, frontmatter included.
      expect(module.content).toBe(bytes);
      expect([...ingested.profiles.get("coding")!.context]).toEqual([
        "engineering/review-findings",
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("files with no, arbitrary, or malformed frontmatter validate and keep their exact bytes", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-context-identity-"));
    try {
      const workspace = scaffoldWorkspace(home);
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["plain.md", "Plain body without any frontmatter.\n"],
        ["arbitrary.md", "---\ntitle: not apkit data\nauthor: someone\n---\nBody.\n"],
        ["malformed.md", "---\n: : [unclosed\nnot yaml at all\n"],
        ["frontmatter-only.md", "---\nid: legacy\n---\n"],
      ];
      for (const [name, bytes] of cases) {
        writeFileSync(join(workspace, "context", name), bytes);
      }
      const ingested = await ingestWorkspace(workspace);
      for (const [name, bytes] of cases) {
        expect(ingested.contexts.get(name.slice(0, -3))!.content).toBe(bytes);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a path segment that cannot form a valid Artifact ID is one violation suggesting the rename", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-context-identity-"));
    try {
      const workspace = scaffoldWorkspace(home);
      mkdirSync(join(workspace, "context", "My_Rules"));
      writeFileSync(join(workspace, "context", "My_Rules", "draft one.md"), "Body.\n");
      const fact = await ingestionFact(workspace);
      expect(fact.case).toBe("context-module-file-name");
      expect(fact.path).toBe("context/My_Rules/draft one.md");
      // The violation's fix is the concrete rename (spec #593 US-006, #600):
      // every segment sanitized to a valid Artifact ID, `/` between folders.
      expect(formatWorkspaceArtifactError(reasonFor(fact))).toBe(
        "Context Module context/My_Rules/draft one.md must have a path whose folders and file name are lowercase kebab-case names without wildcards (they form the Context Module ID); rename the file to context/my-rules/draft-one.md",
      );
      // A path whose segments cannot be sanitized to valid IDs keeps the
      // rule-stating fallback instead of a fabricated suggestion. Its own
      // workspace, because ingestion reports the first violation it reaches.
      const fallbackHome = mkdtempSync(join(tmpdir(), "apkit-context-identity-"));
      const fallbackWorkspace = scaffoldWorkspace(fallbackHome);
      mkdirSync(join(fallbackWorkspace, "context", "___"));
      writeFileSync(join(fallbackWorkspace, "context", "___", "rules.md"), "Body.\n");
      const fallback = await ingestionFact(fallbackWorkspace);
      rmSync(fallbackHome, { recursive: true, force: true });
      expect(fallback.case).toBe("context-module-file-name");
      expect(fallback.name).toBe("___/rules");
      expect(formatWorkspaceArtifactError(reasonFor(fallback))).toContain(
        "rename the file and its folders so every segment is a valid ID",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an invalid Context reference in a Profile names the path grammar and the Profile's file", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-context-identity-"));
    try {
      const workspace = scaffoldWorkspace(home);
      writeFileSync(join(workspace, "profiles", "coding.yaml"), "context:\n  - Bad_Name\nskills: []\n");
      try {
        await ingestWorkspace(workspace);
        throw new Error("expected ingestion to reject the workspace");
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaRejectionError);
        const detail = (error as SchemaRejectionError).reason.detail as Record<string, unknown>;
        expect(detail).toEqual({
          case: "invalid-artifact-id",
          artifact: "Profile",
          path: "profiles/coding.yaml",
          section: "context",
        });
        expect(formatWorkspaceArtifactError(
          reasonFor(detail),
        )).toBe(
          "Profile profiles/coding.yaml context must be a Context Module ID: lowercase kebab-case segments joined by '/'",
        );
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Context delivery as written (spec #593 DEC-005, #600)", () => {
  // A module whose frontmatter bytes are arbitrary user data: they must be
  // delivered exactly, never parsed, never stripped, and never become the
  // Host file's own frontmatter.
  const authored = "---\nid: legacy\ntitle: user data\n---\nBody bytes as written.\n";
  const modules = [{ id: "engineering/review-findings", content: authored }];
  const expectedEnvelope = composeContextEnvelope("coding", modules);

  function contextOutputOf(
    plan: { outputs: ReadonlyArray<{ type: string; path: string; bytes?: unknown }> },
    path: string,
  ): string {
    const output = plan.outputs.find((candidate) => candidate.path === path);
    if (output === undefined || output.type !== "file") throw new Error(`expected file output at ${path}`);
    return output.bytes as string;
  }

  test("every envelope Host delivers the module bytes after the generated header", async () => {
    const deliveries: ReadonlyArray<readonly [string, string]> = [
      ["claude", contextOutputOf(await planClaudeProject("coding", modules), CLAUDE_CONTEXT_RULE_PATH)],
      ["codex", contextOutputOf(await planCodexProject("coding", modules), ".agent-profile-kit/codex/context.md")],
      ["grok", contextOutputOf(await planGrokProject("coding", modules), GROK_CONTEXT_RULE_PATH)],
      ["pi", contextOutputOf(await planPiProject("coding", modules), PI_CONTEXT_PATH)],
      ["opencode", contextOutputOf(await planOpenCodeProject("coding", modules), OPENCODE_CONTEXT_PATH)],
    ];
    for (const [host, bytes] of deliveries) {
      expect(bytes, host).toBe(expectedEnvelope);
      // The generated header precedes all module content: the user's
      // frontmatter bytes never become the Host file's frontmatter.
      expect(bytes.indexOf("---"), host).toBeGreaterThan(bytes.indexOf("# Agent Profile Kit Context"));
    }
  });

  test("Antigravity delivers the module bytes inside one always-on rule whose own frontmatter precedes them", async () => {
    const plan = await planAntigravityProject("coding", modules, []);
    const rule = plan.outputs.find(
      (output) => output.type === "file" && output.path.includes("review-findings"),
    );
    if (rule === undefined || rule.type !== "file") throw new Error("expected module rule output");
    const bytes = rule.bytes as string;
    // Antigravity's generated rule frontmatter and notice come first; the
    // authored bytes (frontmatter included) follow inside the boundary.
    expect(bytes.startsWith("---\ntrigger: always_on\n---\n")).toBe(true);
    expect(bytes).toContain(authored);
    expect(bytes.indexOf(authored)).toBeGreaterThan(bytes.indexOf("trigger: always_on"));
    expect(bytes).toContain("<!-- Context Module: engineering/review-findings -->");
    expect(bytes).toContain("<!-- End Context Module: engineering/review-findings -->");
  });

  test("nested Context IDs produce flat, collision-free Antigravity rule file names", async () => {
    const plan = await planAntigravityProject(
      "coding",
      [
        { id: "engineering/review-findings", content: "One.\n" },
        { id: "engineering-review-findings", content: "Two.\n" },
      ],
      [],
    );
    const paths = plan.outputs
      .filter((output) => output.type === "file")
      .map((output) => output.path);
    // Flat under .agents/rules: no traversal, distinct names for distinct IDs.
    expect(paths).toContain(".agents/rules/agent-profile-kit-010-engineering.review-findings.md");
    expect(paths).toContain(".agents/rules/agent-profile-kit-020-engineering-review-findings.md");
    const rulePaths = paths.filter((path) => path.startsWith(".agents/rules/"));
    expect(new Set(rulePaths).size).toBe(rulePaths.length);
    expect(rulePaths.every((path) => path.startsWith("../") === false)).toBe(true);
  });

  test("planned outputs carrying nested Context origins survive Installer normalization", async () => {
    // normalizeAdapterPlans normalizes Adapter origins; a nested Context ID
    // must pass the same boundary a flat ID passes.
    const claudePlan = await planClaudeProject("coding", modules);
    const normalized = normalizeAdapterPlans([claudePlan]);
    const rule = normalized.find((output) => output.path === CLAUDE_CONTEXT_RULE_PATH);
    expect(rule?.origins).toEqual([{ id: "engineering/review-findings", type: "context" }]);
  });
});

describe("a Profile naming a moved Context ID gets the closest-ID suggestion (spec #593 US-006, #600)", () => {
  test("the ingestion fact carries the moved file's new path among available IDs", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-context-identity-"));
    try {
      const workspace = scaffoldWorkspace(home);
      mkdirSync(join(workspace, "context", "engineering"), { recursive: true });
      writeFileSync(join(workspace, "context", "engineering", "team-rules.md"), "Body.\n");
      writeFileSync(
        join(workspace, "profiles", "coding.yaml"),
        "context:\n  - team-rules\nskills: []\n",
      );
      const fact = await ingestionFact(workspace);
      expect(fact.kind).toBe("missing-context-reference");
      expect(fact.contextId).toBe("team-rules");
      expect(fact.available).toEqual(["engineering/team-rules"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the diagnostic suggests the new path even though edit distance exceeds the nearest-name threshold", async () => {
    const fact: InstallerToolErrorFact = {
      kind: "missing-context-reference",
      profile: "coding",
      contextId: "team-rules",
      file: "profiles/coding.yaml",
      available: ["engineering/team-rules"],
    };
    const diagnostic = formatWorkspaceIngestionErrorDiagnostic(fact);
    const why = diagnostic.why?.map((parts) => parts.map((part) => (typeof part === "string" ? part : "")).join("")).join("\n");
    expect(why).toContain("Did you mean 'engineering/team-rules'?");
  });

  test("several candidates sharing the last segment stay unsuggested so the available list speaks for itself", () => {
    const fact: InstallerToolErrorFact = {
      kind: "missing-context-reference",
      profile: "coding",
      contextId: "team-rules",
      file: "profiles/coding.yaml",
      available: ["engineering/team-rules", "platform/team-rules"],
    };
    const diagnostic = formatWorkspaceIngestionErrorDiagnostic(fact);
    const why = diagnostic.why?.map((parts) => parts.map((part) => (typeof part === "string" ? part : "")).join("")).join("\n");
    expect(why).not.toContain("Did you mean");
  });
});