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
import {
  defaultFileSystem,
  DEFAULT_LOCK_TIMEOUT_MS,
  hasHeldResidue,
  pathExists,
  preserveSourceNewlines,
  publishConfigurationReplacement,
  recoverHeldConfiguration,
  type LocalConfigurationFileSystem,
  withConfigurationLock,
} from "./local-configuration-publication.js";
import { COMMAND_NAME } from "./version.js";

/** Compatibility facade for existing bind-project consumers; publication's canonical implementation is separate. */
export {
  defaultFileSystem,
  DEFAULT_LOCK_TIMEOUT_MS,
  hasHeldResidue,
  pathExists,
  preserveSourceNewlines,
  publishConfigurationReplacement,
  recoverHeldConfiguration,
  withConfigurationLock,
};
export type { LocalConfigurationFileSystem } from "./local-configuration-publication.js";
export type BindProjectFileSystem = LocalConfigurationFileSystem;

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
  /** Test-only filesystem override for snapshot and publication proofs. */
  readonly fileSystem?: BindProjectFileSystem;
  /** Test-only lock wait/stale-empty timeout (ms). */
  readonly lockTimeoutMs?: number;
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
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
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
  // Do not restore held residue here — recovery requires exclusive lock ownership so it
  // cannot interfere with another live bind transaction.
  if (!(await pathExists(fileSystem, configurationPath))) {
    if (!(await hasHeldResidue(configurationPath, fileSystem))) {
      throw new Error(
        `Local Configuration is missing at ${configurationPath}; run ${COMMAND_NAME} init`,
      );
    }
  }

  return withConfigurationLock(
    configurationPath,
    fileSystem,
    lockTimeoutMs,
    "bind",
    async () => {
      // Legacy claim-aside residue is restored only under proven exclusive ownership.
      await recoverHeldConfiguration(configurationPath, fileSystem);

      let source: string;
      try {
        source = await fileSystem.readFile(configurationPath, "utf8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          throw new Error(
            `Local Configuration is missing at ${configurationPath}; run ${COMMAND_NAME} init`,
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
        "bind",
      );

      return {
        outcome: "created" as const,
        configurationPath,
        project: storedProject,
        canonicalProject,
        profile,
        hosts,
      };
    },
  );
}
