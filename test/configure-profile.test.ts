/**
 * Configure Profile membership (ticket #500, spec #491 US-009/US-005):
 * one validated write path (`configureProfileMembership`) shared by the
 * explicit and interactive configure modes. Membership REPLACE semantics
 * per supplied category; omitted categories stay unchanged.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { configureProfileMembership } from "../installer/configure-profile.js";
import { createContextModule } from "../installer/create-context-module.js";
import { createSkill } from "../installer/create-skill.js";
import { initializeWorkspace } from "../installer/initialize-workspace.js";
import { MissingProfileError } from "../installer/profile-selection.js";
import { InstallerToolError } from "../installer/tool-errors.js";
import { SchemaRejectionError } from "../schemas/schema-rejections.js";
import { ingestSelectedWorkspace } from "../installer/local-configuration.js";

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

async function initializedHome(): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), "apkit-configure-profile-"));
  await initializeWorkspace(home);
  return home;
}

describe("configureProfileMembership", () => {
  test("explicit membership change writes the canonical Profile definition", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });

      const result = await configureProfileMembership({
        home,
        profile: "example",
        contexts: ["example-context"],
        skills: ["review-pr"],
      });

      expect(result.id).toBe("example");
      expect(isAbsolute(result.path)).toBe(true);
      expect(result.path).toBe(join(realpathSync(workspacePath(home)), "profiles", "example.yaml"));
      expect(result.previousContexts).toEqual(["example-context"]);
      expect(result.previousSkills).toEqual([]);
      expect(result.contexts).toEqual(["example-context"]);
      expect(result.skills).toEqual(["review-pr"]);
      expect(result.changed).toBe(true);

      // The written file re-ingests with exactly the requested membership.
      const workspace = await ingestSelectedWorkspace(home);
      const profile = workspace.profiles.get("example");
      expect(profile).toBeDefined();
      expect(profile!.context).toEqual(["example-context"]);
      expect(profile!.skills).toEqual(["review-pr"]);
      expect(readFileSync(result.path, "utf8")).toContain("review-pr");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("invalid selections leave the Profile source byte-identical", async () => {
    const home = await initializedHome();
    try {
      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "example.yaml");
      const before = readFileSync(profileFile, "utf8");

      const missingContext = await configureProfileMembership({
        home,
        profile: "example",
        contexts: ["no-such-context"],
      }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(missingContext).toBeInstanceOf(InstallerToolError);
      expect((missingContext as InstallerToolError).fact.kind).toBe("missing-context-reference");

      const missingSkill = await configureProfileMembership({
        home,
        profile: "example",
        skills: ["no-such-skill"],
      }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(missingSkill).toBeInstanceOf(InstallerToolError);
      expect((missingSkill as InstallerToolError).fact.kind).toBe("missing-skill-reference");

      expect(readFileSync(profileFile, "utf8")).toBe(before);
      // The refused requests changed nothing the Workspace can see.
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.profiles.get("example")!.skills).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an omitted category stays unchanged while a present-empty category empties", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });
      await createSkill({ home, name: "second-skill" });
      await configureProfileMembership({
        home,
        profile: "example",
        skills: ["review-pr", "second-skill"],
      });

      // Omitted skills stay; only contexts are replaced.
      const omitted = await configureProfileMembership({
        home,
        profile: "example",
        contexts: ["example-context"],
      });
      expect(omitted.changed).toBe(false);
      expect(omitted.contexts).toEqual(["example-context"]);
      expect(omitted.skills).toEqual(["review-pr", "second-skill"]);

      // Present-with-zero-values empties exactly that category.
      const emptied = await configureProfileMembership({
        home,
        profile: "example",
        skills: [],
      });
      expect(emptied.changed).toBe(true);
      expect(emptied.contexts).toEqual(["example-context"]);
      expect(emptied.skills).toEqual([]);

      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.profiles.get("example")!.skills).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an already-matching request changes nothing and reports unchanged", async () => {
    const home = await initializedHome();
    try {
      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "example.yaml");
      const before = readFileSync(profileFile, "utf8");

      const result = await configureProfileMembership({
        home,
        profile: "example",
        contexts: ["example-context"],
        skills: [],
      });

      expect(result.changed).toBe(false);
      expect(readFileSync(profileFile, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a styled hand-ordered Profile keeps comments, order, and id while membership changes", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });
      await createContextModule({ home, name: "extra-rules" });
      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "example.yaml");
      writeFileSync(
        profileFile,
        "# Team profile: hand-maintained, do not reformat.\n" +
          "skills:\n" +
          "  # review-pr is always available.\n" +
          '  - "review-pr"\n' +
          'id: "example" # stable identity\n' +
          "context:\n" +
          "  - example-context # standing rules\n",
      );
      await ingestSelectedWorkspace(home);

      const result = await configureProfileMembership({
        home,
        profile: "example",
        contexts: ["extra-rules", "example-context"],
      });

      expect(result.changed).toBe(true);
      const after = readFileSync(profileFile, "utf8");
      // Unrelated authored content survives byte-identical.
      expect(after).toContain("# Team profile: hand-maintained, do not reformat.\n");
      expect(after).toContain('id: "example" # stable identity\n');
      expect(after).toContain('  # review-pr is always available.\n  - "review-pr"\n');
      // Hand key order is preserved (skills, id, context), not resorted.
      expect(after.indexOf("skills:")).toBeLessThan(after.indexOf('id: "example"'));
      expect(after.indexOf('id: "example"')).toBeLessThan(after.indexOf("context:"));
      // The changed category carries the new membership in canonical order.
      expect(after).toContain("context:\n  - example-context\n  - extra-rules\n");
      // The written file still ingests with the requested membership.
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.profiles.get("example")!.context).toEqual(["example-context", "extra-rules"]);
      expect(workspace.profiles.get("example")!.skills).toEqual(["review-pr"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("hand editing still works after configure: hand-edit, configure, hand content preserved", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });
      await createContextModule({ home, name: "extra-rules" });
      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "example.yaml");

      await configureProfileMembership({ home, profile: "example", skills: ["review-pr"] });

      // Direct file editing remains supported after a configure write.
      const handEdited = `# hand note after configure\n${readFileSync(profileFile, "utf8")}`;
      writeFileSync(profileFile, handEdited);
      await ingestSelectedWorkspace(home);

      const result = await configureProfileMembership({
        home,
        profile: "example",
        contexts: ["extra-rules"],
      });

      expect(result.changed).toBe(true);
      const after = readFileSync(profileFile, "utf8");
      expect(after).toContain("# hand note after configure\n");
      const workspace = await ingestSelectedWorkspace(home);
      expect(workspace.profiles.get("example")!.context).toEqual(["extra-rules"]);
      expect(workspace.profiles.get("example")!.skills).toEqual(["review-pr"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("duplicated selections are refused with the source unchanged", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });
      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "example.yaml");
      const before = readFileSync(profileFile, "utf8");

      const failure = await configureProfileMembership({
        home,
        profile: "example",
        skills: ["review-pr", "review-pr"],
      }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(SchemaRejectionError);
      expect(readFileSync(profileFile, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unknown Profile is refused with available names and creates nothing", async () => {
    const home = await initializedHome();
    try {
      const failure = await configureProfileMembership({
        home,
        profile: "no-such-profile",
        contexts: ["example-context"],
      }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(MissingProfileError);
      expect((failure as MissingProfileError).availableProfiles).toContain("example");
      expect(existsSync(join(realpathSync(workspacePath(home)), "profiles", "no-such-profile.yaml"))).toBe(
        false,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a symlinked Profile file is never written through", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });
      const profilesDir = join(realpathSync(workspacePath(home)), "profiles");
      const target = join(profilesDir, "example.yaml");
      const linkSource = readFileSync(target, "utf8");
      const outside = join(home, "outside.yaml");
      writeFileSync(outside, linkSource);
      rmSync(target);
      symlinkSync(outside, target);

      const failure = await configureProfileMembership({
        home,
        profile: "example",
        skills: ["review-pr"],
      }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      // Ingestion only reads regular files, so the symlinked Profile is
      // invisible to the Workspace boundary: configure refuses without
      // touching the link or its target (never writes through links).
      expect(failure).toBeInstanceOf(MissingProfileError);
      expect(readFileSync(outside, "utf8")).toBe(linkSource);
      expect(lstatSync(target).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("emptying the last selected category is refused with the source unchanged", async () => {
    const home = await initializedHome();
    try {
      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "example.yaml");
      const before = readFileSync(profileFile, "utf8");

      const failure = await configureProfileMembership({
        home,
        profile: "example",
        contexts: [],
      }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(InstallerToolError);
      expect((failure as InstallerToolError).fact.kind).toBe("profile-without-artifacts");
      expect(readFileSync(profileFile, "utf8")).toBe(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an omitted multi-entry category in non-sorted authored order keeps its comments", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });
      await createContextModule({ home, name: "extra-rules" });
      const profileFile = join(realpathSync(workspacePath(home)), "profiles", "example.yaml");
      writeFileSync(
        profileFile,
        "id: example\ncontext:\n  - extra-rules  # keep me\n  - example-context\nskills: []\n",
      );
      const result = await configureProfileMembership({
        home,
        profile: "example",
        skills: ["review-pr"],
      });
      expect(result.changed).toBe(true);
      expect(result.contexts).toEqual(["extra-rules", "example-context"]);
      const after = readFileSync(profileFile, "utf8");
      expect(after).toContain("# keep me");
      expect(after.indexOf("extra-rules")).toBeLessThan(after.indexOf("example-context"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("writes through the ingested Profile path, including profiles/ subdirectories", async () => {
    const home = await initializedHome();
    try {
      await createSkill({ home, name: "review-pr" });
      const nestedDirectory = join(realpathSync(workspacePath(home)), "profiles", "team");
      mkdirSync(nestedDirectory, { recursive: true });
      const nestedFile = join(nestedDirectory, "nested.yaml");
      writeFileSync(nestedFile, "id: nested\ncontext:\n  - example-context\nskills: []\n");

      const result = await configureProfileMembership({
        home,
        profile: "nested",
        skills: ["review-pr"],
      });

      expect(result.changed).toBe(true);
      expect(result.path).toBe(nestedFile);
      expect(readFileSync(nestedFile, "utf8")).toContain("review-pr");
      expect(existsSync(join(realpathSync(workspacePath(home)), "profiles", "nested.yaml"))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
