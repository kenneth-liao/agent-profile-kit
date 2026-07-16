#!/usr/bin/env node

import { homedir } from "node:os";

import { agentGuide, humanGuide } from "./guides.js";
import { bindProject } from "../installer/bind-project.js";
import { errorMessage, initializeWorkspace } from "../installer/initialize-workspace.js";
import {
  applyApplication,
  previewApplication,
  statusApplication,
  uninstallApplication,
  validateApplication,
} from "../installer/commands.js";
import type { ReconciliationReport } from "../installer/reconcile.js";

function formatError(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = Array.from(error.errors, formatError);
    return [error.message, ...causes.map((cause) => `caused by: ${cause}`)].join("\n");
  }
  return errorMessage(error);
}

function usage(): string {
  return (
    "Usage: agent-profile-kit init\n" +
    "       agent-profile-kit guide [--agent]\n" +
    "       agent-profile-kit bind <profile> [project] --host <host> [--host <host> ...]\n" +
    "       agent-profile-kit validate\n" +
    "       agent-profile-kit preview\n" +
    "       agent-profile-kit apply\n" +
    "       agent-profile-kit status\n" +
    "       agent-profile-kit uninstall\n"
  );
}

/**
 * Parse `bind <profile> [project] --host <host> ...`.
 * At least one --host is required. Host detection/defaults are intentionally absent.
 */
function parseBindArguments(arguments_: readonly string[]): {
  readonly profile: string;
  readonly project?: string;
  readonly hosts: readonly string[];
} {
  if (arguments_.length === 0) {
    throw new Error("bind requires a Profile Artifact ID");
  }
  const profile = arguments_[0]!;
  let index = 1;
  let project: string | undefined;
  if (index < arguments_.length && !arguments_[index]!.startsWith("-")) {
    project = arguments_[index]!;
    index += 1;
  }

  const hosts: string[] = [];
  while (index < arguments_.length) {
    const flag = arguments_[index]!;
    if (flag === "--host") {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("bind --host requires an Agent Host name");
      }
      hosts.push(value);
      index += 2;
      continue;
    }
    throw new Error(`bind does not accept argument '${flag}'`);
  }

  return project === undefined ? { profile, hosts } : { profile, project, hosts };
}

function formatReport(report: ReconciliationReport): string {
  const items = report.items.length === 0
    ? "(no Profile Installations)"
    : report.items
        .map((item) => `${item.project}: ${item.kind}${item.reason ? ` (${item.reason})` : ""}`)
        .join("\n");
  const desired = report.desired.length === 0
    ? "(none)"
    : report.desired
        .map((installation) => {
          const resolved = installation.resolvedArtifacts.length === 0
            ? "  Resolved artifacts: (none)"
            : `  Resolved artifacts:\n${installation.resolvedArtifacts.map((artifact) => {
                const reasons = artifact.inclusionReasons.map((reason) => {
                  const path = reason.path.length === 0
                    ? "selected by profile"
                    : `via ${reason.path.join(" -> ")}`;
                  return `${reason.profile}: ${path}`;
                }).join("; ");
                return `    - ${artifact.type}:${artifact.id} (${reasons})`;
              }).join("\n")}`;
          return (
            `${installation.project}: Profile ${installation.profile}\n` +
            `  Outputs: ${installation.outputs.join(", ")}\n` +
            `${resolved}\n` +
            `  Context:\n${installation.context}`
          );
        })
        .join("\n");
  const blockers = report.blockers.length === 0
    ? "(none)"
    : report.blockers.map((blocker) => `- ${blocker.message}`).join("\n");
  const outputs = report.outputs.length === 0
    ? "(none)"
    : report.outputs
        .map((output) => `${output.project}/${output.path}: ${output.kind}`)
        .join("\n");
  const warnings = report.warnings.length === 0
    ? "(none)"
    : report.warnings.map((warning) => `- ${warning}`).join("\n");
  return `Projects:\n${items}\nOutputs:\n${outputs}\nDesired State:\n${desired}\nWarnings:\n${warnings}\nBlockers:\n${blockers}\n`;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const home = homedir();

  if (arguments_.length === 1 && arguments_[0] === "guide") {
    process.stdout.write(await humanGuide());
    return;
  }
  if (arguments_.length === 2 && arguments_[0] === "guide" && arguments_[1] === "--agent") {
    process.stdout.write(await agentGuide());
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === "init") {
    const result = await initializeWorkspace(home);
    for (const warning of result.warnings) process.stderr.write(`agent-profile-kit: warning: ${warning}\n`);
    if (result.outcome === "unchanged") {
      process.stdout.write(`Workspace and Local Configuration already initialized at ${result.path}; unchanged.\n`);
      return;
    }
    process.stdout.write(
      `Initialized Agent Profile Kit Workspace and Local Configuration at ${result.path}\n` +
        "Next: bind a project or edit config.yaml, then run agent-profile-kit validate\n",
    );
    return;
  }
  if (arguments_.length >= 1 && arguments_[0] === "bind") {
    const parsed = parseBindArguments(arguments_.slice(1));
    const result = await bindProject({
      home,
      profile: parsed.profile,
      hosts: parsed.hosts,
      ...(parsed.project === undefined ? {} : { project: parsed.project }),
    });
    if (result.outcome === "unchanged") {
      process.stdout.write(
        `Project Binding unchanged for ${result.project}\n` +
          `  Profile: ${result.profile}\n` +
          `  Hosts: ${result.hosts.join(", ")}\n` +
          `  Local Configuration: ${result.configurationPath}\n` +
          "Next: agent-profile-kit preview && agent-profile-kit apply\n",
      );
      return;
    }
    process.stdout.write(
      `Recorded Project Binding for ${result.project}\n` +
        `  Profile: ${result.profile}\n` +
        `  Hosts: ${result.hosts.join(", ")}\n` +
        `  Local Configuration: ${result.configurationPath}\n` +
        "Next: agent-profile-kit preview && agent-profile-kit apply\n",
    );
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === "validate") {
    const result = await validateApplication(home);
    process.stdout.write(
      `Workspace and Local Configuration valid (${result.profiles} Profiles, ${result.bindings} Project Bindings)\n` +
      result.warnings.map((warning) => `Warning: ${warning}\n`).join(""),
    );
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === "preview") {
    const report = await previewApplication(home);
    process.stdout.write(formatReport(report));
    if (report.blockers.length > 0) process.exitCode = 1;
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === "apply") {
    process.stdout.write(formatReport(await applyApplication(home)));
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === "status") {
    process.stdout.write(formatReport(await statusApplication(home)));
    return;
  }
  if (arguments_.length === 1 && arguments_[0] === "uninstall") {
    const count = await uninstallApplication(home);
    process.stdout.write(`Uninstalled ${count} Profile Installation${count === 1 ? "" : "s"}\n`);
    return;
  }

  process.stderr.write(usage());
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`agent-profile-kit: ${formatError(error)}\n`);
  process.exitCode = 1;
});
