import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "yaml";

import { codexSkillRoots } from "../adapters/codex.js";
import { parseSkill, type Skill } from "../schemas/skill.js";
import {
  formatSkillLibraryManifest,
  parseSkillLibraryManifest,
  type SkillLibraryManifest,
} from "../schemas/skill-library-manifest.js";
import { hasErrorCode } from "./fs-error.js";
import { hashOutputDirectory, hashSkillCatalog } from "./hashes.js";
import { withCodexLifecycleLock } from "./codex-lifecycle-lock.js";

export const SKILL_LIBRARY_MANIFEST = ".agent-profile-kit.yaml";
const SKILL_LIBRARY_STATE_MARKER = ".agent-profile-kit-owned";

export interface CodexSkillLibraryPlan {
  readonly additions: readonly string[];
  readonly changes: readonly string[];
  readonly destination: string;
  readonly home: string;
  readonly removals: readonly string[];
  readonly skills: ReadonlyMap<string, Skill>;
  readonly workspaceInputHash: string;
}

export interface CodexSkillLibraryLease {
  readonly generation: string;
  readonly path: string;
}

export function codexSkillLibraryPath(home: string): string {
  return join(home, ".agents", "skills", "agent-profile-kit");
}

function codexSkillLibraryStatePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "codex-skill-library");
}

function codexSkillLibraryLeasesPath(home: string): string {
  return join(codexSkillLibraryStatePath(home), "leases");
}

