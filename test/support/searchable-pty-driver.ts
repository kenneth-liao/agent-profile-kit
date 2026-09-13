/**
 * Real-PTY driver for searchable-prompt qualification (ticket #495,
 * TEST-003). Spawned under `test/support/pty-controller.py`, which allocates
 * a genuine pseudo-terminal via `pty.fork()` — raw-mode keypresses, terminal
 * width, and redraws — rather than injected streams. Prints one `RESULT …`
 * line for the parent to match on.
 *
 * Modes:
 * - `select`: searchable single choice over three Profiles.
 * - `multi`: searchable multi choice over three Hosts (none pre-selected).
 * - `install <home> <cwd>`: bare guided `install` in the given Project.
 * - `uninstall <home>`: bare interactive `uninstall` over bound Projects.
 * - `configure <home> <profile>`: interactive `configure profile` for the
 *   named Profile (ticket #500).
 * - `gated-select <releaseFile> <pidFile>`: the real `prompts` dependency
 *   bound directly with the REAL exported product filter
 *   (`searchableSuggest`), whose resolution is gated until the fixture-owned
 *   release file (outside the PTY) appears. This is a fixture boundary, not
 *   wrapper injection: `createSearchableSelectPrompt` is never given a
 *   fixture suggest — the converted PTY tests cover the unchanged product
 *   wrapper; this mode only makes the async-filter timing condition
 *   controllable for the causal discrimination proof (#542). Writes its pid
 *   to `pidFile` for owned-process cleanup evidence.
 */
import { basename, dirname } from "node:path";
import { existsSync, watch, writeFileSync } from "node:fs";

import { runConfigureCommand } from "../../cli/configure-command.js";
import { runInstallCommand } from "../../cli/install-command.js";
import { runUninstallCommand } from "../../cli/uninstall-command.js";
import {
  createSearchableMultiSelectPrompt,
  createSearchableSelectPrompt,
  searchableSuggest,
} from "../../cli/prompts.js";

const mode = process.argv[2];

if (mode === "select") {
  const select = createSearchableSelectPrompt({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await select("Which Profile?", [
    { title: "coding", value: "coding" },
    { title: "ops", value: "ops" },
    { title: "writing", value: "writing" },
  ]);
  process.stdout.write(`\nRESULT ${JSON.stringify(answer)}\n`);
} else if (mode === "multi") {
  const multi = createSearchableMultiSelectPrompt({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await multi(
    "Which Agent Hosts?",
    [
      { title: "claude", value: "claude" },
      { title: "codex", value: "codex" },
      { title: "pi", value: "pi" },
    ],
    { min: 1 },
  );
  process.stdout.write(`\nRESULT ${JSON.stringify(answer)}\n`);
} else if (mode === "install") {
  const home = process.argv[3] ?? "";
  const cwd = process.argv[4] ?? process.cwd();
  const outcome = await runInstallCommand({
    home,
    arguments: [],
    stdout: process.stdout,
    stderr: process.stderr,
    input: process.stdin,
    cwd,
  });
  process.stdout.write(`\nRESULT exitCode=${outcome.exitCode}\n`);
  process.exit(outcome.exitCode);
} else if (mode === "uninstall") {
  const home = process.argv[3] ?? "";
  const outcome = await runUninstallCommand({
    home,
    arguments: [],
    stdout: process.stdout,
    stderr: process.stderr,
    input: process.stdin,
  });
  process.stdout.write(`\nRESULT exitCode=${outcome.exitCode}\n`);
  process.exit(outcome.exitCode);
} else if (mode === "configure") {
  const home = process.argv[3] ?? "";
  const profile = process.argv[4] ?? "";
  const outcome = await runConfigureCommand({
    home,
    arguments: ["profile", profile],
    stdout: process.stdout,
    stderr: process.stderr,
    input: process.stdin,
  });
  process.stdout.write(`\nRESULT exitCode=${outcome.exitCode}\n`);
  process.exit(outcome.exitCode);
} else if (mode === "gated-select") {
  const releaseFile = process.argv[3] ?? "";
  const pidFile = process.argv[4] ?? "";
  writeFileSync(pidFile, `${process.pid}\n`);
  const promptsPackage = (await import("prompts")).default;
  const choices = [
    { title: "coding", value: "coding" },
    { title: "ops", value: "ops" },
    { title: "writing", value: "writing" },
  ];
  // Gate the REAL product filter's delivery until the release file exists.
  // Watch latency only affects when the gate opens, never the ordering the
  // proof relies on (the test observes the resolved render before Enter).
  let gateOpen = false;
  const pendingDeliveries: (() => void)[] = [];
  const openGate = (): void => {
    if (gateOpen) return;
    gateOpen = true;
    clearInterval(backstop);
    watcher.close();
    for (const deliver of pendingDeliveries.splice(0)) deliver();
  };
  if (existsSync(releaseFile)) openGate();
  // fs.watch does not contractually guarantee per-event delivery; the interval
  // backstop keeps the gate causal (creation is always observed) without any
  // timing assumption in the proof.
  const backstop = setInterval(() => {
    if (existsSync(releaseFile)) openGate();
  }, 250);
  const watcher = watch(dirname(releaseFile), (_event, filename) => {
    if ((filename === null || filename === basename(releaseFile)) && existsSync(releaseFile)) {
      openGate();
    }
  });
  const gatedSuggest = (
    input: string,
    suggestChoices: readonly { readonly title: string; readonly value?: unknown }[],
  ): Promise<readonly { readonly title: string; readonly value?: unknown }[]> => {
    // The initial empty-input resolution passes through (as the real
    // dependency resolves it immediately), so the prompt holds the stale
    // full list while a typed filter is gated — exactly the real condition.
    if (input.trim() === "") return searchableSuggest(input, suggestChoices);
    return new Promise((resolveGate) => {
      const deliver = (): void => {
        searchableSuggest(input, suggestChoices).then(resolveGate);
      };
      if (gateOpen) deliver();
      else pendingDeliveries.push(deliver);
    });
  };
  const answer = (await promptsPackage({
    type: "autocomplete",
    name: "answer",
    message: "Which Profile?",
    choices,
    suggest: gatedSuggest,
    hint: "Type to filter, \u2191/\u2193 navigate, enter selects.",
    stdin: process.stdin,
    stdout: process.stdout,
  })) as { readonly answer?: unknown } | undefined;
  clearInterval(backstop);
  process.stdout.write(`\nRESULT ${JSON.stringify(answer?.answer)}\n`);
} else {
  process.stderr.write(`unknown PTY driver mode '${mode ?? ""}'\n`);
  process.exit(2);
}
