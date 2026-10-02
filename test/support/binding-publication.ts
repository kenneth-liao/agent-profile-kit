import {
  defaultFileSystem,
  DEFAULT_LOCK_TIMEOUT_MS,
  publishBindingUnderLock,
  withConfigurationLock,
  type BindProjectFileSystem,
  type BindProjectResult,
} from "../../installer/bind-project.js";
import { localConfigurationPath, normalizeProject } from "../../installer/local-configuration.js";
import type { SupportedHost } from "../../schemas/local-configuration.js";

export interface PublishBindingOptions {
  readonly home: string;
  readonly profile: string;
  readonly project: string;
  readonly hosts: readonly SupportedHost[];
  readonly replace?: boolean;
  readonly fileSystem?: BindProjectFileSystem;
  readonly lockTimeoutMs?: number;
}

/**
 * Record one Project Binding without installing, through the same lock and
 * publication primitive the install commit uses. Production has no
 * recording-only command (ADR-0033); a binding with no installation is still
 * a valid hand-edited state, so tests construct it here instead (#568).
 */
export async function publishBinding(options: PublishBindingOptions): Promise<BindProjectResult> {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const configurationPath = localConfigurationPath(options.home);
  const canonicalProject = await normalizeProject(options.project, options.home, {
    source: "local-configuration",
    configurationPath,
  });
  return withConfigurationLock(
    configurationPath,
    fileSystem,
    options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    "bind",
    () =>
      publishBindingUnderLock(configurationPath, fileSystem, "bind", {
        home: options.home,
        profile: options.profile,
        hosts: options.hosts,
        canonicalProject,
        storedProject: options.project,
        replace: options.replace === true,
      }),
  );
}
