import {
  mkdir as defaultMkdir,
  readFile as defaultReadFile,
  rename as defaultRename,
  rm as defaultRm,
  writeFile as defaultWriteFile,
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
  localConfigurationPath,
  normalizeProject,
  requireExistingDirectory,
  ingestApplication,
} from "./local-configuration.js";

/** Optional filesystem hooks used only to prove concurrent-edit safety in tests. */
export interface BindProjectFileSystem {
  readonly mkdir: typeof defaultMkdir;
  readonly readFile: typeof defaultReadFile;
  readonly rename: typeof defaultRename;
  readonly rm: typeof defaultRm;
  readonly writeFile: typeof defaultWriteFile;
}

const defaultFileSystem: BindProjectFileSystem = {
  mkdir: defaultMkdir,
  readFile: defaultReadFile,
  rename: defaultRename,
  rm: defaultRm,
  writeFile: defaultWriteFile,
};

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

  // Shared desired-state ingestion is the sole trusted semantic boundary for
  // existing bindings, Workspace selection, and Profile existence.
  const { configuration, workspace } = await ingestApplication(options.home);
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
        outcome: "unchanged",
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

  // Re-validate the bytes we will edit still match the ingested configuration path.
  // Concurrent writers that mutated after ingest are caught by the publish re-read.
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

  const nextSource = document.toString();

  // Concurrent-edit guard: re-read immediately before publishing the replacement.
  const current = await fileSystem.readFile(configurationPath, "utf8");
  if (current !== source) {
    throw new Error(
      `${description} changed during bind; retry so concurrent edits are not lost`,
    );
  }

  const directory = dirname(configurationPath);
  await fileSystem.mkdir(directory, { recursive: true });
  const temporary = join(
    directory,
    `.config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fileSystem.writeFile(temporary, nextSource, { flag: "wx" });
  try {
    // Prove the source is still unchanged immediately before the atomic replace.
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
    outcome: "created",
    configurationPath,
    project: storedProject,
    canonicalProject,
    profile,
    hosts,
  };
}
