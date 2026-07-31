/**
 * One canonical command-example set for CLI help and future teaching surfaces.
 * Ticket #121 will add the authoring formats used by guides and init scaffolding.
 */
const workspace = "~/agent-profile-workspace";
const project = "~/projects/example-project";
const profile = "example";

export const COMMAND_EXAMPLES = {
  init: ["init", `init ${workspace}`],
  guide: ["guide", "guide --agent"],
  bind: [
    `bind ${profile} --host codex`,
    `bind ${profile} ${project} --host codex --host claude`,
  ],
  unbind: ["unbind", `unbind ${project}`],
  validate: ["validate"],
  preview: ["preview", "preview --verbose"],
  apply: ["apply", "apply --verbose"],
  status: ["status", "status --verbose"],
  uninstall: ["uninstall"],
} as const;

export const EXAMPLE_IDENTITIES = { workspace, project, profile } as const;
