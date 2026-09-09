import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { createProfile } from "../installer/create-profile.js";
import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { ingestSelectedWorkspace } from "../installer/local-configuration.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import {
  formatInstallerToolError,
  formatInstallerToolErrorDiagnostic,
} from "../cli/error-wording.js";
import { flatInlineText } from "../cli/inline-content.js";

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

async function initializedHome(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "apkit-create-profile-"));
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

describe("createProfile", () => {
  test("creates a valid bindable Profile at the printed path from existing material selections", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });

      const result = await createProfile({
        home,
        name: "engineering",
        contexts: ["example-context"],
        skills: ["review-pr"],
      });

      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "engineering.yaml");
      expect(result.id).toBe("engineering");
      expect(result.path).toBe(profileFile);
      expect(isAbsolute(result.path)).toBe(true);
      expect(existsSync(profileFile)).toBe(true);

      // The created material is valid Workspace source: full ingestion accepts
      // it and exposes the Profile with exactly the selected material.
      const workspace = await ingestSelectedWorkspace(home);
      const profile = workspace.profiles.get("engineering");
      expect(profile).toBeDefined();
      expect(profile!.context).toEqual(["example-context"]);
      expect(profile!.skills).toEqual(["review-pr"]);
      expect(profile!.path).toBe("profiles/engineering.yaml");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an invalid Artifact ID without creating anything", async () => {
    const home = await initializedHome();
    try {
      for (const name of ["Review_PR", "engineering x", "../escape", "a/b", "-leading", "trailing-"]) {
        const failure = await rejection(() =>
          createProfile({ home, name, contexts: ["example-context"], skills: [] }),
        );
        expect(failure).toBeInstanceOf(SchemaRejectionError);
        expect((failure as SchemaRejectionError).reason.schema).toBe("artifact-id");
        expect(existsSync(join(workspacePath(home), "profiles", `${name}.yaml`))).toBe(false);
      }
      await ingestSelectedWorkspace(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a duplicate Profile Artifact ID already present in the Workspace", async () => {
    const home = await initializedHome();
    try {
      const failure = await rejection(() =>
        createProfile({ home, name: "example", contexts: ["example-context"], skills: [] }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("duplicate-artifact-name");
      // The existing Profile file is preserved untouched.
      expect(readFileSync(join(workspacePath(home), "profiles", "example.yaml"), "utf8")).toContain(
        "id: example",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses zero selections with typed available-names guidance and creates nothing", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });

      const failure = await rejection(() =>
        createProfile({ home, name: "empty", contexts: [], skills: [] }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("profile-without-artifacts");
      if (fact.kind === "profile-without-artifacts") {
        expect(fact.profile).toBe("empty");
        expect(fact.availableContexts).toEqual(["example-context"]);
        expect(fact.availableSkills).toEqual(["review-pr"]);
      }

      // The guidance names the available material so the author can re-run
      // with an explicit selection instead of hunting the Workspace.
      const diagnostic = formatInstallerToolErrorDiagnostic(fact);
      const why = diagnostic.why!.map(flatInlineText).join("\n");
      expect(why).toContain("Available Context Modules: example-context");
      expect(why).toContain("Available Skills: review-pr");
      expect(existsSync(join(workspacePath(home), "profiles", "empty.yaml"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses unknown Context Module and Skill selections through the Workspace boundary", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });

      // An unknown Context Module: typed missing-reference fact with sorted
      // available names.
      const contextFailure = await rejection(() =>
        createProfile({ home, name: "engineered", contexts: ["review-standard"], skills: ["review-pr"] }),
      );
      expect(contextFailure).toBeInstanceOf(InstallerToolError);
      const contextFact = (contextFailure as InstallerToolError).fact;
      expect(contextFact.kind).toBe("missing-context-reference");
      if (contextFact.kind === "missing-context-reference") {
        expect(contextFact.profile).toBe("engineered");
        expect(contextFact.contextId).toBe("review-standard");
        expect(contextFact.file).toBe("profiles/engineered.yaml");
        expect(contextFact.available).toEqual(["example-context"]);
      }

      // An unknown Skill: the same boundary, with the nearest-name suggestion
      // when one exists (DEC-017).
      const skillFailure = await rejection(() =>
        createProfile({ home, name: "engineered", contexts: ["example-context"], skills: ["review-p"] }),
      );
      expect(skillFailure).toBeInstanceOf(InstallerToolError);
      const skillFact = (skillFailure as InstallerToolError).fact;
      expect(skillFact.kind).toBe("missing-skill-reference");
      if (skillFact.kind === "missing-skill-reference") {
        expect(skillFact.skillId).toBe("review-p");
        expect(skillFact.available).toEqual(["review-pr"]);
      }
      const skillDiagnostic = formatInstallerToolErrorDiagnostic(skillFact);
      const skillWhy = skillDiagnostic.why!.map(flatInlineText).join("\n");
      expect(skillWhy).toContain("Available Skills: review-pr");
      expect(skillWhy).toContain("Did you mean 'review-pr'?");

      // With no Skills at all, the guidance names the empty inventory instead
      // of printing an empty list.
      const emptyHome = mkdtempSync(join(tmpdir(), "apkit-create-profile-"));
      try {
        await initializeWorkspace(emptyHome);
        const noneFailure = await rejection(() =>
          createProfile({ home: emptyHome, name: "engineered", contexts: ["example-context"], skills: ["review-pr"] }),
        );
        expect(noneFailure).toBeInstanceOf(InstallerToolError);
        const noneFact = (noneFailure as InstallerToolError).fact;
        expect(noneFact.kind).toBe("missing-skill-reference");
        const noneDiagnostic = formatInstallerToolErrorDiagnostic(noneFact);
        const noneWhy = noneDiagnostic.why!.map(flatInlineText).join("\n");
        expect(noneWhy).toContain("No Skills exist in the Workspace");
      } finally {
        rmSync(emptyHome, { recursive: true, force: true });
      }

      // Nothing was written for any refused selection.
      expect(existsSync(join(workspacePath(home), "profiles", "engineered.yaml"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses selections that duplicate a name within one category", async () => {
    const home = await initializedHome();
    try {
      const failure = await rejection(() =>
        createProfile({
          home,
          name: "dupes",
          contexts: ["example-context", "example-context"],
          skills: [],
        }),
      );
      expect(failure).toBeInstanceOf(SchemaRejectionError);
      expect(existsSync(join(workspacePath(home), "profiles", "dupes.yaml"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses an occupied destination and leaves existing material untouched", async () => {
    const home = await initializedHome();
    try {
      const profileFile = join(workspacePath(home), "profiles", "engineering.yaml");
      writeFileSync(profileFile, "id: mine\ncontext: [example-context]\nskills: []\n");

      const failure = await rejection(() =>
        createProfile({ home, name: "engineering", contexts: ["example-context"], skills: [] }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("artifact-path-occupied");
      if (fact.kind === "artifact-path-occupied") {
        expect(fact.artifactType).toBe("Profile");
        expect(fact.path).toBe(realpathSync(profileFile));
      }
      // Presentation owns the sentence and the structured diagnostic (DEC-014);
      // the diagnostic must carry a runnable recovery command (INT-1, US-022).
      const sentence = flatInlineText(formatInstallerToolError(fact));
      expect(sentence).toContain("engineering");
      expect(sentence).toContain(realpathSync(profileFile));
      const diagnostic = formatInstallerToolErrorDiagnostic(fact);
      expect(diagnostic.whatToType).toBeDefined();
      const recovery = flatInlineText(diagnostic.whatToType!.flat());
      expect(recovery).toContain("apkit new profile <different-name>");
      expect(
        diagnostic.whatToType!.flat().some(
          (part) => typeof part !== "string" && part.kind === "command",
        ),
      ).toBe(true);

      expect(readFileSync(profileFile, "utf8")).toContain("id: mine");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses when the destination exists as a directory and creates nothing", async () => {
    const home = await initializedHome();
    try {
      const occupied = join(workspacePath(home), "profiles", "engineering.yaml");
      mkdirSync(occupied);

      const failure = await rejection(() =>
        createProfile({ home, name: "engineering", contexts: ["example-context"], skills: [] }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("artifact-path-occupied");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a destination that is a symlink and never writes through it", async () => {
    const home = await initializedHome();
    const outside = mkdtempSync(join(tmpdir(), "apkit-create-profile-outside-"));
    try {
      const link = join(workspacePath(home), "profiles", "engineering.yaml");
      symlinkSync(outside, link);

      const failure = await rejection(() =>
        createProfile({ home, name: "engineering", contexts: ["example-context"], skills: [] }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("artifact-path-occupied");

      const outsideEntries = Array.from(new Bun.Glob("*").scanSync({ cwd: outside }));
      expect(outsideEntries).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("creates the missing profiles category safely before the exclusive leaf", async () => {
    const home = await initializedHome();
    try {
      // A Workspace with no profiles category is valid: missing categories are empty.
      rmSync(join(workspacePath(home), "profiles"), { recursive: true, force: true });

      const result = await createProfile({
        home,
        name: "engineering",
        contexts: ["example-context"],
        skills: [],
      });

      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "engineering.yaml");
      expect(result.path).toBe(profileFile);
      expect(existsSync(profileFile)).toBe(true);
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.profiles.has("engineering")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("refuses a symlinked profiles category and never writes through it", async () => {
    const home = await initializedHome();
    const outside = mkdtempSync(join(tmpdir(), "apkit-create-profile-category-"));
    try {
      const profilesDirectory = join(workspacePath(home), "profiles");
      rmSync(profilesDirectory, { recursive: true });
      symlinkSync(outside, profilesDirectory);

      const failure = await rejection(() =>
        createProfile({ home, name: "engineering", contexts: ["example-context"], skills: [] }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("workspace-category-not-directory");
      expect(Array.from(new Bun.Glob("*").scanSync({ cwd: outside }))).toEqual([]);

      // The same refusal applies to a link target inside the Workspace.
      rmSync(profilesDirectory);
      const internal = join(workspacePath(home), "elsewhere");
      mkdirSync(internal);
      symlinkSync(internal, profilesDirectory);
      const internalFailure = await rejection(() =>
        createProfile({ home, name: "engineering", contexts: ["example-context"], skills: [] }),
      );
      expect(internalFailure).toBeInstanceOf(InstallerToolError);
      expect((internalFailure as InstallerToolError).fact.kind).toBe("workspace-category-not-directory");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("accepts scalar-looking names by serializing YAML strings", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "123" });

      const result = await createProfile({
        home,
        name: "true",
        contexts: ["example-context"],
        skills: ["123"],
      });
      expect(result.id).toBe("true");

      const workspace = await ingestSelectedWorkspace(home);
      const profile = workspace.profiles.get("true");
      expect(profile).toBeDefined();
      expect(profile!.skills).toEqual(["123"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("cleans up the proven-created file after write failure through a real exclusive open, so retry and ingestion recover", async () => {
    const home = await initializedHome();
    try {
      const enospc = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
      const failure = await rejection(() =>
        createProfile({
          home,
          name: "engineering",
          contexts: ["example-context"],
          skills: [],
          // Default real exclusive open succeeds (ownership proven); the
          // injected handle write lands actual partial bytes, then fails.
          writeProfileFile: async (handle, contents) => {
            await handle.write(Buffer.from(contents.slice(0, 10), "utf8"));
            throw enospc;
          },
        }),
      );
      // No residue: cleanup removed the proven-created file.
      expect(failure).toBe(enospc);
      expect(existsSync(join(workspacePath(home), "profiles", "engineering.yaml"))).toBe(false);

      // The same name retries and the Workspace stays valid.
      const retried = await createProfile({
        home,
        name: "engineering",
        contexts: ["example-context"],
        skills: [],
      });
      expect(retried.id).toBe("engineering");
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.profiles.has("engineering")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("never deletes a file when the exclusive open fails before creating anything", async () => {
    const home = await initializedHome();
    try {
      const foreignBytes = "foreign-profile-bytes\n";
      const emfile = Object.assign(new Error("Too many open files"), { code: "EMFILE" });
      const destination = join(workspacePath(home), "profiles", "engineering.yaml");
      const failure = await rejection(() =>
        createProfile({
          home,
          name: "engineering",
          contexts: ["example-context"],
          skills: [],
          // Simulates a concurrent writer landing the file before a pre-open
          // failure: the exclusive open never completes, so nothing is proven
          // created and no file may be removed.
          openProfileFile: async (path) => {
            writeFileSync(path, foreignBytes);
            throw emfile;
          },
        }),
      );
      // The foreign file is preserved byte-for-byte; the original error is
      // reported (a retry's occupied refusal is the recovery path).
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
      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "engineering.yaml");
      // Real exclusive open succeeds; the injected write leaves partial bytes,
      // then the read-only profiles category makes cleanup of that file fail.
      const failure = await rejection(() =>
        createProfile({
          home,
          name: "engineering",
          contexts: ["example-context"],
          skills: [],
          writeProfileFile: async (handle, contents) => {
            await handle.write(Buffer.from(contents.slice(0, 10), "utf8"));
            chmodSync(join(workspacePath(home), "profiles"), 0o555);
            throw enospc;
          },
        }),
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      const fact = (failure as InstallerToolError).fact;
      expect(fact.kind).toBe("artifact-creation-residue");
      if (fact.kind === "artifact-creation-residue") {
        expect(fact.artifactType).toBe("Profile");
        expect(fact.contents).toBe("own");
        expect(fact.path).toBe(profileFile);
      }
      // The typed residue names the retry command (INT-1).
      const diagnostic = formatInstallerToolErrorDiagnostic(fact);
      const recovery = flatInlineText(diagnostic.whatToType!.flat());
      expect(recovery).toContain("apkit new profile engineering");
    } finally {
      chmodSync(join(workspacePath(home), "profiles"), 0o755);
      rmSync(home, { recursive: true, force: true });
    }
  });
});
