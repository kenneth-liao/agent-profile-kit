import { describe, expect, test } from "bun:test";

import {
  formatInstallerToolError,
  formatInstallerToolErrorDiagnostic,
  formatMissingProfileError,
  formatMissingProfileErrorDiagnostic,
  formatWorkspaceIngestionError,
  formatWorkspaceIngestionErrorDiagnostic,
} from "../cli/error-wording.js";
import { nearestName } from "../cli/nearest-match.js";
import type { WorkspaceIngestionErrorFact, InstallerToolErrorFact } from "../installer/tool-errors.js";
import { MissingProfileError } from "../installer/profile-selection.js";
import { SUPPORTED_HOSTS } from "../adapters/registry.js";
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

describe("missing Profile and Host diagnostics (US-015, DEC-011)", () => {
  test("suggests a plausible near-match for a mistyped Profile in the why section", () => {
    const error = new MissingProfileError("enginering", ["engineering", "example", "writing"]);
    const parts = formatMissingProfileErrorDiagnostic(error);
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).toContain("Available Profiles: engineering, example, writing.");
    expect(why).toContain("Did you mean 'engineering'?");
    // Near-match does not suggest discovery command
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).not.toContain("list profiles");
  });

  test("without a clear match, displays available Profiles and offers discovery command", () => {
    const error = new MissingProfileError("completely-unrelated", ["engineering", "example", "writing"]);
    const parts = formatMissingProfileErrorDiagnostic(error);
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).not.toContain("Did you mean");
    expect(why).toContain("Available Profiles: engineering, example, writing.");
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toContain("Run apkit list profiles to inspect available Profiles.");
  });

  test("caps available Profiles list at 10 items with explicit count and offers discovery command", () => {
    const manyProfiles = Array.from({ length: 15 }, (_, index) => `profile-${String(index + 1).padStart(2, "0")}`);
    const error = new MissingProfileError("nonexistent", manyProfiles);
    const parts = formatMissingProfileErrorDiagnostic(error);
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).toContain("Available Profiles: profile-01, profile-02, profile-03, profile-04, profile-05, profile-06, profile-07, profile-08, profile-09, profile-10 (and 5 more).");
    expect(why).not.toContain("profile-11");
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toContain("Run apkit list profiles to inspect available Profiles.");
  });

  test("plain-text MissingProfileError includes suggestion when near-match is found", () => {
    const error = new MissingProfileError("enginering", ["engineering", "writing"]);
    const text = flatInlineText(formatMissingProfileError(error));
    expect(text).toContain("Available Profiles: engineering, writing. Did you mean 'engineering'?");
  });

  test("suggests a plausible near-match for a mistyped Host with consistent sentence capitalization", () => {
    const fact: InstallerToolErrorFact = {
      kind: "unsupported-host",
      host: "claud",
      supportedHosts: SUPPORTED_HOSTS,
    };
    const parts = formatInstallerToolErrorDiagnostic(fact);
    expect(flatInlineText(parts.happened)).toBe("Unsupported Agent Host 'claud'");
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).toContain("Supported Hosts: antigravity, claude, codex, grok, opencode, pi.");
    expect(why).toContain("Did you mean 'claude'?");
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).not.toContain("list hosts");
  });

  test("without a clear Host match, shows supported Hosts and offers discovery command", () => {
    const fact: InstallerToolErrorFact = {
      kind: "unsupported-host",
      host: "completely-unknown",
      supportedHosts: SUPPORTED_HOSTS,
    };
    const parts = formatInstallerToolErrorDiagnostic(fact);
    expect(flatInlineText(parts.happened)).toBe("Unsupported Agent Host 'completely-unknown'");
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).not.toContain("Did you mean");
    expect(why).toContain("Supported Hosts: antigravity, claude, codex, grok, opencode, pi.");
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toContain("Run apkit list hosts to inspect supported Hosts.");
  });

  test("machine formatInstallerToolError preserves lowercase prefix without capitalization change", () => {
    const fact: InstallerToolErrorFact = {
      kind: "unsupported-host",
      host: "claud",
      supportedHosts: SUPPORTED_HOSTS,
    };
    const sentence = flatInlineText(formatInstallerToolError(fact));
    expect(sentence).toContain("unsupported Agent Host 'claud'; supported Hosts: antigravity, claude, codex, grok, opencode, pi");
  });
});

