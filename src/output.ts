/** Human output shared by commands; arguments use POSIX shell quoting. */
import { homedir } from "node:os";
import { sep } from "node:path";
import { COMMAND } from "./command.js";

/** A path as the user reads it: under the home folder, it starts with `~`. */
export function display(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

export function quoteArgument(value: string): string {
  return /^[a-zA-Z0-9_./,:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function nextCommand(args: readonly string[], command = COMMAND): string {
  return `Next: \`${[command, ...args].map(quoteArgument).join(" ")}\``;
}

/** Call once per warning condition, with all affected Project or file paths. */
export function groupedWarning(message: string, paths: readonly string[]): string {
  return `Warning: ${message}\n${[...new Set(paths)].map((path) => `  - ${path}`).join("\n")}`;
}
