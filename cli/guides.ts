import { readFile } from "node:fs/promises";

import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_NAME } from "../installer/version.js";
import type {
  PresentationDocument,
  PresentationNode,
} from "./presentation-document.js";

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


/**
 * One guide view: its document plus the command lines that must survive
 * wrapping whole.
 */
export interface GuideDocument {
  readonly document: PresentationDocument;
  readonly copyableValues: readonly string[];
}

function spacer(): PresentationNode {
  return { kind: "verbatim", text: "" };
}

/** The guide index as a presentation document. */
export function guideIndexDocument(): GuideDocument {
  const nodes: PresentationNode[] = [
    { kind: "heading", text: "# Agent Profile Kit guide" },
    spacer(),
    {
      kind: "sentence",
      text:
        "Choose a focused authoring topic, read the complete human guide, or open the agent workflow reference.",
    },
    spacer(),
    { kind: "heading", text: "Topics:" },
  ];
  const copyableValues: string[] = [];
  for (const topic of GUIDE_TOPICS) {
    const guide = TOPIC_GUIDES[topic];
    const route = `${COMMAND_NAME} guide ${topic}`;
    nodes.push(
      { kind: "sentence", text: `  ${route}`, category: "command" },
      { kind: "sentence", text: `    ${guide.title}: ${guide.introduction}` },
    );
    copyableValues.push(route);
  }
  nodes.push(spacer(), { kind: "heading", text: "Complete references:" });
  for (const [route, description] of [
    [`${COMMAND_NAME} guide --full`, "Complete human Workspace guide"],
    [`${COMMAND_NAME} guide --agent`, "Agent workflow reference"],
  ] as const) {
    nodes.push(
      { kind: "sentence", text: `  ${route}`, category: "command" },
      { kind: "sentence", text: `    ${description}` },
    );
    copyableValues.push(route);
  }
  nodes.push(spacer(), { kind: "heading", text: "Examples:" });
  for (const example of [
    `${COMMAND_NAME} init`,
    `${COMMAND_NAME} guide profile`,
    `${COMMAND_NAME} bind ${AUTHORING_EXAMPLES.profile.id} --host codex`,
  ]) {
    nodes.push({ kind: "sentence", text: `  ${example}`, category: "command" });
    copyableValues.push(example);
  }
  return { document: nodes, copyableValues };
}

/** One fenced authoring example, reproduced exactly (verbatim content). */
function exampleNodes(
  example: { readonly path: string; readonly contents: string },
  language: string,
): readonly PresentationNode[] {
  return [
    spacer(),
    {
      kind: "verbatim",
      text: `Create \`${example.path}\`:\n\n\`\`\`${language}\n${example.contents}\`\`\``,
    },
  ];
}

/** One focused authoring guide (profile, context, or skill) as a document. */
export function focusedGuideDocument(topic: GuideTopic): GuideDocument {
  const guide = TOPIC_GUIDES[topic];
  const nodes: PresentationNode[] = [
    { kind: "heading", text: `# ${guide.title}` },
    spacer(),
    { kind: "sentence", text: guide.introduction },
    ...exampleNodes(AUTHORING_EXAMPLES[topic], guide.language),
  ];
  if (topic === "profile") {
    nodes.push(...exampleNodes(AUTHORING_EXAMPLES.context, "md"));
  }
  nodes.push(spacer(), { kind: "sentence", text: guide.next, category: "heading" });
  // The carried next action renders whole, as the literal block it came from.
  return { document: nodes, copyableValues: [guide.next] };
}

/**
 * A complete guide file body as one verbatim document: the markdown is
 * user-facing quoted material reproduced without wrapping or styling. The
 * file's trailing newline is the writer's line terminator.
 */
export function guideFileDocument(body: string): GuideDocument {
  const withoutFinalNewline = body.endsWith("\n") ? body.slice(0, -1) : body;
  return {
    document: [{ kind: "verbatim", text: withoutFinalNewline }],
    copyableValues: [],
  };
}
