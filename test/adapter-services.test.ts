import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invokeExecutable } from "../adapters/services/executable.js";
import { classifyFileSystemEntry } from "../adapters/services/project-surface.js";
import {
  compareCoreSemanticVersions,
  normalizeCoreSemanticVersion,
} from "../adapters/services/semantic-version.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("shared Adapter services", () => {
  test("normalizes and compares core semantic versions without Host policy", () => {
    expect(normalizeCoreSemanticVersion("01", "145", "0")).toBe("1.145.0");
    expect(compareCoreSemanticVersions("0.99.0", "0.145.0")).toBe(-1);
    expect(compareCoreSemanticVersions("2.0.64", "2.0.64")).toBe(0);
    expect(compareCoreSemanticVersions("3.0.0", "2.99.99")).toBe(1);
  });

  test("invokes executables and classifies filesystem entries without Host policy", async () => {
    const root = mkdtempSync(join(tmpdir(), "apkit-adapter-services-"));
    temporaryDirectories.push(root);
    const directory = join(root, "directory");
    const file = join(root, "file");
    const link = join(root, "link");
    mkdirSync(directory);
    writeFileSync(file, "content\n");
    symlinkSync(file, link);

    expect(await classifyFileSystemEntry(join(root, "missing"))).toBe("missing");
    expect(await classifyFileSystemEntry(directory)).toBe("directory");
    expect(await classifyFileSystemEntry(file)).toBe("file");
    expect(await classifyFileSystemEntry(link)).toBe("symlink");

    const result = await invokeExecutable(
      process.execPath,
      ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
      { env: process.env, timeoutMs: 10_000 },
    );
    expect(result).toEqual({ stderr: "err", stdout: "out" });
  });
});
