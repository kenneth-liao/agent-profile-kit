import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";

/** One canonical command-example set for CLI help. */
const workspace = "~/agent-profile-workspace";
const project = "~/projects/example-project";
const profile = AUTHORING_EXAMPLES.profile.id;

export const COMMAND_EXAMPLES = {
  init: ["init", `init ${workspace}`],
  guide: ["guide", "guide profile", "guide context", "guide skill", "guide --agent"],
  bind: [
    `bind ${profile} --host codex`,
    `bind ${profile} ${project} --host codex --host claude`,
  ],
  unbind: ["unbind", `unbind ${project}`],
  validate: ["validate"],
  preview: ["preview", "preview --verbose", "preview --json"],
  apply: ["apply", "apply --verbose", "apply --json"],
  status: ["status", "status --verbose", "status --json"],
  uninstall: ["uninstall"],
  "install-temp": [
    `install-temp ${profile} ${project} --host codex --json`,
  ],
  "remove-temp": ["remove-temp <temporary-installation-id> --json"],
} as const;
