// Machine configuration: the selected Workspace and the folders apkit has
// installed into. Each folder's own manifest says what is installed there;
// the registry only lists folders, so `--all` can find them.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { refuseNewer } from "./schema.js";
import type { NoteRecords } from "./setup.js";

export interface Config {
  readonly workspace?: string;
  readonly installs: readonly string[];
  /** User-level files that carry the apkit note (see setup.ts). */
  readonly notes?: NoteRecords;
  /** For each installed folder in a Git repository, the exclude file that holds its block (see gitexclude.ts). */
  readonly exclusions?: Readonly<Record<string, string>>;
}

export function configHome(): string {
  return process.env.APKIT_HOME ?? join(homedir(), ".agents", "apkit");
}

const configPath = () => join(configHome(), "config.json");

/** The global install's manifest. It lives apart from the home folder, which can have a project install of its own. */
export const globalManifestPath = () => join(configHome(), "global.json");

/** Throws NewerSchemaError for a configuration from a newer apkit; a file without a schema is schema 1. */
export async function readConfig(): Promise<Config> {
  let data: Partial<Config> & { schema?: unknown };
  try {
    data = JSON.parse(await readFile(configPath(), "utf8"));
  } catch {
    return { installs: [] };
  }
  refuseNewer(data.schema, 1, configPath());
  return { workspace: data.workspace, installs: Array.isArray(data.installs) ? data.installs : [], notes: data.notes, exclusions: data.exclusions };
}

export async function writeConfig(config: Config): Promise<void> {
  await mkdir(configHome(), { recursive: true });
  const temp = `${configPath()}.tmp`;
  const installs = [...new Set(config.installs)].sort();
  await writeFile(temp, `${JSON.stringify({ schema: 1, ...config, installs }, null, 2)}\n`);
  await rename(temp, configPath());
}

/** Adds or forgets `target`, with the exclude file of its block when installed in a Git repository. */
export async function recordInstall(target: string, installed: boolean, exclusion: string | null = null): Promise<void> {
  const config = await readConfig();
  const others = config.installs.filter((path) => path !== target);
  const exclusions: Record<string, string> = { ...config.exclusions };
  delete exclusions[target];
  if (installed && exclusion !== null) exclusions[target] = exclusion;
  await writeConfig({
    ...config,
    installs: installed ? [...others, target] : others,
    exclusions: Object.keys(exclusions).length > 0 ? exclusions : undefined,
  });
}
