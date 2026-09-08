import { describe, expect, test } from "bun:test";

import {
  formatWorkspaceIngestionError,
  formatWorkspaceIngestionErrorDiagnostic,
} from "../cli/error-wording.js";
import { nearestName } from "../cli/nearest-match.js";
import type { WorkspaceIngestionErrorFact } from "../installer/tool-errors.js";
import { flatInlineText } from "../cli/inline-content.js";

const contextReference: WorkspaceIngestionErrorFact = {
  kind: "missing-context-reference",
  profile: "broken",
  contextId: "no-such-contex",
  file: "profiles/broken.yaml",
  available: ["team-rules", "writing-style"],
};

const skillReference: WorkspaceIngestionErrorFact = {
  kind: "missing-skill-reference",
  profile: "broken",
  skillId: "deplo",
  file: "profiles/broken.yaml",
  available: ["deploy"],
};

const dependencyReference: WorkspaceIngestionErrorFact = {
  kind: "missing-dependency-reference",
  label: "Context Module",
  id: "no-such-context",
  file: "context/team-rules.md",
  available: ["team-rules", "writing-style"],
};

describe("invalid-reference diagnostics (US-025/026, DEC-014/017)", () => {
  test("a near match is suggested through the shared nearest-name selection", () => {
    expect(nearestName("deplo", ["deploy"])).toBe("deploy");
    expect(nearestName("no-such-contex", ["team-rules", "writing-style"])).toBeUndefined();
  });

  test("the diagnostic names the offending file and invalid value in what happened", () => {
    const parts = formatWorkspaceIngestionErrorDiagnostic(contextReference);
    const happened = flatInlineText(parts.happened);
    expect(happened).toContain("profiles/broken.yaml");
    expect(happened).toContain("no-such-contex");
  });

  test("a near match is suggested in the why section", () => {
    const parts = formatWorkspaceIngestionErrorDiagnostic(skillReference);
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).toContain("Did you mean 'deploy'?");
  });

  test("absence of a near match keeps the available names visible", () => {
    const parts = formatWorkspaceIngestionErrorDiagnostic(contextReference);
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).not.toContain("Did you mean");
    expect(why).toContain("team-rules");
    expect(why).toContain("writing-style");
  });

  test("what to type offers a runnable recovery command", () => {
    const parts = formatWorkspaceIngestionErrorDiagnostic(contextReference);
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("apkit validate");
    expect(whatToType).toContain("profiles/broken.yaml");
  });

  test("dependency references carry the same evidence through the same structure", () => {
    const parts = formatWorkspaceIngestionErrorDiagnostic(dependencyReference);
    const happened = flatInlineText(parts.happened);
    const why = (parts.why ?? []).map((line) => flatInlineText(line)).join("\n");
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(happened).toContain("context/team-rules.md");
    expect(happened).toContain("no-such-context");
    expect(why).toContain("team-rules");
    expect(whatToType).toContain("apkit validate");
  });

  test("the carried sentence exposes file, invalid value, and available names", () => {
    const sentence = formatWorkspaceIngestionError(skillReference);
    expect(sentence).toContain("profiles/broken.yaml");
    expect(sentence).toContain("deplo");
    expect(sentence).toContain("deploy");
  });
});
