/**
 * The `apkit details` command (US-012, DEC-007, DEC-008): read the retained
 * machine-local lifecycle history — the latest run, a compact list, one run by
 * identity, or the structured JSON — without rerunning any lifecycle planning
 * or write. Long human detail pages on an interactive terminal through the one
 * shared pager; redirected output never pages.
 */
import type { Writable } from "node:stream";

import { COMMAND_NAME } from "../installer/version.js";
import {
  operationHistoryPath,
  OperationHistoryUnavailableError,
  readOperationHistory,
  type OperationHistoryEntry,
  type OperationHistoryFileSystem,
} from "../installer/operation-history.js";
import { COMMANDS } from "./command-help.js";
import { errorDiagnosticDocument, formatError } from "./error-wording.js";
import {
  formatDetailsJson,
  operationHistoryEmptyDocument,
  operationHistoryEntryDocument,
  operationHistoryListDocument,
  operationHistoryMissingIdDocument,
  operationHistoryUnavailableDocument,
} from "./operation-history-presentation.js";
import {
  pageGuidanceDocument,
  shouldPageGuidance,
  type InteractiveExecution,
} from "./pager.js";
import {
  renderPresentationDocument,
  writeHumanDocument,
  type PresentationDocument,
} from "./presentation-document.js";
import {
  terminalPresentationContext,
  type TerminalStream,
} from "./terminal-presentation.js";

export interface DetailsCommandRequest {
  readonly home: string;
  /** The arguments after the command token. */
  readonly arguments: readonly string[];
  readonly stdout: Writable & TerminalStream;
  readonly stderr: Writable & TerminalStream;
  /** Test seam over the shared pager executor (long interactive detail). */
  readonly pagerExecution?: InteractiveExecution;
  readonly pagerEnvironment?: NodeJS.ProcessEnv;
  /** Test seam over the history document's filesystem operations. */
  readonly fileSystem?: Partial<OperationHistoryFileSystem>;
}

export interface DetailsCommandOutcome {
  readonly exitCode: number;
}

type DetailsSelection =
  | { readonly kind: "latest" }
  | { readonly kind: "list" }
  | { readonly kind: "id"; readonly id: string };

interface ParsedDetailsArguments {
  readonly json: boolean;
  readonly selection: DetailsSelection;
}

/** `details`, `details --list`, `details <operation-id>`, each with `--json`. */
function parseDetailsArguments(arguments_: readonly string[]): ParsedDetailsArguments {
  let json = false;
  let list = false;
  let id: string | undefined;
  for (const argument of arguments_) {
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--list") {
      if (list) throw new Error("details accepts at most one --list");
      list = true;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new Error(`details does not accept argument '${argument}'`);
    }
    if (id !== undefined) {
      throw new Error(`details accepts at most one operation identity, not '${argument}'`);
    }
    id = argument;
  }
  if (list && id !== undefined) {
    throw new Error("details --list cannot be combined with an operation identity");
  }
  return {
    json,
    selection: list ? { kind: "list" } : id === undefined ? { kind: "latest" } : { kind: "id", id },
  };
}

/** The one canonical details usage line, read from the command-help table. */
const detailsUsage = COMMANDS.find((command) => command.name === "details")!.syntax;

/** The best-effort selection named by rejected arguments, for the error payload. */
function requestedSelection(arguments_: readonly string[]): DetailsSelection {
  if (arguments_.includes("--list")) return { kind: "list" };
  const positional = arguments_.find((argument) => !argument.startsWith("-"));
  return positional === undefined ? { kind: "latest" } : { kind: "id", id: positional };
}

function detailsArgumentDiagnostic(error: unknown): PresentationDocument {
  return errorDiagnosticDocument(error, { usage: detailsUsage });
}

/**
 * Render one detail document, paging it on an interactive terminal whose
 * height is known when it exceeds one screen (US-012). Returns the exit code
 * the caller applies; a pager interruption keeps its 128+signal convention.
 */
