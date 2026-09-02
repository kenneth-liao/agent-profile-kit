export const INVENTORY_TOPICS = [
  {
    description: "Configured Project inventory from settings.",
    name: "projects",
  },
  {
    description: "Profile inventory from the selected Workspace.",
    name: "profiles",
  },
  {
    description: "Supported Agent Hosts for configured Projects.",
    name: "hosts",
  },
] as const;

/**
 * Inventory topics of the machine-facing namespace (DEC-019). The temporary
 * topic moved here with the temporary installation commands; its record shape
 * and `--json` payload are unchanged.
 */
export const MACHINE_INVENTORY_TOPICS = [
  {
    description: "Active temporary Profile inventory.",
    name: "temporary",
  },
] as const;

export type InventoryTopic = (typeof INVENTORY_TOPICS)[number]["name"];

export type MachineInventoryTopic = (typeof MACHINE_INVENTORY_TOPICS)[number]["name"];

export function isInventoryTopic(value: string): value is InventoryTopic {
  return INVENTORY_TOPICS.some((topic) => topic.name === value);
}

export function isMachineInventoryTopic(value: string): value is MachineInventoryTopic {
  return MACHINE_INVENTORY_TOPICS.some((topic) => topic.name === value);
}

export function inventoryTopicNames(): readonly InventoryTopic[] {
  return INVENTORY_TOPICS.map((topic) => topic.name);
}

export function inventoryCommandSyntax(): string {
  return `list [${inventoryTopicNames().join("|")} [--json]]`;
}

function machineInventoryTopicNames(): readonly MachineInventoryTopic[] {
  return MACHINE_INVENTORY_TOPICS.map((topic) => topic.name);
}

export { machineInventoryTopicNames };

export function machineInventoryCommandSyntax(): string {
  return `list [${machineInventoryTopicNames().join("|")} [--json]]`;
}

export function inventoryCommandExamples(): readonly string[] {
  return [
    "list",
    ...INVENTORY_TOPICS.flatMap((topic) => [
      `list ${topic.name}`,
      `list ${topic.name} --json`,
    ]),
  ];
}

export function machineInventoryCommandExamples(): readonly string[] {
  return MACHINE_INVENTORY_TOPICS.flatMap((topic) => [
    `machine list ${topic.name}`,
    `machine list ${topic.name} --json`,
  ]);
}
