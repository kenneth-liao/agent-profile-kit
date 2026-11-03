import { expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir, writeTree } from "./fixtures.js";

setDefaultTimeout(30_000);

const SCRIPT = join(import.meta.dir, "../scripts/release.ts");
function run(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });
}
async function repository() {
  const root = await tempDir("release");
  await writeTree(root, {
    ".gitignore": "dist/\n",
    "package.json": JSON.stringify({ name: "agent-profile-kit", version: "0.239.0", bin: { apkit: "dist/cli.js" }, files: ["dist/cli.js"], scripts: { build: "bun build.ts", prepack: "exit 88" } }),
    "build.ts": 'await Bun.write("dist/cli.js", "#!/usr/bin/env node\\nconsole.log(42);\\n");',
    "test/cli.test.ts": 'import {test,expect,describe} from "bun:test"; describe("installed package",()=>test("packed CLI",()=>expect(Bun.spawnSync(["node", Bun.env.APKIT_CLI!]).stdout.toString().trim()).toBe("42")));',
  });
  for (const args of [["init"], ["add", "."], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root });
    expect(result.status).toBe(0);
  }
  return root;
}

test("candidate records its commit and prerelease version without changing the source manifest", async () => {
  const root = await repository();
  const output = await tempDir("candidate");
  const result = run(root, "candidate", output, "rc.1");
  expect(result.status).toBe(0);
  const identity = JSON.parse(await readFile(join(output, "candidate.json"), "utf8"));
  expect(identity.version).toBe("0.239.0-rc.1");
  expect(identity.commit).toMatch(/^[a-f0-9]{40}$/);
  expect(identity.digest).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version).toBe("0.239.0");
  const packed = spawnSync("tar", ["-xOf", join(output, identity.archive), "package/package.json"], { encoding: "utf8" });
  expect(JSON.parse(packed.stdout).version).toBe("0.239.0-rc.1");
});

async function prepared() {
  const root = await repository();
  const output = await tempDir("candidate");
  expect(run(root, "candidate", output).status).toBe(0);
  const identity = JSON.parse(await readFile(join(output, "candidate.json"), "utf8"));
  return { root, output, identity };
}

test("plain qualification records the full selection and observed runtimes for the exact packed CLI", async () => {
  const { root, output, identity } = await prepared();
  const result = run(root, "qualify", output);
  expect(result.stderr).not.toContain("error:");
  expect(result.status).toBe(0);
  const record = JSON.parse(await readFile(join(output, "qualification-record.json"), "utf8"));
  expect(record).toMatchObject({ commit: identity.commit, version: "0.239.0", digest: identity.digest, selectedTests: ["test/cli.test.ts"], result: "passed", tests: 1 });
  expect(record.command.slice(0, 2)).toEqual(["bun", "test"]);
  expect(record.runtime.bun).toBe(Bun.version);
  expect(record.runtime.node).toMatch(/^v\d+/);
  expect(run(root, "verify", output, identity.commit).status).toBe(0);
});

test("release gate rejects substituted bytes, revision, or incomplete and omitted-selection records", async () => {
  const { root, output, identity } = await prepared();
  expect(run(root, "qualify", output).status).toBe(0);
  expect(run(root, "verify", output, "0".repeat(40)).status).not.toBe(0);
  expect(run(root, "verify", output, identity.commit, "0.239.0-rc.9").status).not.toBe(0);
  const path = join(output, "qualification-record.json");
  const record = JSON.parse(await readFile(path, "utf8"));
  for (const change of [{ selectedTests: [] }, { result: "incomplete" }, { result: "failed" }, { version: "0.239.0-rc.2" }]) {
    await writeFile(path, JSON.stringify({ ...record, ...change }));
    expect(run(root, "verify", output, identity.commit).status).not.toBe(0);
  }
  await writeFile(path, JSON.stringify(record));
  await writeFile(join(output, identity.archive), "substituted bytes");
  expect(run(root, "verify", output, identity.commit).status).not.toBe(0);
  expect(run(root, "qualify", output).status).not.toBe(0);
  expect(JSON.parse(await readFile(path, "utf8")).result).toBe("failed");
});

