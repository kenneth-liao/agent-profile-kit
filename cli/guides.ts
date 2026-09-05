import { readFile } from "node:fs/promises";

import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_NAME } from "../installer/version.js";
import {
  commandPart,
  identifierPart,
  type PresentationDocument,
  type PresentationNode,
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


function spacer(): PresentationNode {
  return { kind: "verbatim", text: "" };
}

/** The guide index as a presentation document. */
export function guideIndexDocument(): PresentationDocument {
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
  for (const topic of GUIDE_TOPICS) {
    const guide = TOPIC_GUIDES[topic];
    nodes.push(
      routeLine(["guide", topic]),
      { kind: "sentence", parts: [`    ${guide.title}: ${guide.introduction}`] },
    );
  }
  nodes.push(spacer(), { kind: "heading", text: "Complete references:" });
  for (const [route, description] of [
    [["guide", "--full"], "Complete human Workspace guide"],
    [["guide", "--agent"], "Agent workflow reference"],
  ] as const) {
    nodes.push(
      routeLine(route),
      { kind: "sentence", parts: [`    ${description}`] },
    );
  }
  nodes.push(spacer(), { kind: "heading", text: "Examples:" });
  for (const args of [
    ["init"],
    ["guide", "profile"],
    ["bind", AUTHORING_EXAMPLES.profile.id, "--host", "codex"],
  ] as const) {
    nodes.push(routeLine(args));
  }
  return nodes;
}

/**
 * One indented route line as a single atomic command part: the whole route
 * renders on one line, never split or folded.
 */
function routeLine(args: readonly string[]): PresentationNode {
  return {
    kind: "sentence",
    parts: [
      "  ",
      commandPart(COMMAND_NAME, args.map((value) => ({ kind: "text" as const, value }))),
    ],
    category: "command",
  };
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
export function focusedGuideDocument(topic: GuideTopic): PresentationDocument {
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
  nodes.push(spacer(), {
    kind: "sentence",
    // The carried next action renders whole, as the literal block it came from.
    parts: [identifierPart(guide.next)],
    category: "heading",
  });
  return nodes;
}

/**
 * A complete guide file body as one verbatim document: the markdown is
 * user-facing quoted material reproduced without wrapping or styling. The
 * file's trailing newline is the writer's line terminator.
 */
export function guideFileDocument(body: string): PresentationDocument {
  const withoutFinalNewline = body.endsWith("\n") ? body.slice(0, -1) : body;
  return [{ kind: "verbatim", text: withoutFinalNewline }];
}
