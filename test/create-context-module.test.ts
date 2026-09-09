import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { createContextModule } from "../installer/create-context-module.js";
import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { ingestSelectedWorkspace } from "../installer/local-configuration.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import {
  errorDiagnosticParts,
  formatInstallerToolError,
  formatInstallerToolErrorDiagnostic,
} from "../cli/error-wording.js";
import { flatInlineText } from "../cli/inline-content.js";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "apkit-create-context-"));
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

async function initializedHome(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "apkit-create-context-"));
  await initializeWorkspace(home);
  return home;
}

/** Capture the rejection of an async call as a value. */
async function rejection(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    (result) => result,
    (error) => error,
  );
}

/**
 * Re-point the scaffolded example Profile from the example Context Module to
 * a freshly created Skill, so the Workspace stays valid without a `context`
 * category for the category-boundary tests.
 */
async function selectSkillInsteadOfExampleContext(home: string): Promise<void> {
  await createSkill({ home, name: "anchor-skill" });
  writeFileSync(
    join(workspacePath(home), "profiles", "example.yaml"),
    "id: example\ncontext: []\nskills: [anchor-skill]\n",
  );
}

describe("createContextModule", () => {
  test("creates a valid Context Module in the configured Workspace and returns the absolute file path", async () => {
    const home = await initializedHome();
    try {
      const result = await createContextModule({ home, name: "review-standards" });

      const contextFile = join(realpathSync(workspacePath(home)), "context", "review-standards.md");
      expect(result.id).toBe("review-standards");
      expect(result.path).toBe(contextFile);
      expect(isAbsolute(result.path)).toBe(true);
      expect(existsSync(contextFile)).toBe(true);

      // The created material is valid Workspace source: full ingestion accepts it
      // and exposes the Context Module under its Artifact ID.
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.contexts.has("review-standards")).toBe(true);
      expect(workspace.contexts.get("review-standards")!.path).toBe("context/review-standards.md");

      const source = readFileSync(contextFile, "utf8");
      expect(source).toContain("id: \"review-standards\"");
      expect(source).toContain("dependencies:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an invalid Artifact ID without creating anything", async () => {
    const home = await initializedHome();
    try {
      for (const name of ["Review_PR", "review pr", "../escape", "a/b", "-leading", "trailing-"]) {
        const failure = await rejection(() => createContextModule({ home, name }));
        expect(failure).toBeInstanceOf(SchemaRejectionError);
        expect((failure as SchemaRejectionError).reason.schema).toBe("artifact-id");
        expect(existsSync(join(workspacePath(home), "context", `${name}.md`))).toBe(false);
      }
      await ingestSelectedWorkspace(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a duplicate Context Module Artifact ID already present in the Workspace", async () => {
    const home = await initializedHome();
    try {
      await createContextModule({ home, name: "review-standards" });
      // A second Context Module file whose frontmatter claims the same Artifact ID.
      const otherFile = join(workspacePath(home), "context", "elsewhere.md");
      writeFileSync(
        otherFile,
        "---\nid: review-standards\ndependencies: []\n---\n\nAnother file claiming the same ID.\n",
      );

      const failure = await rejection(() => createContextModule({ home, name: "review-standards" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("duplicate-artifact-name");
      // The foreign second file is preserved.
      expect(existsSync(otherFile)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses an occupied destination and leaves existing material untouched", async () => {
    const home = await initializedHome();
    try {
      // An existing Context Module file with hand-authored content: refused,
      // never overwritten.
      const contextFile = join(workspacePath(home), "context", "review-standards.md");
      writeFileSync(contextFile, "---\nid: mine\ndependencies: []\n---\n\nHand-authored.\n");

      const failure = await rejection(() => createContextModule({ home, name: "review-standards" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("artifact-path-occupied");
      if (fact.kind === "artifact-path-occupied") {
        expect(fact.artifactType).toBe("Context Module");
        expect(fact.path).toBe(realpathSync(contextFile));
      }
      // Presentation owns the sentence and the structured diagnostic (DEC-014);
      // the diagnostic must carry a runnable recovery command after the
      // explanation (INT-1, US-022).
      const sentence = flatInlineText(formatInstallerToolError(fact));
      expect(sentence).toContain("review-standards");
      expect(sentence).toContain(realpathSync(contextFile));
      const diagnostic = formatInstallerToolErrorDiagnostic(fact);
      expect(flatInlineText(diagnostic.happened)).toContain(realpathSync(contextFile));
      expect(diagnostic.whatToType).toBeDefined();
      const recovery = flatInlineText(diagnostic.whatToType!.flat());
      expect(recovery).toContain("apkit new context <different-name>");
      expect(
        diagnostic.whatToType!.flat().some(
          (part) => typeof part !== "string" && part.kind === "command",
        ),
      ).toBe(true);

      expect(readFileSync(contextFile, "utf8")).toContain("Hand-authored.\n");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses when the destination exists as a directory and creates nothing", async () => {
    const home = await initializedHome();
    try {
      const occupied = join(workspacePath(home), "context", "review-standards.md");
      mkdirSync(occupied);

      const failure = await rejection(() => createContextModule({ home, name: "review-standards" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("artifact-path-occupied");
      expect(existsSync(join(occupied, "review-standards.md"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a destination that is a symlink and never writes through it", async () => {
    const home = await initializedHome();
    try {
      const outside = mkdtempSync(join(tmpdir(), "apkit-create-context-outside-"));
      const link = join(workspacePath(home), "context", "review-standards.md");
      symlinkSync(outside, link);

      const failure = await rejection(() => createContextModule({ home, name: "review-standards" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("artifact-path-occupied");

      const outsideEntries = Array.from(new Bun.Glob("*").scanSync({ cwd: outside }));
      expect(outsideEntries).toEqual([]);
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("creates the missing context category safely before the exclusive leaf", async () => {
    const home = await initializedHome();
    try {
      // A Workspace with no context category is valid: missing categories are empty.
      await selectSkillInsteadOfExampleContext(home);
      rmSync(join(workspacePath(home), "context"), { recursive: true, force: true });

      const result = await createContextModule({ home, name: "review-standards" });

      const contextFile = join(realpathSync(workspacePath(home)), "context", "review-standards.md");
      expect(result.path).toBe(contextFile);
      expect(existsSync(contextFile)).toBe(true);
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.contexts.has("review-standards")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a symlinked context category and never writes through it", async () => {
    const home = await initializedHome();
    const outside = mkdtempSync(join(tmpdir(), "apkit-create-context-outside-"));
    try {
      const contextDirectory = join(workspacePath(home), "context");
      await selectSkillInsteadOfExampleContext(home);
      rmSync(contextDirectory, { recursive: true });
      symlinkSync(outside, contextDirectory);

      const failure = await rejection(() => createContextModule({ home, name: "review-standards" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("workspace-category-not-directory");
      // The external target must be preserved untouched.
      expect(Array.from(new Bun.Glob("*").scanSync({ cwd: outside }))).toEqual([]);

      // The same refusal applies to a link target inside the Workspace.
      rmSync(contextDirectory);
      const internal = join(workspacePath(home), "elsewhere");
      mkdirSync(internal);
      symlinkSync(internal, contextDirectory);
      const internalFailure = await rejection(() => createContextModule({ home, name: "review-standards" }));
      expect(internalFailure).toBeInstanceOf(InstallerToolError);
      expect((internalFailure as InstallerToolError).fact.kind).toBe("workspace-category-not-directory");
      expect(Array.from(new Bun.Glob("*").scanSync({ cwd: internal }))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("accepts scalar-looking names by serializing a YAML string", async () => {
    const home = await initializedHome();
    try {
      for (const name of ["true", "123"]) {
        const result = await createContextModule({ home, name });
        expect(result.id).toBe(name);
        const workspace = await ingestSelectedWorkspace(home);
        expect(workspace.contexts.has(name)).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cleans up the proven-created file after write failure through a real exclusive open, so retry and ingestion recover", async () => {
    const home = await initializedHome();
    try {
      // A pre-existing sibling Context Module must survive the failed creation untouched.
      await createContextModule({ home, name: "keep-me" });
      const keepFile = join(workspacePath(home), "context", "keep-me.md");
      const keepBefore = readFileSync(keepFile, "utf8");

      const enospc = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
      const failure = await rejection(
        () =>
          createContextModule({
            home,
            name: "review-standards",
            // Default real exclusive open succeeds (ownership proven); the
            // injected handle write lands actual partial bytes, then fails.
            writeModuleFile: async (handle, contents) => {
              await handle.write(Buffer.from(contents.slice(0, 10), "utf8"));
              throw enospc;
            },
          }),
      );
      // No residue: cleanup removed the proven-created file.
      expect(failure).toBe(enospc);
      expect(existsSync(join(workspacePath(home), "context", "review-standards.md"))).toBe(false);

      // The same name retries and the Workspace stays valid.
      const retried = await createContextModule({ home, name: "review-standards" });
      expect(retried.id).toBe("review-standards");
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.contexts.has("review-standards")).toBe(true);
      expect(readFileSync(keepFile, "utf8")).toBe(keepBefore);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never deletes a file when the exclusive open fails before creating anything", async () => {
    const home = await initializedHome();
    try {
      const foreignBytes = "foreign-context-bytes\n";
      const emfile = Object.assign(new Error("Too many open files"), { code: "EMFILE" });
      const destination = join(workspacePath(home), "context", "review-standards.md");
      const failure = await rejection(() =>
        createContextModule({
          home,
          name: "review-standards",
          // Simulates a concurrent writer landing the file before a pre-open
          // failure: the exclusive open never completes, so nothing is proven
          // created and no file may be removed.
          openModuleFile: async (path) => {
            writeFileSync(path, foreignBytes);
            throw emfile;
          },
        }),
      );
      // The foreign file is preserved byte-for-byte; the original error is
      // reported (the destination is not Agent Profile Kit-created material,
      // so a retry's occupied refusal is the recovery path).
      expect(readFileSync(destination, "utf8")).toBe(foreignBytes);
      expect(failure).toBe(emfile);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports typed own-material residue when cleanup fails, with complete recovery", async () => {
    const home = await initializedHome();
    try {
      const enospc = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
      const contextFile = join(realpathSync(workspacePath(home)), "context", "review-standards.md");
      // Real exclusive open succeeds; the injected write leaves partial bytes,
      // then the read-only category directory makes cleanup of that file fail.
      const failure = await rejection(() =>
        createContextModule({
          home,
          name: "review-standards",
          writeModuleFile: async (handle, contents) => {
            await handle.write(Buffer.from(contents.slice(0, 10), "utf8"));
            chmodSync(join(workspacePath(home), "context"), 0o555);
            throw enospc;
          },
        }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("artifact-creation-residue");
      if (fact.kind === "artifact-creation-residue") {
        // The residue path is the file: removing it clears the retry blocker;
        // the surviving material is all Agent Profile Kit-created.
        expect(fact.artifactType).toBe("Context Module");
        expect(fact.path).toBe(contextFile);
        expect(fact.contents).toBe("own");
        expect(fact.id).toBe("review-standards");
      }
      // Presentation owns the recovery sentence and command; removing the
      // reported file alone unblocks the retry.
      const diagnostic = formatInstallerToolErrorDiagnostic(fact);
      expect(flatInlineText(diagnostic.happened)).toContain(contextFile);
      expect(diagnostic.whatToType).toBeDefined();
      expect(flatInlineText(diagnostic.whatToType!.flat())).toContain("apkit new context review-standards");

      // Complete recovery: remove the reported file, retry recovers.
      chmodSync(join(workspacePath(home), "context"), 0o755);
      rmSync(contextFile);
      const retried = await createContextModule({ home, name: "review-standards" });
      expect(retried.id).toBe("review-standards");
      await ingestSelectedWorkspace(home);
    } finally {
      chmodSync(join(workspacePath(home), "context"), 0o755);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never reports success when the post-write close fails", async () => {
    const home = await initializedHome();
    try {
      const closeError = Object.assign(new Error("Input/output error on close"), { code: "EIO" });
      const failure = await rejection(() =>
        createContextModule({
          home,
          name: "review-standards",
          // Real exclusive open (ownership proven); the write succeeds, then
          // the post-write close is injected to reject.
          openModuleFile: async (path) => {
            const real = await open(path, "wx");
            return {
              writeFile: (contents: string) => real.writeFile(contents),
              close: async () => {
                await real.close();
                throw closeError;
              },
            } as unknown as FileHandle;
          },
        }),
      );
      // No successful creation result: the close failure is routed through
      // creation recovery and reported as the original error.
      expect(failure).toBe(closeError);
      expect(existsSync(join(workspacePath(home), "context", "review-standards.md"))).toBe(false);

      // Retry recovers cleanly and ingestion stays valid.
      const retried = await createContextModule({ home, name: "review-standards" });
      expect(retried.id).toBe("review-standards");
      await ingestSelectedWorkspace(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports a missing Local Configuration as a typed fact", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-create-context-"));
    try {
      const failure = await rejection(() => createContextModule({ home, name: "review-standards" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("missing-local-configuration");
      const diagnostic = errorDiagnosticParts(failure!);
      expect(flatInlineText(diagnostic.happened)).not.toContain(configPathOf(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function configPathOf(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}