async function writeDetailsDocument(
  request: DetailsCommandRequest,
  document: PresentationDocument,
): Promise<number> {
  const stdoutContext = terminalPresentationContext(request.stdout);
  const stderrContext = terminalPresentationContext(request.stderr);
  const rendered = renderPresentationDocument(document, stdoutContext);
  const text = rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  return pageGuidanceDocument({
    text,
    stream: request.stdout,
    writeAdvisory: (advisory) => {
      writeHumanDocument(request.stderr, advisory, stderrContext);
    },
    shouldPage: shouldPageGuidance(stdoutContext, text),
    ...(request.pagerExecution === undefined ? {} : { execute: request.pagerExecution }),
    ...(request.pagerEnvironment === undefined ? {} : { environment: request.pagerEnvironment }),
  });
}

function toolErrorJson(
  selection: DetailsSelection,
  historyPath: string,
  error: unknown,
): string {
  return formatDetailsJson({
    selection: selection.kind,
    entries: [],
    historyPath,
    error: formatError(error),
  });
}

export async function runDetailsCommand(
  request: DetailsCommandRequest,
): Promise<DetailsCommandOutcome> {
  const stderrContext = terminalPresentationContext(request.stderr);
  const historyPath = operationHistoryPath(request.home);

  let parsed: ParsedDetailsArguments;
  try {
    parsed = parseDetailsArguments(request.arguments);
  } catch (error) {
    if (request.arguments.includes("--json")) {
      request.stdout.write(toolErrorJson(requestedSelection(request.arguments), historyPath, error));
    } else {
      writeHumanDocument(request.stderr, detailsArgumentDiagnostic(error), stderrContext);
    }
    return { exitCode: 1 };
  }

  let entries: readonly OperationHistoryEntry[];
  try {
    entries = (await readOperationHistory(request.home, {
      ...(request.fileSystem === undefined ? {} : { fileSystem: request.fileSystem }),
    })).entries;
  } catch (error) {
    const detail = error instanceof OperationHistoryUnavailableError
      ? error.detail
      : error instanceof Error ? error.message : String(error);
    if (parsed.json) {
      request.stdout.write(toolErrorJson(parsed.selection, historyPath, detail));
    } else {
      writeHumanDocument(
        request.stderr,
        operationHistoryUnavailableDocument(detail, historyPath),
        stderrContext,
      );
    }
    return { exitCode: 1 };
  }

  if (parsed.selection.kind === "list") {
    if (parsed.json) {
      request.stdout.write(formatDetailsJson({
        selection: "list",
        entries,
        historyPath,
      }));
      return { exitCode: 0 };
    }
    if (entries.length === 0) {
      return {
        exitCode: await writeDetailsDocument(request, operationHistoryEmptyDocument(historyPath)),
      };
    }
    return { exitCode: await writeDetailsDocument(request, operationHistoryListDocument(entries)) };
  }

  const selection = parsed.selection;
  const selected = selection.kind === "latest"
    ? entries[0]
    : selection.kind === "id"
      ? entries.find((entry) => entry.id === selection.id)
      : undefined;

  if (selected === undefined) {
    if (selection.kind === "id") {
      if (parsed.json) {
        request.stdout.write(toolErrorJson(
          selection,
          historyPath,
          `no recorded operation has the identity '${selection.id}'`,
        ));
      } else {
        writeHumanDocument(
          request.stderr,
          operationHistoryMissingIdDocument(selection.id, historyPath),
          stderrContext,
        );
      }
      return { exitCode: 1 };
    }
    if (parsed.json) {
      request.stdout.write(formatDetailsJson({
        selection: "latest",
        entries: [],
        historyPath,
      }));
      return { exitCode: 0 };
    }
    return {
      exitCode: await writeDetailsDocument(request, operationHistoryEmptyDocument(historyPath)),
    };
  }

  if (parsed.json) {
    request.stdout.write(formatDetailsJson({
      selection: selection.kind,
      entries: [selected],
      historyPath,
    }));
    return { exitCode: 0 };
  }
  return { exitCode: await writeDetailsDocument(request, operationHistoryEntryDocument(selected)) };
}
