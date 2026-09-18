import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AUTHORING_EXAMPLES, newProfileScaffold } from "../installer/authoring-examples.js";
import { collectWorkspaceViolations, ingestWorkspace } from "../installer/ingest-workspace.js";
import { workspaceViolationToken } from "../installer/tool-errors.js";
import type { WorkspaceIngestionErrorFact } from "../installer/tool-errors.js";
import type {
  WorkspaceArtifactRejectionReason,
  WorkspaceManifestRejectionReason,
} from "../schemas/schema-rejections.js";
import { WORKSPACE_MANIFEST } from "../schemas/workspace-manifest.js";

/**
 * The published Workspace contract (spec #593 US-004, DEC-010, #602): one
 * canonical document shipped with the guides. TEST-005 executes it:
 *
 * 1. every valid example in the document validates;
 * 2. every invalid example produces exactly the violations the document
 *    names. Validation reports violations one at a time today; #604
 *    (collection) tightens this to a full set comparison — the per-example
 *    `<!-- expects violations: ... -->` annotations in the document are
 *    already the named set, so that tightening edits the assertion, not the
 *    document. Each invalid example is therefore constructed so its tree
 *    contains no violation other than the one it names.
 * 3. every violation kind validation enforces maps to a statement in the
 *    document (ISC-35). The map is exhaustive over the enforced-kind unions,
 *    so a new kind cannot compile until this test and the contract grow the
 *    statement together. #605 (hidden and stray-file rules) extends the map;
 *    it does not rewrite it.
 *
 * Example format (the document is the authority for its own examples): each
 * example is a `### Valid: …` / `### Invalid: …` / `### Pattern: …` heading
 * under `## Examples`; a file is a `<!-- <workspace-relative-path> -->`
 * comment followed by one fenced code block holding the file's bytes; a
 * complete example writes exactly the files it lists.
 */

const CONTRACT_PATH = fileURLToPath(new URL("../docs/guides/workspace-contract.md", import.meta.url));
const contractDocument = readFileSync(CONTRACT_PATH, "utf8");

interface ContractExample {
  readonly title: string;
  readonly files: Readonly<Record<string, string>>;
  readonly expectsViolations?: readonly string[];
}

