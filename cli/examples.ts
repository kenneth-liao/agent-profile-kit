import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { inventoryCommandExamples } from "./inventory-topics.js";

/** One canonical command-example set for CLI help. */
const workspace = "~/agent-profile-workspace";
const project = "~/projects/example-project";
const profile = AUTHORING_EXAMPLES.profile.id;

export const COMMAND_EXAMPLES = {
  init: ["init", `init ${workspace}`],
  guide: ["guide", "guide profile", "guide context", "guide skill", "guide --full", "guide --agent"],
  bind: [
    `bind ${profile} --host codex`,
    `bind ${profile} ${project} --host codex --host claude`,
  ],
  unbind: ["unbind", `unbind ${project}`],
  validate: ["validate"],
  info: ["info", "info --json"],
  list: inventoryCommandExamples(),
  preview: ["preview", "preview --verbose", "preview --json"],
  apply: ["apply", `apply ${project}`, "apply --all", "apply --json"],
  status: ["status", `status ${project}`, "status --all", "status --json"],
  uninstall: ["uninstall"],
  "install-temp": [
    `install-temp ${profile} ${project} --host codex --json`,
    `install-temp ${profile} ${project} --host claude --json`,
  ],
  "remove-temp": ["remove-temp <temporary-installation-id> --json"],
} as const;
