import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";

import { join, resolve } from "node:path";

import { packedCliNodeExecutable } from "./package-archive.js";

/**
 * The common controlled fixture boundary for packed, golden, and fleet tests
 * (issue #541, US-003): one home for the intended executable availability and
 * environment inputs a controlled child sees.
 *
 * - PATH is composed hermetically: the fixture's own Host stub bins first,
 *   then one allowlist bin of the non-Host tools the CLI and fixture-owned
 *   stub scripts actually invoke — and never the ambient machine PATH. An
 *   unselected real Host executable can therefore never be resolved by a
 *   controlled child (TEST-004, ISC-16).
 * - The child environment is an explicit overlay, not an ambient spread: HOME,
 *   the composed PATH, and the invocation's scoped TMPDIR are the only
 *   inherited facts; every other value must be supplied explicitly by the
 *   fixture caller, so deliberate Host-detection inputs (CODEX_HOME,
 *   GROK_HOME), terminal configuration (COLUMNS, LINES, TERM, NO_COLOR, PAGER,
 *   LESS), and runtime overrides (APKIT_TEST_*) are preserved while unrelated
 *   ambient values cannot leak into an outcome (explicit input preservation,
 *   not indiscriminate stripping).
 */

/**
 * Non-Host tools a controlled child may resolve. `git` is a real CLI
 * dependency (Repository Exclusion, Git topology inspection). `sleep` and
 * `cat` are the external commands the fixture-owned Host stub scripts and PTY
 * feeds actually invoke; `echo`/`printf` are POSIX shell builtins and need no
 * entry. Each tool is resolved once from the runner's PATH, by absolute
 * realpath, and fail-fast: a missing tool is a fixture defect, never an
 * ambient PATH fallback.
 */
export type ControlledTool = "git" | "sleep" | "cat" | "sh" | "stty" | "script" | "node";

/** The default allowlist for every controlled packed-CLI child PATH. */
export const DEFAULT_CONTROLLED_TOOLS: readonly ControlledTool[] = ["git", "sleep", "cat"];

/** Additional allowlist tools needed only by PTY-driven seams. */
export const PTY_CONTROLLED_TOOLS: readonly ControlledTool[] = [
  ...DEFAULT_CONTROLLED_TOOLS,
  "sh",
  "stty",
  "script",
];

const resolvedToolPaths = new Map<ControlledTool, string>();

function executableName(value: string): string {
  const index = value.lastIndexOf("/");
  return index === -1 ? value : value.slice(index + 1);
}

/**
 * Find `name` on the runner's PATH by filesystem lookup — POSIX semantics:
 * each `:`-separated segment in order, an empty segment meaning the current
 * directory, first executable regular file wins, resolved to its absolute
 * realpath. No resolver subprocess: the lookup cannot hang and stays inside
 * the fixture boundary (ADR-0027/0028). A missing name fails fast with the
 * selected name in the message — never an ambient or literal fallback.
 */
function executableRealpathOnRunnerPath(name: string): string {
  const segments = (process.env.PATH ?? "").split(":");
  for (const segment of segments) {
    const candidate = segment === "" ? join(process.cwd(), name) : join(segment, name);
    let stat: import("node:fs").Stats;
    try {
      stat = statSync(candidate);
    } catch {
      continue;
    }
    if (!stat.isFile() || (stat.mode & 0o111) === 0) continue;
    try {
      return realpathSync(candidate);
    } catch {
      continue; // a broken PATH entry is skipped, like exec-family resolution
    }
  }
  throw new Error(
    `Controlled fixture tool '${name}' is not resolvable on the runner's PATH; ` +
      "the controlled fixture boundary resolves every selected executable explicitly and never falls back to an ambient child PATH",
  );
}

/**
 * Resolve one allowlist tool to an absolute realpath, once per process,
 * failing fast. `node` honors the canonical packed-CLI reader
 * (`packedCliNodeExecutable`, US-007): the NODE_BINARY override or the same
 * PATH resolution a packed launch would perform, never an independent
 * authority.
 */
export function controlledToolPath(tool: ControlledTool): string {
  const cached = resolvedToolPaths.get(tool);
  if (cached !== undefined) return cached;
  let absolute: string;
  if (tool === "node") {
    // The canonical packed-CLI reader (US-007) is the only selection fact:
    // its value is the selected executable. An absolute/relative override is
    // real-pathed as authored; a bare name (possibly an alternate executable
    // name, not necessarily `node`) is looked up by that actual basename and
    // fails fast when absent. The literal `node` is never a fallback.
    const canonical = packedCliNodeExecutable();
    const selected = executableName(canonical);
    if (selected !== canonical) {
      try {
        absolute = realpathSync(resolve(canonical));
      } catch (error) {
        throw new Error(
          `The canonical packed-CLI Node reader selected '${canonical}' via NODE_BINARY, but that executable does not exist; ` +
            "the controlled fixture boundary resolves the actual selection and never falls back to an ambient child PATH",
          { cause: error },
        );
      }
    } else {
      absolute = executableRealpathOnRunnerPath(selected);
    }
  } else {
    absolute = executableRealpathOnRunnerPath(tool);
  }
  resolvedToolPaths.set(tool, absolute);
  return absolute;
}

