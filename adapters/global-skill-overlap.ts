import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { parse } from "yaml";

/** Codex personal/global Skill discovery roots relative to the user home. */
export const CODEX_GLOBAL_SKILL_ROOTS = [
  posix.join(".agents", "skills"),
  posix.join(".codex", "skills"),
] as const;

/** Claude personal Skill discovery root relative to the user home. */
export const CLAUDE_GLOBAL_SKILL_ROOT = posix.join(".claude", "skills");

/** Project-relative path Codex receives for a managed Skill package. */
export function codexProjectSkillPath(skillId: string): string {
  return posix.join(".agents", "skills", skillId);
}

/** Project-relative path Claude receives for a managed Skill package. */
export function claudeProjectSkillPath(skillId: string): string {
  return posix.join(".claude", "skills", skillId);
}

export interface GlobalSkillOverlapOptions {
  /** Absolute project root used only in actionable blocker paths. */
  readonly project: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function parseFrontmatterName(source: string): string | undefined {
  // Readable package without a Host-visible name is not an identity collision.
  const normalized = source.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) {
    return undefined;
  }
  const open = normalized.startsWith("---\r\n") ? "---\r\n" : "---\n";
  const close = normalized.startsWith("---\r\n") ? "\r\n---" : "\n---";
  const closing = normalized.indexOf(close, open.length);
  if (closing === -1) return undefined;
  let document: unknown;
  try {
    document = parse(normalized.slice(open.length, closing));
  } catch {
    return undefined;
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return undefined;
  }
  const name = (document as Record<string, unknown>).name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

async function pathKind(path: string): Promise<"directory" | "file" | "missing" | "other"> {
  try {
    const info = await stat(path);
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return "missing";
    throw error;
  }
}

function overlapBlocker(input: {
  readonly host: string;
  readonly artifactId: string;
  readonly globalPath: string;
  readonly proposedProjectPath: string;
}): string {
  return (
    `${input.host} personal/global Skill '${input.artifactId}' collides with selected Profile Skill: ` +
    `unmanaged global delivery at ${input.globalPath} would conflict with project snapshot at ` +
    `${input.proposedProjectPath}; remove or relocate the unmanaged global Skill before applying`
  );
}

function inspectBlocker(host: string, path: string, detail: string): string {
  return (
    `${host} personal/global Skill root at ${path} cannot be inspected sufficiently to prove absence ` +
    `of selected Skills (${detail}); remove the obstruction or make the path readable before applying`
  );
}

/**
 * Read-only Codex overlap detection for selected Skill Artifact IDs against every
 * Adapter-supported personal/global Codex Skill root. Missing roots are empty.
 * Uninspectable roots fail closed. Host-visible identity is the SKILL.md frontmatter name.
 */
export async function detectCodexGlobalSkillOverlaps(
  home: string,
  skillIds: readonly string[],
  options: GlobalSkillOverlapOptions,
): Promise<readonly string[]> {
  if (skillIds.length === 0) return [];
  const selected = new Set(skillIds);
  const blockers: string[] = [];

  for (const relativeRoot of CODEX_GLOBAL_SKILL_ROOTS) {
    const root = join(home, ...relativeRoot.split("/"));
    let kind: Awaited<ReturnType<typeof pathKind>>;
    try {
      kind = await pathKind(root);
    } catch (error) {
      blockers.push(
        inspectBlocker("Codex", root, error instanceof Error ? error.message : String(error)),
      );
      continue;
    }
    if (kind === "missing") continue;
    if (kind !== "directory") {
      blockers.push(inspectBlocker("Codex", root, `path is a ${kind}, not a directory`));
      continue;
    }

    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      blockers.push(
        inspectBlocker("Codex", root, error instanceof Error ? error.message : String(error)),
      );
      continue;
    }

    for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
      // Codex system bundles live under .system and are not personal/global user delivery.
      if (entry.startsWith(".")) continue;
      const packagePath = join(root, entry);
      let packageKind: Awaited<ReturnType<typeof pathKind>>;
      try {
        packageKind = await pathKind(packagePath);
      } catch (error) {
        blockers.push(
          inspectBlocker(
            "Codex",
            packagePath,
            error instanceof Error ? error.message : String(error),
          ),
        );
        continue;
      }
      if (packageKind !== "directory") continue;

      const skillMd = join(packagePath, "SKILL.md");
      let skillKind: Awaited<ReturnType<typeof pathKind>>;
      try {
        skillKind = await pathKind(skillMd);
      } catch (error) {
        blockers.push(
          inspectBlocker("Codex", skillMd, error instanceof Error ? error.message : String(error)),
        );
        continue;
      }
      if (skillKind === "missing") continue;
      if (skillKind !== "file") {
        blockers.push(inspectBlocker("Codex", skillMd, `SKILL.md is a ${skillKind}, not a file`));
        continue;
      }

      let source: string;
      try {
        source = await readFile(skillMd, "utf8");
      } catch (error) {
        blockers.push(
          inspectBlocker("Codex", skillMd, error instanceof Error ? error.message : String(error)),
        );
        continue;
      }
      // No frontmatter name ⇒ no Host-visible identity that can collide with a
      // selected Artifact ID. Unrelated/junk packages stay quiet; unreadable I/O
      // already failed closed above.
      const identity = parseFrontmatterName(source);
      if (identity === undefined || !selected.has(identity)) continue;

      // Resolve for reporting only; symlinks and identical bytes still block.
      let evidencePath = packagePath;
      try {
        evidencePath = await realpath(packagePath);
      } catch {
        evidencePath = packagePath;
      }
      blockers.push(
        overlapBlocker({
          host: "Codex",
          artifactId: identity,
          globalPath: evidencePath === packagePath ? packagePath : `${packagePath} -> ${evidencePath}`,
          proposedProjectPath: join(options.project, ...codexProjectSkillPath(identity).split("/")),
        }),
      );
    }
  }

  return [...new Set(blockers)].sort();
}

