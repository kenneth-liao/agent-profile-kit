export const INVENTORY_TOPICS = [
  {
    description: "Project inventory from Local Configuration.",
    name: "projects",
  },
  {
    description: "Profile inventory from the selected Workspace.",
    name: "profiles",
  },
  {
    description: "Supported Agent Host inventory with Temporary Profile Installation eligibility.",
    name: "hosts",
  },
  {
    description: "Active Temporary Profile Installation inventory from Installation State.",
    name: "temporary",
  },
] as const;

export type InventoryTopic = (typeof INVENTORY_TOPICS)[number]["name"];

export function isInventoryTopic(value: string): value is InventoryTopic {
  return INVENTORY_TOPICS.some((topic) => topic.name === value);
}

export function inventoryTopicNames(): readonly InventoryTopic[] {
  return INVENTORY_TOPICS.map((topic) => topic.name);
}

export function inventoryCommandSyntax(): string {
  return `list [${inventoryTopicNames().join("|")} [--json]]`;
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
