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
import { requireProfile } from "./profile-selection.js";
import { InstallerToolError, type ConfiguredPathOrigin } from "./tool-errors.js";

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
    throw new InstallerToolError({
      kind: "bind-host-required",
      supportedHosts: SUPPORTED_HOSTS,
    });
  }
  const seen = new Set<SupportedHost>();
  for (const host of hosts) {
    if (!isSupportedHost(host)) {
      throw new InstallerToolError({
        kind: "unsupported-host",
        host,
        supportedHosts: SUPPORTED_HOSTS,
      });
    }
    seen.add(host);
  }
  // Canonical Host order matches Local Configuration ingestion.
  return SUPPORTED_HOSTS.filter((host) => seen.has(host));
}

/** Canonical-order equality; shared with CLI old → new receipt rendering. */
export function hostsEqual(
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
  /** Restate Profile and Hosts of an existing binding for the canonical project. */
  readonly replace?: boolean;
  /** Working directory used when project is omitted. Defaults to process.cwd(). */
  readonly cwd?: string;
  /** Test-only filesystem override for snapshot and publication proofs. */
  readonly fileSystem?: BindProjectFileSystem;
  /** Test-only lock wait/stale-empty timeout (ms). */
  readonly lockTimeoutMs?: number;
}

interface BindProjectResultBase {
  readonly configurationPath: string;
  readonly project: string;
  readonly canonicalProject: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
}

export type BindProjectResult =
  | (BindProjectResultBase & { readonly outcome: "created" | "unchanged" })
  | (BindProjectResultBase & {
      readonly outcome: "replaced";
      /** Previous values for old → new receipts; "replaced" guarantees a delta. */
      readonly previousProfile: string;
      readonly previousHosts: readonly SupportedHost[];
    });

/**
 * Append one Project Binding to Local Configuration without reconciling output.
 * Local Configuration remains the sole canonical home; this is a validated edit.
 */
export interface PublishBindingUnderLockOptions {
  readonly home: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
  readonly canonicalProject: string;
  readonly storedProject: string;
  readonly replace: boolean;
}

/**
 * Validate, edit, and atomically publish one Project Binding while the caller
 * holds the Local Configuration lock. Shared by `bindProject` and the install
 * commit path so both publish through one snapshot-checked boundary.
 */
export async function publishBindingUnderLock(
  configurationPath: string,
  fileSystem: BindProjectFileSystem,
  operation: string,
  binding: PublishBindingUnderLockOptions,
): Promise<BindProjectResult> {
  const description = `Local Configuration ${configurationPath}`;
  // Legacy claim-aside residue is restored only under proven exclusive ownership.
  await recoverHeldConfiguration(configurationPath, fileSystem);

  let source: string;
  try {
    source = await fileSystem.readFile(configurationPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new InstallerToolError({
        kind: "missing-local-configuration",
        path: configurationPath,
      });
    }
    throw error;
  }

  // Exact snapshot being edited is the sole input to the trusted semantic boundary.
  const { configuration, workspace } = await ingestApplicationFromSource(
    binding.home,
    source,
    configurationPath,
  );
  requireProfile(workspace.profiles, binding.profile);

  // Serialize one edited document and publish it through the shared
  // configuration-replacement boundary; all edits happen under held lock.
  const publishSourceReplacement = async (editedSource: string): Promise<void> => {
    const nextSource = preserveSourceNewlines(source, editedSource);
    const sourceStats = await fileSystem.stat(configurationPath);
    const mode = sourceStats.mode & 0o777;
    await publishConfigurationReplacement(
      configurationPath,
      source,
      nextSource,
      mode,
      fileSystem,
      description,
      operation,
    );
  };

  // The application model preserves Local Configuration's binding order 1:1,
  // so the semantic match's position is also the YAML sequence index.
  const existingIndex = configuration.bindings.findIndex(
    (entry) => entry.canonicalProject === binding.canonicalProject,
  );
  const existing = existingIndex === -1 ? undefined : configuration.bindings[existingIndex];
  if (existing) {
    if (existing.profile === binding.profile && hostsEqual(existing.hosts, binding.hosts)) {
      return {
        outcome: "unchanged" as const,
        configurationPath,
        project: existing.project,
        canonicalProject: binding.canonicalProject,
        profile: binding.profile,
        hosts: binding.hosts,
      };
    }
    if (!binding.replace) {
      throw new InstallerToolError({
        kind: "bind-conflict",
        configurationPath,
        canonicalProject: binding.canonicalProject,
        profile: existing.profile,
        hosts: existing.hosts,
      });
    }

    // The application model preserves Local Configuration's binding order 1:1,
    // so the semantic match's position is also the YAML sequence index.
    const document = parseDocument(source);
    const bindingsNode = document.get("bindings");
    if (!isSeq(bindingsNode)) {
      throw new Error(`${description} bindings must be an array`);
    }
    const bindingNode = bindingsNode.items[existingIndex];
    if (!isMap(bindingNode)) {
      throw new Error(`${description} bindings[${existingIndex}] must be a mapping`);
    }
    bindingNode.set("profile", binding.profile);
    bindingNode.set("hosts", [...binding.hosts]);
    bindingNode.flow = false;

    await publishSourceReplacement(document.toString());

    return {
      outcome: "replaced" as const,
      configurationPath,
      project: existing.project,
      canonicalProject: binding.canonicalProject,
      profile: binding.profile,
      hosts: binding.hosts,
      previousProfile: existing.profile,
      previousHosts: existing.hosts,
    };
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
    project: binding.storedProject,
    profile: binding.profile,
    hosts: [...binding.hosts],
  });
  if (isMap(entry)) {
    entry.flow = false;
    const hostsNode = entry.get("hosts");
    if (isSeq(hostsNode)) hostsNode.flow = false;
  }
  bindingsNode.add(entry);

  await publishSourceReplacement(document.toString());

  return {
    outcome: "created" as const,
    configurationPath,
    project: binding.storedProject,
    canonicalProject: binding.canonicalProject,
    profile: binding.profile,
    hosts: binding.hosts,
  };

}

