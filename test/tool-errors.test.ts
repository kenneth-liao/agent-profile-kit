import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindProject } from "../installer/bind-project.js";
import { unbindProject } from "../installer/unbind-project.js";
import { ingestApplicationModelFromSource } from "../installer/local-configuration.js";
import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { expandConfiguredPath, requireExistingDirectory } from "../installer/local-configuration.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { installTemporaryProfile, removeTemporaryProfile } from "../installer/temporary-installation.js";
import { InstallerToolError, type InstallerToolErrorFact } from "../installer/tool-errors.js";
import { parseLocalConfiguration } from "../schemas/local-configuration.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import { MissingProfileError } from "../installer/profile-selection.js";
import {
  formatInstallerToolError,
  formatLocalConfigurationError,
  formatMissingProfileError,
  formatSchemaRejection,
} from "../cli/error-wording.js";
import { installerErrorSentence } from "../cli/error-wording.js";
import { flatInlineText } from "../cli/inline-content.js";
import { INTERNAL_ONLY_DEFAULT_TERMS } from "../cli/presentation.js";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "apkit-tool-errors-"));
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function scaffoldWorkspace(home: string): string {
  const workspace = join(home, "workspace");
  mkdirSync(join(workspace, "profiles"), { recursive: true });
  mkdirSync(join(workspace, "context"), { recursive: true });
  mkdirSync(join(workspace, "skills"), { recursive: true });
  writeFileSync(join(workspace, "workspace.yaml"), "schema_version: 1\n");
  writeFileSync(
    join(workspace, "profiles", "coding.yaml"),
    "id: coding\ncontext:\n  - team-rules\nskills: []\n",
  );
  writeFileSync(
    join(workspace, "profiles", "ops.yaml"),
    "id: ops\ncontext:\n  - team-rules\nskills: []\n",
  );
  writeFileSync(
    join(workspace, "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\n\n# Team rules\n",
  );
  return workspace;
}

function scaffoldConfiguration(home: string, workspace: string): void {
  mkdirSync(join(home, ".agents", "agent-profile-kit"), { recursive: true });
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspace}\nbindings: []\n`,
  );
}

/** Capture the rejection of an async call as a value. */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    (result) => result,
    (error) => error,
  );
}

describe("typed Installer tool errors", () => {
  test("missing Local Configuration is a typed fact, not a sentence", async () => {
    const home = isolatedHome();
    try {
      const projectPath = join(home, "project");
      mkdirSync(projectPath, { recursive: true });
      const failure = await rejection(() =>
        bindProject({ home, profile: "coding", project: projectPath, hosts: ["codex"] }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("missing-local-configuration");
      if (fact.kind === "missing-local-configuration") {
        expect(fact.path).toBe(configPath(home));
      }
      // The typed message is non-prose: no user-facing sentence is authored here.
      expect((failure as InstallerToolError).message).toBe(
        "installer tool error: missing-local-configuration",
      );
      // Presentation owns the carried sentence on both surfaces, verbatim.
      expect(flatInlineText(formatInstallerToolError(fact))).toBe(
        `Local Configuration is missing at ${configPath(home)}; run apkit init`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("bind conflict, unsupported Host, and duplicate roots are typed facts", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      const projectPath = join(home, "project");
      mkdirSync(projectPath, { recursive: true });
      scaffoldConfiguration(home, workspace);

      const unsupportedHost = await rejection(() =>
        bindProject({ home, profile: "coding", project: projectPath, hosts: ["gemini"] }),
      );
      expect(unsupportedHost).toBeInstanceOf(InstallerToolError);
      expect((unsupportedHost as InstallerToolError).fact.kind).toBe("unsupported-host");
      expect(flatInlineText(formatInstallerToolError((unsupportedHost as InstallerToolError).fact))).toBe(
        "unsupported Agent Host 'gemini'; supported Hosts: antigravity, claude, codex, grok, opencode, pi",
      );

      await bindProject({ home, profile: "coding", project: projectPath, hosts: ["codex"] });
      const conflict = await rejection(() =>
        bindProject({ home, profile: "ops", project: projectPath, hosts: ["codex"] }),
      );
      expect(conflict).toBeInstanceOf(InstallerToolError);
      expect((conflict as InstallerToolError).fact.kind).toBe("bind-conflict");
      const conflictSentence = flatInlineText(formatInstallerToolError((conflict as InstallerToolError).fact));
      expect(conflictSentence).toContain("already binds canonical project");
      expect(conflictSentence).toContain("pass --replace to restate its Profile and Hosts");

      const source = `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`;
      const duplicate = await rejection(() =>
        ingestApplicationModelFromSource(home, source, configPath(home)),
      );
      expect(duplicate).toBeInstanceOf(InstallerToolError);
      expect((duplicate as InstallerToolError).fact.kind).toBe("duplicate-canonical-root");
      expect(flatInlineText(formatInstallerToolError((duplicate as InstallerToolError).fact))).toContain(
        "project resolves to duplicate canonical root",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("unbind's stale-binding fallback carries its typed cause", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      const projectPath = join(home, "project");
      mkdirSync(projectPath, { recursive: true });
      scaffoldConfiguration(home, workspace);
      writeFileSync(
        configPath(home),
        `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${projectPath}\n    profile: missing\n    hosts: [codex]\n`,
      );

      const failure = await rejection(() => unbindProject({ home, project: projectPath }));
      // Missing Profile crosses through the pre-existing typed error with its
      // hand-edit recovery; the sentence is composed by presentation from the
      // typed fields, not read from the error's opaque message.
      expect((failure as Error).name).toBe("MissingProfileError");
      expect((failure as Error).message).toBe("missing profile: missing");
      const sentence = failure instanceof MissingProfileError
        ? flatInlineText(formatMissingProfileError(failure))
        : undefined;
      expect(sentence).toContain("Profile 'missing' does not exist in this Workspace");
      expect(sentence).toContain(
        "Edit Local Configuration directly if this stale binding must be removed.",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("configured path shape rejections are typed facts with composed presentation sentences", () => {
    const home = isolatedHome();
    try {
      const origin = {
        source: "local-configuration" as const,
        configurationPath: "/home/.agents/agent-profile-kit/config.yaml",
        bindingIndex: 2,
      };
      const wildcard = (() => {
        try {
          expandConfiguredPath("~/p/*", home, origin, "project");
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(wildcard).toBeInstanceOf(InstallerToolError);
      expect(
        flatInlineText(formatInstallerToolError((wildcard as InstallerToolError).fact)),
      ).toBe(
        "Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[2] project must be an explicit directory path without wildcards",
      );

      const relative = (() => {
        try {
          expandConfiguredPath("./relative", home, origin, "project");
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(
        flatInlineText(formatInstallerToolError((relative as InstallerToolError).fact)),
      ).toBe(
        "Local Configuration /home/.agents/agent-profile-kit/config.yaml bindings[2] project must be an absolute path or home-relative path beginning with ~/",
      );

      const missing = (() => {
        try {
          expandConfiguredPath("/home/no-such", home, origin, "project");
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(missing).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("missing configured directory is a typed fact carrying authored identity", async () => {
    const home = isolatedHome();
    try {
      const origin = { source: "init" as const };
      const failure = await rejection(() =>
        requireExistingDirectory("/home/no-such-dir", "~/no-such-dir", origin, "workspace"),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("missing-directory");
      expect(flatInlineText(formatInstallerToolError((failure as InstallerToolError).fact))).toBe(
        "apkit init workspace '~/no-such-dir' must be an existing directory",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Local Configuration parse rejections are typed facts", () => {
    const path = "/home/.agents/agent-profile-kit/config.yaml";
    const failure = (() => {
      try {
        parseLocalConfiguration(
          "schema_version: 2\nworkspace: /ws\nbindings:\n  - project: /p\n    profile: coding\n    hosts: [cursor]\n",
          path,
        );
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(SchemaRejectionError);
    const rejection = failure as SchemaRejectionError;
    expect(rejection.reason.schema).toBe("local-configuration");
    expect(rejection.reason.detail.case).toBe("unsupported-host");
    expect(flatInlineText(formatSchemaRejection(rejection.reason))).toBe(
      `Local Configuration ${path} bindings[0] hosts[0] unsupported Agent Host 'cursor'; supported Hosts: antigravity, claude, codex, grok, opencode, pi`,
    );
    expect(rejection.message).toBe("schema rejected: local-configuration/unsupported-host");
  });

  test("Workspace ingestion rejections are typed facts", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      writeFileSync(
        join(workspace, "profiles", "broken.yaml"),
        "id: broken\ncontext:\n  - no-such-context\nskills: []\n",
      );
      const failure = await rejection(() => ingestWorkspace(workspace));
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("missing-context-reference");
      expect(flatInlineText(formatInstallerToolError((failure as InstallerToolError).fact))).toBe(
        "Profile 'broken' selects missing Context Module 'no-such-context'. " +
          "Restore the Context Module, or remove or update Profile 'broken'",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("init Workspace validation rejections are typed facts", async () => {
    const home = isolatedHome();
    try {
      const destination = join(home, "occupied");
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "unrelated.txt"), "user material\n");
      const failure = await rejection(() =>
        initializeWorkspace(home, { workspace: destination }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("init-not-workspace-directory");
      expect(flatInlineText(formatInstallerToolError((failure as InstallerToolError).fact))).toBe(
        `Cannot initialize ${destination}: directory is non-empty and is not an Agent Profile Kit Workspace`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("temporary installation identity errors are typed facts", async () => {
    const home = isolatedHome();
    try {
      const missingIdentity = await rejection(() =>
        removeTemporaryProfile({ home, temporaryInstallationId: "  " }),
      );
      expect(missingIdentity).toBeInstanceOf(InstallerToolError);
      expect((missingIdentity as InstallerToolError).fact.kind).toBe("temporary-identity-required");

      const workspace = scaffoldWorkspace(home);
      const projectPath = join(home, "project");
      mkdirSync(projectPath, { recursive: true });
      scaffoldConfiguration(home, workspace);
      await installTemporaryProfile({
        home,
        profile: "coding",
        project: projectPath,
        host: "codex",
      });
      const unknownIdentity = await rejection(() =>
        removeTemporaryProfile({ home, temporaryInstallationId: "no-such-identity" }),
      );
      expect(unknownIdentity).toBeInstanceOf(InstallerToolError);
      expect((unknownIdentity as InstallerToolError).fact.kind).toBe("unknown-temporary-identity");
      expect(flatInlineText(formatInstallerToolError((unknownIdentity as InstallerToolError).fact))).toBe(
        "unknown temporary installation identity 'no-such-identity'",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("temporary installation Host rejections carry their typed sentences", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      const projectPath = join(home, "project");
      mkdirSync(projectPath, { recursive: true });
      scaffoldConfiguration(home, workspace);

      const unsupported = await rejection(() =>
        installTemporaryProfile({
          home,
          profile: "coding",
          project: projectPath,
          host: "gemini",
        }),
      );
      expect((unsupported as InstallerToolError).fact.kind).toBe("unsupported-temporary-host");
      expect(flatInlineText(formatInstallerToolError((unsupported as InstallerToolError).fact))).toBe(
        "unsupported Agent Host 'gemini'; temporary installation supports: claude, codex, opencode, pi",
      );

      const notYet = await rejection(() =>
        installTemporaryProfile({
          home,
          profile: "coding",
          project: projectPath,
          host: "grok",
        }),
      );
      expect((notYet as InstallerToolError).fact.kind).toBe("temporary-host-unsupported");
      expect(flatInlineText(formatInstallerToolError((notYet as InstallerToolError).fact))).toBe(
        "temporary installation does not yet support Agent Host 'grok'; supported Hosts: claude, codex, opencode, pi",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("INTERNAL_ONLY_DEFAULT_TERMS covers the vocabulary these error surfaces carry", () => {
    // The carried tool-error sentences name internal vocabulary ("Local
    // Configuration"); the guard must know those terms so the error surfaces
    // stay inside the vocabulary system (DEC-021) without changing on-screen
    // wording (the #405 verbatim decision).
    for (const term of ["Local Configuration"]) {
      expect(INTERNAL_ONLY_DEFAULT_TERMS.some((pattern) => pattern.test(term))).toBeTrue();
    }
  });

  test("tool-error wording renders verbatim on human surfaces", () => {
    const fact: InstallerToolErrorFact = {
      kind: "missing-local-configuration",
      path: "/home/.agents/agent-profile-kit/config.yaml",
    };
    const machine = flatInlineText(formatInstallerToolError(fact));
    // The machine and human projections publish the same carried sentence.
    expect(flatInlineText(installerErrorSentence(new InstallerToolError(fact)) ?? [])).toBe(machine);
    expect(machine).toContain("run apkit init");
  });

  test("foreign runtime causes keep the hand-edit recovery through typed evidence", async () => {
    const home = isolatedHome();
    try {
      const workspace = scaffoldWorkspace(home);
      const projectPath = join(home, "project");
      mkdirSync(projectPath, { recursive: true });
      scaffoldConfiguration(home, workspace);
      writeFileSync(
        configPath(home),
        `schema_version: 2\nworkspace: ${workspace}\nbindings:\n  - project: ${projectPath}\n    profile: coding\n    hosts: [codex]\n`,
      );
      // An unreadable Workspace Manifest makes its readFile fail with a raw
      // runtime error (EACCES) inside Workspace ingestion — not a typed fact.
      chmodSync(join(workspace, "workspace.yaml"), 0o000);

      const failure = await rejection(() => unbindProject({ home, project: projectPath }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("stale-binding-removal");
      if (fact.kind === "stale-binding-removal") {
        expect(fact.cause).toBeInstanceOf(InstallerToolError);
        expect((fact.cause as InstallerToolError).fact.kind).toBe("foreign-diagnostic");
      }
      // The foreign detail is carried verbatim and the presentation-owned
      // recovery clause is retained, matching the pre-typing composition.
      const sentence = flatInlineText(formatInstallerToolError(fact));
      expect(sentence).toContain("EACCES");
      expect(sentence.endsWith(
        "; edit Local Configuration directly if this stale or malformed binding must be removed",
      )).toBeTrue();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
