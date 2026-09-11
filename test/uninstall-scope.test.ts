/**
 * Uninstall scope parsing (ticket #496, spec #491 US-003/DEC-003): explicit
 * `--here` / `--project` / `--all` scope, mutually exclusive; `--profile`
 * intersects as a simple selector; `--host` is rejected as 498-owned;
 * `--replace-changed` is rejected as inapplicable to a deletion-only
 * operation. Pure argument tests: no filesystem, no writes.
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

  test("--host is rejected as 498-owned with the full-Project equivalent", () => {
    let caught: unknown;
    try {
      parseUninstallArguments(["--here", "--host", "codex", "--auto-confirm"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UninstallUnsupportedFlagError);
    const message = (caught as Error).message;
    expect(message).toContain("--host");
    expect(message).toContain("per-Host removal");
    expect(message).toContain("uninstall --here --auto-confirm");
    expect(message).not.toContain("--host codex");
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

  test("bare --host names --here in its equivalent instead of a scope-less dead end", () => {
    let caught: unknown;
    try {
      parseUninstallArguments(["--host", "codex"]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UninstallUnsupportedFlagError);
    const message = (caught as Error).message;
    expect(message).toContain("uninstall --here");
    expect(message).not.toContain("--host codex");
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
