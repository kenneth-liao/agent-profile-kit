import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { ingestSelectedWorkspace } from "../installer/local-configuration.js";
import { InstallerToolError, type InstallerToolErrorFact } from "../installer/tool-errors.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import {
  errorDiagnosticParts,
  formatInstallerToolError,
  formatInstallerToolErrorDiagnostic,
} from "../cli/error-wording.js";
import { flatInlineText } from "../cli/inline-content.js";

function isolatedHome(): string {
  return mkdtempSync(join(tmpdir(), "apkit-create-skill-"));
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

async function initializedHome(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "apkit-create-skill-"));
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

describe("createSkill", () => {
  test("creates a valid Skill in the configured Workspace and returns the absolute file path", async () => {
    const home = await initializedHome();
    try {
      const result = await createSkill({ home, name: "review-pr" });

      const skillDirectory = join(realpathSync(workspacePath(home)), "skills", "review-pr");
      const skillFile = join(skillDirectory, "SKILL.md");
      expect(result.id).toBe("review-pr");
      expect(result.path).toBe(skillFile);
      expect(isAbsolute(result.path)).toBe(true);
      expect(existsSync(skillFile)).toBe(true);

      // The created material is valid Workspace source: full ingestion accepts it
      // and exposes the Skill under its Artifact ID.
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.skills.has("review-pr")).toBe(true);
      expect(workspace.skills.get("review-pr")!.path).toBe(skillDirectory);

      const source = readFileSync(skillFile, "utf8");
      expect(source).toContain("name: \"review-pr\"");
      expect(source).toContain("description:");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an invalid Artifact ID without creating anything", async () => {
    const home = await initializedHome();
    try {
      for (const name of ["Review_PR", "review pr", "../escape", "a/b", "-leading", "trailing-"]) {
        const failure = await rejection(() => createSkill({ home, name }));
        expect(failure).toBeInstanceOf(SchemaRejectionError);
        expect((failure as SchemaRejectionError).reason.schema).toBe("artifact-id");
        expect(existsSync(join(workspacePath(home), "skills", name))).toBe(false);
      }
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.skills.size).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a duplicate Skill Artifact ID already present in the Workspace", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });
      // A second Skill directory whose frontmatter claims the same Artifact ID.
      const otherRoot = join(workspacePath(home), "skills", "elsewhere");
      mkdirSync(otherRoot, { recursive: true });
      writeFileSync(
        join(otherRoot, "SKILL.md"),
        "---\nname: review-pr\ndescription: Another directory claiming the same ID.\n---\n\nBody.\n",
      );

      const failure = await rejection(() => createSkill({ home, name: "review-pr" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("duplicate-artifact-name");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses an occupied destination and leaves existing material untouched", async () => {
    const home = await initializedHome();
    try {
      const skillRoot = join(workspacePath(home), "skills", "review-pr");
      mkdirSync(join(skillRoot, "scripts"), { recursive: true });
      writeFileSync(join(skillRoot, "scripts", "run.sh"), "#!/bin/sh\necho owned\n");

      const failure = await rejection(() => createSkill({ home, name: "review-pr" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("skill-path-occupied");
      if (fact.kind === "skill-path-occupied") {
        expect(fact.path).toBe(realpathSync(skillRoot));
      }
      // Presentation owns the sentence and the structured diagnostic (DEC-014);
      // the diagnostic must carry a runnable recovery command after the
      // explanation (INT-1, US-022).
      const sentence = flatInlineText(formatInstallerToolError(fact));
      expect(sentence).toContain("review-pr");
      expect(sentence).toContain(skillRoot);
      const diagnostic = formatInstallerToolErrorDiagnostic(fact);
      expect(flatInlineText(diagnostic.happened)).toContain(skillRoot);
      expect(diagnostic.whatToType).toBeDefined();
      const recovery = flatInlineText(diagnostic.whatToType!.flat());
      expect(recovery).toContain("apkit new skill <different-name>");
      // The command follows the failure explanation as one structured part.
      expect(
        diagnostic.whatToType!.flat().some(
          (part) => typeof part !== "string" && part.kind === "command",
        ),
      ).toBe(true);

      expect(readFileSync(join(skillRoot, "scripts", "run.sh"), "utf8")).toBe("#!/bin/sh\necho owned\n");
      expect(existsSync(join(skillRoot, "SKILL.md"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses when the destination exists as a plain file and creates nothing", async () => {
    const home = await initializedHome();
    try {
      const occupied = join(workspacePath(home), "skills", "review-pr");
      writeFileSync(occupied, "not a directory\n");

      const failure = await rejection(() => createSkill({ home, name: "review-pr" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("skill-path-occupied");
      expect(readFileSync(occupied, "utf8")).toBe("not a directory\n");
      expect(existsSync(join(occupied, "SKILL.md"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a destination that is a symlink and never writes through it", async () => {
    const home = await initializedHome();
    try {
      const outside = mkdtempSync(join(tmpdir(), "apkit-create-skill-outside-"));
      const link = join(workspacePath(home), "skills", "review-pr");
      symlinkSync(outside, link);

      const failure = await rejection(() => createSkill({ home, name: "review-pr" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("skill-path-occupied");

      const outsideEntries = Array.from(new Bun.Glob("*").scanSync({ cwd: outside }));
      expect(outsideEntries).toEqual([]);
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("creates the missing skills category safely before the exclusive leaf (SPEC-1)", async () => {
    const home = await initializedHome();
    try {
      // A Workspace with no skills category is valid: missing categories are empty.
      rmSync(join(workspacePath(home), "skills"), { recursive: true, force: true });

      const result = await createSkill({ home, name: "review-pr" });

      const skillFile = join(realpathSync(workspacePath(home)), "skills", "review-pr", "SKILL.md");
      expect(result.path).toBe(skillFile);
      expect(existsSync(skillFile)).toBe(true);
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.skills.has("review-pr")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a symlinked skills category and never writes through it (CRAFT-1)", async () => {
    const home = await initializedHome();
    const outside = mkdtempSync(join(tmpdir(), "apkit-create-skill-outside-"));
    try {
      const skillsDirectory = join(workspacePath(home), "skills");
      rmSync(skillsDirectory, { recursive: true });
      symlinkSync(outside, skillsDirectory);

      const failure = await rejection(() => createSkill({ home, name: "review-pr" }));
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("workspace-category-not-directory");
      // The external target must be preserved untouched.
      expect(Array.from(new Bun.Glob("*").scanSync({ cwd: outside }))).toEqual([]);

      // The same refusal applies to a link target inside the Workspace.
      rmSync(skillsDirectory);
      const internal = join(workspacePath(home), "elsewhere");
      mkdirSync(internal);
      symlinkSync(internal, skillsDirectory);
      const internalFailure = await rejection(() => createSkill({ home, name: "review-pr" }));
      expect(internalFailure).toBeInstanceOf(InstallerToolError);
      expect((internalFailure as InstallerToolError).fact.kind).toBe("workspace-category-not-directory");
      expect(Array.from(new Bun.Glob("*").scanSync({ cwd: internal }))).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("accepts scalar-looking names by serializing a YAML string (CRAFT-2)", async () => {
    const home = await initializedHome();
    try {
      for (const name of ["true", "123"]) {
        const result = await createSkill({ home, name });
        expect(result.id).toBe(name);
        const workspace = await ingestSelectedWorkspace(home);
        expect(workspace.skills.has(name)).toBe(true);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a name exceeding the Skill schema length before any write (CRAFT-2)", async () => {
    const home = await initializedHome();
    try {
      const tooLong = "a".repeat(65); // lowercase kebab, one over the schema maximum
      expect(tooLong.length).toBe(65);
      const failure = await rejection(() => createSkill({ home, name: tooLong }));
      expect(failure).toBeInstanceOf(SchemaRejectionError);
      expect((failure as SchemaRejectionError).reason.schema).toBe("workspace-artifact");
      expect(existsSync(join(workspacePath(home), "skills", tooLong))).toBe(false);
      // A 64-character name is the accepted boundary.
      const boundary = "a".repeat(64);
      expect(boundary.length).toBe(64);
      const accepted = await createSkill({ home, name: boundary });
      expect(accepted.id).toBe(boundary);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cleans up an invocation-created partial write so retry and ingestion recover (PROD-1)", async () => {
    const home = await initializedHome();
    try {
      // A pre-existing sibling Skill must survive the failed creation untouched.
      await createSkill({ home, name: "keep-me" });
      const keepFile = join(workspacePath(home), "skills", "keep-me", "SKILL.md");
      const keepBefore = readFileSync(keepFile, "utf8");

      const enospc = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
      const failure = await rejection(
        () =>
          createSkill({
            home,
            name: "review-pr",
            writeSkillFile: async () => {
              throw enospc;
            },
          }),
      );
      // No residual fact: cleanup removed everything this invocation created.
      expect(failure).toBe(enospc);
      expect(existsSync(join(workspacePath(home), "skills", "review-pr"))).toBe(false);

      // Capacity restored: the same name retries and the Workspace stays valid.
      const retried = await createSkill({ home, name: "review-pr" });
      expect(retried.id).toBe("review-pr");
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.skills.has("review-pr")).toBe(true);
      expect(readFileSync(keepFile, "utf8")).toBe(keepBefore);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports typed residual-path evidence when cleanup fails and preserves existing content (PROD-1)", async () => {
    const home = await initializedHome();
    try {
      const enospc = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
      const skillRoot = join(realpathSync(workspacePath(home)), "skills", "review-pr");
      // Injected write creates the truncated file before failing, then the
      // read-only directory makes cleanup of that file fail.
      chmodSync(join(workspacePath(home), "skills"), 0o755);
      const failure = await rejection(() =>
        createSkill({
          home,
          name: "review-pr",
          writeSkillFile: async (path, contents) => {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, contents.slice(0, 10));
            chmodSync(dirname(path), 0o555);
            throw enospc;
          },
        }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("skill-creation-residue");
      if (fact.kind === "skill-creation-residue") {
        expect(fact.path).toBe(join(skillRoot, "SKILL.md"));
        expect(fact.id).toBe("review-pr");
      }
      // Presentation owns the recovery sentence and command.
      const diagnostic = formatInstallerToolErrorDiagnostic(fact);
      expect(flatInlineText(diagnostic.happened)).toContain(join(skillRoot, "SKILL.md"));
      expect(diagnostic.whatToType).toBeDefined();

      // Restore access, remove the residue, and retry recovers cleanly.
      chmodSync(skillRoot, 0o755);
      rmSync(join(skillRoot, "SKILL.md"));
      rmdirSync(skillRoot);
      const retried = await createSkill({ home, name: "review-pr" });
      expect(retried.id).toBe("review-pr");
      await ingestSelectedWorkspace(home);
    } finally {
      chmodSync(join(workspacePath(home), "skills"), 0o755);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("preserves a foreign file left beside a failed write instead of deleting it (PROD-1)", async () => {
    const home = await initializedHome();
    try {
      const enospc = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
      const failure = await rejection(() =>
        createSkill({
          home,
          name: "review-pr",
          writeSkillFile: async (path, contents) => {
            const directory = dirname(path);
            mkdirSync(directory, { recursive: true });
            writeFileSync(path, contents.slice(0, 5));
            // A concurrent writer lands a foreign entry before our failure.
            writeFileSync(join(directory, "notes.md"), "foreign\n");
            throw enospc;
          },
        }),
      );
      // Cleanup removes the proven-created SKILL.md, refuses the non-empty
      // directory, and reports the residual directory as typed evidence.
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("skill-creation-residue");
      if (fact.kind === "skill-creation-residue") {
        expect(fact.path).toBe(join(realpathSync(workspacePath(home)), "skills", "review-pr"));
      }
      expect(readFileSync(join(workspacePath(home), "skills", "review-pr", "notes.md"), "utf8")).toBe("foreign\n");
      expect(existsSync(join(workspacePath(home), "skills", "review-pr", "SKILL.md"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("reports a missing Local Configuration as a typed fact", async () => {
    const home = mkdtempSync(join(tmpdir(), "apkit-create-skill-"));
    try {
      const failure = await rejection(() => createSkill({ home, name: "review-pr" }));
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