import { describe, expect, test } from "bun:test";
import { Writable } from "node:stream";

import {
  pageGuidanceDocument,
  parsePagerCommand,
  shouldPageGuidance,
  type InteractiveExecution,
  type PagerExecutionResult,
} from "../cli/pager.js";
import { diagnosticDocument } from "../cli/diagnostics.js";

/** A writable that records everything written to it. */
class OutputCapture extends Writable {
  readonly chunks: string[] = [];
  override _write(
    chunk: Buffer | string,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    callback();
  }
  get text(): string {
    return this.chunks.join("");
  }
}

describe("PAGER normalization (#448, DEC-029)", () => {
  test("unset or empty PAGER falls back to the default pager", () => {
    expect(parsePagerCommand({})).toEqual({
      kind: "configured",
      executable: "less",
      args: [],
    });
    expect(parsePagerCommand({ PAGER: "" })).toEqual({
      kind: "configured",
      executable: "less",
      args: [],
    });
    expect(parsePagerCommand({ PAGER: "   " })).toEqual({
      kind: "configured",
      executable: "less",
      args: [],
    });
  });

  test("a plain configured command splits on whitespace into argv", () => {
    expect(parsePagerCommand({ PAGER: "less -FRX" })).toEqual({
      kind: "configured",
      executable: "less",
      args: ["-FRX"],
    });
    expect(parsePagerCommand({ PAGER: "pager -X -e" })).toEqual({
      kind: "configured",
      executable: "pager",
      args: ["-X", "-e"],
    });
  });

  test("quoted tokens keep spaces as one argv element", () => {
    expect(parsePagerCommand({ PAGER: '"/Applications/My Pager.app/pg" -X' })).toEqual({
      kind: "configured",
      executable: "/Applications/My Pager.app/pg",
      args: ["-X"],
    });
    expect(parsePagerCommand({ PAGER: "less -Ps'my title'" })).toEqual({
      kind: "configured",
      executable: "less",
      args: ["-Psmy title"],
    });
    expect(parsePagerCommand({ PAGER: '"pg two" "arg three"' })).toEqual({
      kind: "configured",
      executable: "pg two",
      args: ["arg three"],
    });
  });

  test("backslash escapes the next character in argv syntax", () => {
    expect(parsePagerCommand({ PAGER: "/opt/weird\\ pager -X" })).toEqual({
      kind: "configured",
      executable: "/opt/weird pager",
      args: ["-X"],
    });
    expect(parsePagerCommand({ PAGER: 'less -P"it\'s"' })).toEqual({
      kind: "configured",
      executable: "less",
      args: ["-Pit's"],
    });
    expect(parsePagerCommand({ PAGER: 'less -P"a \\"quoted\\" word"' })).toEqual({
      kind: "configured",
      executable: "less",
      args: ['-Pa "quoted" word'],
    });
  });

  test("argv syntax only: shell metacharacters stay literal characters", () => {
    // No variable, command, or operator interpretation is performed; the
    // tokenizer treats these as ordinary argument characters.
    expect(parsePagerCommand({ PAGER: "less -P'$HOME;`id`|x'" })).toEqual({
      kind: "configured",
      executable: "less",
      args: ["-P$HOME;`id`|x"],
    });
    expect(parsePagerCommand({ PAGER: "echo hi > /tmp/owned" })).toEqual({
      kind: "configured",
      executable: "echo",
      args: ["hi", ">", "/tmp/owned"],
    });
  });

  test("malformed quoting is a typed failure, never silently split", () => {
    expect(parsePagerCommand({ PAGER: "less -P'unterminated" })).toEqual({
      kind: "malformed",
      value: "less -P'unterminated",
    });
    expect(parsePagerCommand({ PAGER: "pg \\" })).toEqual({
      kind: "malformed",
      value: "pg \\",
    });
    expect(parsePagerCommand({ PAGER: 'pg "mixed\'' })).toEqual({
      kind: "malformed",
      value: 'pg "mixed\'',
    });
  });
});

