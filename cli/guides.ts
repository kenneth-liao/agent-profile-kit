import { readFile } from "node:fs/promises";

import type {
  InfoConfigurationState,
  InfoWorkspaceLocation,
} from "../installer/info.js";
import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_NAME } from "../installer/version.js";
import {
  guideCodeBlockNode,
  guideHeadingNode,
  guideMarkdownDocument,
} from "./guide-markdown.js";
import {
  commandPart,
  identifierPart,
  pathPart,
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

/**
 * The focused guide topics (spec #491, US-016, #509): command-first. Each
 * topic leads with the `apkit new`/`configure` commands that create and
 * select the material, then explains the resulting files through the
 * canonical examples (AUTHORING_EXAMPLES, DEC-011), and closes with the one
 * next lifecycle action plus the route to the complete reference. The `next`
 * block renders whole, as the literal line it carries.
 */
export const TOPIC_GUIDES = {
  profile: {
    title: "Profile",
    introduction:
      "A Profile selects reusable material for a kind of work through its context and skills lists.",
    scaffoldLead: "Create its Context Module, then the Profile selecting it:",
    scaffoldCommands: [
      ["new", "context", "<context>"],
      ["new", "profile", "<profile>", "--context", "<context>"],
    ] as const,
    next: "Next: from the project you want to try, run `apkit install example --host codex`.",
  },
  context: {
    title: "Context Module",
    introduction:
      "A Context Module is an independently reusable unit of always-loaded guidance. " +
      "Profiles select it by its path under `context/` without `.md`, and apkit reads no frontmatter.",
    scaffoldLead: "Create one, then select it into a Profile:",
    scaffoldCommands: [
      ["new", "context", "<context>"],
      ["configure", "profile"],
    ] as const,
    next: "Next: run `apkit validate`, then select it into a Profile with `apkit configure profile`.",
  },
  skill: {
    title: "Skill",
    introduction:
      "A Skill is a reusable workflow package. Profiles select it by its frontmatter `name`, " +
      "and its description tells an Agent Host when the workflow applies.",
    scaffoldLead: "Create one, then select it into a Profile:",
    scaffoldCommands: [
      ["new", "skill", "<skill>"],
      ["configure", "profile"],
    ] as const,
    next: "Next: run `apkit validate`, then select it into a Profile with `apkit configure profile`.",
  },
} as const;

/** The route to the complete reference, shared by every focused guide. Guide
 * prose carries no category (the focused-guide presentation rule), so the
 * pointer renders as plain prose around its atomic command part. */
const FULL_GUIDE_POINTER = {
  kind: "sentence",
  parts: ["For complete authoring guidance, run ",
    commandPart(COMMAND_NAME, [
      { kind: "text" as const, value: "guide" },
      { kind: "text" as const, value: "--full" },
    ]),
    "."],
} as const satisfies PresentationNode;


function spacer(): PresentationNode {
  return { kind: "verbatim", text: "" };
}

/** The guide index as a presentation document. */
export function guideIndexDocument(): PresentationDocument {
  const nodes: PresentationNode[] = [
    guideHeadingNode("Agent Profile Kit guide"),
    spacer(),
    {
      kind: "sentence",
      parts: [
        "Choose a focused authoring topic, read the complete human guide, or open the agent workflow reference.",
      ],
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
    ["init", "<path>"],
    ["new", "skill", "<skill>"],
    ["guide", "profile"],
    ["install", AUTHORING_EXAMPLES.profile.id, "--host", "codex"],
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

/**
 * One authoring example as terminal content (#510, DEC-011): a wrapping lead
 * sentence, then the example body through the one copyability rule — the
 * verbatim code block, never wrapped or styled, so copyable commands stay
 * whole. No markdown fences: those are source decoration, not terminal
 * content.
 */
function exampleNodes(
  example: { readonly path: string; readonly contents: string },
): readonly PresentationNode[] {
  return [
    { kind: "sentence", parts: [`An example ${example.path}:`] },
    spacer(),
    guideCodeBlockNode(example.contents),
  ];
}

/** The scaffold commands: one framing sentence, then atomic command lines. */
function scaffoldNodes(guide: (typeof TOPIC_GUIDES)[GuideTopic]): readonly PresentationNode[] {
  return [
    spacer(),
    { kind: "sentence", parts: [guide.scaffoldLead] },
    ...guide.scaffoldCommands.map((args) => routeLine([...args])),
  ];
}

export interface FocusedGuideWorkspaceInput {
  readonly configurationState: InfoConfigurationState;
  readonly workspace: InfoWorkspaceLocation | null;
}

function focusedGuideWorkspaceNode(input?: FocusedGuideWorkspaceInput): PresentationNode {
  if (input === undefined || input.configurationState === "not-configured" || input.workspace === null) {
    // No Workspace location was ever given: there is no default to name, so
    // the remedy names the explicit path form (spec #593 #601, ADR-0049).
    if (input?.configurationState === "legacy") {
      return {
        kind: "sentence",
        parts: [
          "Workspace: Legacy configuration; run ",
          commandPart(COMMAND_NAME, [{ kind: "text", value: "init" }, { kind: "text", value: "<path>" }]),
        ],
      };
    }
    return {
      kind: "sentence",
      parts: [
        "Workspace: Not configured (run ",
        commandPart(COMMAND_NAME, [{ kind: "text", value: "init" }, { kind: "text", value: "<path>" }]),
        ")",
      ],
    };
  }
  if (input.configurationState === "legacy") {
    return {
      kind: "sentence",
      parts: [
        "Workspace: Legacy configuration; run ",
        commandPart(COMMAND_NAME, [{ kind: "text", value: "init" }]),
        " (selected: ",
        pathPart(input.workspace.canonical, "fleet", input.workspace.authored),
        ")",
      ],
    };
  }
  return {
    kind: "sentence",
    parts: [
      "Workspace: ",
      pathPart(input.workspace.canonical, "fleet", input.workspace.authored),
    ],
  };
}

/** One focused authoring guide (profile, context, or skill) as a document. */
export function focusedGuideDocument(
  topic: GuideTopic,
  workspace?: FocusedGuideWorkspaceInput,
): PresentationDocument {
  const guide = TOPIC_GUIDES[topic];
  const nodes: PresentationNode[] = [
    guideHeadingNode(guide.title),
    spacer(),
    { kind: "sentence", parts: [guide.introduction] },
    spacer(),
    focusedGuideWorkspaceNode(workspace),
    ...scaffoldNodes(guide),
    spacer(),
    ...exampleNodes(AUTHORING_EXAMPLES[topic]),
  ];
  if (topic === "profile") {
    nodes.push(spacer(), ...exampleNodes(AUTHORING_EXAMPLES.context));
  }
  nodes.push(
    spacer(),
    {
      kind: "sentence",
      // The carried next action renders whole, as the literal block it came from.
      parts: [identifierPart(guide.next)],
      category: "heading",
    },
    spacer(),
    FULL_GUIDE_POINTER,
  );
  return nodes;
}

/**
 * The complete human Workspace guide as terminal content (#510, US-016):
 * the guide-markdown rendering policy parses the source into presentation
 * nodes — headings without decoration, wrapping prose, bullet items, and
 * verbatim copyable code — inside the existing terminal/pager boundary.
 */
export function humanGuideDocument(body: string): PresentationDocument {
  return guideMarkdownDocument(body);
}

/**
 * The agent workflow reference as one verbatim document: the markdown is
 * agent-facing material reproduced without wrapping or styling, because
 * markdown structure is information to its agent consumer (#510). The
 * file's trailing newline is the writer's line terminator.
 */
export function guideFileDocument(body: string): PresentationDocument {
  const withoutFinalNewline = body.endsWith("\n") ? body.slice(0, -1) : body;
  return [{ kind: "verbatim", text: withoutFinalNewline }];
}
