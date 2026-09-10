import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { inventoryCommandExamples, machineInventoryCommandExamples } from "./inventory-topics.js";

/** One canonical command-example set for CLI help. */
const workspace = "~/agent-profile-workspace";
const project = "~/projects/example-project";
const profile = AUTHORING_EXAMPLES.profile.id;

export const COMMAND_EXAMPLES = {
  init: ["init", `init ${workspace}`],
  guide: ["guide", "guide profile", "guide context", "guide skill", "guide --full", "guide --agent"],
  new: ["new skill review-pr", "new context review-standards", `new profile my-profile --context ${AUTHORING_EXAMPLES.context.id}`],
  open: ["open"],
  install: [
    `install ${profile} --host codex --auto-confirm`,
    `install ${profile} ${project} --host codex --host claude --auto-confirm`,
  ],
  unbind: ["unbind", `unbind ${project}`],
  validate: ["validate"],
  info: ["info", "info --json"],
  list: inventoryCommandExamples(),
  update: [
    "update",
    "update --here",
    `update ${project}`,
    "update --all",
    "update --stale",
    "update --stale --json",
    "update --blocked",
    "update --replace-changed",
    "update --remove-changed",
    "update --json",
  ],
  status: [
    "status",
    "status --here",
    `status ${project}`,
    "status --all",
    "status --blocked",
    "status --stale --json",
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
