import { mkdir, mkdtemp, readdir, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

export async function tempDir(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `apkit-${label}-`)));
}

/** Writes files given as { "posix/path": content } under root. */
export async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, ...path.split("/"));
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

export async function read(root: string, path: string): Promise<string> {
  return readFile(join(root, ...path.split("/")), "utf8");
}

export const SKILL = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: Summarize a change when asked.\n${extra}---\n\n# ${name}\n\nDo the thing.\n`;

/** A valid Workspace with one Context Module, two Skills, and three Profiles. */
export async function makeWorkspace(): Promise<string> {
  const root = await tempDir("ws");
  await writeTree(root, {
    "apkit-workspace.yaml": "schema_version: 1\n",
    "context/communication.md": "# Communication\n\nBe concise.\n",
    "context/writing/voice.md": "# Voice\n\nWarm and plain. Ünïcödé ok.\n",
    "skills/summarize/SKILL.md": SKILL("summarize"),
    "skills/summarize/scripts/run.sh": "#!/bin/sh\necho hi\n",
    "skills/group/review/SKILL.md": SKILL("review", "disable-model-invocation: true\n"),
    "profiles/engineering.yaml": "context:\n  - communication\nskills:\n  - summarize\n  - review\n",
    "profiles/writing.yaml": "context:\n  - writing/voice\nskills: []\n",
    "profiles/skills-only.yaml": "context: []\nskills:\n  - summarize\n",
  });
  return root;
}

/** Every file under root as { "posix/path": content }, to show that nothing changed. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files[relative(root, full).split(sep).join("/")] = await readFile(full, "utf8");
  }
  return files;
}

export interface ExactTreeOptions {
  /** Leaves out the entry at this POSIX path (its descendants are still visited). */
  skip?: (path: string) => boolean;
  /** Rewrites a file's contents (exact bytes as latin1) before recording them. */
  rewrite?: (text: string) => string;
}

/**
 * The whole tree under root, to show exactly what changed: every file (POSIX path → exact bytes as
 * latin1), every folder including empty ones (`path/` → ""), and every link without following it
 * (`path@` → its target).
 */
export async function exactTree(root: string, options: ExactTreeOptions = {}): Promise<Record<string, string>> {
  const tree: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const full = join(entry.parentPath, entry.name);
    const path = relative(root, full).split(sep).join("/");
    if (options.skip?.(path)) continue;
    if (entry.isSymbolicLink()) tree[`${path}@`] = await readlink(full);
    else if (entry.isDirectory()) tree[`${path}/`] = "";
    else if (entry.isFile()) {
      const text = (await readFile(full)).toString("latin1");
      tree[path] = options.rewrite ? options.rewrite(text) : text;
    } else throw new Error(`Unexpected entry: ${path}`);
  }
  return tree;
}