/**
 * Remove one Project Binding by canonical identity while the caller holds the
 * Local Configuration lock. Used only to restore the pre-install selection
 * after a failed install commit; removal selection itself belongs to uninstall.
 */
export async function removeBindingUnderLock(
  home: string,
  configurationPath: string,
  fileSystem: BindProjectFileSystem,
  operation: string,
  canonicalProject: string,
): Promise<{ readonly removed: boolean }> {
  const description = `Local Configuration ${configurationPath}`;
  await recoverHeldConfiguration(configurationPath, fileSystem);
  let source: string;
  try {
    source = await fileSystem.readFile(configurationPath, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      throw new InstallerToolError({
        kind: "missing-local-configuration",
        path: configurationPath,
      });
    }
    throw error;
  }
  const { configuration } = await ingestApplicationFromSource(
    home,
    source,
    configurationPath,
  );
  const existingIndex = configuration.bindings.findIndex(
    (entry) => entry.canonicalProject === canonicalProject,
  );
  if (existingIndex === -1) return { removed: false };
  const document = parseDocument(source);
  const bindingsNode = document.get("bindings");
  if (!isSeq(bindingsNode)) {
    throw new Error(`${description} bindings must be an array`);
  }
  bindingsNode.items.splice(existingIndex, 1);
  if (bindingsNode.items.length === 0) {
    bindingsNode.flow = false;
  }
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
    operation,
  );
  return { removed: true };
}

export async function bindProject(
  options: BindProjectOptions,
): Promise<BindProjectResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const configurationPath = localConfigurationPath(options.home);
  const origin: ConfiguredPathOrigin = {
    source: "local-configuration",
    configurationPath,
  };
  const profile = requireArtifactId(options.profile, "bind profile");
  const hosts = normalizeHosts(options.hosts);
  const cwd = options.cwd ?? process.cwd();

  let canonicalProject: string;
  if (options.project === undefined) {
    canonicalProject = await requireExistingDirectory(
      cwd,
      cwd,
      origin,
      "project",
    );
  } else {
    canonicalProject = await normalizeProject(
      options.project,
      options.home,
      origin,
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
      throw new InstallerToolError({
        kind: "missing-local-configuration",
        path: configurationPath,
      });
    }
  }

  return withConfigurationLock(configurationPath, fileSystem, lockTimeoutMs, "bind", () =>
    publishBindingUnderLock(configurationPath, fileSystem, "bind", {
      home: options.home,
      profile,
      hosts,
      canonicalProject,
      storedProject,
      replace: options.replace === true,
    }),
  );
}
