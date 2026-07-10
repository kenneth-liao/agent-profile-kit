import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type ContextModule, type Profile } from "../schemas/context-profile.js";
import { type Skill } from "../schemas/skill.js";
import { WORKSPACE_SCHEMA_VERSION } from "../schemas/workspace-manifest.js";

function sha256(source: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

function writeFrame(hash: ReturnType<typeof createHash>, value: string | Uint8Array): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

function compareNames(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

async function skillInput(skill: Skill): Promise<unknown> {
  const entries: unknown[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort(compareNames);
    for (const child of children) {
      const path = join(directory, child.name);
      const relativePath = prefix.length === 0 ? child.name : `${prefix}/${child.name}`;
      const mode = (await lstat(path)).mode & 0o7777;
      if (child.isDirectory()) {
        entries.push({ mode, path: relativePath, type: "directory" });
        await visit(path, relativePath);
      } else if (child.isFile()) {
        entries.push({ content: sha256(await readFile(path)), mode, path: relativePath, type: "file" });
      } else {
        throw new Error(`Skill '${skill.id}' contains unsupported entry '${relativePath}'`);
      }
    }
  }
  await visit(skill.path, "");
  return { files: entries, id: skill.id };
}

export async function hashWorkspaceInputs(
  profile: Profile,
  contexts: ReadonlyMap<string, ContextModule>,
  skills: ReadonlyMap<string, Skill>,
): Promise<string> {
  const selectedContexts = profile.context.map((id) => {
    const context = contexts.get(id);
    if (!context) {
      throw new Error(`Profile '${profile.id}' selects missing Context Module '${id}'`);
    }
    return { content: context.content, id: context.id };
  });
  const selectedSkills = await Promise.all(
    profile.skills.map((id) => {
      const skill = skills.get(id);
      if (!skill) throw new Error(`Profile '${profile.id}' selects missing Skill '${id}'`);
      return skillInput(skill);
    }),
  );
  return sha256(
    JSON.stringify({
      context_modules: selectedContexts,
      profile: {
        agents: profile.agents,
        context: profile.context,
        hooks: profile.hooks,
        id: profile.id,
        skills: profile.skills,
        tools: profile.tools,
      },
      skills: selectedSkills,
      workspace_schema_version: WORKSPACE_SCHEMA_VERSION,
    }),
  );
}

export async function hashOutputDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort(compareNames);
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (relativePath === "installation.yaml") continue;
      const path = join(directory, entry.name);
      const mode = (await lstat(path)).mode & 0o7777;
      if (entry.isDirectory()) {
        writeFrame(hash, "directory");
        writeFrame(hash, relativePath);
        writeFrame(hash, String(mode));
        await visit(path, relativePath);
        continue;
      }
      if (entry.isFile()) {
        writeFrame(hash, "file");
        writeFrame(hash, relativePath);
        writeFrame(hash, String(mode));
        writeFrame(hash, await readFile(path));
        continue;
      }
      throw new Error(`Profile Installation output contains unsupported entry '${relativePath}'`);
    }
  }

  await visit(root, "");
  return `sha256:${hash.digest("hex")}`;
}