async function assertOwnedOrMissingLibraryState(home: string): Promise<void> {
  const state = codexSkillLibraryStatePath(home);
  let entry;
  try {
    entry = await lstat(state);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (!entry.isDirectory()) {
    throw new Error(`Refusing unowned Codex Skill Library state at ${state}`);
  }
  try {
    if (
      (await readFile(join(state, SKILL_LIBRARY_STATE_MARKER), "utf8")) !==
      "agent-profile-kit\n"
    ) {
      throw new Error("invalid ownership marker");
    }
  } catch (error) {
    throw new Error(
      `Refusing unowned Codex Skill Library state at ${state}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function ensureOwnedLibraryState(home: string): Promise<string> {
  await assertOwnedOrMissingLibraryState(home);
  const state = codexSkillLibraryStatePath(home);
  if ((await pathKind(state)) === "missing") {
    await mkdir(state);
    await writeFile(join(state, SKILL_LIBRARY_STATE_MARKER), "agent-profile-kit\n");
  }
  return state;
}

async function ensurePlainOwnedDirectory(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isDirectory()) {
      throw new Error(`Agent Profile Kit state path must be a directory: ${path}`);
    }
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    await mkdir(path);
  }
}

function homeFromLibraryPath(destination: string): string {
  return dirname(dirname(dirname(destination)));
}

async function pathKind(path: string): Promise<"directory" | "missing" | "other"> {
  try {
    const entry = await lstat(path);
    if (entry.isDirectory()) return "directory";
    if (entry.isSymbolicLink()) {
      try {
        return (await stat(path)).isDirectory() ? "directory" : "other";
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) return "other";
        throw error;
      }
    }
    return "other";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "missing";
    throw error;
  }
}

export async function readOwnedSkillLibrary(destination: string): Promise<SkillLibraryManifest> {
  if ((await pathKind(destination)) !== "directory") {
    throw new Error(`Codex Skill Library at ${destination} must be a directory`);
  }
  try {
    const entry = await lstat(destination);
    if (!entry.isSymbolicLink()) {
      throw new Error("discovery path is not an Agent Profile Kit generation pointer");
    }
    const target = await realpath(destination);
    const generations = await realpath(
      join(codexSkillLibraryStatePath(homeFromLibraryPath(destination)), "generations"),
    );
    if (!target.startsWith(`${generations}/`)) {
      throw new Error("generation pointer targets a path outside Agent Profile Kit-owned state");
    }
    return readSkillLibraryManifest(destination);
  } catch (error) {
    throw new Error(
      `Refusing unowned Codex Skill Library destination at ${destination}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readSkillLibraryManifest(destination: string): Promise<SkillLibraryManifest> {
  return parseSkillLibraryManifest(
    await readFile(join(destination, SKILL_LIBRARY_MANIFEST), "utf8"),
  );
}

export async function assertCodexSkillLibraryIntact(
  destination: string,
): Promise<SkillLibraryManifest> {
  const manifest = (await lstat(destination)).isSymbolicLink()
    ? await readOwnedSkillLibrary(destination)
    : await readSkillLibraryManifest(destination);
  const entries = await readdir(destination, { withFileTypes: true });
  const skillDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const unexpected = entries.filter(
    (entry) => !entry.isDirectory() && !(entry.isFile() && entry.name === SKILL_LIBRARY_MANIFEST),
  );
  if (
    unexpected.length > 0 ||
    JSON.stringify(skillDirectories) !== JSON.stringify([...manifest.skills].sort())
  ) {
    throw new Error(`Codex Skill Library at ${destination} does not match its ownership Manifest`);
  }
  const outputHash = await hashOutputDirectory(destination, [SKILL_LIBRARY_MANIFEST]);
  if (outputHash !== manifest.outputHash) {
    throw new Error(`Codex Skill Library at ${destination} has drifted generated output`);
  }
  return manifest;
}

export async function pinCodexSkillLibraryUnderLock(
  home: string,
): Promise<{ readonly lease: CodexSkillLibraryLease; readonly manifest: SkillLibraryManifest }> {
  const destination = codexSkillLibraryPath(home);
  const manifest = await assertCodexSkillLibraryIntact(destination);
  const generation = await realpath(destination);
  const leases = codexSkillLibraryLeasesPath(home);
  await ensurePlainOwnedDirectory(leases);
  const generationLeases = join(leases, basename(generation));
  await ensurePlainOwnedDirectory(generationLeases);
  const leasePath = join(generationLeases, `${randomUUID()}.lock`);
  await writeFile(leasePath, "agent-profile-kit Codex run lease\n", { flag: "wx" });
  return { lease: { generation, path: leasePath }, manifest };
}

export async function releaseCodexSkillLibraryLeaseUnderLock(
  lease: CodexSkillLibraryLease,
): Promise<void> {
  await rm(lease.path, { force: true });
}

async function leaseIsLocked(path: string): Promise<boolean> {
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      "/usr/bin/lockf",
      ["-s", "-t", "0", "-k", path, "/usr/bin/true"],
      { stdio: "ignore" },
    );
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  if (exitCode === 0) return false;
  if (exitCode === 75) return true;
  throw new Error(`Could not inspect Codex run lease at ${path} (exit ${exitCode})`);
}

export async function codexSkillLibraryHasLeases(home: string): Promise<boolean> {
  const root = codexSkillLibraryLeasesPath(home);
  try {
    if (!(await lstat(root)).isDirectory()) {
      throw new Error(`Agent Profile Kit lease path must be a directory: ${root}`);
    }
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  for (const generation of await readdir(root, { withFileTypes: true })) {
    if (!generation.isDirectory()) continue;
    const generationPath = join(root, generation.name);
    for (const lease of await readdir(generationPath, { withFileTypes: true })) {
      if (!lease.isFile()) {
        throw new Error(`Codex run lease must be a file: ${join(generationPath, lease.name)}`);
      }
      const path = join(generationPath, lease.name);
      if (await leaseIsLocked(path)) return true;
      await rm(path, { force: true });
    }
  }
  return false;
}

async function discoveredSkillFiles(root: string, excludedRoot: string): Promise<readonly string[]> {
  if ((await pathKind(root)) !== "directory") return [];
  const files: string[] = [];
  const visited = new Set<string>();
  async function visit(directory: string): Promise<void> {
    if (resolve(directory) === resolve(excludedRoot)) return;
    const canonical = await realpath(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (resolve(path) === resolve(excludedRoot)) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isSymbolicLink()) {
        try {
          if ((await stat(path)).isDirectory()) await visit(path);
        } catch (error) {
          if (!hasErrorCode(error, "ENOENT")) throw error;
        }
      } else if (entry.isFile() && entry.name === "SKILL.md") files.push(path);
    }
  }
  await visit(root);
  return files;
}

export async function assertNoCodexSkillConflicts(
  roots: readonly string[],
  destination: string,
  desired: { readonly has: (id: string) => boolean },
): Promise<void> {
  const seenRoots = new Set<string>();
  for (const root of roots) {
    const canonical = resolve(root);
    if (seenRoots.has(canonical)) continue;
    seenRoots.add(canonical);
    for (const file of await discoveredSkillFiles(root, destination)) {
      const source = await readFile(file, "utf8");
      const delimiter = "---\n";
      const closing = source.startsWith(delimiter)
        ? source.indexOf(delimiter, delimiter.length)
        : -1;
      if (closing < 0) continue;
      let header: unknown;
      try {
        header = parse(source.slice(delimiter.length, closing));
      } catch {
        continue;
      }
      const name =
        typeof header === "object" &&
        header !== null &&
        !Array.isArray(header) &&
        "name" in header &&
        typeof header.name === "string"
          ? header.name
          : undefined;
      if (name && desired.has(name)) {
        throw new Error(
          `Workspace Skill '${name}' conflicts with an existing Codex Skill at ${file}`,
        );
      }
    }
  }
}

async function projectedSourceHash(skill: Skill): Promise<string> {
  return hashOutputDirectory(skill.path, ["agent-profile-kit.yaml"]);
}

async function installedSkillHash(destination: string, id: string): Promise<string | undefined> {
  const path = join(destination, id);
  if ((await pathKind(path)) !== "directory") return undefined;
  return hashOutputDirectory(path, []);
}

export async function planCodexSkillLibrary(
  home: string,
  skills: ReadonlyMap<string, Skill>,
): Promise<CodexSkillLibraryPlan> {
  const destination = codexSkillLibraryPath(home);
  await assertOwnedOrMissingLibraryState(home);
  const kind = await pathKind(destination);
  let existingSkills: readonly string[] = [];
  if (kind === "other") {
    throw new Error(`Refusing unowned Codex Skill Library destination at ${destination}`);
  }
  if (kind === "directory") {
    existingSkills = (await readOwnedSkillLibrary(destination)).skills;
  }
  await assertNoCodexSkillConflicts(
    await codexSkillRoots(home, process.cwd()),
    destination,
    skills,
  );

  const additions: string[] = [];
  const changes: string[] = [];
  const desiredIds = [...skills.keys()].sort();
  for (const id of desiredIds) {
    const installedHash = await installedSkillHash(destination, id);
    if (!installedHash) additions.push(id);
    else if (installedHash !== (await projectedSourceHash(skills.get(id)!))) changes.push(id);
  }
  const desiredSet = new Set(desiredIds);
  const removals = existingSkills.filter((id) => !desiredSet.has(id)).sort();
  return {
    additions,
    changes,
    destination,
    home,
    removals,
    skills,
    workspaceInputHash: await hashSkillCatalog(skills),
  };
}

async function stageLibrary(staging: string, plan: CodexSkillLibraryPlan): Promise<void> {
  const stagedSkills = new Map<string, Skill>();
  for (const [id, skill] of [...plan.skills.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const destination = join(staging, id);
    await cp(skill.path, destination, {
      recursive: true,
      filter: (source) => source !== join(skill.path, "agent-profile-kit.yaml"),
    });
    const stagedSkill = parseSkill(
      await readFile(join(destination, "SKILL.md"), "utf8"),
      join(destination, "SKILL.md"),
      destination,
    );
    if (stagedSkill.id !== id) {
      throw new Error(`Staged Codex Skill '${id}' changed identity to '${stagedSkill.id}'`);
    }
    stagedSkills.set(id, stagedSkill);
  }
  if ((await hashSkillCatalog(stagedSkills)) !== plan.workspaceInputHash) {
    throw new Error("Staged Codex Skill Library does not match the installation plan");
  }
  const manifest: SkillLibraryManifest = {
    outputHash: await hashOutputDirectory(staging, [SKILL_LIBRARY_MANIFEST]),
    owner: "agent-profile-kit",
    schemaVersion: 1,
    skills: [...plan.skills.keys()].sort(),
    workspaceInputHash: plan.workspaceInputHash,
  };
  await writeFile(join(staging, SKILL_LIBRARY_MANIFEST), formatSkillLibraryManifest(manifest));
  parseSkillLibraryManifest(await readFile(join(staging, SKILL_LIBRARY_MANIFEST), "utf8"));
}

async function publishGeneration(
  generation: string,
  destination: string,
): Promise<void> {
  if ((await pathKind(destination)) !== "missing") await readOwnedSkillLibrary(destination);
  await mkdir(dirname(destination), { recursive: true });
  const temporaryLink = join(
    dirname(destination),
    `.agent-profile-kit-link-${process.pid}-${Date.now()}`,
  );
  try {
    await symlink(generation, temporaryLink, "dir");
    await rename(temporaryLink, destination);
  } catch (error) {
    await rm(temporaryLink, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncCodexSkillLibraryUnderLock(
  plan: CodexSkillLibraryPlan,
): Promise<void> {
  await assertNoCodexSkillConflicts(
    await codexSkillRoots(plan.home, process.cwd()),
    plan.destination,
    plan.skills,
  );
  if ((await hashSkillCatalog(plan.skills)) !== plan.workspaceInputHash) {
    throw new Error("Workspace Skills changed after the Codex Skill Library plan was created");
  }
  const state = await ensureOwnedLibraryState(plan.home);
  const generations = join(state, "generations");
  await ensurePlainOwnedDirectory(generations);
  if ((await pathKind(plan.destination)) === "directory") {
    await readOwnedSkillLibrary(plan.destination);
  }
  const generation = join(generations, plan.workspaceInputHash.slice("sha256:".length));
  if ((await pathKind(generation)) === "directory") {
    await assertCodexSkillLibraryIntact(generation);
    await publishGeneration(generation, plan.destination);
    return;
  }
  const staging = await mkdtemp(join(state, ".generation-"));
  try {
    await stageLibrary(staging, plan);
    await rename(staging, generation);
    await publishGeneration(generation, plan.destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function syncCodexSkillLibrary(plan: CodexSkillLibraryPlan): Promise<void> {
  return withCodexLifecycleLock(plan.home, () => syncCodexSkillLibraryUnderLock(plan));
}

export async function assertCodexSkillLibraryRemovable(home: string): Promise<string> {
  const destination = codexSkillLibraryPath(home);
  try {
    await assertCodexSkillLibraryIntact(destination);
  } catch (error) {
    throw new Error(
      `Refusing to remove Codex Skill Library at ${destination}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return destination;
}

export async function removeOwnedCodexSkillLibrary(home: string): Promise<string> {
  const destination = await assertCodexSkillLibraryRemovable(home);
  await rm(destination, { force: false });
  await rm(codexSkillLibraryStatePath(home), { recursive: true, force: false });
  return destination;
}
