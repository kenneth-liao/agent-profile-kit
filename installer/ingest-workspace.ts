import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ContextModule,
  parseContextModule,
  parseProfile,
  type Profile,
} from "../schemas/context-profile.js";
import { validateWorkspaceStructure, workspacePath } from "./workspace.js";

export interface Workspace {
  readonly path: string;
  readonly contexts: ReadonlyMap<string, ContextModule>;
  readonly profiles: ReadonlyMap<string, Profile>;
}

async function sourceFiles(
  directory: string,
  extension: string,
  prefix = "",
): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = join(prefix, entry.name);
      if (entry.isDirectory()) {
        return sourceFiles(join(directory, entry.name), extension, relativePath);
      }
      return entry.isFile() && entry.name.endsWith(extension) ? [relativePath] : [];
    }),
  );
  return files.flat().sort();
}

function addUnique<T extends { readonly id: string }>(
  entries: Map<string, T>,
  entry: T,
  description: string,
): void {
  if (entries.has(entry.id)) {
    throw new Error(`${description} Artifact ID '${entry.id}' is duplicated`);
  }
  entries.set(entry.id, entry);
}

export async function ingestWorkspace(home: string): Promise<Workspace> {
  const path = workspacePath(home);
  await validateWorkspaceStructure(path);
  const contexts = new Map<string, ContextModule>();
  const profiles = new Map<string, Profile>();

  for (const name of await sourceFiles(join(path, "context"), ".md")) {
    const sourcePath = join(path, "context", name);
    addUnique(
      contexts,
      parseContextModule(await readFile(sourcePath, "utf8"), `context/${name}`),
      "Context Module",
    );
  }
  for (const name of await sourceFiles(join(path, "profiles"), ".yaml")) {
    const sourcePath = join(path, "profiles", name);
    addUnique(
      profiles,
      parseProfile(await readFile(sourcePath, "utf8"), `profiles/${name}`),
      "Profile",
    );
  }

  for (const profile of profiles.values()) {
    if (profile.context.length === 0) {
      throw new Error(
        `Profile '${profile.id}' must select at least one Context Module`,
      );
    }
    for (const contextId of profile.context) {
      if (!contexts.has(contextId)) {
        throw new Error(
          `Profile '${profile.id}' selects missing Context Module '${contextId}'`,
        );
      }
    }
    for (const [name, selection] of [
      ["skills", profile.skills],
      ["agents", profile.agents],
      ["hooks", profile.hooks],
      ["tools", profile.tools],
    ] as const) {
      if (selection.length > 0) {
        throw new Error(
          `Profile '${profile.id}' selects ${name}, which this Context-only release does not support`,
        );
      }
    }
  }

  return { path, contexts, profiles };
}