/**
 * Read-only Claude overlap detection for selected Skill Artifact IDs against the
 * personal Claude Skill root. Host-visible identity is the package directory name
 * (command name); a directory without SKILL.md is not a Skill.
 */
export async function detectClaudeGlobalSkillOverlaps(
  home: string,
  skillIds: readonly string[],
  options: GlobalSkillOverlapOptions,
): Promise<readonly string[]> {
  if (skillIds.length === 0) return [];
  const selected = new Set(skillIds);
  const blockers: string[] = [];
  const root = join(home, ...CLAUDE_GLOBAL_SKILL_ROOT.split("/"));

  let kind: Awaited<ReturnType<typeof pathKind>>;
  try {
    kind = await pathKind(root);
  } catch (error) {
    return [
      inspectBlocker("Claude", root, error instanceof Error ? error.message : String(error)),
    ];
  }
  if (kind === "missing") return [];
  if (kind !== "directory") {
    return [inspectBlocker("Claude", root, `path is a ${kind}, not a directory`)];
  }

  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    return [
      inspectBlocker("Claude", root, error instanceof Error ? error.message : String(error)),
    ];
  }

  for (const entry of entries.sort((left, right) => left.localeCompare(right))) {
    if (entry.startsWith(".")) continue;
    if (!selected.has(entry)) continue;
    const packagePath = join(root, entry);
    let packageKind: Awaited<ReturnType<typeof pathKind>>;
    try {
      packageKind = await pathKind(packagePath);
    } catch (error) {
      blockers.push(
        inspectBlocker(
          "Claude",
          packagePath,
          error instanceof Error ? error.message : String(error),
        ),
      );
      continue;
    }
    if (packageKind !== "directory") continue;

    const skillMd = join(packagePath, "SKILL.md");
    let skillKind: Awaited<ReturnType<typeof pathKind>>;
    try {
      skillKind = await pathKind(skillMd);
    } catch (error) {
      blockers.push(
        inspectBlocker("Claude", skillMd, error instanceof Error ? error.message : String(error)),
      );
      continue;
    }
    if (skillKind === "missing") continue;
    if (skillKind !== "file") {
      blockers.push(inspectBlocker("Claude", skillMd, `SKILL.md is a ${skillKind}, not a file`));
      continue;
    }

    let evidencePath = packagePath;
    try {
      evidencePath = await realpath(packagePath);
    } catch {
      evidencePath = packagePath;
    }
    blockers.push(
      overlapBlocker({
        host: "Claude",
        artifactId: entry,
        globalPath: evidencePath === packagePath ? packagePath : `${packagePath} -> ${evidencePath}`,
        proposedProjectPath: join(options.project, ...claudeProjectSkillPath(entry).split("/")),
      }),
    );
  }

  return [...new Set(blockers)].sort();
}
