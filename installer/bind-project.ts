import {
  mkdir as defaultMkdir,
  open as defaultOpen,
  readFile as defaultReadFile,
  rename as defaultRename,
  rm as defaultRm,
  stat as defaultStat,
  unlink as defaultUnlink,
  writeFile as defaultWriteFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";

import { requireArtifactId } from "../schemas/dependencies.js";
import {
  isSupportedHost,
  SUPPORTED_HOSTS,
  type SupportedHost,
} from "../schemas/local-configuration.js";
import {
  ingestApplicationFromSource,
  localConfigurationPath,
  normalizeProject,
  requireExistingDirectory,
} from "./local-configuration.js";

/** Optional filesystem hooks used to prove concurrent-edit and lock safety in tests. */
export interface BindProjectFileSystem {
  readonly mkdir: typeof defaultMkdir;
  readonly open: typeof defaultOpen;
  readonly readFile: typeof defaultReadFile;
  readonly rename: typeof defaultRename;
  readonly rm: typeof defaultRm;
  readonly stat: typeof defaultStat;
  readonly unlink: typeof defaultUnlink;
  readonly writeFile: typeof defaultWriteFile;
}

const defaultFileSystem: BindProjectFileSystem = {
  mkdir: defaultMkdir,
  open: defaultOpen,
  readFile: defaultReadFile,
  rename: defaultRename,
  rm: defaultRm,
  stat: defaultStat,
  unlink: defaultUnlink,
  writeFile: defaultWriteFile,
};

const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 5_000;

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function normalizeHosts(hosts: readonly string[]): readonly SupportedHost[] {
  if (hosts.length === 0) {
    throw new Error(
      "bind requires at least one --host flag; supported Hosts: " +
        SUPPORTED_HOSTS.join(", "),
    );
  }
  const seen = new Set<SupportedHost>();
  for (const host of hosts) {
    if (!isSupportedHost(host)) {
      throw new Error(
        `unsupported Agent Host '${host}'; supported Hosts: ${SUPPORTED_HOSTS.join(", ")}`,
      );
    }
    seen.add(host);
  }
  // Canonical Host order matches Local Configuration ingestion.
  return SUPPORTED_HOSTS.filter((host) => seen.has(host));
}

function hostsEqual(
  left: readonly SupportedHost[],
  right: readonly SupportedHost[],
): boolean {
  return left.length === right.length && left.every((host, index) => host === right[index]);
}

/** Restore the source newline convention after YAML Document serialization (LF-only). */
export function preserveSourceNewlines(source: string, serialized: string): string {
  if (!source.includes("\r\n")) return serialized;
  return serialized.replace(/\r?\n/g, "\r\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize Local Configuration mutations. Cooperating writers take an exclusive
 * lockfile for the entire read→validate→publish window so two binds cannot both
 * pass a final check and rename over each other.
 */
async function withConfigurationLock<T>(
  configurationPath: string,
  fileSystem: BindProjectFileSystem,
  body: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configurationPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let handle: FileHandle | undefined;

  while (handle === undefined) {
    try {
      handle = await fileSystem.open(lockPath, "wx");
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Local Configuration ${configurationPath} is busy; another bind holds the lock — retry`,
        );
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await body();
  } finally {
    await handle.close().catch(() => undefined);
    await fileSystem.unlink(lockPath).catch(() => undefined);
  }
}

export interface BindProjectOptions {
  readonly home: string;
  readonly profile: string;
  /** Authored project path; omit to use cwd. */
  readonly project?: string;
  readonly hosts: readonly string[];
  /** Working directory used when project is omitted. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Test-only filesystem override for concurrent-edit proofs. */
  readonly fileSystem?: BindProjectFileSystem;
}

export interface BindProjectResult {
  readonly outcome: "created" | "unchanged";
  readonly configurationPath: string;
  readonly project: string;
  readonly canonicalProject: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
}

/**
 * Append one Project Binding to Local Configuration without reconciling output.
 * Local Configuration remains the sole canonical home; this is a validated edit.
 */
export async function bindProject(
  options: BindProjectOptions,
): Promise<BindProjectResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const configurationPath = localConfigurationPath(options.home);
  const profile = requireArtifactId(options.profile, "bind profile");
  const hosts = normalizeHosts(options.hosts);
  const cwd = options.cwd ?? process.cwd();

  const description = `Local Configuration ${configurationPath}`;
  let canonicalProject: string;
  if (options.project === undefined) {
    canonicalProject = await requireExistingDirectory(
      cwd,
      cwd,
      description,
      "project",
    );
  } else {
    canonicalProject = await normalizeProject(
      options.project,
      options.home,
      description,
    );
  }

  // Prefer absolute canonical root for cwd bindings; preserve authored spelling otherwise.
  const storedProject =
    options.project === undefined ? canonicalProject : options.project;

  return withConfigurationLock(configurationPath, fileSystem, async () => {
    let source: string;
    try {
      source = await fileSystem.readFile(configurationPath, "utf8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) {
        throw new Error(
          `Local Configuration is missing at ${configurationPath}; run agent-profile-kit init`,
        );
      }
      throw error;
    }

    // Exact snapshot being edited is the sole input to the trusted semantic boundary.
    const { configuration, workspace } = await ingestApplicationFromSource(
      options.home,
      source,
      configurationPath,
    );
    if (!workspace.profiles.has(profile)) {
      throw new Error(
        `${description} profile '${profile}' does not exist in Workspace ${workspace.path}`,
      );
    }

    const existing = configuration.bindings.find(
      (binding) => binding.canonicalProject === canonicalProject,
    );
    if (existing) {
      if (existing.profile === profile && hostsEqual(existing.hosts, hosts)) {
        return {
          outcome: "unchanged" as const,
          configurationPath,
          project: existing.project,
          canonicalProject,
          profile,
          hosts,
        };
      }
      throw new Error(
        `${description} already binds canonical project '${canonicalProject}' to profile '${existing.profile}' hosts [${existing.hosts.join(", ")}]; replace is not supported by bind`,
      );
    }

    const document = parseDocument(source);
    const bindingsNode = document.get("bindings");
    if (!isSeq(bindingsNode)) {
      throw new Error(`${description} bindings must be an array`);
    }
    // Prefer block style when starting from an empty flow sequence (init default).
    if (bindingsNode.items.length === 0) {
      bindingsNode.flow = false;
    }

    const entry = document.createNode({
      project: storedProject,
      profile,
      hosts: [...hosts],
    });
    if (isMap(entry)) {
      entry.flow = false;
      const hostsNode = entry.get("hosts");
      if (isSeq(hostsNode)) hostsNode.flow = false;
    }
    bindingsNode.add(entry);

    const nextSource = preserveSourceNewlines(source, document.toString());
    const sourceStats = await fileSystem.stat(configurationPath);
    const mode = sourceStats.mode & 0o777;

    const directory = dirname(configurationPath);
    await fileSystem.mkdir(directory, { recursive: true });
    const temporary = join(
      directory,
      `.config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    await fileSystem.writeFile(temporary, nextSource, { flag: "wx", mode });
    try {
      // Under the exclusive lock, refuse to publish if the snapshot drifted (external
      // non-cooperating writer). Cooperating binds cannot interleave this check→rename.
      const stillCurrent = await fileSystem.readFile(configurationPath, "utf8");
      if (stillCurrent !== source) {
        throw new Error(
          `${description} changed during bind; retry so concurrent edits are not lost`,
        );
      }
      await fileSystem.rename(temporary, configurationPath);
    } finally {
      await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    }

    return {
      outcome: "created" as const,
      configurationPath,
      project: storedProject,
      canonicalProject,
      profile,
      hosts,
    };
  });
}
