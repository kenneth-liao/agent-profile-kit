import {
  normalizeHostSelection,
  publishBindingUnderLock,
  type BindProjectFileSystem,
  type BindProjectResult,
} from "../../installer/bind-project.js";
import {
  defaultFileSystem,
  DEFAULT_LOCK_TIMEOUT_MS,
  withConfigurationLock,
} from "../../installer/local-configuration-publication.js";
import { localConfigurationPath, normalizeProject } from "../../installer/local-configuration.js";

export interface PublishBindingOptions {
  readonly home: string;
  readonly profile: string;
  readonly project: string;
  readonly hosts: readonly string[];
  readonly fileSystem?: BindProjectFileSystem;
  readonly lockTimeoutMs?: number;
}

/** Operation label for test-only publications; never a retired command name. */
const OPERATION = "test-binding";

/**
 * Record one Project Binding without installing, through the same Host
 * normalization, lock, and publication primitive the install commit uses.
 * Production has no recording-only command (ADR-0033); a binding with no
 * installation is still a valid hand-edited state, so tests construct it here
 * instead (#568).
 */
export async function publishBinding(options: PublishBindingOptions): Promise<BindProjectResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const configurationPath = localConfigurationPath(options.home);
  const hosts = normalizeHostSelection(options.hosts);
  const canonicalProject = await normalizeProject(options.project, options.home, {
    source: "local-configuration",
    configurationPath,
  });
  return withConfigurationLock(
    configurationPath,
    fileSystem,
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    OPERATION,
    () =>
      publishBindingUnderLock(configurationPath, fileSystem, OPERATION, {
        home: options.home,
        profile: options.profile,
        hosts,
        canonicalProject,
        storedProject: options.project,
      }),
  );
}
