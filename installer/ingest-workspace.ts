import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type ContextModule,
  parseContextModule,
  parseProfile,
  type Profile,
} from "../schemas/context-profile.js";
import { parseSkill, type Skill } from "../schemas/skill.js";
import { parseAgent, type Agent } from "../schemas/agent.js";
import { resolveProfileDependencies, validateDependencyCatalog } from "./resolve-dependencies.js";
import { validateWorkspaceStructure, workspacePath } from "./workspace.js";

export interface Workspace {
  readonly path: string;
  readonly contexts: ReadonlyMap<string, ContextModule>;
  readonly agents: ReadonlyMap<string, Agent>;
  readonly profiles: ReadonlyMap<string, Profile>;
  readonly skills: ReadonlyMap<string, Skill>;
}

async function skillPaths(directory: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = join(prefix, entry.name);
      if (!entry.isDirectory()) return [];
      const source = join(directory, entry.name);
      const nested = await skillPaths(source, relativePath);
      const children = await readdir(source, { withFileTypes: true });
      return children.some((child) => child.isFile() && child.name === "SKILL.md")
        ? [relativePath, ...nested]
        : nested;
    }),
  );
  return paths.flat().sort();
}

async function agentPaths(directory: string, prefix = ""): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory()) return [];
      const relativePath = join(prefix, entry.name);
      const source = join(directory, entry.name);
      const nested = await agentPaths(source, relativePath);
      const children = await readdir(source, { withFileTypes: true });
      return children.some((child) => child.isFile() && child.name === "AGENT.md")
        ? [relativePath, ...nested]
        : nested;
    }),
  );
  return paths.flat().sort();
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
  const agents = new Map<string, Agent>();
  const profiles = new Map<string, Profile>();
  const skills = new Map<string, Skill>();

  for (const name of await sourceFiles(join(path, "context"), ".md")) {
    const sourcePath = join(path, "context", name);
    addUnique(
      contexts,
      parseContextModule(await readFile(sourcePath, "utf8"), `context/${name}`),
      "Context Module",
    );
  }
  for (const name of await agentPaths(join(path, "agents"))) {
    const sourcePath = join(path, "agents", name, "AGENT.md");
    addUnique(
      agents,
      parseAgent(await readFile(sourcePath, "utf8"), `agents/${name}/AGENT.md`),
      "Agent",
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
  for (const name of await skillPaths(join(path, "skills"))) {
    const sourcePath = join(path, "skills", name);
    let sidecar: string | undefined;
    try {
      sidecar = await readFile(join(sourcePath, "agent-profile-kit.yaml"), "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
    }
    addUnique(
      skills,
      parseSkill(
        await readFile(join(sourcePath, "SKILL.md"), "utf8"),
        `skills/${name}/SKILL.md`,
        sourcePath,
        sidecar,
      ),
      "Skill",
    );
  }

  validateDependencyCatalog(agents, contexts, skills);
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
    for (const skillId of profile.skills) {
      if (!skills.has(skillId)) {
        throw new Error(`Profile '${profile.id}' selects missing Skill '${skillId}'`);
      }
    }
    for (const agentId of profile.agents) {
      if (!agents.has(agentId)) {
        throw new Error(`Profile '${profile.id}' selects missing Agent '${agentId}'`);
      }
    }
    for (const [name, selection] of [["hooks", profile.hooks], ["tools", profile.tools]] as const) {
      if (selection.length > 0) {
        throw new Error(
          `Profile '${profile.id}' selects ${name}, which this release does not support`,
        );
      }
    }
    resolveProfileDependencies(profile, agents, contexts, skills);
  }

  return { path, agents, contexts, profiles, skills };
}
