/**
 * Uninstall scope parsing (tickets #496/#498, spec #491 US-003/US-004/
 * DEC-003): explicit `--here` / `--project` / `--all` scope, mutually
 * exclusive; `--profile` intersects as a simple selector; repeatable
 * `--host` narrows removal within the scope; `--replace-changed` is
 * accepted only alongside `--host` (survivor rewrites) and rejected for
 * whole-removal. Pure argument tests: no filesystem, no writes.
 */
import { describe, expect, test } from "bun:test";

import {
  parseUninstallArguments,
  UninstallUnsupportedFlagError,
} from "../cli/uninstall-command.js";

describe("uninstall scope parsing", () => {
  test("bare arguments select no scope", () => {
    const parsed = parseUninstallArguments([]);
    expect(parsed.here).toBe(false);
    expect(parsed.all).toBe(false);
    expect(parsed.project).toBeUndefined();
    expect(parsed.profile).toBeUndefined();
    expect(parsed.autoConfirm).toBe(false);
    expect(parsed.removeChanged).toBe(false);
    expect(parsed.json).toBe(false);
  });

  test("--here, --project, and --all each parse", () => {
    expect(parseUninstallArguments(["--here"]).here).toBe(true);
    expect(parseUninstallArguments(["--all"]).all).toBe(true);
    const project = parseUninstallArguments(["--project", "/tmp/example"]);
    expect(project.project).toBe("/tmp/example");
    expect(project.projectFlag).toBe(true);
  });

  test("a positional Project path parses like --project", () => {
    const parsed = parseUninstallArguments(["/tmp/example"]);
    expect(parsed.project).toBe("/tmp/example");
    expect(parsed.projectFlag).toBe(false);
  });

  test("--profile intersects without implying a Project scope", () => {
    const parsed = parseUninstallArguments(["--profile", "engineering"]);
    expect(parsed.profile).toBe("engineering");
    expect(parsed.here).toBe(false);
    expect(parsed.all).toBe(false);
    expect(parsed.project).toBeUndefined();
  });

  test("--here cannot be combined with --all", () => {
    expect(() => parseUninstallArguments(["--here", "--all"])).toThrow(
      "--here cannot be combined with --all",
    );
  });

  test("--project cannot be combined with --here", () => {
    expect(() => parseUninstallArguments(["--here", "--project", "/tmp/example"])).toThrow(
      "--project cannot be combined with --here",
    );
  });

  test("--project cannot be combined with --all", () => {
    expect(() => parseUninstallArguments(["--all", "--project", "/tmp/example"])).toThrow(
      "--project cannot be combined with --all",
    );
  });

  test("--all cannot be combined with a Project path", () => {
    expect(() => parseUninstallArguments(["--all", "/tmp/example"])).toThrow(
      "--all cannot be combined with a Project path",
    );
  });

  test("--here cannot be combined with a Project path", () => {
    expect(() => parseUninstallArguments(["--here", "/tmp/example"])).toThrow(
      "--here cannot be combined with a Project path",
    );
  });

  test("--project cannot be combined with a Project path", () => {
    expect(() => parseUninstallArguments(["--project", "/tmp/a", "/tmp/b"])).toThrow(
      "--project cannot be combined with a Project path",
    );
  });

  test("--profile requires a value", () => {
    expect(() => parseUninstallArguments(["--profile"])).toThrow(
      "uninstall --profile requires a Profile name",
    );
  });

  test("unknown flags are rejected", () => {
    expect(() => parseUninstallArguments(["--verbose"])).toThrow(
      "uninstall does not accept argument '--verbose'",
    );
  });

  test("repeatable --host narrows within the scope", () => {
    const parsed = parseUninstallArguments(["--here", "--host", "codex", "--host", "pi", "--auto-confirm"]);
    expect(parsed.hosts).toEqual(["codex", "pi"]);
    expect(parsed.here).toBe(true);
  });

  test("--host requires a value", () => {
    expect(() => parseUninstallArguments(["--host"])).toThrow(
      "uninstall --host requires an Agent Host name",
    );
  });

  test("--host alone selects no scope", () => {
    const parsed = parseUninstallArguments(["--host", "codex"]);
    expect(parsed.hosts).toEqual(["codex"]);
    expect(parsed.here).toBe(false);
    expect(parsed.all).toBe(false);
    expect(parsed.project).toBeUndefined();
    expect(parsed.profile).toBeUndefined();
  });

  test("--replace-changed is accepted alongside --host", () => {
    const parsed = parseUninstallArguments(["--here", "--host", "codex", "--replace-changed"]);
    expect(parsed.replaceChanged).toBe(true);
    expect(parsed.hosts).toEqual(["codex"]);
  });

  test("bare --replace-changed names --here alongside --remove-changed", () => {
    let caught: unknown;
    try {
      parseUninstallArguments(["--replace-changed"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UninstallUnsupportedFlagError);
    const message = (caught as Error).message;
    expect(message).toContain("uninstall --here");
    expect(message).toContain("--remove-changed");
  });

  test("whole-removal --replace-changed rejection points at the --host partial path", () => {
    let caught: unknown;
    try {
      parseUninstallArguments(["--here", "--replace-changed"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UninstallUnsupportedFlagError);
    const message = (caught as Error).message;
    expect(message).toContain("--replace-changed");
    expect(message).toContain("--host <name>");
  });

  test("--replace-changed is rejected with a did-you-mean---remove-changed equivalent", () => {
    let caught: unknown;
    try {
      parseUninstallArguments(["--all", "--replace-changed", "--auto-confirm"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UninstallUnsupportedFlagError);
    const message = (caught as Error).message;
    expect(message).toContain("--replace-changed");
    expect(message).toContain("--remove-changed");
    expect(message).toContain("uninstall --all --remove-changed --auto-confirm");
  });
});
