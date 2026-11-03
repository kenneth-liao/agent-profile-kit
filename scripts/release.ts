// A small artifact/evidence boundary around plain Bun tests. CI owns timeouts.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

function command(exe: string, args: string[], env = process.env): string {
  // Windows cannot execute npm.cmd without a shell. Invoke its JS entrypoint instead.
  if (exe === "npm" && process.platform === "win32") {
    const node = command("node", ["-p", "process.execPath"]).trim();
    args = [join(dirname(node), "node_modules", "npm", "bin", "npm-cli.js"), ...args];
    exe = node;
  }
  const result = spawnSync(exe, args, { env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${exe} ${args.join(" ")}: ${result.error ?? result.signal ?? result.status}\n${result.stdout ?? ""}`);
  return result.stdout;
}
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const save = (path: string, value: unknown) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const digest = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const head = () => command("git", ["rev-parse", "HEAD"]).trim();
function clean() {
  if (command("git", ["status", "--porcelain"]).trim()) throw new Error("Release source must be clean");
}
function selection(): string[] {
  return command("git", ["ls-files", "test"]).trim().split("\n").filter((file) => /\.test\.ts$/.test(file)).sort();
}
interface Candidate { commit: string; version: string; archive: string; digest: string }
interface Qualification {
  commit: string;
  version: string;
  digest: string;
  selectedTests: string[];
  command: string[];
  runtime: { bun: string; node: string; platform: string; arch: string };
  result: "incomplete" | "failed" | "passed";
  tests?: number;
  error?: string;
}

async function candidate(directory: string, prerelease?: string) {
  clean();
  if (prerelease !== undefined && !/^(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*$/.test(prerelease)) throw new Error("Invalid prerelease suffix");
  const original = await readFile("package.json", "utf8");
  const manifest = JSON.parse(original);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error("Source version must be stable SemVer");
  const commit = head();
  const version = manifest.version + (prerelease ? `-${prerelease}` : "");
  await mkdir(directory, { recursive: true });
  try {
    if (prerelease) await save("package.json", { ...manifest, version });
    command(process.execPath, ["run", "build"]);
    const packed = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", directory]));
    if (packed.length !== 1) throw new Error("Expected one archive");
    const archive = basename(packed[0].filename);
    await save(join(directory, "candidate.json"), { commit, version, archive, digest: await digest(join(directory, archive)) });
  } finally {
    await writeFile("package.json", original);
  }
  clean();
  if (head() !== commit) throw new Error("Source changed while creating candidate");
}

async function verify(directory: string, commit: string, version?: string) {
  const identity: Candidate = await json(join(directory, "candidate.json"));
  const record: Qualification = await json(join(directory, "qualification-record.json"));
  if (!identity.archive || identity.archive !== `agent-profile-kit-${identity.version}.tgz` || basename(identity.archive) !== identity.archive || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid candidate identity");
  if (identity.commit !== commit || record.commit !== commit) throw new Error("Tested commit differs from release commit");
  if (identity.digest !== await digest(join(directory, identity.archive)) || record.digest !== identity.digest) throw new Error("Candidate digest mismatch");
  if (record.version !== identity.version || record.result !== "passed" || !Number.isSafeInteger(record.tests) || Number(record.tests) < 1 || !record.runtime?.bun || !record.runtime?.node || !record.runtime?.platform || !record.runtime?.arch) throw new Error("Incomplete qualification");
  if (head() !== commit) throw new Error("Verifier checkout differs from release commit");
  if (version && identity.version !== version) throw new Error("Packed version differs from requested release");
  const packed = JSON.parse(command("tar", ["-xOf", join(directory, identity.archive), "package/package.json"]));
  if (packed.name !== "agent-profile-kit" || packed.version !== identity.version) throw new Error("Packed manifest identity mismatch");
  const required = selection();
  if (!required.length || JSON.stringify(record.selectedTests) !== JSON.stringify(required) || JSON.stringify(record.command) !== JSON.stringify(testCommand())) throw new Error("Required selection omitted or changed");
  return identity;
}
function testCommand() {
  // The placeholder keeps the command reproducible when the evidence directory moves.
  return ["bun", "test", "--reporter=junit", "--reporter-outfile=<candidate>/tests.xml"];
}
async function qualify(directory: string) {
  const identity: Candidate = await json(join(directory, "candidate.json"));
  const path = join(directory, "qualification-record.json");
  const record: Qualification = {
    commit: head(), version: identity.version, digest: identity.digest,
    selectedTests: selection(), command: testCommand(),
    runtime: { bun: Bun.version, node: "", platform: process.platform, arch: process.arch },
    result: "incomplete",
  };
  await save(path, record);
  try {
    record.runtime.node = command("node", ["--version"]).trim();
    clean();
    if (record.commit !== identity.commit || await digest(join(directory, identity.archive)) !== identity.digest) throw new Error("Candidate source or digest mismatch");
    const prefix = join(directory, "install");
    command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, join(directory, identity.archive)]);
    const cli = join(prefix, "node_modules", "agent-profile-kit", "dist", "cli.js");
    command(process.execPath, ["test", "--reporter=junit", "--reporter-outfile=" + join(directory, "tests.xml")], { ...process.env, APKIT_CLI: cli });
    const report = await readFile(join(directory, "tests.xml"), "utf8");
    const suites = [...report.matchAll(/<testsuite\s[^>]*file="([^"]+)"[^>]*>/g)];
    const observed = [...new Set(suites.map((match) => relative(process.cwd(), resolve(match[1]!)).replaceAll("\\", "/")))].sort();
    if (!record.selectedTests.length || JSON.stringify(observed) !== JSON.stringify(record.selectedTests)) throw new Error("Required test file omitted");
    if (/\b(?:failures|errors|skipped)="[1-9]\d*"/.test(report) || suites.some((match) => /\btests="0"/.test(match[0]))) throw new Error("Required tests failed or were skipped");
    const count = /<testsuites\s[^>]*tests="(\d+)"/.exec(report);
    record.tests = Number(count?.[1]);
    if (!record.tests) throw new Error("No tests completed");
    clean();
    if (head() !== record.commit) throw new Error("Source changed during qualification");
    record.result = "passed";
    await save(path, record);
    await verify(directory, record.commit);
  } catch (error) {
    record.result = "failed";
    record.error = String(error);
    await save(path, record);
    throw error;
  }
}

if (import.meta.main) {
  try {
    const [operation, directory, arg, version, extra] = process.argv.slice(2);
    if (!directory || extra) throw new Error("Usage: bun scripts/release.ts candidate <directory> [prerelease] | qualify <directory> | verify <directory> <commit> [version]");
    if (operation === "candidate" && !version) await candidate(resolve(directory), arg);
    else if (operation === "qualify" && !arg && !version) await qualify(resolve(directory));
    else if (operation === "verify" && arg) await verify(resolve(directory), arg, version);
    else throw new Error("Unknown release operation or unexpected arguments");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
