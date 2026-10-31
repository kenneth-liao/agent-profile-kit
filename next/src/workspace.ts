// Reads and validates a Workspace. The format is the Workspace contract
// (next/docs/workspace-contract.md), as simplified by ADR-0057.
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";

export interface ContextModule {
  readonly id: string;
  readonly text: string;
}

export interface SkillFile {
  /** POSIX path inside the Skill package. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

export interface Skill {
  readonly name: string;
  readonly disableModelInvocation: boolean;
  readonly files: readonly SkillFile[];
}

export interface Profile {
  readonly id: string;
  readonly context: readonly string[];
  readonly skills: readonly string[];
}

export interface Violation {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface Workspace {
  readonly root: string;
  readonly context: ReadonlyMap<string, ContextModule>;
  readonly skills: ReadonlyMap<string, Skill>;
  readonly profiles: ReadonlyMap<string, Profile>;
  /** Errors: each makes an install wrong or ambiguous, so it blocks installs. */
  readonly violations: readonly Violation[];
  /** Files apkit skips, and other harmless findings. A warning never blocks an install (ADR-0057 §4). */
  readonly warnings: readonly Violation[];
}

/** The codes that are warnings; every other code is an error. */
export const WARNINGS: ReadonlySet<string> = new Set([
  "stray-context-file",
  "stray-skill-file",
  "stray-profile-file",
  "profile-in-subfolder",
  "symlink",
  "empty-content",
  "profile-without-artifacts",
]);

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isHidden = (name: string) => name.startsWith(".");
/** Code-point order, so results are identical on every machine and locale. */
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export async function loadWorkspace(root: string): Promise<Workspace> {
  const violations: Violation[] = [];
  const add = (code: string, path: string, message: string) => violations.push({ code, path, message });

  await checkManifest(root, add);
  const { context, declared } = await loadContext(root, add);
  const skills = await loadSkills(root, add);
  const { profiles, selections } = await loadProfiles(root, skills, add);

  // Every readable selection is checked, even in a Profile with another error, so one run names every change.
  for (const { profile, path } of selections) {
    for (const id of profile.context) {
      if (!context.has(id)) {
        add("missing-context-reference", path, `Profile '${profile.id}' names Context '${id}', which does not exist${contextFix(id, context, declared)}.`);
      }
    }
    for (const name of profile.skills) {
      if (!skills.has(name)) add("missing-skill-reference", path, `Profile '${profile.id}' names Skill '${name}', which does not exist.`);
    }
  }
  return {
    root,
    context,
    skills,
    profiles,
    violations: violations.filter((v) => !WARNINGS.has(v.code)),
    warnings: violations.filter((v) => WARNINGS.has(v.code)),
  };
}

type Add = (code: string, path: string, message: string) => void;

/**
 * Names the change for a Context reference that matches no ID, when one is clear. Earlier releases
 * took a Context ID from frontmatter `id` or from the file name alone; today the ID is the path.
 */
function contextFix(id: string, context: ReadonlyMap<string, ContextModule>, declared: ReadonlyMap<string, readonly string[]>): string {
  const moved = [...context.keys()].filter((other) => other.endsWith(`/${id}`));
  if (moved.length === 1) return `; use '${moved[0]}', the ID of context/${moved[0]}.md`;
  const files = declared.get(id) ?? [];
  if (files.length === 1) {
    return `; ${files[0]} declares \`id: ${id}\`, but a Context ID is its path, so rename ${files[0]} to context/${id}.md`;
  }
  return "";
}

/** The file whose presence makes a folder a Workspace (ADR-0057 §6). */
const MARKER = "apkit-workspace.yaml";
/** The schema version this apkit reads; a missing `schema_version` means 1. */
const SCHEMA_VERSION = 1;

async function checkManifest(root: string, add: Add): Promise<void> {
  let text: string;
  try {
    text = await readFile(join(root, MARKER), "utf8");
  } catch {
    if (await exists(join(root, "workspace.yaml"))) {
      add("workspace-old-manifest", "workspace.yaml", `Rename workspace.yaml to ${MARKER}; that file now marks a Workspace.`);
    } else {
      add("workspace-missing-manifest", MARKER, `A Workspace needs an ${MARKER} file; it may be empty.`);
    }
    return;
  }
  let manifest: unknown;
  try {
    manifest = parseYaml(text);
  } catch {
    add("workspace-manifest", MARKER, `${MARKER} is not valid YAML.`);
    return;
  }
  if (manifest === null || manifest === undefined) return;
  if (!isRecord(manifest)) {
    add("workspace-manifest", MARKER, `${MARKER} must be empty or hold YAML keys such as \`schema_version: 1\`.`);
    return;
  }
  const version = manifest.schema_version;
  if (version === undefined || version === SCHEMA_VERSION) return;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    add("workspace-manifest", MARKER, `${MARKER}: \`schema_version\` must be a whole number such as 1.`);
    return;
  }
  add(
    "workspace-unsupported-version",
    MARKER,
    `${MARKER} declares schema_version ${version}, which needs a newer apkit; this apkit reads schema_version ${SCHEMA_VERSION}. Update apkit.`,
  );
}

