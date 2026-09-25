import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { parseInstallArguments } from "../cli/install-command.js";
import { parseUninstallArguments } from "../cli/uninstall-command.js";
import { parseInstallTempArguments } from "../cli/index.js";
import {
  isInventoryTopic,
  inventoryTopicNames,
  inventoryCommandSyntax,
} from "../cli/inventory-topics.js";
import { listHosts } from "../installer/inventory.js";
import {
  formatHostInventoryJson,
  inventoryIndexDocument,
  validationResultDocument,
  uninstallInteractiveCommandsDocument,
  formatUninstallJson,
} from "../cli/presentation.js";
import { commandHelpDocument, defaultCommands } from "../cli/command-help.js";
import { flatInlineText, renderPresentationDocument } from "../cli/presentation-document.js";
import { applyNewcomerSubstitutions } from "../cli/blocker-wording.js";
import { caughtCapabilityFailure } from "../adapters/capability.js";
import { probeCodexMachineCapability } from "../adapters/codex.js";
import { formatInstallerToolErrorDiagnostic } from "../cli/error-wording.js";
import { errorDiagnosticDocument } from "../cli/error-wording.js";
import {
  operationHistoryEntryDocument,
  localHumanTimeContext,
} from "../cli/operation-history-presentation.js";
import { diagnosticDocument } from "../cli/diagnostics.js";

const defaultRenderContext = { color: false, interactive: false, width: 80, rows: undefined };

/**
 * The user-facing prose of one shipped-guide line: the line with the frozen
 * keys removed (DEC-004, OOS-001). Only the `hosts` binding key is masked —
 * no agent id contains "host" — so whatever remains is prose and must carry
 * "agent", never the internal "Host" word.
 */
function guideProse(line: string): string {
  return line.replace(/^\s*hosts:/, "").replace(/`hosts:?`/g, "");
}


