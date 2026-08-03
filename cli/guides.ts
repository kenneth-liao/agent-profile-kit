import { readFile } from "node:fs/promises";

import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";

function guidePath(name: string): URL {
  return new URL(`../docs/guides/${name}`, import.meta.url);
}

export function humanGuide(): Promise<string> {
  return readFile(guidePath("workspace.md"), "utf8");
}

export function agentGuide(): Promise<string> {
  return readFile(guidePath("agent-workflow.md"), "utf8");
}

export type GuideTopic = "profile" | "context" | "skill";

const TOPIC_GUIDES = {
  profile: {
    title: "Profile",
    introduction:
      "A Profile selects reusable material for a kind of work. Every category is explicit; " +
      "agents, hooks, and tools are currently empty.",
    language: "yaml",
    next: `Next: run \`apkit bind ${AUTHORING_EXAMPLES.profile.id} --host codex\`.`,
  },
  context: {
    title: "Context Module",
    introduction:
      "A Context Module is an independently reusable unit of always-loaded guidance. " +
      "Its frontmatter id is the stable Artifact ID selected by Profiles.",
    language: "md",
    next: `Next: add \`${AUTHORING_EXAMPLES.context.id}\` to a Profile's context list.`,
  },
  skill: {
    title: "Skill",
    introduction:
      "A Skill is a reusable workflow package. Its frontmatter name is the stable Artifact ID, " +
      "and its description tells an Agent Host when the workflow applies.",
    language: "md",
    next: `Next: add \`${AUTHORING_EXAMPLES.skill.id}\` to a Profile's skills list.`,
  },
} as const;

export function focusedGuide(topic: GuideTopic): string {
  const guide = TOPIC_GUIDES[topic];
  const example = AUTHORING_EXAMPLES[topic];
  const companion = topic === "profile"
    ? `\n${renderExample(AUTHORING_EXAMPLES.context, "md")}`
    : "";
  return (
    `# ${guide.title}\n\n` +
    `${guide.introduction}\n\n` +
    renderExample(example, guide.language) +
    companion +
    "\n" +
    `${guide.next}\n`
  );
}

function renderExample(
  example: { readonly path: string; readonly contents: string },
  language: string,
): string {
  return `Create \`${example.path}\`:\n\n\`\`\`${language}\n${example.contents}\`\`\`\n`;
}
