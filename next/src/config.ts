// Machine configuration: the selected Workspace and the folders apkit has
// installed into. Each folder's own manifest says what is installed there;
// the registry only lists folders, so `--all` can find them.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NoteRecords } from "./setup.js";

export interface Config {
  readonly workspace?: string;
  readonly installs: readonly string[];
  /** User-level files that carry the apkit note (see setup.ts). */
  readonly notes?: NoteRecords;
}

export function configHome(): string {
  return process.env.APKIT_HOME ?? join(homedir(), ".agents", "apkit");
}

const configPath = () => join(configHome(), "config.json");

export async function readConfig(): Promise<Config> {
  try {
    const data = JSON.parse(await readFile(configPath(), "utf8")) as Partial<Config>;
    return { workspace: data.workspace, installs: Array.isArray(data.installs) ? data.installs : [], notes: data.notes };
  } catch {
    return { installs: [] };
  }
}

export async function writeConfig(config: Config): Promise<void> {
  await mkdir(configHome(), { recursive: true });
  const temp = `${configPath()}.tmp`;
  const installs = [...new Set(config.installs)].sort();
  await writeFile(temp, `${JSON.stringify({ ...config, installs }, null, 2)}\n`);
  await rename(temp, configPath());
}

export async function recordInstall(target: string, installed: boolean): Promise<void> {
  const config = await readConfig();
  const others = config.installs.filter((path) => path !== target);
  await writeConfig({ ...config, installs: installed ? [...others, target] : others });
}
