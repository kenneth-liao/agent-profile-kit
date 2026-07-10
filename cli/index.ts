#!/usr/bin/env node

import { homedir } from "node:os";

import { initializeWorkspace } from "../installer/initialize-workspace.js";

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);

  if (arguments_.length !== 1 || arguments_[0] !== "init") {
    process.stderr.write("Usage: agent-profile-kit init\n");
    process.exitCode = 1;
    return;
  }

  const result = await initializeWorkspace(homedir());
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
      `Optional Git setup:\n  cd ${JSON.stringify(result.path)}\n  git init\n` +
      "Review personal content before publishing this Workspace.\n",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`agent-profile-kit: ${message}\n`);
  process.exitCode = 1;
});