describe("paging decision (#448, US-050)", () => {
  const baseContext = {
    color: false,
    interactive: true,
    width: 80,
    rows: 24,
  };
  const shortText = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const longText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";

  test("interactive output longer than one screen pages", () => {
    expect(shouldPageGuidance(baseContext, longText)).toBe(true);
  });

  test("output that fits one screen never pages", () => {
    expect(shouldPageGuidance(baseContext, shortText)).toBe(false);
    // Exactly filling the screen is not long.
    const exactText = Array.from({ length: 24 }, (_, i) => `line ${i}`).join("\n") + "\n";
    expect(shouldPageGuidance(baseContext, exactText)).toBe(false);
  });

  test("redirected output never pages regardless of length", () => {
    expect(shouldPageGuidance({ ...baseContext, interactive: false }, longText)).toBe(false);
  });

  test("unknown terminal height never pages", () => {
    expect(shouldPageGuidance({ ...baseContext, rows: undefined }, longText)).toBe(false);
  });
});

describe("pager execution (#448, US-050, ADR-0027)", () => {
  const renderedText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const longContext = { color: false, interactive: true, width: 80, rows: 24 };

  function executorReturning(result: PagerExecutionResult): {
    calls: { stdin: string; environment: NodeJS.ProcessEnv | undefined }[];
    execute: InteractiveExecution;
  } {
    const calls: { stdin: string; environment: NodeJS.ProcessEnv | undefined }[] = [];
    const execute: InteractiveExecution = async (options) => {
      calls.push({ stdin: options.stdin, environment: options.environment });
      return result;
    };
    return { calls, execute };
  }

  async function page(options: {
    execute: InteractiveExecution;
  }): Promise<{ out: OutputCapture; err: OutputCapture; exitCode: number }> {
    const out = new OutputCapture();
    const err = new OutputCapture();
    const exitCode = await pageGuidanceDocument({
      text: renderedText,
      stream: out,
      writeAdvisory: (document) => {
        // The advisory is a presentation document; the caller renders it to
        // its own stream. For these tests a fixed marker suffices.
        err.write(`advisory:${document.length}`);
      },
      execute: options.execute,
      pager: { kind: "configured", executable: "fake-pager", args: ["-X"] },
      shouldPage: true,
    });
    return { out, err, exitCode };
  }

  test("the rendered guidance is delivered to the pager on stdin, not argv", async () => {
    const { calls, execute } = executorReturning({
      kind: "exit",
      exitCode: 0,
      signal: null,
      error: null,
      cleanupFailed: false,
      durationMs: 1,
      commandLabel: "fake pager",
    });
    const { out, exitCode } = await page({ execute });
    expect(exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stdin).toBe(renderedText);
    expect(out.text).toBe("");
  });

  test("an ordinary user quit (exit 0) writes nothing extra and exits cleanly", async () => {
    const { execute } = executorReturning({
      kind: "exit",
      exitCode: 0,
      signal: null,
      error: null,
      cleanupFailed: false,
      durationMs: 1,
      commandLabel: "fake pager",
    });
    const { out, err, exitCode } = await page({ execute });
    expect(exitCode).toBe(0);
    expect(out.text).toBe("");
    expect(err.text).toBe("");
  });

  test("a pager failing before display falls back to unchanged output plus an advisory", async () => {
    for (const failure of [
      {
        kind: "spawn-error" as const,
        exitCode: null,
        signal: null,
        error: new Error("spawn fake-pager ENOENT"),
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "fake pager",
      },
      {
        kind: "exit" as const,
        exitCode: 7,
        signal: null,
        error: null,
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "fake pager",
      },
      {
        kind: "signal" as const,
        exitCode: null,
        signal: "SIGSEGV",
        error: null,
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "fake pager",
      },
      {
        kind: "stdin-error" as const,
        exitCode: null,
        signal: null,
        error: new Error("EIO writing guidance"),
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "fake pager",
      },
    ]) {
      const { execute } = executorReturning(failure);
      const { out, err, exitCode } = await page({ execute });
      expect(out.text).toBe(renderedText);
      expect(err.text).toMatch(/^advisory:\d+$/);
      expect(exitCode).toBe(0);
    }
  });

  test("cleanup failure evidence reaches the advisory and the exit code stays advisory", async () => {
    const { execute } = executorReturning({
      kind: "exit",
      exitCode: 7,
      signal: null,
      error: null,
      cleanupFailed: true,
      durationMs: 1,
      commandLabel: "fake pager",
    });
    const { out, err, exitCode } = await page({ execute });
    expect(out.text).toBe(renderedText);
    expect(err.text).toMatch(/^advisory:\d+$/);
    expect(exitCode).toBe(0);
  });

  test("cancellation is distinct: no reprint, exit code 128+signal", async () => {
    const { execute } = executorReturning({
      kind: "cancelled",
      exitCode: null,
      signal: "SIGTERM",
      error: null,
      cleanupFailed: false,
      durationMs: 1,
      commandLabel: "fake pager",
    });
    const { out, err, exitCode } = await page({ execute });
    expect(out.text).toBe("");
    expect(err.text).toBe("");
    expect(exitCode).toBe(130);
  });

  test("cancellation with unconfirmed cleanup preserves the evidence in an advisory", async () => {
    const { execute } = executorReturning({
      kind: "cancelled",
      exitCode: null,
      signal: null,
      error: null,
      cleanupFailed: true,
      durationMs: 1,
      commandLabel: "fake pager",
    });
    const { out, err, exitCode } = await page({ execute });
    expect(out.text).toBe("");
    expect(err.text).toMatch(/^advisory:\d+$/);
    expect(exitCode).toBe(130);
  });
});