function existsLink(path: string): boolean {
  try {
    realpathSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The allowlist bin for one test home: one symlink per requested tool,
 * idempotently extended (a seam that needs PTY tools extends the same bin the
 * default composition created). Tools resolve once, fail-fast, by absolute
 * realpath — no ambient PATH fallback and no copied tool directories.
 */
export function controlledAllowlistBin(
  home: string,
  tools: readonly ControlledTool[] = DEFAULT_CONTROLLED_TOOLS,
): string {
  const bin = join(home, "allow-bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of tools) {
    const link = join(bin, tool);
    if (!existsLink(link)) symlinkSync(controlledToolPath(tool), link);
  }
  return bin;
}

export interface ControlledPathOptions {
  /** The fixture's own Host stub bin directories, in probe order. */
  readonly stubBins?: readonly string[];
  /** Allowlist tools beyond the default set. */
  readonly tools?: readonly ControlledTool[];
}

/**
 * A hermetic PATH for one controlled packed-CLI child: the fixture's stub
 * bins first, then the allowlist bin. The ambient machine PATH is never
 * included, so unselected real Host executables cannot satisfy a probe.
 */
export function controlledPath(home: string, options: ControlledPathOptions = {}): string {
  const allowlist = controlledAllowlistBin(home, options.tools ?? DEFAULT_CONTROLLED_TOOLS);
  return [...(options.stubBins ?? []), allowlist].join(":");
}

/** The hermetic PATH for PTY-driven controlled seams (adds `sh`, `stty`, `script`). */
export function controlledPtyPath(home: string, options: ControlledPathOptions = {}): string {
  return controlledPath(home, { ...options, tools: options.tools ?? PTY_CONTROLLED_TOOLS });
}

export interface ControlledEnvironmentOptions {
  readonly home: string;
  readonly path: string;
  /**
   * Deliberate intended inputs supplied by the fixture caller. An entry with
   * an undefined value deletes the key; every defined value wins over any
   * default. Ambient values are never inherited beyond the overlay's own
   * HOME, PATH, and TMPDIR facts.
   */
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * The controlled child environment: exactly HOME, the composed PATH, the
 * invocation's scoped TMPDIR, and the caller's explicit overrides.
 */
export function controlledEnvironment(options: ControlledEnvironmentOptions): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    HOME: options.home,
    PATH: options.path,
  };
  const tmpdir = process.env.TMPDIR;
  if (tmpdir !== undefined) result.TMPDIR = tmpdir;
  for (const [key, value] of Object.entries(options.environment ?? {})) {
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

/**
 * The Host executable names a controlled fixture may leave deliberately
 * unselected. A trap bin installs one recording trap executable per name so a
 * fixture that still leaks the ambient PATH resolves every unselected probe
 * into the trap instead of a real installed Host, proving absence of
 * unintended Host execution (TEST-004).
 */
export const TRAPPED_HOST_STUBS: readonly string[] = [
  "agy",
  "claude",
  "codex",
  "grok",
  "opencode",
  "pi",
] as const;

export interface HostTrapBin {
  readonly bin: string;
  readonly logPath: string;
}

/**
 * One bin directory of recording Host-name traps: each appends
 * `<name> <args>` to an owned log file and exits 1. Prepend this bin to the
 * ambient PATH to make the ambient environment hostile: any controlled
 * fixture that still inherits ambient PATH resolves an unselected Host probe
 * into the trap, and a real installed Host CLI is never reached.
 */
export function createHostTrapBin(home: string): HostTrapBin {
  const bin = join(home, "host-trap-bin");
  const logPath = join(home, "host-trap.log");
  mkdirSync(bin, { recursive: true });
  for (const name of TRAPPED_HOST_STUBS) {
    // Single-quote the owned log path for sh; an embedded quote closes the
    // string, so escape it the POSIX way. Fixture-authored homes only, but
    // the boundary stays correct rather than trusting the caller.
    const quotedLogPath = logPath.replaceAll("'", `'\\''`);
    writeExecutable(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\n' "\${0##*/} $*" >> '${quotedLogPath}'\nexit 1\n`,
    );
  }
  return { bin, logPath };
}

function writeExecutable(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

export interface HostileAmbient {
  /** Recorded trap invocations so far (`<name> <args>` lines). */
  readonly trapLog: () => readonly string[];
  /** Restore the runner's ambient PATH and varied values exactly. */
  readonly restore: () => void;
}

export interface HostileAmbientOptions {
  /** The trap bin to prepend to the runner's ambient PATH. */
  readonly trapBin: string;
  /** The trap log {@link createHostTrapBin} returned, read by {@link HostileAmbient.trapLog}. */
  readonly logPath: string;
  /**
   * Unrelated ambient environment values a hostile machine may carry. Applied
   * to the runner's environment for the hostile window and restored exactly,
   * including keys that were absent before. `PATH` is owned by this window
   * (the trap prefix); supplying it here is rejected so the hostile PATH can
   * never be snapshotted as a "varied value" and restored wrongly.
   */
  readonly values?: Readonly<Record<string, string>>;
}

/**
 * Make the runner's ambient environment hostile for one bounded window: trap
 * executables first on PATH and unrelated varied values set. The window owns
 * its restoration; nothing leaks past `restore()`.
 */
export function hostileAmbient(options: HostileAmbientOptions): HostileAmbient {
  const savedValues: [string, string | undefined][] = [];
  for (const [key, value] of Object.entries(options.values ?? {})) {
    if (key === "PATH") {
      throw new Error(
        "hostileAmbient owns the runner's PATH for the trap window; supply only unrelated varied values",
      );
    }
    savedValues.push([key, process.env[key]]);
    process.env[key] = value;
  }
  const savedPath = process.env.PATH;
  process.env.PATH = savedPath === undefined ? options.trapBin : `${options.trapBin}:${savedPath}`;
  return {
    trapLog: () => {
      try {
        return readFileSync(options.logPath, "utf8").split("\n").filter((line) => line !== "");
      } catch {
        return [];
      }
    },
    restore: () => {
      for (const [key, value] of savedValues) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    },
  };
}