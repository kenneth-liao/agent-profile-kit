import type { WriteStream } from "node:tty";
import type { Writable } from "node:stream";

import {
  runInteractiveProcess as defaultRunInteractive,
  type InteractiveExecutorOptions,
  type InteractiveProcessResult,
} from "../process/process-executor.js";
import { diagnosticDocument } from "./diagnostics.js";
import type { InlineContent } from "./inline-content.js";
import type { TerminalPresentationContext } from "./terminal-presentation.js";
import type { PresentationDocument } from "./presentation-document.js";

/**
 * One PAGER normalization boundary (DEC-029). The configured value is argv
 * syntax only — whitespace-separated arguments with POSIX quoting (single
 * quotes are literal, double quotes honor backslash escapes, backslash escapes
 * the next character). No shell interpretation of any kind is performed: no
 * variable or command substitution, no operators. Rendered guidance reaches
 * the pager through its stdin pipe, never through argv or a shell string.
 * Malformed quoting is a typed failure, never silently split.
 */
export type PagerCommand =
  | { readonly kind: "configured"; readonly executable: string; readonly args: readonly string[] }
  | { readonly kind: "malformed"; readonly value: string };

/** The fallback pager used when PAGER is unset, empty, or whitespace. */
export const DEFAULT_PAGER_EXECUTABLE = "less";

export function parsePagerCommand(environment: NodeJS.ProcessEnv): PagerCommand {
  const configured = environment.PAGER?.trim();
  if (configured === undefined || configured === "") {
    return { kind: "configured", executable: DEFAULT_PAGER_EXECUTABLE, args: [] };
  }
  return parsePagerArgv(configured);
}

function parsePagerArgv(value: string): PagerCommand {
  const args: string[] = [];
  let current = "";
  let hasToken = false;
  let index = 0;
  const endToken = () => {
    if (hasToken) args.push(current);
    current = "";
    hasToken = false;
  };
  while (index < value.length) {
    const character = value[index]!;
    if (character === "'") {
      hasToken = true;
      const close = value.indexOf("'", index + 1);
      if (close === -1) return { kind: "malformed", value };
      current += value.slice(index + 1, close);
      index = close + 1;
    } else if (character === '"') {
      hasToken = true;
      index += 1;
      let closed = false;
      while (index < value.length) {
        const inner = value[index]!;
        if (inner === "\\") {
          const next = value[index + 1];
          if (next === undefined) return { kind: "malformed", value };
          // POSIX double-quote contract: backslash is special only before
          // $, `, ", \, and newline; before any other character it is a
          // literal backslash. No expansion is performed either way.
          if (next === "$" || next === "`" || next === '"' || next === "\\") {
            current += next;
            index += 2;
          } else if (next === "\n") {
            // Backslash-newline inside double quotes is elided.
            index += 2;
          } else {
            current += "\\";
            index += 1;
          }
        } else if (inner === '"') {
          closed = true;
          index += 1;
          break;
        } else {
          current += inner;
          index += 1;
        }
      }
      if (!closed) return { kind: "malformed", value };
    } else if (character === "\\") {
      if (index + 1 >= value.length) return { kind: "malformed", value };
      current += value[index + 1]!;
      hasToken = true;
      index += 2;
    } else if (/\s/.test(character)) {
      endToken();
      index += 1;
    } else {
      current += character;
      hasToken = true;
      index += 1;
    }
  }
  endToken();
  if (args.length === 0) return { kind: "malformed", value };
  return { kind: "configured", executable: args[0]!, args: args.slice(1) };
}

/**
 * The long-guidance threshold: page only on an interactive terminal whose
 * height is known, when the rendered guidance exceeds one screen. Redirected
 * output and unknown terminal dimensions never page.
 */
export function shouldPageGuidance(
  context: Pick<TerminalPresentationContext, "interactive" | "rows">,
  text: string,
): boolean {
  if (!context.interactive || context.rows === undefined) return false;
  const lineCount = text.split("\n").length;
  // A trailing newline contributes an empty final element; the writer's
  // terminating newline is not an extra visible line.
  const visibleLines = text.endsWith("\n") ? lineCount - 1 : lineCount;
  return visibleLines > context.rows;
}

export type InteractiveExecution = (
  options: InteractiveExecutorOptions,
  abortSignal?: AbortSignal,
) => Promise<InteractiveProcessResult>;

/** Alias for the executor's typed interactive result. */
export type PagerExecutionResult = InteractiveProcessResult;

/**
 * The signals the paging window listens for. A repeated signal during cleanup
 * is a no-op: the first signal already owns termination of the owned child,
 * and the handler stays installed until the window closes so a second press
 * cannot fall through to the default disposition and orphan the child.
 */
type PagingSignal = "SIGINT" | "SIGTERM";

const SIGNAL_EXIT_CODES: Readonly<Record<PagingSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

export interface PageGuidanceInput {
  /** The rendered guidance text, exactly as it would print redirected. */
  readonly text: string;
  /** The guidance output stream (the interactive terminal stdout). */
  readonly stream: Writable | WriteStream;
  /** Receives one advisory presentation document when a failure is owned. */
  readonly writeAdvisory: (document: PresentationDocument) => void;
  /** Precomputed long-guidance decision (shouldPageGuidance). */
  readonly shouldPage: boolean;
  /**
   * The environment resolving PAGER and inherited by the pager child. When
   * the caller's `LESS` is unset or empty, the child receives `LESS=FRX`
   * (git's pager default: quit-if-one-screen, raw ANSI control characters,
   * no init on clear) so default `less` renders colored guidance readably;
   * an existing `LESS` is never overridden. Defaults to process.env.
   */
  readonly environment?: NodeJS.ProcessEnv;
  /** The resolved pager command; defaults to parsing PAGER from process.env. */
  readonly pager?: PagerCommand;
  /** Test seam over the executor's interactive mode. */
  readonly execute?: InteractiveExecution;
  /** Test seam over the paging-window signal handlers. */
  readonly registerSignals?: (
    onSignal: (signal: PagingSignal) => void,
  ) => () => void;
}