/** Lists every non-hidden file under `dir`, as POSIX paths relative to it, except inside the `skip` folders. */
async function walk(dir: string, add: Add, label: string, skip: readonly string[] = [], rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort(byName)) {
    if (isHidden(entry.name)) continue;
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (skip.includes(child)) continue;
    if (entry.isSymbolicLink()) {
      add("symlink", `${label}/${child}`, `${label}/${child} is a symlink; apkit never follows links outside a Skill package, so it skips it.`);
    } else if (entry.isDirectory()) {
      files.push(...(await walk(dir, add, label, skip, child)));
    } else {
      files.push(child);
    }
  }
  return files;
}

async function loadContext(
  root: string,
  add: Add,
): Promise<{ context: Map<string, ContextModule>; declared: Map<string, string[]> }> {
  const modules = new Map<string, ContextModule>();
  /** Frontmatter `id` → the files that declare it; used only to name a fix (contextFix). */
  const declared = new Map<string, string[]>();
  const dir = join(root, "context");
  const files = await walk(dir, add, "context");
  // IDs that differ only in case would collide on a case-insensitive file system (ADR-0057 §1).
  const ids = files.filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -".md".length));
  for (const file of files) {
    const path = `context/${file}`;
    if (!file.endsWith(".md")) {
      add("stray-context-file", path, `${path} is not Markdown; only .md files are Context, so apkit skips it.`);
      continue;
    }
    const id = file.slice(0, -".md".length);
    const others = ids.filter((other) => other !== id && other.toLowerCase() === id.toLowerCase());
    if (others.length > 0) {
      const names = others.map((other) => `context/${other}.md`).join(", ");
      add("context-id-case-collision", path, `${path} and ${names} differ only in case; rename one so each Context ID is unique.`);
      continue;
    }
    const text = await readFile(join(dir, ...file.split("/")), "utf8");
    if (text.trim() === "") {
      add("empty-content", path, `${path} is empty, so apkit skips it.`);
      continue;
    }
    modules.set(id, { id, text });
    const old = readFrontmatter(text)?.id;
    if (typeof old === "string" && old !== id) declared.set(old, [...(declared.get(old) ?? []), path]);
  }
  return { context: modules, declared };
}

async function loadSkills(root: string, add: Add): Promise<Map<string, Skill>> {
  const skills = new Map<string, Skill>();
  const dir = join(root, "skills");
  const packages = await findSkillPackages(dir);
  // Package content belongs to the package, so only files outside every package are walked.
  for (const file of await walk(dir, add, "skills", packages)) {
    add("stray-skill-file", `skills/${file}`, `skills/${file} is not inside a Skill package (a folder with a SKILL.md), so apkit skips it.`);
  }
  for (const pkg of packages) {
    const path = `skills/${pkg}/SKILL.md`;
    const source = await readFile(join(dir, ...pkg.split("/"), "SKILL.md"), "utf8");
    const frontmatter = readFrontmatter(source);
    if (frontmatter === undefined) {
      add("invalid-frontmatter", path, `${path} must open and close YAML frontmatter with a name and description.`);
      continue;
    }
    const { name, description } = frontmatter;
    if (typeof name !== "string" || !KEBAB.test(name) || name.length > 64) {
      add("invalid-field", path, `${path} needs a lowercase kebab-case \`name\` of at most 64 characters.`);
      continue;
    }
    if (typeof description !== "string" || description.trim() === "" || description.length > 1024) {
      add("invalid-field", path, `${path} needs a non-empty \`description\` of at most 1024 characters.`);
      continue;
    }
    const disable = frontmatter["disable-model-invocation"];
    if (disable !== undefined && typeof disable !== "boolean") {
      add("invalid-model-invocation", path, `${path}: \`disable-model-invocation\` must be true or false.`);
      continue;
    }
    if (skills.has(name)) {
      add("duplicate-artifact-name", path, `Two Skill packages declare the name '${name}'.`);
      continue;
    }
    skills.set(name, {
      name,
      disableModelInvocation: disable === true,
      files: await readPackage(join(dir, ...pkg.split("/"))),
    });
  }
  return skills;
}

/** Finds Skill package folders (POSIX, relative to skills/); packages do not nest. */
async function findSkillPackages(dir: string, rel = ""): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  if (rel !== "" && entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) return [rel];
  const found: string[] = [];
  for (const entry of entries.sort(byName)) {
    if (isHidden(entry.name) || !entry.isDirectory()) continue;
    found.push(...(await findSkillPackages(dir, rel === "" ? entry.name : `${rel}/${entry.name}`)));
  }
  return found;
}