describe("guidance writing (#448, US-050)", () => {
  const shortText = "short guidance\n";
  const longText = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const longContext = { color: false, interactive: true, width: 80, rows: 24 };
  const redirectContext = { color: false, interactive: false, width: 80, rows: undefined };

  function executorRecording(): {
    calls: { stdin: string }[];
    execute: InteractiveExecution;
  } {
    const calls: { stdin: string }[] = [];
    const execute: InteractiveExecution = async (options) => {
      calls.push({ stdin: options.stdin });
      return {
        kind: "exit",
        exitCode: 0,
        signal: null,
        error: null,
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "fake pager",
      };
    };
    return { calls, execute };
  }

  async function guidanceWriter(options: {
    context: typeof longContext | typeof redirectContext;
    execute: InteractiveExecution;
  }) {
    const out = new OutputCapture();
    const err = new OutputCapture();
    const exitCode = await pageGuidanceDocument({
      text: longText,
      stream: out,
      writeAdvisory: (document) => err.write(`advisory:${document.length}`),
      execute: options.execute,
      pager: { kind: "configured", executable: "fake-pager", args: [] },
      shouldPage: shouldPageGuidance(options.context, longText),
    });
    return { out, err, exitCode };
  }

  test("redirected guidance is byte-identical and never invokes the pager", async () => {
    const { calls, execute } = executorRecording();
    const { out, err, exitCode } = await guidanceWriter({ context: redirectContext, execute });
    expect(calls).toHaveLength(0);
    expect(out.text).toBe(longText);
    expect(err.text).toBe("");
    expect(exitCode).toBe(0);
  });

  test("short interactive guidance is written directly without the pager", async () => {
    const { calls, execute } = executorRecording();
    const out = new OutputCapture();
    const exitCode = await pageGuidanceDocument({
      text: shortText,
      stream: out,
      writeAdvisory: () => {},
      execute,
      pager: { kind: "configured", executable: "fake-pager", args: [] },
      shouldPage: shouldPageGuidance(longContext, shortText),
    });
    expect(calls).toHaveLength(0);
    expect(out.text).toBe(shortText);
    expect(exitCode).toBe(0);
  });

  test("long interactive guidance pages instead of printing", async () => {
    const { calls, execute } = executorRecording();
    const { out, exitCode } = await guidanceWriter({ context: longContext, execute });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.stdin).toBe(longText);
    expect(out.text).toBe("");
    expect(exitCode).toBe(0);
  });

  test("a malformed configured pager is an advisory with unchanged fallback output", async () => {
    const { calls, execute } = executorRecording();
    const out = new OutputCapture();
    const err = new OutputCapture();
    const exitCode = await pageGuidanceDocument({
      text: longText,
      stream: out,
      writeAdvisory: (document) => err.write(`advisory:${document.length}`),
      execute,
      pager: { kind: "malformed", value: "less -P'unterminated" },
      shouldPage: shouldPageGuidance(longContext, longText),
    });
    expect(calls).toHaveLength(0);
    expect(out.text).toBe(longText);
    expect(err.text).toMatch(/^advisory:\d+$/);
    expect(exitCode).toBe(0);
  });

  test("the failure advisory is a structured diagnostic document", () => {
    const document = diagnosticDocument({
      happened: ["guidance could not be opened in the configured pager 'less -FRX'"],
      why: [["the pager exited with code 7 before displaying the guidance"]],
      whatToType: [["Set PAGER to an available pager, or redirect the output to a file."]],
      severity: "attention",
    });
    expect(document.length).toBeGreaterThan(0);
    expect(JSON.stringify(document)).toContain("attention");
  });
});
describe("pager child environment (#448, CRAFT-1)", () => {
  const longContext = { color: false, interactive: true, width: 80, rows: 24 };

  function executorRecordingEnvironment(): {
    calls: { environment: NodeJS.ProcessEnv | undefined }[];
    execute: InteractiveExecution;
  } {
    const calls: { environment: NodeJS.ProcessEnv | undefined }[] = [];
    const execute: InteractiveExecution = async (options) => {
      calls.push({ environment: options.environment });
      return {
        kind: "exit",
        exitCode: 0,
        signal: null,
        error: null,
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "fake pager",
      };
    };
    return { calls, execute };
  }

  test("an unset LESS defaults to FRX so default less renders ANSI guidance readably", async () => {
    const { calls, execute } = executorRecordingEnvironment();
    await pageGuidanceDocument({
      text: "colored guidance\n",
      stream: new OutputCapture(),
      writeAdvisory: () => {},
      execute,
      pager: { kind: "configured", executable: "less", args: [] },
      shouldPage: true,
      environment: { PATH: "/bin" },
    });
    expect(calls[0]!.environment?.LESS).toBe("FRX");
    // User environment variables other than LESS pass through untouched.
    expect(calls[0]!.environment?.PATH).toBe("/bin");
  });

  test("an existing LESS setting is preserved, never overridden", async () => {
    const { calls, execute } = executorRecordingEnvironment();
    await pageGuidanceDocument({
      text: "colored guidance\n",
      stream: new OutputCapture(),
      writeAdvisory: () => {},
      execute,
      pager: { kind: "configured", executable: "less", args: [] },
      shouldPage: true,
      environment: { LESS: "M" },
    });
    expect(calls[0]!.environment?.LESS).toBe("M");
  });

  test("an explicitly empty LESS is preserved (PROD-1): it may mean no defaults", async () => {
    const { calls, execute } = executorRecordingEnvironment();
    await pageGuidanceDocument({
      text: "colored guidance\n",
      stream: new OutputCapture(),
      writeAdvisory: () => {},
      execute,
      pager: { kind: "configured", executable: "less", args: [] },
      shouldPage: true,
      environment: { LESS: "" },
    });
    expect(calls[0]!.environment?.LESS).toBe("");
  });
});

