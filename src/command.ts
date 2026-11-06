/** The command name, used everywhere apkit tells someone what to run. */
export const COMMAND = "apkit";

/**
 * What each command takes. `--help` works with any command, and `--json` is accepted everywhere
 * (help, guide, and contract print text with it). `arguments` is the most arguments it takes after
 * its name; `--global` and `--all` take the place of the folder, so each lowers it by one. Anything
 * else is a usage error, before any read or write.
 */
export const COMMANDS: Readonly<Record<string, { readonly options: readonly string[]; readonly arguments: number }>> = {
  help: { options: [], arguments: 0 },
  guide: { options: [], arguments: 0 },
  contract: { options: [], arguments: 0 },
  init: { options: ["--json"], arguments: 1 },
  workspace: { options: ["--json"], arguments: 1 },
  setup: { options: ["--agents", "--remove", "--yes", "--overwrite", "--json"], arguments: 0 },
  check: { options: ["--workspace", "--json"], arguments: 0 },
  install: { options: ["--agents", "--global", "--yes", "--overwrite", "--workspace", "--json"], arguments: 2 },
  update: { options: ["--all", "--yes", "--overwrite", "--workspace", "--json"], arguments: 1 },
  remove: { options: ["--global", "--yes", "--overwrite", "--json"], arguments: 1 },
  status: { options: ["--all", "--global", "--workspace", "--json"], arguments: 1 },
  migrate: { options: ["--yes", "--overwrite", "--workspace", "--json"], arguments: 0 },
};
