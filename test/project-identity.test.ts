import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  displayPath,
  projectIdentityChunks,
  projectIdentityLookup,
  stableProjectDisplay,
  wrapProjectIdentity,
  type ViewProjectLocation,
} from "../cli/display-path.js";

const HOME = "/home/user";
const CWD = "/home/user/projects/demo";

function location(project: string, canonicalProject: string = project): ViewProjectLocation {
  return { canonicalProject, project };
}

describe("per-view Project identity", () => {
  test("uses the shortest unique suffix of each Project's stable display", () => {
    const view = [
      location("~/projects/demo"),
      location("~/projects/other"),
    ];
    const identity = projectIdentityLookup(view, CWD, HOME);

    expect(identity(view[0]!)).toBe("demo");
    expect(identity(view[1]!)).toBe("other");
  });

  test("expands duplicate basenames until the suffix is unambiguous", () => {
    const view = [
      location("~/work/acme/fleet/api"),
      location("~/work/beta/fleet/api"),
      location("~/work/acme/fleet/docs"),
    ];
    const identity = projectIdentityLookup(view, CWD, HOME);

    expect(identity(view[0]!)).toBe("acme/fleet/api");
    expect(identity(view[1]!)).toBe("beta/fleet/api");
    expect(identity(view[2]!)).toBe("docs");
  });

  test("names a single-Project view by its basename", () => {
    const only = location("~/work/beta/fleet/api");
    const identity = projectIdentityLookup([only], CWD, HOME);

    expect(identity(only)).toBe("api");
  });

  test("never lengthens an identity for Projects outside the view", () => {
    const view = [location("~/work/acme/fleet/api")];
    const siblingOutsideView = location("~/work/beta/fleet/api");
    const identity = projectIdentityLookup(view, CWD, HOME);

    expect(identity(view[0]!)).toBe("api");
    // The outside Project is not part of this view: its own view decides its identity.
    expect(projectIdentityLookup([siblingOutsideView], CWD, HOME)(siblingOutsideView)).toBe("api");
  });

  test("preserves an authored spelling while shortening it", () => {
    const authored = location("~/alias/project", "/real/place/project");
    const identity = projectIdentityLookup([authored], CWD, HOME);

    expect(stableProjectDisplay(authored, CWD, HOME)).toBe("~/alias/project");
    expect(identity(authored)).toBe("project");
  });

  test("keeps an outside-home absolute Project absolute until a unique suffix exists", () => {
    const view = [
      location("~/projects/shared-name"),
      location("/var/tmp/shared-name"),
    ];
    const identity = projectIdentityLookup(view, CWD, HOME);

    expect(identity(view[0]!)).toBe("~/projects/shared-name");
    expect(identity(view[1]!)).toBe("tmp/shared-name");
  });

  test("leaves an invalid relative binding as its labeled form", () => {
    const view = [location("..", "..")];
    const identity = projectIdentityLookup(view, CWD, HOME);

    expect(stableProjectDisplay(view[0]!, CWD, HOME)).toBe('relative path ".."');
    expect(identity(view[0]!)).toBe('relative path ".."');
  });

  test("keeps a location with no path segments whole", () => {
    const view = [location("~", HOME)];
    const identity = projectIdentityLookup(view, CWD, HOME);

    expect(identity(view[0]!)).toBe("~");
  });

  test("falls back to the stable display when two Projects share it", () => {
    const view = [location("~/projects/twin"), location("~/projects/twin")];
    const identity = projectIdentityLookup(view, CWD, HOME);

    expect(identity(view[0]!)).toBe("~/projects/twin");
  });

  test("resolves an unknown Project to its stable display", () => {
    const view = [location("~/projects/demo")];
    const identity = projectIdentityLookup(view, CWD, HOME);

    expect(identity(location("~/projects/unlisted"))).toBe("~/projects/unlisted");
  });
});

describe("identity rendering", () => {
  test("splits an identity at path-segment boundaries", () => {
    expect(projectIdentityChunks("acme/fleet/api")).toEqual(["acme/", "fleet/", "api"]);
    expect(projectIdentityChunks("api")).toEqual(["api"]);
  });

  test("keeps a fitting identity on one line", () => {
    expect(wrapProjectIdentity("acme/fleet/api", 40)).toEqual(["acme/fleet/api"]);
  });

  test("wraps a long identity at segment boundaries without losing characters", () => {
    const identity = "group-b/nested-nested-nested/nested-nested/app";
    const lines = wrapProjectIdentity(identity, 24);

    expect(lines.every((line) => line.length <= 24)).toBe(true);
    expect(lines.join("")).toBe(identity);
    expect(lines.length).toBeGreaterThan(1);
  });

  test("hard-splits a single segment longer than the measure without losing characters", () => {
    const identity = "a".repeat(30);
    const lines = wrapProjectIdentity(identity, 12);

    expect(lines.every((line) => line.length <= 12)).toBe(true);
    expect(lines.join("")).toBe(identity);
  });
});

describe("project display scope", () => {
  test("names a Project root by its stable identity even when it is the working directory", () => {
    const project = join(HOME, "projects", "demo");

    expect(displayPath(project, project, "project", project, HOME)).toBe("~/projects/demo");
    expect(displayPath(project, project, "project", join(project, "nested"), HOME)).toBe(
      "~/projects/demo",
    );
  });

  test("still shortens a location strictly inside the working directory", () => {
    const project = join(HOME, "projects", "demo");
    const output = join(project, ".claude", "rules", "agent-profile-kit.md");

    expect(displayPath(output, output, "project", project, HOME)).toBe(
      ".claude/rules/agent-profile-kit.md",
    );
  });

  test("never renders a cwd-relative parent alias", () => {
    const project = join(HOME, "projects", "demo");

    expect(displayPath(project, project, "project", join(project, "nested"), HOME)).not.toBe("..");
    expect(displayPath(project, project, "project", project, HOME)).not.toBe(".");
  });
});