describe("issue #673 agent wording & flag changes", () => {
  describe("install command argument parsing", () => {
    test("accepts --agent flag", () => {
      const parsed = parseInstallArguments(["engineering", "--agent", "codex", "--auto-confirm"]);
      expect(parsed.hosts).toEqual(["codex"]);
      expect(parsed.profile).toBe("engineering");
    });

    test("accepts repeatable --agent flag", () => {
      const parsed = parseInstallArguments([
        "engineering",
        "--agent",
        "codex",
        "--agent",
        "claude",
        "--auto-confirm",
      ]);
      expect(parsed.hosts).toEqual(["codex", "claude"]);
    });

    test("--agent without value throws expected error", () => {
      expect(() => parseInstallArguments(["engineering", "--agent"])).toThrow(
        "install --agent requires an agent name",
      );
    });

    test("--host is rejected with standard unknown-argument error", () => {
      expect(() =>
        parseInstallArguments(["engineering", "--host", "codex", "--auto-confirm"]),
      ).toThrow("install does not accept argument '--host'");
    });
  });

  describe("uninstall command argument parsing", () => {
    test("accepts --agent flag", () => {
      const parsed = parseUninstallArguments(["--here", "--agent", "codex", "--auto-confirm"]);
      expect(parsed.hosts).toEqual(["codex"]);
      expect(parsed.here).toBe(true);
    });

    test("accepts repeatable --agent flag", () => {
      const parsed = parseUninstallArguments([
        "--here",
        "--agent",
        "codex",
        "--agent",
        "pi",
        "--auto-confirm",
      ]);
      expect(parsed.hosts).toEqual(["codex", "pi"]);
    });

    test("--agent without value throws expected error", () => {
      expect(() => parseUninstallArguments(["--agent"])).toThrow(
        "uninstall --agent requires an agent name",
      );
    });

    test("--host is rejected with standard unknown-argument error", () => {
      expect(() =>
        parseUninstallArguments(["--here", "--host", "codex", "--auto-confirm"]),
      ).toThrow("uninstall does not accept argument '--host'");
    });
  });

  describe("machine install-temp argument parsing (ADR-0051)", () => {
    test("accepts --host flag", () => {
      const parsed = parseInstallTempArguments(["engineering", "/path/to/project", "--host", "codex"]);
      expect(parsed.host).toBe("codex");
      expect(parsed.profile).toBe("engineering");
      expect(parsed.project).toBe("/path/to/project");
    });

    test("rejects --agent flag on machine install-temp", () => {
      expect(() =>
        parseInstallTempArguments(["engineering", "/path/to/project", "--agent", "codex"]),
      ).toThrow("machine install-temp does not accept argument '--agent'");
    });
  });

  describe("inventory topics", () => {
    test("topic 'agents' is recognized and 'hosts' is rejected", () => {
      expect(isInventoryTopic("agents")).toBe(true);
      expect(isInventoryTopic("hosts")).toBe(false);
      expect(inventoryTopicNames()).toContain("agents");
      expect(inventoryTopicNames()).not.toContain("hosts");
      expect(inventoryCommandSyntax()).toContain("agents");
      expect(inventoryCommandSyntax()).not.toContain("hosts");
    });
  });

  describe("JSON parity (DEC-004, OOS-001)", () => {
    test("list agents --json produces byte-identical payload structure with topic 'hosts'", () => {
      const hosts = listHosts();
      const jsonStr = formatHostInventoryJson(hosts);
      const payload = JSON.parse(jsonStr);

      expect(payload).toEqual({
        schemaVersion: 1,
        command: "list",
        topic: "hosts",
        outcome: "success",
        engineVersion: payload.engineVersion,
        hosts: [
          { host: "antigravity", supportsTemporaryProfileInstallation: false },
          { host: "claude", supportsTemporaryProfileInstallation: true },
          { host: "codex", supportsTemporaryProfileInstallation: true },
          { host: "grok", supportsTemporaryProfileInstallation: false },
          { host: "opencode", supportsTemporaryProfileInstallation: true },
          { host: "pi", supportsTemporaryProfileInstallation: true },
        ],
      });
    });
  });

  describe("user-facing vocabulary guard", () => {
    test("user-facing command help does not say 'Host' or 'Agent Host'", () => {
      const commands = defaultCommands();
      for (const cmd of commands) {
        const doc = commandHelpDocument(cmd);
        for (const node of doc) {
          if ("text" in node && typeof node.text === "string") {
            expect(node.text).not.toMatch(/\bAgent Hosts?\b/);
            expect(node.text).not.toMatch(/\bHosts?\b/);
          }
          if ("parts" in node && Array.isArray(node.parts)) {
            const text = flatInlineText(node.parts);
            expect(text).not.toMatch(/\bAgent Hosts?\b/);
            expect(text).not.toMatch(/\bHosts?\b/);
          }
        }
      }
    });

    test("rendered diagnostic whatToType suggestions never suggest 'list hosts' or reference 'Host'", () => {
      // INT-1, INT-3: ensure every diagnostic that offers an inventory or support suggestion
      // points to 'list agents' and uses 'agent' vocabulary in its whatToType remedy.
      const facts = [
        { kind: "unsupported-host" as const, host: "unknown", supportedHosts: ["codex", "claude"] },
        { kind: "unsupported-temporary-host" as const, host: "unknown", supportedHosts: ["codex"] },
        { kind: "temporary-host-unsupported" as const, host: "unknown", supportedHosts: ["codex"] },
      ];

      for (const fact of facts) {
        const parts = formatInstallerToolErrorDiagnostic(fact);
        const doc = diagnosticDocument(parts);
        const rendered = renderPresentationDocument(doc, defaultRenderContext);

        expect(rendered).not.toContain("list hosts");
        expect(rendered).not.toContain("supported Hosts");

        if (parts.whatToType !== undefined) {
          const whatToTypeText = parts.whatToType.map((line) => flatInlineText(line)).join("\n");
          expect(whatToTypeText).not.toContain("list hosts");
          expect(whatToTypeText).not.toMatch(/\bHosts?\b/);
          expect(whatToTypeText).toContain("list agents");
        }
      }
    });

    test("key rendered receipts and inventory index present 'agents' vocabulary", () => {
      const validationDoc = validationResultDocument({
        bindings: 1,
        hosts: ["codex"],
        profiles: ["coding"],
        warnings: [],
        workspace: { authored: "~/apkit-workspace", canonical: "/home/apkit-workspace" },
      }, "/home/.agents/agent-profile-kit/config.yaml");
      const renderedValidation = renderPresentationDocument(validationDoc, defaultRenderContext);
      expect(renderedValidation).toContain("Agents in use: codex");
      expect(renderedValidation).not.toContain("Hosts bound");

      const inventoryDoc = inventoryIndexDocument();
      const renderedInventory = renderPresentationDocument(inventoryDoc, defaultRenderContext);
      expect(renderedInventory).toContain("agents");
      expect(renderedInventory).not.toContain("list hosts");
    });

    test("USER-JOURNEY user-facing output examples contain no stale Host wording", () => {
      // INT-2: Verify USER-JOURNEY.md user-facing output blocks (stages 1-12)
      // have received the rename pass and do not contain stale output strings.
      const content = readFileSync(join(import.meta.dirname, "../docs/USER-JOURNEY.md"), "utf8");
      // Split off stage 13 which preserves the machine namespace
      const userFacingContent = content.split("### 13. Temporary Profile Installations")[0]!;

      expect(userFacingContent).not.toContain("Detected Agent Hosts:");
      expect(userFacingContent).not.toContain("Hosts bound:");
      expect(userFacingContent).not.toContain("Start a new Host session");
      expect(userFacingContent).not.toContain("Project  Profile  Hosts  State");
      expect(userFacingContent).not.toContain("list hosts");
      expect(userFacingContent).not.toContain("Install a Profile with Agent Hosts");
    });

    test("shipped guide prose says 'agent', never 'Host' (US-002, DEC-003, OOS-001)", () => {
      // The shipped guides render through `apkit guide` (ADR-0044) and carry
      // user-facing prose, so they hold the same vocabulary as help and
      // human output. Frozen keys stay exactly as authored (DEC-004, OOS-001):
      // `hosts` is the Local Configuration / Project Binding key and the one
      // frozen spelling that contains "host", so each line is reduced to its
      // prose by removing that key before the user-facing word is checked.
      const violations: string[] = [];
      for (const name of ["workspace.md", "agent-workflow.md", "workspace-contract.md"]) {
        const content = readFileSync(join(import.meta.dirname, "../docs/guides", name), "utf8");
        for (const [offset, line] of content.split("\n").entries()) {
          const prose = guideProse(line);
          if (/\bAgent Hosts?\b/.test(prose) || /\bHosts?\b/i.test(prose)) {
            violations.push(`${name}:${offset + 1}: ${line}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });

    test("the frozen `hosts` binding key stays exactly as authored (DEC-004, OOS-001)", () => {
      const content = readFileSync(join(import.meta.dirname, "../docs/guides/workspace.md"), "utf8");
      expect(content).toMatch(/^\s*hosts:$/m);
    });

    test("the newcomer Host substitution is word-bounded and case-correct (#700, gap 3)", () => {
      // One entry in the newcomer-substitution layer rewrites the internal
      // "Host" word to the user-facing "agent" word for every non-blocker
      // error surface. The test pins the rewrite and the boundaries the
      // rewrite must never cross.
      expect(applyNewcomerSubstitutions("surviving Hosts stay")).toBe("surviving agents stay");
      expect(applyNewcomerSubstitutions("the surviving Host output")).toBe("the surviving agent output");
      expect(applyNewcomerSubstitutions("check the Host CLI works")).toBe("check the agent CLI works");
      expect(applyNewcomerSubstitutions("require Codex Host capabilities"))
        .toBe("require Codex agent capabilities");
      expect(applyNewcomerSubstitutions("the Host mode left no Host selection"))
        .toBe("the agent mode left no agent selection");
      // Sentence-initial Host keeps its capital.
      expect(applyNewcomerSubstitutions("Host output is occupied."))
        .toBe("Agent output is occupied.");
      expect(applyNewcomerSubstitutions("surviving-Host plan")).toBe("surviving-agent plan");
      // Word-bounded: embedded words and frozen keys are never touched.
      expect(applyNewcomerSubstitutions("localhost hostname")).toBe("localhost hostname");
      expect(applyNewcomerSubstitutions("--host codex")).toBe("--host codex");
      expect(applyNewcomerSubstitutions("hosts: [codex]")).toBe("hosts: [codex]");
      expect(applyNewcomerSubstitutions("the Hosts: [codex]")).toBe("the agents: [codex]");
    });

    test("the newcomer Host substitution never rewrites a path segment or a quoted path (#700, OOS-004)", () => {
      // OOS-004 keeps raw recovery facts unchanged. A path segment named
      // `Host` (or a Project named `Host`) is a raw fact, so the substitution
      // skips the word when it sits next to a path separator or inside quotes.
      expect(applyNewcomerSubstitutions("/tmp/Host/file")).toBe("/tmp/Host/file");
      expect(applyNewcomerSubstitutions("/tmp/Host")).toBe("/tmp/Host");
      expect(applyNewcomerSubstitutions("Host/file")).toBe("Host/file");
      expect(applyNewcomerSubstitutions("'/tmp/Host/file'")).toBe("'/tmp/Host/file'");
      expect(applyNewcomerSubstitutions(`"/tmp/Host/file"`)).toBe(`"/tmp/Host/file"`);
      expect(applyNewcomerSubstitutions("apkit uninstall --project 'Host'"))
        .toBe("apkit uninstall --project 'Host'");
      expect(applyNewcomerSubstitutions("The folder /tmp/Host doesn't exist."))
        .toBe("The folder /tmp/Host doesn't exist.");
      // Prose still rewrites.
      expect(applyNewcomerSubstitutions("surviving Host output")).toBe("surviving agent output");
    });

    test("the interactive uninstall stop path renders without 'Host' (#700, INT-2)", () => {
      // The interactive uninstall stop path (`uninstall stopped at …`) and
      // the interactive `formatError` happened sites route through the same
      // newcomer substitution as the non-interactive recovery screen, so a
      // surviving-Host detail never leaks `Host` to a user.
      const document = uninstallInteractiveCommandsDocument({
        happened: [
          "uninstall stopped at /proj: surviving Host output '/tmp/x/SKILL.md' is occupied by unowned content",
        ],
        intro: "After resolving the cause, retry the same scope (one command per Project):",
        commands: [[{ kind: "text" as const, value: "uninstall" }]],
      });
      const rendered = renderPresentationDocument(document, defaultRenderContext);
      expect(rendered).not.toMatch(/\bHosts?\b/);
      expect(rendered).toContain("surviving agent output");
      // The raw path fact survives (OOS-004).
      expect(rendered).toContain("/tmp/x/SKILL.md");
    });

    test("runtime capability remedies say 'agent', never 'Host' (#700, gap 3)", () => {
      // The Adapter capability remedies are authored at the Adapter boundary
      // and render as `Remedy:` lines on public commands. Every human remedy
      // names the agent (via the Host catalog displayName) and never the
      // internal "Host" word; the machine message keeps its own words.
      const foreign = caughtCapabilityFailure("codex", "host", new Error("probe exploded"));
      expect(foreign.remedy).not.toMatch(/\bHosts?\b/);
      expect(foreign.remedy).toContain("Codex");
    });

    test("the Codex version-failure remedy is human-rendered while the machine message stays unchanged (#700, gap 3)", async () => {
      // The Codex `--version` failure is a JSON-valued message (DEC-004). The
      // human `Remedy:` line gets a rendering that says "agent"; the machine
      // `message` keeps the authored wording with "Codex Host capabilities".
      const bin = mkdtempSync(join(tmpdir(), "apkit-host-wording-"));
      try {
        writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 97\n");
        chmodSync(join(bin, "codex"), 0o755);
        let caught: unknown;
        try {
          await probeCodexMachineCapability({
            env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
            requireContext: true,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeDefined();
        const failure = caught as { remedy: string; remedyParts?: readonly string[]; parts: readonly string[] };
        const humanRemedy = failure.remedyParts?.join("") ?? failure.remedy;
        expect(humanRemedy).not.toMatch(/\bHosts?\b/);
        const machineMessage = failure.parts.join("");
        expect(machineMessage).toContain("Codex Host capabilities");
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });

    test("rows 10 and 11 render without 'Host' (#700, gap 3)", () => {
      // Row 10: the interactive uninstall invariant diagnostic renders through
      // the shared error-diagnostic path (which applies newcomer substitutions).
      const row10 = errorDiagnosticDocument(
        new Error("interactive uninstall Host mode left no Host selection"),
      );
      const rendered10 = renderPresentationDocument(row10, defaultRenderContext);
      expect(rendered10).not.toMatch(/\bHosts?\b/);
      expect(rendered10).toContain("agent mode");
      // Row 11: the surviving-plan invariant reaches skip reasons and details
      // through the substitution layer every non-blocker error surface uses.
      const row11 = applyNewcomerSubstitutions(
        "surviving-Host plan missing for partial removal of ~/proj/alpha",
      );
      expect(row11).not.toMatch(/\bHosts?\b/);
      expect(row11).toContain("surviving-agent plan");
    });

    test("apkit details substitutes 'Host' but keeps raw recovery facts (#700, OOS-004)", () => {
      // The details view renders the substituted wording for the prose while
      // every raw recovery fact — the file path and the errno code — stays
      // exactly as the run recorded it.
      const entry = {
        id: "op-1",
        command: "uninstall" as const,
        startedAt: "2026-09-25T10:00:00.000Z",
        finishedAt: "2026-09-25T10:00:01.000Z",
        outcome: "partial" as const,
        scope: { selection: "project" as const },
        projects: [
          {
            project: "~/proj/alpha",
            canonicalProject: "/home/user/proj/alpha",
            result: "skipped" as const,
            failure:
              "surviving Host output '/home/user/proj/alpha/.agents/skills/x/SKILL.md' " +
              "is occupied by unowned content (EACCES); remove it or remove the whole installation instead",
          },
        ],
      };
      const document = operationHistoryEntryDocument(
        entry,
        localHumanTimeContext(Date.parse("2026-09-25T10:00:02.000Z")),
      );
      const rendered = renderPresentationDocument(document, defaultRenderContext);
      expect(rendered).not.toMatch(/\bHosts?\b/);
      expect(rendered).toContain("surviving agent output");
      // Raw recovery facts survive the substitution untouched (OOS-004).
      expect(rendered).toContain("/home/user/proj/alpha/.agents/skills/x/SKILL.md");
      expect(rendered).toContain("EACCES");
    });

    test("the surviving-agents uninstall machine JSON keeps the raw Host strings (#700, PROD-1)", () => {
      // DEC-004: the machine JSON for a surviving-agents uninstall failure
      // stays byte-identical — `skipped[].reason` and `failed.detail` keep the
      // authored `Host` wording even though the human rendering says "agent".
      const json = formatUninstallJson({
        completed: [],
        skipped: [
          {
            project: "/proj",
            profile: "coding",
            reason:
              "cannot plan the surviving Hosts without the Workspace (unavailable); " +
              "fix the Workspace selection or remove the whole installation instead",
          },
        ],
        failed: {
          project: "/proj",
          profile: "coding",
          detail:
            "surviving Host output '/proj/.agents/skills/x/SKILL.md' is occupied by " +
            "content written after the review; re-run uninstall to review the current state",
          selectionRestored: true,
          concurrentSelectionChange: false,
        },
        unattempted: [],
        warnings: [],
      });
      expect(json).toContain("cannot plan the surviving Hosts");
      expect(json).toContain("surviving Host output");
    });
  });
});
