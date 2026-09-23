import { readFileSync } from "node:fs";
import { join } from "node:path";
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
} from "../cli/presentation.js";
import { commandHelpDocument, defaultCommands } from "../cli/command-help.js";
import { flatInlineText, renderPresentationDocument } from "../cli/presentation-document.js";
import { formatInstallerToolErrorDiagnostic } from "../cli/error-wording.js";
import { diagnosticDocument } from "../cli/diagnostics.js";

const defaultRenderContext = { color: false, interactive: false, width: 80, rows: undefined };

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
      });
      const renderedValidation = renderPresentationDocument(validationDoc, defaultRenderContext);
      expect(renderedValidation).toContain("Agents bound: codex");
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
  });
});
