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
import { formatHostInventoryJson } from "../cli/presentation.js";
import { commandHelpDocument, defaultCommands } from "../cli/command-help.js";
import { flatInlineText } from "../cli/presentation-document.js";

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
  });
});
