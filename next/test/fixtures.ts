import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export async function tempDir(label: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), `apkit-next-${label}-`)));
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