async function changedFixture(content: string, other: Record<string, string> = {}) {
  const root = await repository();
  await writeTree(root, { "test/cli.test.ts": content, ...other });
  spawnSync("git", ["add", "."], { cwd: root });
  expect(spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "changed tests"], { cwd: root }).status).toBe(0);
  const output = await tempDir("candidate");
  expect(run(root, "candidate", output).status).toBe(0);
  return { root, output };
}

test("failing, skipped, omitted-file and interrupted plain test runs cannot record success", async () => {
  for (const content of [
    'import {test,expect} from "bun:test"; test("failure",()=>expect(1).toBe(2));',
    'import {test} from "bun:test"; test.skip("required",()=>{});',
    'import {test} from "bun:test"; test("interrupted",()=>process.kill(process.pid,"SIGTERM"));',
  ]) {
    const { root, output } = await changedFixture(content);
    expect(run(root, "qualify", output).status).not.toBe(0);
    const record = JSON.parse(await readFile(join(output, "qualification-record.json"), "utf8"));
    expect(record.result).toBe("failed");
    expect(run(root, "verify", output, record.commit).status).not.toBe(0);
  }
  const { root, output } = await changedFixture('import {test} from "bun:test"; test("one",()=>{});', {
    "test/required.test.ts": 'import {test} from "bun:test"; test("required",()=>{});',
    "bunfig.toml": '[test]\nroot = "./selected"\n',
    "selected/only.test.ts": 'import {test} from "bun:test"; test("selected",()=>{});',
  });
  expect(run(root, "qualify", output).status).not.toBe(0);
  const record = JSON.parse(await readFile(join(output, "qualification-record.json"), "utf8"));
  expect(record.result).toBe("failed");
  expect(record.error).toContain("omitted");
});

test("workflow dry run excludes the entire write job and prereleases select next on a non-default ref", async () => {
  const { parse } = await import("yaml");
  const workflow = parse(await readFile(join(import.meta.dir, "../.github/workflows/release.yml"), "utf8"));
  expect(workflow.on.workflow_dispatch.inputs["dry-run"].default).toBe(true);
  const publish = workflow.jobs["publish-release"];
  expect(publish.if).toBe("${{ !inputs.dry-run }}");
  expect(publish.permissions).toEqual({ contents: "write", "id-token": "write" });
  const verify = workflow.jobs["verify-release-candidate"];
  expect(verify.permissions).toEqual({ contents: "read" });
  const policy = verify.steps.find((step: { name: string }) => step.name === "Validate release identity").run;
  const root = await repository();
  // Dry runs and next prereleases must not query main. Stub gh so an accidental query fails.
  const { chmod } = await import("node:fs/promises");
  await writeTree(root, { "bin/gh": "#!/bin/sh\nexit 91\n" });
  await chmod(join(root, "bin/gh"), 0o755);
  const env = { ...process.env, PATH: join(root, "bin") + ":" + process.env.PATH, VERSION: "0.239.0", PRERELEASE: "rc.1", DRY_RUN: "true", GITHUB_REF: "refs/heads/spec/728-agent-first-cutover" };
  if (process.platform !== "win32") {
    expect(spawnSync("bash", ["-e", "-c", policy], { cwd: root, env, encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("bash", ["-e", "-c", policy], { cwd: root, env: { ...env, DRY_RUN: "false" }, encoding: "utf8" }).status).toBe(0);
    expect(spawnSync("bash", ["-e", "-c", policy], { cwd: root, env: { ...env, DRY_RUN: "false", PRERELEASE: "" }, encoding: "utf8" }).status).not.toBe(0);
  }
  const npm = publish.steps.find((step: { name: string }) => step.name === "Publish to npm");
  expect(npm.run).toContain('--tag "$DIST_TAG"');
  expect(publish.env.DIST_TAG).toContain("'next'");
  expect(publish.steps.some((step: { run?: string }) => /npm pack|run build/.test(step.run ?? ""))).toBe(false);
});
