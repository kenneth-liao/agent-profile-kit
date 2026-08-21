import { readFile } from "node:fs/promises";

import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_NAME } from "../installer/version.js";
import { wrapPresentationText, type TerminalPresentationContext } from "./terminal-presentation.js";

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

const GUIDE_TOPICS: readonly GuideTopic[] = ["profile", "context", "skill"];

export const TOPIC_GUIDES = {
  profile: {
    title: "Profile",
    introduction:
      "A Profile selects reusable material for a kind of work through its context and skills lists.",
    language: "yaml",
    next: `Next: run \`apkit bind ${AUTHORING_EXAMPLES.profile.id} --host codex\`.`,
  },
  context: {
    title: "Context Module",
    introduction:
      "A Context Module is an independently reusable unit of always-loaded guidance. " +
      "Profiles select it by its frontmatter `id`.",
    language: "md",
    next: `Next: add \`${AUTHORING_EXAMPLES.context.id}\` to a Profile's context list.`,
  },
  skill: {
    title: "Skill",
    introduction:
      "A Skill is a reusable workflow package. Profiles select it by its frontmatter `name`, " +
      "and its description tells an Agent Host when the workflow applies.",
    language: "md",
    next: `Next: add \`${AUTHORING_EXAMPLES.skill.id}\` to a Profile's skills list.`,
  },
} as const;

export function guideIndex(context: TerminalPresentationContext): string {
  const lines = [
    "# Agent Profile Kit guide",
    "",
    ...wrapPresentationText(
      "Choose a focused authoring topic, read the complete human guide, or open the agent workflow reference.",
      context.width,
    ),
    "",
    "Topics:",
  ];

  for (const topic of GUIDE_TOPICS) {
    const guide = TOPIC_GUIDES[topic];
    lines.push(`  ${COMMAND_NAME} guide ${topic}`);
    lines.push(
      ...wrapPresentationText(
        `${guide.title}: ${guide.introduction}`,
        Math.max(1, context.width - 4),
      )
        .map((line) => `    ${line}`),
    );
  }

  lines.push(
    "",
    "Complete references:",
    ...routeDescription(
      `${COMMAND_NAME} guide --full`,
      "Complete human Workspace guide",
      context.width,
    ),
    ...routeDescription(
      `${COMMAND_NAME} guide --agent`,
      "Agent workflow reference",
      context.width,
    ),
    "",
    "Examples:",
    `  ${COMMAND_NAME} init`,
    `  ${COMMAND_NAME} guide profile`,
    `  ${COMMAND_NAME} bind ${AUTHORING_EXAMPLES.profile.id} --host codex`,
  );
  return `${lines.join("\n")}\n`;
}

function routeDescription(route: string, description: string, width: number): readonly string[] {
  return [
    `  ${route}`,
    ...wrapPresentationText(description, Math.max(1, width - 4)).map((line) =>
      `    ${line}`),
  ];
}

type GuideBlock =
  | { readonly kind: "prose"; readonly text: string }
  | { readonly kind: "literal"; readonly text: string };

export function focusedGuide(topic: GuideTopic, context: TerminalPresentationContext): string {
  const guide = TOPIC_GUIDES[topic];
  const example = AUTHORING_EXAMPLES[topic];
  const blocks: GuideBlock[] = [
    {
      kind: "prose",
      text: `# ${guide.title}\n\n${guide.introduction}\n\n`,
    },
    renderExample(example, guide.language),
  ];
  if (topic === "profile") {
    blocks.push(
      { kind: "literal", text: "\n" },
      renderExample(AUTHORING_EXAMPLES.context, "md"),
    );
  }
  blocks.push({ kind: "literal", text: `\n${guide.next}\n` });
  return renderGuideBlocks(blocks, context.width);
}

function renderGuideBlocks(blocks: readonly GuideBlock[], width: number): string {
  return blocks.map((block) => block.kind === "literal"
    ? block.text
    : renderProseBlock(block.text, width)).join("");
}

function renderProseBlock(prose: string, width: number): string {
  const rendered = prose.split("\n").flatMap((line) => {
    if (line.trim().length === 0) return [line];
    const indentation = line.match(/^\s*/)?.[0] ?? "";
    const text = line.trim();
    const listPrefix = text.match(/^(?:[-*+]\s+|\d+[.)]\s+)/)?.[0];
    if (listPrefix !== undefined) {
      const content = text.slice(listPrefix.length);
      const firstWidth = Math.max(1, width - indentation.length - listPrefix.length);
      const wrapped = wrapPresentationText(content, firstWidth);
      const continuationIndent = `${indentation}${" ".repeat(listPrefix.length)}`;
      return [
        `${indentation}${listPrefix}${wrapped[0] ?? ""}`,
        ...wrapped.slice(1).map((wrappedLine) => `${continuationIndent}${wrappedLine}`),
      ];
    }

    return wrapPresentationText(text, Math.max(1, width - indentation.length)).map(
      (wrappedLine) => `${indentation}${wrappedLine}`,
    );
  });
  return rendered.join("\n");
}

function renderExample(
  example: { readonly path: string; readonly contents: string },
  language: string,
): GuideBlock {
  return {
    kind: "literal",
    text: `Create \`${example.path}\`:\n\n\`\`\`${language}\n${example.contents}\`\`\`\n`,
  };
}
