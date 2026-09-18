import { describe, expect, test } from "bun:test";

import { parseProfile } from "../schemas/context-profile.js";
import { formatSchemaRejection } from "../cli/error-wording.js";
import { formatWorkspaceIngestionError } from "../cli/error-wording.js";
import { flatInlineText } from "../cli/inline-content.js";

/**
 * Profile identity is its file name under `profiles/` without `.yaml`, and the
 * file holds only `context` and `skills` lists (spec #593 DEC-014, #598). The
 * parser is the one identity boundary: it derives the ID from the path and
 * never reads an `id` field.
 */

function expectSchemaFact(parse: () => unknown): Record<string, unknown> {
  try {
    parse();
  } catch (error) {
    const reason = (error as { reason?: { schema: string; detail: unknown } }).reason;
    if (reason === undefined || reason.schema !== "workspace-artifact") throw error;
    return reason.detail as Record<string, unknown>;
  }
  throw new Error("expected parseProfile to reject");
}

describe("Profile identity by file name (spec #593 DEC-014, #598)", () => {
  test("a Profile without an id field parses with the file name as its ID", () => {
    const profile = parseProfile(
      'context:\n  - "team-rules"\nskills:\n  - "review-pr"\n',
      "profiles/coding.yaml",
    );
    expect(profile.id).toBe("coding");
    expect(profile.context).toEqual(["team-rules"]);
    expect(profile.skills).toEqual(["review-pr"]);
    expect(profile.path).toBe("profiles/coding.yaml");
  });

  test("an id field is a violation naming the path and the authored id", () => {
    expect(expectSchemaFact(() =>
      parseProfile(
        'id: "coding"\ncontext: []\nskills: ["review-pr"]\n',
        "profiles/coding.yaml",
      ),
    )).toEqual({ case: "profile-id-field", path: "profiles/coding.yaml", id: "coding" });
  });

  test("an id field whose value is not a string is still the id-field violation", () => {
    expect(expectSchemaFact(() =>
      parseProfile("id: 123\ncontext: []\nskills: [review-pr]\n", "profiles/coding.yaml"),
    )).toEqual({ case: "profile-id-field", path: "profiles/coding.yaml" });
  });

  test("a top-level file name that is not a valid Artifact ID is a violation", () => {
    expect(expectSchemaFact(() =>
      parseProfile("context: []\nskills: [review-pr]\n", "profiles/Coding_Rules.yaml"),
    )).toEqual({
      case: "profile-file-name",
      path: "profiles/Coding_Rules.yaml",
      name: "Coding_Rules",
    });
  });

  test("a nested Profile path is a file-name violation when parsed directly", () => {
    expect(expectSchemaFact(() =>
      parseProfile("context: []\nskills: [review-pr]\n", "profiles/nested/coding.yaml"),
    )).toEqual({
      case: "profile-file-name",
      path: "profiles/nested/coding.yaml",
      name: "nested/coding",
    });
  });
});

describe("Profile identity violation wording (spec #593 DEC-014, #598)", () => {
  test("the id-field sentence names the path and the remove fix", () => {
    const sentence = flatInlineText(formatSchemaRejection({
      schema: "workspace-artifact",
      detail: { case: "profile-id-field", path: "profiles/coding.yaml", id: "coding" },
    }));
    expect(sentence).toContain("profiles/coding.yaml");
    expect(sentence).toContain("Remove the 'id' field");
    expect(sentence).not.toContain("rename");
  });

  test("the id-field sentence keeps bindings working when the authored id differs", () => {
    const sentence = flatInlineText(formatSchemaRejection({
      schema: "workspace-artifact",
      detail: { case: "profile-id-field", path: "profiles/foo.yaml", id: "bar" },
    }));
    expect(sentence).toContain("profiles/foo.yaml");
    expect(sentence).toContain("Remove the 'id' field");
    expect(sentence).toContain("rename the file to profiles/bar.yaml");
    expect(sentence).toContain("'bar'");
  });

  test("the file-name sentence names the path and directs a rename", () => {
    const sentence = flatInlineText(formatSchemaRejection({
      schema: "workspace-artifact",
      detail: { case: "profile-file-name", path: "profiles/Coding_Rules.yaml", name: "Coding_Rules" },
    }));
    expect(sentence).toContain("profiles/Coding_Rules.yaml");
    expect(sentence).toContain("rename");
    expect(sentence).toContain("lowercase kebab-case");
  });

  test("the nested-profile sentence names the path and directs the move", () => {
    const sentence = formatWorkspaceIngestionError({
      kind: "nested-profile",
      file: "profiles/archive/old-work.yaml",
    });
    expect(sentence).toContain("profiles/archive/old-work.yaml");
    expect(sentence).toContain("profiles/old-work.yaml");
  });
});