/** Reads every file in a Skill package, hidden files included. */
async function readPackage(dir: string, rel = ""): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const entries = await readdir(join(dir, rel), { withFileTypes: true });
  for (const entry of entries.sort(byName)) {
    const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
    const full = join(dir, ...child.split("/"));
    const info = await stat(full);
    if (info.isDirectory()) {
      files.push(...(await readPackage(dir, child)));
    } else if (info.isFile()) {
      files.push({ path: child, bytes: new Uint8Array(await readFile(full)), executable: (info.mode & 0o111) !== 0 });
    }
  }
  return files;
}

/** A Profile's file name, without its `.yaml` or `.yml` extension (ADR-0057 §2). */
const PROFILE_FILE = /^([^/]+)\.ya?ml$/;

async function loadProfiles(
  root: string,
  skillMap: ReadonlyMap<string, Skill>,
  add: Add,
): Promise<{ profiles: Map<string, Profile>; selections: { profile: Profile; path: string }[] }> {
  const profiles = new Map<string, Profile>();
  const selections: { profile: Profile; path: string }[] = [];
  const dir = join(root, "profiles");
  const files = await walk(dir, add, "profiles");
  const ids = files.map((file) => PROFILE_FILE.exec(file)?.[1]);
  for (const [index, file] of files.entries()) {
    const path = `profiles/${file}`;
    const id = ids[index];
    if (id === undefined && file.includes("/") && /\.ya?ml$/.test(file)) {
      add("profile-in-subfolder", path, `${path} is in a subfolder; Profiles are read only directly in profiles/, so apkit skips it.`);
      continue;
    }
    if (id === undefined) {
      add("stray-profile-file", path, `${path} is not a Profile (a .yaml or .yml file), so apkit skips it.`);
      continue;
    }
    if (!KEBAB.test(id)) {
      add("profile-file-name", path, `${path} must have a lowercase kebab-case file name.`);
      continue;
    }
    if (ids.indexOf(id) !== index) {
      add("duplicate-profile", path, `Two files define Profile '${id}'; keep one of ${id}.yaml and ${id}.yml.`);
      continue;
    }
    let data: unknown;
    try {
      data = parseYaml(await readFile(join(dir, file), "utf8"));
    } catch {
      add("invalid-yaml", path, `${path} is not valid YAML.`);
      continue;
    }
    if (data === null || data === undefined) data = {};
    if (!isRecord(data)) {
      add("invalid-profile", path, `${path} may contain only a \`context\` list and a \`skills\` list.`);
      continue;
    }
    // Other keys are reported, but the lists are still read, so their references are checked in the same run.
    const extra = Object.keys(data).filter((key) => key !== "context" && key !== "skills");
    if (extra.length > 0) {
      const named = extra.map((key) => `\`${key}\``).join(", ");
      const why = extra.includes("id") ? ", and its ID is its file name" : "";
      add("invalid-profile", path, `${path}: remove ${named}; a Profile holds only a \`context\` list and a \`skills\` list${why}.`);
    }
    if (data.context === "all") {
      add("invalid-profile", path, `${path}: Context must be listed by ID, in the order to join it; \`all\` is only for skills.`);
      continue;
    }
    const context = data.context ?? [];
    const selected = data.skills ?? [];
    if (!isNameList(context) || !(selected === "all" || isNameList(selected))) {
      add("invalid-profile", path, `${path}: \`context\` must be a list of IDs and \`skills\` a list of names or \`all\`.`);
      continue;
    }
    const skills = selected === "all" ? [...skillMap.keys()].sort() : selected;
    if (new Set(context).size !== context.length || new Set(skills).size !== skills.length) {
      add("duplicate-selection", path, `${path} names the same item more than once.`);
      continue;
    }
    if (context.length === 0 && skills.length === 0 && selected !== "all") {
      add("profile-without-artifacts", path, `${path} selects nothing; installing it installs nothing.`);
    }
    selections.push({ profile: { id, context, skills }, path });
    if (extra.length === 0) profiles.set(id, { id, context, skills });
  }
  return { profiles, selections };
}

function readFrontmatter(source: string): Record<string, unknown> | undefined {
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const document = parseDocument(normalized.slice(4, end + 1));
  if (document.errors.length > 0) return undefined;
  const value: unknown = document.toJS();
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Creates any missing Workspace parts. Returns the parts it added. */
export async function initWorkspace(root: string): Promise<string[]> {
  const added: string[] = [];
  await mkdir(root, { recursive: true });
  if (!(await exists(join(root, MARKER)))) {
    await writeFile(join(root, MARKER), `schema_version: ${SCHEMA_VERSION}\n`);
    added.push(MARKER);
  }
  for (const part of ["context", "skills", "profiles"]) {
    if (!(await exists(join(root, part)))) {
      await mkdir(join(root, part));
      added.push(`${part}/`);
    }
  }
  return added;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
