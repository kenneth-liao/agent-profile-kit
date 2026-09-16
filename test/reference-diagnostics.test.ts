import { describe, expect, test } from "bun:test";

import {
  formatConfiguredPathError,
  formatConfiguredPathErrorDiagnostic,
  formatInstallerToolError,
  formatInstallerToolErrorDiagnostic,
  formatMissingProfileError,
  formatMissingProfileErrorDiagnostic,
  formatProjectTargetError,
  formatProjectTargetErrorDiagnostic,
  formatWorkspaceIngestionError,
  formatWorkspaceIngestionErrorDiagnostic,
} from "../cli/error-wording.js";
import { nearestName } from "../cli/nearest-match.js";
import type { WorkspaceIngestionErrorFact, InstallerToolErrorFact } from "../installer/tool-errors.js";
import type { ProjectTargetErrorReason } from "../installer/local-configuration.js";
import type { DiagnosticDocumentParts } from "../cli/diagnostics.js";
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


describe("Project-target diagnostics (#507, US-015)", () => {
  const configurationPath = "/home/.agents/agent-profile-kit/config.yaml";

  const targetReason = (
    reason: Omit<Extract<ProjectTargetErrorReason, { case: "missing-target" }>, "case">,
  ): ProjectTargetErrorReason => ({ case: "missing-target", ...reason });

  test("a missing target leads with the target and cause, without command or noun fragments", () => {
    const parts = formatProjectTargetErrorDiagnostic(
      targetReason({ command: "update", target: "/projects/nope" }),
    );
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe("Project target '/projects/nope' must be an existing directory");
    // AC-2: no repeated command echo (the Usage node carries the command) and
    // no repeated target noun.
    expect(happened).not.toContain("apkit update");
    expect(happened).not.toContain("Project target project");
    // AC-2: a runnable recovery matching the failed lifecycle operation.
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("Run apkit list projects to see configured Projects.");
  });

  test("a relative target keeps the shape cause first and offers the discovery recovery", () => {
    const parts = formatProjectTargetErrorDiagnostic({
      case: "relative-target",
      command: "uninstall",
      target: "./relative",
    });
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe(
      "Project target must be an absolute path or home-relative path beginning with ~/",
    );
    expect(happened).not.toContain("apkit uninstall");
    expect(happened).not.toContain("Project target project");
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("Run apkit list projects to see configured Projects.");
  });

  test("a wildcard target keeps the shape cause first and offers the discovery recovery", () => {
    const parts = formatProjectTargetErrorDiagnostic({
      case: "wildcard-target",
      command: "status",
      target: "~/projects/*",
    });
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe("Project target must be an explicit directory path without wildcards");
    expect(happened).not.toContain("apkit status");
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("Run apkit list projects to see configured Projects.");
  });

  test("a dangling-symlink target keeps its restore remedy and gains the discovery recovery", () => {
    const parts = formatProjectTargetErrorDiagnostic({
      case: "dangling-symlink-target",
      command: "update",
      target: "~/dangling",
    });
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe("Project target '~/dangling' is a dangling symlink");
    expect(happened).not.toContain("apkit update");
    expect(happened).not.toContain("Project target project");
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("Restore its target or choose an existing directory.");
    expect(whatToType).toContain("Run apkit list projects to see configured Projects.");
  });

  test("an ambiguous target drops the command echo and keeps its recovery", () => {
    const parts = formatProjectTargetErrorDiagnostic({
      case: "ambiguous-target",
      command: "update",
      target: "~/projects/fleet",
    });
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe(
      "Project target '~/projects/fleet' is ambiguous because it matches multiple configured Projects",
    );
    expect(happened).not.toContain("apkit update");
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("Pass one exact Project root or run apkit list projects.");
  });

  test("an unbound target keeps its structured recovery with the capitalized family lead", () => {
    const parts = formatProjectTargetErrorDiagnostic({
      case: "unbound-target",
      command: "uninstall",
      target: "~/unbound",
    });
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe("Directory '~/unbound' is not configured as a Project");
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("Run apkit install to configure this directory as a Project.");
    expect(whatToType).toContain("Run apkit list projects to see configured Projects.");
  });

  test("a recorded missing binding leads with the target and moves the configuration locator to why", () => {
    const fact: InstallerToolErrorFact = {
      kind: "missing-directory",
      origin: { source: "local-configuration", configurationPath, bindingIndex: 0 },
      field: "project",
      authored: "~/projects/nope",
    };
    const parts = formatInstallerToolErrorDiagnostic(fact);
    const happened = flatInlineText(parts.happened);
    // AC-1: target and cause first; the internal configuration path is no
    // longer the lead.
    expect(happened).toBe("Project target '~/projects/nope' must be an existing directory");
    expect(happened).not.toContain("Local Configuration");
    const why = (parts.why ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(why).toContain(`Recorded in Local Configuration ${configurationPath} bindings[0].`);
    // AC-2/AC-3: runnable recovery quoting the authored spelling.
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain(
      "Restore the directory, or run apkit uninstall --project '~/projects/nope' to remove its stale record.",
    );
  });

  test("a prospective install target leads with the target and offers a creation remedy without a locator", () => {
    const fact: InstallerToolErrorFact = {
      kind: "missing-directory",
      origin: { source: "local-configuration", configurationPath },
      field: "project",
      authored: "/projects/nope",
    };
    const parts = formatInstallerToolErrorDiagnostic(fact);
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe("Project target '/projects/nope' must be an existing directory");
    expect(parts.why).toBeUndefined();
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("Create it or pass an existing Project directory.");
    expect(whatToType).not.toContain("uninstall");
  });

  test("a target with spaces stays runnable through single quotes", () => {
    const fact: InstallerToolErrorFact = {
      kind: "missing-directory",
      origin: { source: "local-configuration", configurationPath, bindingIndex: 1 },
      field: "project",
      authored: "~/my projects/nope",
    };
    const whatToType = formatInstallerToolErrorDiagnostic(fact)
      .whatToType?.map((line) => flatInlineText(line))
      .join("\n");
    expect(whatToType).toContain("apkit uninstall --project '~/my projects/nope'");
  });

  test("a dangling recorded binding keeps the target-first lead and its restore remedy", () => {
    const fact: InstallerToolErrorFact = {
      kind: "dangling-symlink",
      origin: { source: "local-configuration", configurationPath, bindingIndex: 0 },
      field: "project",
      authored: "~/projects/dangling",
    };
    const parts = formatInstallerToolErrorDiagnostic(fact);
    expect(flatInlineText(parts.happened)).toBe(
      "Project target '~/projects/dangling' is a dangling symlink",
    );
    const whatToType = (parts.whatToType ?? []).map((line) => flatInlineText(line)).join("\n");
    expect(whatToType).toContain("Restore its target or choose an existing directory.");
  });

  test("Workspace-path facts keep the Local Configuration lead (not this family)", () => {
    const fact: InstallerToolErrorFact = {
      kind: "missing-directory",
      origin: { source: "local-configuration", configurationPath },
      field: "workspace",
      authored: "~/no-such-workspace",
    };
    const happened = flatInlineText(
      formatInstallerToolErrorDiagnostic(fact).happened,
    );
    expect(happened).toBe(
      `Local Configuration ${configurationPath} workspace '~/no-such-workspace' must be an existing directory`,
    );
  });

  test("machine projections stay byte-identical for both fact families (DEC-009)", () => {
    const configured: InstallerToolErrorFact = {
      kind: "missing-directory",
      origin: { source: "local-configuration", configurationPath, bindingIndex: 0 },
      field: "project",
      authored: "~/projects/nope",
    };
    expect(flatInlineText(formatInstallerToolError(configured))).toBe(
      `Local Configuration ${configurationPath} bindings[0] project '~/projects/nope' must be an existing directory`,
    );
    expect(
      flatInlineText(
        formatProjectTargetError(targetReason({ command: "update", target: "/projects/nope" })),
      ),
    ).toBe(
      "apkit update Project target project '/projects/nope' must be an existing directory",
    );
  });
});

describe("authoring rejection diagnostics (US-015, #508)", () => {
  function partsText(parts: DiagnosticDocumentParts): string {
    return [
      flatInlineText(parts.happened),
      ...(parts.why ?? []).map(flatInlineText),
      ...(parts.whatToType ?? []).map(flatInlineText),
    ].join("\n");
  }

  const duplicateAtCreation: InstallerToolErrorFact = {
    kind: "duplicate-artifact-name",
    artifactType: "Profile",
    id: "bar",
    path: "profiles/foo.yaml",
    stage: "creation",
  };

  const duplicateSkillAtCreation: InstallerToolErrorFact = {
    kind: "duplicate-artifact-name",
    artifactType: "Skill",
    id: "review-pr",
    path: "skills/review-pr/SKILL.md",
    stage: "creation",
  };

  const duplicateAtIngestion: InstallerToolErrorFact = {
    kind: "duplicate-artifact-name",
    artifactType: "Profile",
    id: "dup",
    path: "profiles/dup-one.yaml",
  };

  const creationContextReference: WorkspaceIngestionErrorFact = {
    kind: "missing-context-reference",
    profile: "engineering",
    contextId: "missing-ctx",
    file: "profiles/engineering.yaml",
    available: ["team-rules", "writing-style"],
    stage: "creation",
  };

  const creationSkillReference: WorkspaceIngestionErrorFact = {
    kind: "missing-skill-reference",
    profile: "engineering",
    skillId: "missing-skill",
    file: "profiles/engineering.yaml",
    available: ["review-pr"],
    stage: "creation",
  };

  const initCollision: InstallerToolErrorFact = {
    kind: "init-planned-profile-conflict",
    profile: "example",
  };

  test("a duplicate name at creation identifies the existing file and offers editing it or another name", () => {
    const parts = formatInstallerToolErrorDiagnostic(duplicateAtCreation);
    expect(flatInlineText(parts.happened)).toBe(
      "A Profile named 'bar' already exists at profiles/foo.yaml",
    );
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).toContain("Nothing was created or changed");
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toContain("Edit profiles/foo.yaml");
    expect(whatToType).toContain("apkit new profile <name>");
  });

  test("a duplicate Skill name carries the same evidence with its own kind token", () => {
    const parts = formatInstallerToolErrorDiagnostic(duplicateSkillAtCreation);
    expect(flatInlineText(parts.happened)).toBe(
      "A Skill named 'review-pr' already exists at skills/review-pr/SKILL.md",
    );
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toContain("Edit skills/review-pr/SKILL.md");
    expect(whatToType).toContain("apkit new skill <name>");
  });

  test("a duplicate name at ingestion offers editing the conflicting files and validate", () => {
    const parts = formatInstallerToolErrorDiagnostic(duplicateAtIngestion);
    expect(flatInlineText(parts.happened)).toBe(
      "A Profile named 'dup' already exists at profiles/dup-one.yaml",
    );
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toContain("unique Artifact ID");
    expect(whatToType).toContain("apkit validate");
    expect(whatToType).not.toContain("apkit new");
  });

  test("a refused creation states the Profile was not created and never directs to the uncreated file", () => {
    const parts = formatWorkspaceIngestionErrorDiagnostic(creationContextReference);
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe(
      "Profile 'engineering' was not created: it selects missing Context Module 'missing-ctx'",
    );
    expect(partsText(parts)).not.toContain("Correct profiles/engineering.yaml");
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).toContain("Available Context Modules: team-rules, writing-style");
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toContain("Create it with apkit new context <name>, or select an available name, then run apkit new profile engineering again");
  });

  test("a refused creation with a missing Skill names the skill creation command", () => {
    const parts = formatWorkspaceIngestionErrorDiagnostic(creationSkillReference);
    const happened = flatInlineText(parts.happened);
    expect(happened).toBe(
      "Profile 'engineering' was not created: it selects missing Skill 'missing-skill'",
    );
    expect(partsText(parts)).not.toContain("Correct profiles/engineering.yaml");
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toContain("Create it with apkit new skill <name>, or select an available name, then run apkit new profile engineering again");
  });

  test("the near-match suggestion carries into the refused-creation diagnostic", () => {
    const parts = formatWorkspaceIngestionErrorDiagnostic({
      kind: "missing-context-reference",
      profile: "engineering",
      contextId: "writing-styl",
      file: "profiles/engineering.yaml",
      available: ["team-rules", "writing-style"],
      stage: "creation",
    });
    const why = (parts.why ?? []).map(flatInlineText).join("\n");
    expect(why).toContain("Did you mean 'writing-style'?");
  });

  test("carried sentences stay byte-identical for creation-stage facts (DEC-009)", () => {
    expect(
      flatInlineText(formatInstallerToolError(duplicateAtCreation)),
    ).toBe("Profile name 'bar' is duplicated");
    expect(
      flatInlineText(
        formatInstallerToolError(creationContextReference),
      ),
    ).toBe(
      "Profile 'engineering' in profiles/engineering.yaml selects missing Context Module 'missing-ctx'. " +
        "Restore the Context Module, or remove or update Profile 'engineering'. " +
        "Available Context Modules: team-rules, writing-style",
    );
  });

  test("an init first-Profile name colliding with the planned example scaffold names what init will create", () => {
    const parts = formatInstallerToolErrorDiagnostic(initCollision);
    expect(flatInlineText(parts.happened)).toBe(
      "Profile 'example' is the example Profile this init will scaffold",
    );
    const whatToType = (parts.whatToType ?? []).map(flatInlineText).join("\n");
    expect(whatToType).toBe("Choose a different Profile name.");
  });
});
