import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  appendOperationHistory,
  operationHistoryLockPath,
  operationHistoryPath,
  parseOperationHistory,
  readOperationHistory,
  OPERATION_HISTORY_LIMIT,
  OPERATION_HISTORY_SCHEMA_VERSION,
  type OperationHistoryEntryDraft,
} from "../installer/operation-history.js";
import { stateDirectory } from "../installer/local-configuration.js";

const temporaryDirectories: string[] = [];

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "agent-profile-kit-history-"));
  temporaryDirectories.push(home);
  return home;
}

afterAll(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function draft(index: number, overrides: Partial<OperationHistoryEntryDraft> = {}): OperationHistoryEntryDraft {
  return {
    command: "update",
    startedAt: `2026-09-10T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
    finishedAt: `2026-09-10T10:00:${String(index % 60).padStart(2, "0")}.500Z`,
    outcome: "succeeded",
    scope: { selection: "all" },
    projects: [{
      canonicalProject: `/tmp/project-${index}`,
      project: `/tmp/project-${index}`,
      result: "completed",
      written: [`.agent-profile-kit/codex/context-${index}.md`],
    }],
    ...overrides,
  };
}

describe("operation history store", () => {
  test("keeps one machine-local document beside Local Configuration and a dedicated lock", () => {
    const home = isolatedHome();
    expect(operationHistoryPath(home)).toBe(
      join(home, ".agents", "agent-profile-kit", "operation-history.json"),
    );
    expect(operationHistoryLockPath(home)).toBe(
      join(home, ".agents", "agent-profile-kit", "operation-history.lock"),
    );
    // The history document is a sibling of the installation state directory,
    // never inside it: diagnostic evidence stays outside ownership evidence.
    expect(dirname(operationHistoryPath(home))).toBe(dirname(stateDirectory(home)));
  });

  test("an absent history file reads as an empty history and is not created", async () => {
    const home = isolatedHome();
    const history = await readOperationHistory(home);
    expect(history).toEqual({
      schemaVersion: OPERATION_HISTORY_SCHEMA_VERSION,
      entries: [],
    });
    expect(existsSync(operationHistoryPath(home))).toBe(false);
  });

  test("appends structured entries with stable monotonic ids, newest first", async () => {
    const home = isolatedHome();
    const first = await appendOperationHistory(home, draft(1));
    const second = await appendOperationHistory(home, draft(2, {
      command: "uninstall",
      outcome: "cancelled",
      cancelledReason: "declined",
      scope: { selection: "project", profile: "example", hosts: ["codex"] },
      projects: [{
        canonicalProject: "/tmp/project-2",
        project: "/tmp/project-2",
        profile: "example",
        hosts: ["codex"],
        result: "failed",
        outputCommitted: true,
        failure: "the recorded selection changed before publication",
      }],
      reviewedChangedOutputs: [{
        operation: "remove",
        path: ".codex/hooks.json",
        project: "/tmp/project-2",
        reviewId: "review-2",
      }],
    }));

    expect(first.id).toBe("op-000001");
    expect(second.id).toBe("op-000002");
    const history = await readOperationHistory(home);
    expect(history.entries.map((entry) => entry.id)).toEqual(["op-000002", "op-000001"]);
    expect(history.entries[0]).toEqual(second);
    expect(history.entries[1]).toEqual(first);
    // Identity is persisted, so an unchanged reader keeps returning it.
    expect((await readOperationHistory(home)).entries[0]!.id).toBe("op-000002");
  });

  test("retains exactly the latest 200 entries and evicts the oldest only after the cap", async () => {
    const home = isolatedHome();
    for (let index = 1; index <= OPERATION_HISTORY_LIMIT; index += 1) {
      await appendOperationHistory(home, draft(index));
    }
    const atLimit = await readOperationHistory(home);
    expect(atLimit.entries).toHaveLength(OPERATION_HISTORY_LIMIT);
    expect(atLimit.entries[0]!.id).toBe(`op-${String(OPERATION_HISTORY_LIMIT).padStart(6, "0")}`);
    expect(atLimit.entries.at(-1)!.id).toBe("op-000001");

    const appended = await appendOperationHistory(home, draft(OPERATION_HISTORY_LIMIT + 1));
    const evicted = await readOperationHistory(home);
    expect(evicted.entries).toHaveLength(OPERATION_HISTORY_LIMIT);
    expect(evicted.entries[0]!.id).toBe(appended.id);
    expect(evicted.entries.map((entry) => entry.id)).not.toContain("op-000001");
    expect(evicted.entries.at(-1)!.id).toBe("op-000002");
  });

  test("parallel writers never lose a retained entry", async () => {
    const home = isolatedHome();
    const writes = Array.from({ length: 24 }, (_, index) =>
      appendOperationHistory(home, draft(index + 1))
    );
    const appended = await Promise.all(writes);
    const history = await readOperationHistory(home);
    expect(history.entries).toHaveLength(24);
    expect(new Set(appended.map((entry) => entry.id)).size).toBe(24);
    expect(history.entries.map((entry) => entry.id).sort()).toEqual(
      Array.from({ length: 24 }, (_, index) => `op-${String(index + 1).padStart(6, "0")}`),
    );
    // Every draft is present exactly once: no lost report, no duplicate id.
    expect(new Set(history.entries.map((entry) => entry.projects[0]!.canonicalProject)).size).toBe(24);
  });

  test("a reader never observes a torn document while writers publish", async () => {
    const home = isolatedHome();
    await appendOperationHistory(home, draft(1));
    const path = operationHistoryPath(home);
    let torn = 0;
    let reads = 0;
    const readers = (async () => {
      while (reads < 200) {
        reads += 1;
        try {
          const parsed = JSON.parse(readFileSync(path, "utf8")) as { entries?: unknown };
          if (!Array.isArray(parsed.entries)) torn += 1;
        } catch {
          torn += 1;
        }
      }
    })();
    await Promise.all([
      readers,
      ...Array.from({ length: 40 }, (_, index) => appendOperationHistory(home, draft(index + 2))),
    ]);
    expect(torn).toBe(0);
    expect((await readOperationHistory(home)).entries).toHaveLength(41);
  });

  test("reads never mutate the document", async () => {
    const home = isolatedHome();
    await appendOperationHistory(home, draft(1));
    const before = readFileSync(operationHistoryPath(home));
    await readOperationHistory(home);
    await readOperationHistory(home);
    expect(readFileSync(operationHistoryPath(home))).toEqual(before);
  });

  test("an invalid document fails closed instead of being overwritten", async () => {
    const home = isolatedHome();
    await appendOperationHistory(home, draft(1));
    const source = "{\"schemaVersion\":1,\"entries\":[{\"id\":\"op-000001\"}]}\n";
    writeFileSync(operationHistoryPath(home), source);

    await expect(readOperationHistory(home)).rejects.toThrow(/operation history/);
    await expect(appendOperationHistory(home, draft(2))).rejects.toThrow(/operation history/);
    expect(readFileSync(operationHistoryPath(home), "utf8")).toBe(source);
  });

  test("a failed publication keeps the retained document and leaves no temporary file", async () => {
    const home = isolatedHome();
    await appendOperationHistory(home, draft(1));
    const before = readFileSync(operationHistoryPath(home));

    await expect(appendOperationHistory(home, draft(2), {
      fileSystem: {
        rename: async () => {
          throw new Error("rename refused");
        },
      },
    })).rejects.toThrow(/rename refused/);

    expect(readFileSync(operationHistoryPath(home))).toEqual(before);
    const leftovers = readFileSync(operationHistoryPath(home), "utf8");
    expect(leftovers).toBe(before.toString("utf8"));
    expect(
      // No staging file may outlive its failed publication.
      (await import("node:fs")).readdirSync(dirname(operationHistoryPath(home)))
        .filter((name) => name.includes("operation-history") && name.endsWith(".tmp")),
    ).toEqual([]);
  });

  test("parses only the exact schema it publishes", () => {
    expect(() => parseOperationHistory("{}")).toThrow(/operation history/);
    expect(() => parseOperationHistory("")).toThrow(/operation history/);
    expect(() => parseOperationHistory(JSON.stringify({
      schemaVersion: OPERATION_HISTORY_SCHEMA_VERSION,
      entries: [{ id: "op-000001", command: "apply" }],
    }))).toThrow(/operation history/);
    expect(() => parseOperationHistory(JSON.stringify({
      schemaVersion: OPERATION_HISTORY_SCHEMA_VERSION,
      entries: [{
        id: "op-000001",
        command: "install",
        startedAt: "2026-09-10T10:00:00.000Z",
        finishedAt: "2026-09-10T10:00:01.000Z",
        outcome: "failed",
        scope: { selection: "project" },
        projects: [{
          project: "/tmp/project",
          canonicalProject: "/tmp/project",
          result: "failed",
          outputCommitted: "yes",
        }],
      }],
    }))).toThrow(/operation history/);
  });

  test("refuses a history path that is not a file before writing", async () => {
    const home = isolatedHome();
    mkdirSync(operationHistoryPath(home), { recursive: true });
    await expect(readOperationHistory(home)).rejects.toThrow(/operation history/);
    await expect(appendOperationHistory(home, draft(1))).rejects.toThrow(/operation history/);
  });
});
