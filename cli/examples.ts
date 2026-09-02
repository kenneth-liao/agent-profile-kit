import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { inventoryCommandExamples, machineInventoryCommandExamples } from "./inventory-topics.js";

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
    `bind ${profile} ${project} --host codex --host opencode --replace`,
  ],
  unbind: ["unbind", `unbind ${project}`],
  validate: ["validate"],
  info: ["info", "info --json"],
  list: inventoryCommandExamples(),
  apply: [
    "apply",
    `apply ${project}`,
    "apply --all",
    "apply --blockers-only",
    "apply --blockers-only --verbose",
    "apply --json",
  ],
  status: [
    "status",
    `status ${project}`,
    "status --all",
    "status --blockers-only",
    "status --blockers-only --verbose",
    "status --json",
  ],
  uninstall: ["uninstall"],
  "install-temp": [
    `machine install-temp ${profile} ${project} --host codex --json`,
    `machine install-temp ${profile} ${project} --host claude --json`,
  ],
  "remove-temp": ["machine remove-temp <temporary-installation-id> --json"],
} as const;

/** Examples for the machine-namespaced inventory command (DEC-019). */
export const MACHINE_LIST_EXAMPLES = machineInventoryCommandExamples();
