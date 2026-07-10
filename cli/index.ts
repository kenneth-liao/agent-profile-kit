#!/usr/bin/env node

import { homedir } from "node:os";

import {
  errorMessage,
  initializeWorkspace,
} from "../installer/initialize-workspace.js";

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = Array.from(error.errors, formatError);
    return [error.message, ...causes.map((cause) => `caused by: ${cause}`)].join(
      "\n",
    );
  }
  return errorMessage(error);
}

function quoteForPosixShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);

  if (arguments_.length !== 1 || arguments_[0] !== "init") {
    process.stderr.write("Usage: agent-profile-kit init\n");
    process.exitCode = 1;
    return;
  }

  const result = await initializeWorkspace(homedir());
  for (const warning of result.warnings) {
    process.stderr.write(`agent-profile-kit: warning: ${warning}\n`);
  }
  if (result.outcome === "unchanged") {
    process.stdout.write(
      `Workspace already initialized at ${result.path}; unchanged.\n`,
    );
    return;
  }

  process.stdout.write(
    `Initialized Agent Profile Kit Workspace at ${result.path}\n` +
      "Next: run agent-profile-kit guide\n" +
      "Agent prompt: Run agent-profile-kit guide --agent, then help me create the smallest useful Profile.\n" +
      `Optional Git setup:\n  cd ${quoteForPosixShell(result.path)}\n  git init\n` +
      "Review personal content before publishing this Workspace.\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`agent-profile-kit: ${formatError(error)}\n`);
  process.exitCode = 1;
});