function parseExamples(document: string): readonly ContractExample[] {
  const examplesSection = document.split(/^## /m).find((section) =>
    section.startsWith("Examples\n"),
  );
  if (examplesSection === undefined) {
    throw new Error("the contract has no '## Examples' section");
  }
  const headings = examplesSection.split(/^### /m).slice(1);
  return headings.map((heading) => {
    const [titleLine, ...bodyLines] = heading.split("\n");
    const files: Record<string, string> = {};
    let expectsViolations: string[] | undefined;
    for (let index = 0; index < bodyLines.length; index += 1) {
      const line = bodyLines[index]!;
      const expects = line.match(/^<!-- expects violations: (.+) -->$/);
      if (expects !== null) {
        expectsViolations = expects[1]!.split(",").map((kind) => kind.trim());
        continue;
      }
      const path = line.match(/^<!-- (.+) -->$/);
      if (path === null) continue;
      const openingFence = bodyLines.findIndex((candidate, offset) =>
        offset > index && candidate.startsWith("```"),
      );
      if (openingFence === -1 || openingFence !== index + 1) {
        throw new Error(`example '${titleLine}' has a file comment not followed by a code block: ${line}`);
      }
      const closingFence = bodyLines.findIndex(
        (candidate, offset) => offset > openingFence && candidate.startsWith("```"),
      );
      if (closingFence === -1) {
        throw new Error(`example '${titleLine}' has an unclosed code block for ${path[1]}`);
      }
      const contents = bodyLines.slice(openingFence + 1, closingFence).join("\n");
      files[path[1]!] = contents.length === 0 ? "" : `${contents}\n`;
      index = closingFence;
    }
    return { title: titleLine!, files, ...(expectsViolations === undefined ? {} : { expectsViolations }) };
  });
}

const examples = parseExamples(contractDocument);
const validExamples = examples.filter((example) => example.title.startsWith("Valid:"));
const invalidExamples = examples.filter((example) => example.title.startsWith("Invalid:"));

function writeExampleTree(example: ContractExample): string {
  const root = mkdtempSync(join(tmpdir(), "apkit-contract-example-"));
  for (const [path, contents] of Object.entries(example.files)) {
    // Containment: a document path comment never escapes the example root.
    if (join(root, path).startsWith(root) === false || path.includes("..")) {
      throw new Error(`example '${example.title}' has a path outside the example root: ${path}`);
    }
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
  return root;
}

/** The example harness publishes tokens through the shared token home (#604). */

describe("workspace contract examples (TEST-005)", () => {
  test("the document declares at least one valid and one invalid example", () => {
    expect(validExamples.length).toBeGreaterThan(0);
    expect(invalidExamples.length).toBeGreaterThan(0);
  });

  test("each valid example validates", async () => {
    for (const example of validExamples) {
      const root = writeExampleTree(example);
      try {
        await expect(ingestWorkspace(root)).resolves.toBeDefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  test("each invalid example produces exactly the violations the document names", async () => {
    for (const example of invalidExamples) {
      const named = example.expectsViolations;
      if (named === undefined || named.length === 0) {
        throw new Error(`invalid example '${example.title}' does not name its violations`);
      }
      const root = writeExampleTree(example);
      try {
        // Exact-set equality over the collected run (#604): one validation
        // run reports every violation, and the collected token set must
        // equal the document's named set — no hidden extra violation, none
        // missing.
        const collected = await collectWorkspaceViolations(root);
        expect(collected.outcome).toBe("invalid");
        if (collected.outcome !== "invalid") throw new Error("expected an invalid collection");
        expect(collected.violations.map(workspaceViolationToken).sort()).toEqual([...named].sort());
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe("workspace contract examples share the authoring-examples authority (DEC-003)", () => {
  const minimal = validExamples.find((example) =>
    example.title.startsWith("Valid: a minimal valid Workspace"),
  );
  if (minimal === undefined) {
    throw new Error("the contract has no 'Valid: a minimal valid Workspace' example");
  }

  test("the example Profile bytes are the Profile writer's output", () => {
    expect(minimal.files["profiles/example.yaml"]).toBe(
      newProfileScaffold(["example-context"], ["example-skill"]),
    );
  });

  test("the example Context Module bytes are the canonical authoring example", () => {
    expect(minimal.files["context/example-context.md"]).toBe(AUTHORING_EXAMPLES.context.contents);
  });

  test("the example Skill bytes are the canonical authoring example", () => {
    expect(minimal.files["skills/example-skill/SKILL.md"]).toBe(AUTHORING_EXAMPLES.skill.contents);
  });

  test("the example Manifest bytes are the canonical Manifest", () => {
    expect(minimal.files["workspace.yaml"]).toBe(WORKSPACE_MANIFEST);
  });
});

/**
 * Every violation kind Workspace validation enforces maps to a statement in
 * the contract (ISC-35, TEST-005). Each Record is exhaustive over its own
 * enforced union, so adding a kind — #605's hidden-file and stray-file kinds,
 * for example — is a compile error until this map and the contract gain the
 * statement together. Each value must appear verbatim in the document (with
 * whitespace collapsed).
 */
const INGESTION_CONTRACT_STATEMENTS: Record<WorkspaceIngestionErrorFact["kind"], string> = {
  // Workspace structure.
  "workspace-missing-manifest": "A Workspace root must contain a `workspace.yaml` file",
  "workspace-manifest-not-file": "`workspace.yaml` must be a file, not a folder",
  "workspace-dangling-category": "a dangling symlink is invalid",
  "workspace-category-not-directory":
    "`context/`, `skills/`, and `profiles/` must be directories, not files",
  // Ingestion.
  "duplicate-artifact-name": "Two Skill packages must not declare the same `name`",
  "nested-profile": "Profile files live directly in `profiles/`; a `.yaml` file inside a `profiles/` subfolder is a violation",
  "leftover-skill-sidecar": "A Skill package must not contain an `agent-profile-kit.yaml` sidecar",
  "profile-without-artifacts":
    "A Profile must select at least one artifact: its `context` list, its `skills` list, or both must be non-empty",
  "missing-context-reference":
    "Every name in a Profile's `context` list must be an existing Context Module ID",
  "missing-skill-reference":
    "Every name in a Profile's `skills` list must be an existing Skill `name`",
};

/** Exhaustive over the Workspace Manifest rejection cases (prefixed with their schema). */
const MANIFEST_CONTRACT_STATEMENTS: Record<WorkspaceManifestRejectionReason["case"], string> = {
  "invalid-yaml": "`workspace.yaml` must be valid YAML",
  "schema-version-missing": "must declare `schema_version: 1`",
  "schema-version-not-positive": "`schema_version` must be a positive integer",
  "unsupported-schema-version":
    "The current Workspace schema version is 1; other versions are not supported",
  "unknown-fields": "`workspace.yaml` contains only `schema_version`",
};

/** Exhaustive over the artifact-parse rejection cases (prefixed with their schema). */
const ARTIFACT_CONTRACT_STATEMENTS: Record<WorkspaceArtifactRejectionReason["case"], string> = {
  "invalid-yaml": "Profile files and `SKILL.md` frontmatter must be valid YAML",
  "not-a-mapping":
    "Profile files are YAML mappings, and `SKILL.md` frontmatter is a YAML mapping",
  "unknown-fields":
    "A Profile file contains exactly its `context` and `skills` lists — no other fields",
  "obsolete-fields": "The `agents`, `hooks`, and `tools` fields are not supported in a Profile",
  "missing-field": "contains both lists: `context` and `skills`",
  "not-array-of-names": "`context` and `skills` are lists of names",
  "duplicate-name": "A Profile list must not select a name more than once",
  "frontmatter-not-open": "A Skill's `SKILL.md` must open with YAML frontmatter",
  "frontmatter-unclosed": "must close its YAML frontmatter",
  "empty-content": "A Context Module file must not be empty",
  "invalid-field":
    "Required Skill fields must be non-empty strings within the Agent Skills length limits: `name` at most 64 characters, `description` at most 1024",
  "invalid-artifact-id":
    "Artifact IDs are lowercase kebab-case names: lowercase letters and digits joined by single hyphens",
  "invalid-model-invocation": "`disable-model-invocation` must be a boolean",
  "leftover-model-invocation-metadata":
    "The retired `metadata.agent-profile-kit.model-invocation` key is a violation; the standard top-level `disable-model-invocation` field is its replacement",
  "profile-id-field": "A Profile carries no `id` field: its ID is its file name without `.yaml`",
  "profile-file-name":
    "A Profile's file name, without `.yaml`, must be a lowercase kebab-case name",
  "context-module-file-name":
    "Every folder and file name under `context/` must be a lowercase kebab-case name, because together they form the Context Module ID",
};

/** The whole enforced-kind space as the test's token space: Installer facts by kind, schema rejections by `schema/case`. */
const VIOLATION_CONTRACT_STATEMENTS: Readonly<Record<string, string>> = {
  ...INGESTION_CONTRACT_STATEMENTS,
  ...Object.fromEntries(
    Object.entries(MANIFEST_CONTRACT_STATEMENTS).map(([token, statement]) => [
      `workspace-manifest/${token}`,
      statement,
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(ARTIFACT_CONTRACT_STATEMENTS).map(([token, statement]) => [
      `workspace-artifact/${token}`,
      statement,
    ]),
  ),
};

describe("every enforced violation kind maps to a contract statement (ISC-35)", () => {
  // Matching collapses whitespace: the contract wraps its prose, and the
  // statement pins the wording, not the line breaks.
  const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

  test("each kind's statement appears in the contract", () => {
    const document = flat(contractDocument);
    for (const [kind, statement] of Object.entries(VIOLATION_CONTRACT_STATEMENTS)) {
      expect(
        document.includes(flat(statement)),
        `violation kind '${kind}' has no matching contract statement: ${statement}`,
      ).toBe(true);
    }
  });
});