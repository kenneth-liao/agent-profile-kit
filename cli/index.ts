#!/usr/bin/env node

import { homedir } from "node:os";

import { agentGuide, humanGuide } from "./guides.js";
import {
  errorMessage,
  initializeWorkspace,
} from "../installer/initialize-workspace.js";
import { ingestWorkspace } from "../installer/ingest-workspace.js";
import { installContextOnlyCodex } from "../installer/install.js";
import { planContextOnlyCodex } from "../installer/plan.js";
import { runContextOnlyCodex } from "../installer/run.js";
import { statusContextOnlyCodex } from "../installer/status.js";
import { updateInstalledContextOnlyCodex } from "../installer/update.js";
import { uninstallContextOnlyCodex } from "../installer/uninstall.js";
import { requireArtifactId } from "../schemas/context-profile.js";

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

function profileAndHost(arguments_: readonly string[]): { host: string; profile: string } {
  if (
    arguments_.length !== 4 ||
    arguments_[0] !== "--profile" ||
    arguments_[2] !== "--host" ||
    !arguments_[1] ||
    !arguments_[3]
  ) {
    throw new Error("Usage: --profile <id> --host codex");
  }
  return {
    profile: requireArtifactId(arguments_[1], "Profile id"),
    host: arguments_[3],
  };
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);

  if (arguments_.length === 1 && arguments_[0] === "guide") {
    process.stdout.write(await humanGuide());
    return;
  }

  if (
    arguments_.length === 2 &&
    arguments_[0] === "guide" &&
    arguments_[1] === "--agent"
  ) {
    process.stdout.write(await agentGuide());
    return;
  }

  if (arguments_.length === 1 && arguments_[0] === "validate") {
    const workspace = await ingestWorkspace(homedir());
    process.stdout.write(`Workspace valid at ${workspace.path}\n`);
    return;
  }

  if (arguments_[0] === "plan") {
    const { host, profile } = profileAndHost(arguments_.slice(1));
    if (host !== "codex") {
      throw new Error(`Unsupported Agent Host '${host}'`);
    }
    const plan = await planContextOnlyCodex(homedir(), profile);
    process.stdout.write(
      `Profile: ${plan.profile.id}\n` +
        "Host: codex\n" +
        `Capability: supported (${plan.capability.version})\n` +
        `Destination: ${plan.destination}\n` +
        "Context output:\n" +
        `${plan.context}\n`,
    );
    return;
  }

  if (arguments_[0] === "install") {
    const { host, profile } = profileAndHost(arguments_.slice(1));
    if (host !== "codex") {
      throw new Error(`Unsupported Agent Host '${host}'`);
    }
    const plan = await planContextOnlyCodex(homedir(), profile);
    await installContextOnlyCodex(plan);
    process.stdout.write(`Installed Profile at ${plan.destination}\n`);
    return;
  }

  if (arguments_[0] === "status") {
    const { host, profile } = profileAndHost(arguments_.slice(1));
    if (host !== "codex") {
      throw new Error(`Unsupported Agent Host '${host}'`);
    }
    const status = await statusContextOnlyCodex(homedir(), profile);
    process.stdout.write(`Status: ${status.join(", ")}\n`);
    return;
  }

  if (arguments_[0] === "uninstall") {
    const { host, profile } = profileAndHost(arguments_.slice(1));
    if (host !== "codex") {
      throw new Error(`Unsupported Agent Host '${host}'`);
    }
    const destination = await uninstallContextOnlyCodex(homedir(), profile);
    process.stdout.write(`Uninstalled Profile at ${destination}\n`);
    return;
  }

  if (arguments_[0] === "run") {
    const runArguments = arguments_.slice(1);
    if (runArguments.length < 5 || runArguments[4] !== "--") {
      throw new Error(
        "Usage: agent-profile-kit run --profile <id> --host codex -- <native Codex arguments>",
      );
    }
    const { host, profile } = profileAndHost(runArguments.slice(0, 4));
    if (host !== "codex") {
      throw new Error(`Unsupported Agent Host '${host}'`);
    }
    process.exitCode = await runContextOnlyCodex(
      homedir(),
      profile,
      runArguments.slice(5),
    );
    return;
  }

  if (arguments_.length === 1 && arguments_[0] === "update") {
    const count = await updateInstalledContextOnlyCodex(homedir());
    process.stdout.write(
      `Updated ${count} Profile Installation${count === 1 ? "" : "s"}\n`,
    );
    return;
  }

  if (arguments_.length !== 1 || arguments_[0] !== "init") {
    process.stderr.write(
      "Usage: agent-profile-kit init\n       agent-profile-kit guide [--agent]\n       agent-profile-kit validate\n       agent-profile-kit plan --profile <id> --host codex\n       agent-profile-kit install --profile <id> --host codex\n       agent-profile-kit status --profile <id> --host codex\n       agent-profile-kit update\n       agent-profile-kit uninstall --profile <id> --host codex\n       agent-profile-kit run --profile <id> --host codex -- <native Codex arguments>\n",
    );
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