describe("PR #476 review cycle 1", () => {
  test("INT-1: double-quoted backslash before an ordinary character stays literal", () => {
    // PAGER value carries two backslashes; POSIX double-quote rules reduce
    // "\\" to one literal backslash, and `.agents` follows untouched.
    expect(parsePagerCommand({ PAGER: 'less -p "\\\\.agents"' })).toEqual({
      kind: "configured",
      executable: "less",
      args: ["-p", "\\.agents"],
    });
    // Backslash before n inside double quotes is literal backslash-n.
    expect(parsePagerCommand({ PAGER: 'pg "-D\\n"' })).toEqual({
      kind: "configured",
      executable: "pg",
      args: ["-D\\n"],
    });
    // Backslash-dollar stays escaped (dollar never expands either way).
    expect(parsePagerCommand({ PAGER: 'pg "a\\$b"' })).toEqual({
      kind: "configured",
      executable: "pg",
      args: ["a$b"],
    });
  });

  test("INT-2: real signal propagation — single abort, exit mapping, unregister", async () => {
    const out = new OutputCapture();
    const err = new OutputCapture();
    let registered: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
    let unregisterCalls = 0;
    let abortEvents = 0;
    const execute: InteractiveExecution = async (options, signal) => {
      signal?.addEventListener("abort", () => {
        abortEvents += 1;
      });
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        kind: "cancelled",
        exitCode: null,
        signal: null,
        error: null,
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "signal fixture",
      };
    };
    const pending = pageGuidanceDocument({
      text: "long guidance\n",
      stream: out,
      writeAdvisory: (document) => err.write(`advisory:${document.length}`),
      execute,
      pager: { kind: "configured", executable: "fake-pager", args: [] },
      shouldPage: true,
      registerSignals: (onSignal) => {
        registered = onSignal;
        return () => {
          unregisterCalls += 1;
        };
      },
    });
    registered!("SIGINT");
    registered!("SIGINT");
    registered!("SIGTERM");
    const exitCode = await pending;
    // Repeated signals are no-ops: the executor observed exactly one abort.
    expect(abortEvents).toBe(1);
    // The first delivered signal owns the exit mapping (SIGINT → 130).
    expect(exitCode).toBe(130);
    // No reprint on cancellation; handlers unregistered exactly once.
    expect(out.text).toBe("");
    expect(err.text).toBe("");
    expect(unregisterCalls).toBe(1);
  });

  test("INT-2: SIGTERM as the first delivered signal maps to 143", async () => {
    const out = new OutputCapture();
    let registered: ((signal: "SIGINT" | "SIGTERM") => void) | undefined;
    let unregisterCalls = 0;
    const execute: InteractiveExecution = async (options, signal) => {
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        kind: "cancelled",
        exitCode: null,
        signal: null,
        error: null,
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "signal fixture",
      };
    };
    const pending = pageGuidanceDocument({
      text: "long guidance\n",
      stream: out,
      writeAdvisory: () => {},
      execute,
      pager: { kind: "configured", executable: "fake-pager", args: [] },
      shouldPage: true,
      registerSignals: (onSignal) => {
        registered = onSignal;
        return () => {
          unregisterCalls += 1;
        };
      },
    });
    registered!("SIGTERM");
    expect(await pending).toBe(143);
    expect(out.text).toBe("");
    expect(unregisterCalls).toBe(1);
  });

  test("PROD-1: an explicitly empty LESS is preserved as operator authority", async () => {
    const calls: { environment: NodeJS.ProcessEnv | undefined }[] = [];
    const execute: InteractiveExecution = async (options) => {
      calls.push({ environment: options.environment });
      return {
        kind: "exit",
        exitCode: 0,
        signal: null,
        error: null,
        cleanupFailed: false,
        durationMs: 1,
        commandLabel: "fake pager",
      };
    };
    await pageGuidanceDocument({
      text: "long guidance\n",
      stream: new OutputCapture(),
      writeAdvisory: () => {},
      execute,
      pager: { kind: "configured", executable: "less", args: [] },
      shouldPage: true,
      environment: { LESS: "" },
    });
    expect(calls[0]!.environment?.LESS).toBe("");
  });
});