function defaultRegisterSignals(
  onSignal: (signal: PagingSignal) => void,
): () => void {
  const handler = (signal: PagingSignal) => () => onSignal(signal);
  const sigint = handler("SIGINT");
  const sigterm = handler("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);
  return () => {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  };
}

/**
 * Deliver rendered guidance through the configured pager. Ordinary user quit
 * (pager exit 0) succeeds quietly. Cancellation is distinct: the owned child
 * is terminated, nothing is reprinted, and the exit code is 128+signal. Every
 * other outcome — the pager never started, failed on stdin, or exited
 * non-zero — cannot prove the guidance was displayed, so the unchanged text is
 * written and one structured advisory is emitted; the command exit code never
 * changes (advisories stay advisory, DEC-011). Cleanup-failure evidence is
 * carried into the advisory verbatim, never swallowed. Returns the exit code
 * the caller should apply.
 */
export async function pageGuidanceDocument(input: PageGuidanceInput): Promise<number> {
  if (!input.shouldPage) {
    input.stream.write(input.text);
    return 0;
  }
  const environment = input.environment ?? process.env;
  const pager = input.pager ?? parsePagerCommand(environment);
  if (pager.kind === "malformed") {
    input.writeAdvisory(malformedPagerDiagnostic(pager.value));
    input.stream.write(input.text);
    return 0;
  }

  const execute = input.execute ?? defaultRunInteractive;
  const controller = new AbortController();
  let interrupted: PagingSignal | null = null;
  const unregister = (input.registerSignals ?? defaultRegisterSignals)((signal) => {
    // Idempotent: the first signal aborts the executor, whose bounded cleanup
    // owns child termination; repeated signals must not restart or preempt it.
    if (interrupted !== null) return;
    interrupted = signal;
    controller.abort();
  });
  try {
    const result = await execute(
      {
        executable: pager.executable,
        arguments_: [...pager.args],
        stdin: input.text,
        // Explicit LESS authority: any value present — including empty — is
        // preserved; the FRX default applies only when LESS is unset.
        environment: environment.LESS !== undefined
          ? environment
          : { ...environment, LESS: "FRX" },
        commandLabel: `pager ${pager.executable}`,
      },
      controller.signal,
    );
    if (result.kind === "exit" && result.exitCode === 0) return 0;
    if (result.kind === "cancelled") {
      if (result.cleanupFailed) {
        input.writeAdvisory(pagerCleanupAdvisory(pager));
      }
      // 128+signal for the signal that interrupted this command; a pager that
      // ended without a local signal defaults to the SIGINT convention.
      return interrupted === "SIGTERM" ? SIGNAL_EXIT_CODES.SIGTERM : SIGNAL_EXIT_CODES.SIGINT;
    }
    // spawn-error, stdin-error, non-zero exit, or signal: display is not
    // proven, so availability wins — unchanged output plus one advisory.
    input.writeAdvisory(pagerFailureDiagnostic(pager, result));
    input.stream.write(input.text);
    return 0;
  } finally {
    unregister();
  }
}

function pagerDisplay(pager: Extract<PagerCommand, { kind: "configured" }>): string {
  return [pager.executable, ...pager.args].join(" ");
}

const PAGER_RECOVERY: readonly (readonly InlineContent[])[] = [
  ["Set PAGER to an available pager, or redirect the output to a file."],
];

function malformedPagerDiagnostic(value: string): PresentationDocument {
  return diagnosticDocument({
    happened: [`the configured PAGER '${value}' is not a command with arguments`],
    why: [["quotes and backslashes must balance; shell operators are not interpreted"]],
    whatToType: PAGER_RECOVERY,
    severity: "attention",
  });
}

function pagerFailureDiagnostic(
  pager: Extract<PagerCommand, { kind: "configured" }>,
  result: InteractiveProcessResult,
): PresentationDocument {
  const detail =
    result.kind === "spawn-error"
      ? result.error?.message ?? "the pager could not be started"
      : result.kind === "stdin-error"
        ? result.error?.message ?? "the guidance could not be delivered"
        : result.kind === "exit"
          ? `the pager exited with code ${result.exitCode}`
          : `the pager terminated on signal ${result.signal}`;
  return diagnosticDocument({
    happened: [
      `guidance could not be opened in the configured pager '${pagerDisplay(pager)}'`,
    ],
    why: [
      [
        result.cleanupFailed
          ? `${detail}; its process could not be confirmed terminated`
          : detail,
      ],
    ],
    whatToType: PAGER_RECOVERY,
    severity: "attention",
  });
}

function pagerCleanupAdvisory(
  pager: Extract<PagerCommand, { kind: "configured" }>,
): PresentationDocument {
  return diagnosticDocument({
    happened: [
      `the pager '${pagerDisplay(pager)}' did not exit when the command was interrupted`,
    ],
    why: [["its process could not be confirmed terminated"]],
    whatToType: [["Check for a still-running pager process before retrying."]],
    severity: "attention",
  });
}