import {
  link as defaultLink,
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
  readonly link: typeof defaultLink;
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
  link: defaultLink,
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

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pathExists(
  fileSystem: BindProjectFileSystem,
  path: string,
): Promise<boolean> {
  try {
    await fileSystem.stat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

/**
 * Exclusive bind lock with crash-safe ownership: lock contents are the owner PID.
 * A lock whose owner is not alive is removed so a crashed bind cannot block forever.
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
      await handle.writeFile(`${process.pid}\n`);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      let recovered = false;
      try {
        const ownerRaw = (await fileSystem.readFile(lockPath, "utf8")).trim();
        const ownerPid = Number.parseInt(ownerRaw, 10);
        if (!processIsAlive(ownerPid)) {
          await fileSystem.unlink(lockPath);
          recovered = true;
        }
      } catch (recoveryError) {
        if (!hasErrorCode(recoveryError, "ENOENT")) throw recoveryError;
        recovered = true;
      }
      if (!recovered && Date.now() >= deadline) {
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

/**
 * Publish nextSource without an unchecked overwrite window:
 * 1. Atomically move the current config aside (claim).
 * 2. Refuse if the claimed bytes are not the validated snapshot.
 * 3. Create the destination only if the path is still free (`link` fails on EEXIST),
 *    so an external writer that recreated config.yaml is never erased.
 */
async function publishConfigurationReplacement(
  configurationPath: string,
  source: string,
  nextSource: string,
  mode: number,
  fileSystem: BindProjectFileSystem,
  description: string,
): Promise<void> {
  const directory = dirname(configurationPath);
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const heldPath = join(directory, `.config-held-${token}`);
  const temporary = join(directory, `.config-${token}.tmp`);

  await fileSystem.rename(configurationPath, heldPath);
  let published = false;
  try {
    const claimed = await fileSystem.readFile(heldPath, "utf8");
    if (claimed !== source) {
      throw new Error(
        `${description} changed during bind; retry so concurrent edits are not lost`,
      );
    }

    await fileSystem.writeFile(temporary, nextSource, { flag: "wx", mode });
    try {
      // link fails with EEXIST when the destination already exists — never overwrites.
      await fileSystem.link(temporary, configurationPath);
      published = true;
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) {
        throw new Error(
          `${description} changed during bind; retry so concurrent edits are not lost`,
        );
      }
      throw error;
    }
  } finally {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    if (published) {
      await fileSystem.unlink(heldPath).catch(() => undefined);
    } else if (!(await pathExists(fileSystem, configurationPath))) {
      // Restore the claimed snapshot only when no external writer recreated the path.
      await fileSystem.rename(heldPath, configurationPath).catch(() => undefined);
    } else {
      await fileSystem.unlink(heldPath).catch(() => undefined);
    }
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

  // Friendly missing-config diagnostic before lock acquisition (avoids raw ENOENT on .lock).
  try {
    await fileSystem.stat(configurationPath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new Error(
        `Local Configuration is missing at ${configurationPath}; run agent-profile-kit init`,
      );
    }
    throw error;
  }

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

    await publishConfigurationReplacement(
      configurationPath,
      source,
      nextSource,
      mode,
      fileSystem,
      description,
    );

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
