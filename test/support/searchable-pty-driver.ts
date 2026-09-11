/**
 * Real-PTY driver for searchable-prompt qualification (ticket #495,
 * TEST-003). Spawned under `script(1)` so `process.stdin`/`process.stdout`
 * are a genuine pseudo-terminal — raw-mode keypresses, terminal width, and
 * redraws — rather than injected streams. Prints one `RESULT …` line for the
 * parent to match on.
 *
 * Modes:
 * - `select`: searchable single choice over three Profiles.
 * - `multi`: searchable multi choice over three Hosts (none pre-selected).
 * - `install <home> <cwd>`: bare guided `install` in the given Project.
 */
import { runInstallCommand } from "../../cli/install-command.js";
import {
  createSearchableMultiSelectPrompt,
  createSearchableSelectPrompt,
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
} else {
  process.stderr.write(`unknown PTY driver mode '${mode ?? ""}'\n`);
  process.exit(2);
}
