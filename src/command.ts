/** The command name, used everywhere apkit tells someone what to run. */
export const COMMAND = "apkit";

/**
 * The options each command takes. `--help` works with any command, and `--json` is accepted
 * everywhere (help, guide, and contract print text with it). Anything else is a usage error,
 * before any read or write.
 */
export const OPTIONS: Readonly<Record<string, readonly string[]>> = {
  help: [],
  guide: [],
  contract: [],
  init: ["--json"],
  workspace: ["--json"],
  setup: ["--agents", "--remove", "--yes", "--overwrite", "--json"],
  check: ["--workspace", "--json"],
  install: ["--agents", "--global", "--yes", "--overwrite", "--workspace", "--json"],
  update: ["--all", "--yes", "--overwrite", "--workspace", "--json"],
  remove: ["--global", "--yes", "--overwrite", "--json"],
  status: ["--all", "--global", "--workspace", "--json"],
  migrate: ["--yes", "--overwrite", "--workspace", "--json"],
};

/** The most arguments each command takes after its name. More is a usage error, before any read or write. */
export const POSITIONALS: Readonly<Record<string, number>> = {
  help: 0,
  guide: 0,
  contract: 0,
  init: 1,
  workspace: 1,
  setup: 0,
  check: 0,
  install: 2,
  update: 1,
  remove: 1,
  status: 1,
  migrate: 0,
};
