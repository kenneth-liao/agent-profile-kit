// Materializes the migration fixture that apkit 0.238.0 wrote (test/migration/0.238.0/README.md).
import { spawnSync } from "node:child_process";
import { chmod, cp, lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hashOldDirectory, oldFileHash } from "../src/migrate.js";
import { tempDir } from "./fixtures.js";

export const MIGRATION_FIXTURE = join(import.meta.dir, "migration", "0.238.0");

export interface MigrationFixture {
  /** The fresh root that holds everything below. */
  readonly root: string;
  /** The user's home folder, with the old state at `.agents/agent-profile-kit`. */
  readonly home: string;
  readonly workspace: string;
  /** The Project the old engine installed into: a Git repository. */
  readonly project: string;
  /** The same Project before the old install, for a fresh install to compare with. */
  readonly pristine: string;
  readonly state: string;
}

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** Git keeps 0644 and 0755 only, and the old receipts record exact modes: set what 0.238.0 had. */
async function setModes(folder: string): Promise<void> {
  await chmod(folder, 0o755);
  for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.parentPath.split(/[\\/]/).includes(".git") || entry.name === ".git") continue;
    await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644);
  }
}

/**
 * Copies the fixture into a fresh folder: the Project and the pristine copy become Git
 * repositories, the old exclude file is restored, and `{{ROOT}}` in the old state becomes
 * the new root. On Windows, POSIX modes do not exist, so a receipt recorded on macOS
 * can never match there: only on Windows, each output's mode and hash are re-recorded
 * from the copied tree. The engine itself always compares exactly, as 0.238.0 did.
 */
export async function materializeMigration(): Promise<MigrationFixture> {
  const root = await tempDir("migration");
  const home = join(root, "home");
  const project = join(root, "project");
  const pristine = join(root, "pristine");
  const workspace = join(root, "workspace");
  const state = join(home, ".agents", "agent-profile-kit");
  for (const part of ["home", "project", "pristine", "workspace"]) await cp(join(MIGRATION_FIXTURE, part), join(root, part), { recursive: true });
  await setModes(project);
  for (const folder of [project, pristine]) git(folder, "init", "-q");
  // Both copies get the same exclude file, so they differ only by the old block.
  const exclude = await readFile(join(MIGRATION_FIXTURE, "git-info-exclude"), "utf8");
  await writeFile(join(project, ".git", "info", "exclude"), exclude);
  await writeFile(join(pristine, ".git", "info", "exclude"), exclude.replace(/# BEGIN Agent Profile Kit[^]*# END Agent Profile Kit generated paths\n/, ""));
  for (const file of ["config.yaml", join("state", "manifest.json")]) {
    const path = join(state, file);
    const value = file.endsWith(".json") ? JSON.stringify(root).slice(1, -1) : root;
    const text = (await readFile(path, "utf8")).replaceAll("{{ROOT}}", value);
    await writeFile(path, text);
  }
  if (process.platform === "win32") await rerecord(join(state, "state", "manifest.json"));
  return { root, home, workspace, project, pristine, state };
}

async function rerecord(manifest: string): Promise<void> {
  const data = JSON.parse(await readFile(manifest, "utf8"));
  for (const receipt of data.receipts) {
    for (const output of receipt.outputs) {
      const path = join(receipt.project, ...output.path.split("/"));
      output.mode = (await lstat(path)).mode & 0o777;
      output.hash = output.type === "file" ? await oldFileHash(path) : await hashOldDirectory(path);
    }
  }
  await writeFile(manifest, JSON.stringify(data, null, 2));
}

/** One Project on a fixture machine: a copy of the 0.238.0 Project under `name`, with its own receipt. */
export interface MachineProject {
  readonly name: string;
  readonly profile?: string;
  readonly agents?: readonly string[];
  readonly retired?: boolean;
  /** Recorded, but its folder is not created. */
  readonly missing?: boolean;
}

export interface MachineFixture extends MigrationFixture {
  /** Each Project's folder, by name. */
  readonly projects: Readonly<Record<string, string>>;
}

/**
 * A machine where 0.238.0 installed several Projects (SRC-25c). Each Project is a copy of the
 * 0.238.0 Project, a Git repository with the 0.238.0 exclude file. Its receipt is the 0.238.0
 * receipt with that Project's path, Profile, and a subset of its agents: the outputs, modes,
 * hashes, and bytes are exactly what 0.238.0 wrote (test/migration/0.238.0/README.md).
 */
export async function materializeMachine(projects: readonly MachineProject[]): Promise<MachineFixture> {
  const fixture = await materializeMigration();
  const manifest = join(fixture.state, "state", "manifest.json");
  const data = JSON.parse(await readFile(manifest, "utf8"));
  const [template] = data.receipts;
  const folders: Record<string, string> = {};
  data.receipts = [];
  for (const entry of projects) {
    const folder = join(fixture.root, entry.name);
    folders[entry.name] = folder;
    if (!entry.missing && folder !== fixture.project) await cp(fixture.project, folder, { recursive: true });
    const agents = entry.agents ?? Object.keys(template.hosts);
    data.receipts.push({
      ...template,
      installation_id: `${template.installation_id}-${entry.name}`,
      project: folder,
      profile_id: entry.profile ?? template.profile_id,
      hosts: Object.fromEntries(agents.map((agent) => [agent, template.hosts[agent]])),
      ...(entry.retired ? { retired: true } : {}),
    });
  }
  await writeFile(manifest, JSON.stringify(data, null, 2));
  return { ...fixture, projects: folders };
}
