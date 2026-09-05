import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { hostsEqual } from "../installer/bind-project.js";
import type { SupportedHost } from "../adapters/host-catalog.js";
import { COMMAND_NAME } from "../installer/version.js";
import { capitalize, DEFAULT_VIEW_LEXICON } from "./presentation.js";
import { displayProjectPath } from "./display-path.js";
import {
  commandPart,
  identifierPart,
  pathPart,
  type PresentationDocument,
  type PresentationNode,
} from "./presentation-document.js";

/**
 * Authoring and teardown receipt views as presentation documents. Every node
 * carries its semantic category where the meaning is known (DEC-003); wording
 * is the view's carried text, and every structurally supplied value is an
 * atomic inline part the renderer never re-identifies (DEC-009).
 */

const localConfiguration = DEFAULT_VIEW_LEXICON.localConfiguration;
const projectBindingSingular = DEFAULT_VIEW_LEXICON.projectBinding.singular;
const projectBindingCapitalized = capitalize(projectBindingSingular);

/** The receipt document for one `init` invocation. */
export function initReceiptDocument(input: {
  readonly outcome: "created" | "migrated" | "unchanged";
  readonly path: string;
  readonly workspaceScaffolded?: boolean;
}): PresentationDocument {
  const workspace = pathPart(input.path, "project", input.path);
  if (input.outcome === "unchanged") {
    return [{
      kind: "sentence",
      parts: [
        `Workspace and ${localConfiguration} already initialized at `,
        workspace,
        "; unchanged.",
      ],
    }];
  }
  if (input.outcome === "migrated") {
    return [
      {
        kind: "sentence",
        parts: [
          `Migrated ${localConfiguration} and validated the Agent Profile Kit Workspace at `,
          workspace,
        ],
        category: "success",
      },
      {
        kind: "sentence",
        parts: [
          "Next: run ",
          commandPart(COMMAND_NAME, [{ kind: "text", value: "validate" }]),
          ", then status and apply as needed",
        ],
        category: "command",
      },
    ];
  }
  return [
    {
      kind: "sentence",
      parts: [
        `Initialized Agent Profile Kit Workspace and ${localConfiguration} at `,
        workspace,
      ],
      category: "success",
    },
    {
      kind: "sentence",
      parts: input.workspaceScaffolded === true
        ? [
          "Next: from the project you want to try, run ",
          commandPart(COMMAND_NAME, [{ kind: "text", value: "bind" }]),
          ` ${AUTHORING_EXAMPLES.profile.id} --host codex`,
        ]
        : [
          "Next: run ",
          commandPart(COMMAND_NAME, [{ kind: "text", value: "validate" }]),
        ],
      category: "command",
    },
  ];
}

export type BindReceiptInput = {
  readonly outcome: "created" | "unchanged" | "replaced";
  readonly canonicalProject: string;
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
} & (BindReceiptInputBase | {
  readonly outcome: "replaced";
  readonly previousProfile: string;
  readonly previousHosts: readonly SupportedHost[];
});

type BindReceiptInputBase = {
  readonly outcome: "created" | "unchanged";
};

/** The receipt document for one `bind` invocation. */
export function bindReceiptDocument(
  input: BindReceiptInput,
): PresentationDocument {
  const project = pathPart(
    input.canonicalProject,
    "project",
    displayProjectPath(input.canonicalProject, input.project, "project"),
  );
  const nodes: PresentationNode[] = [];
  if (input.outcome === "unchanged") {
    nodes.push({
      kind: "sentence",
      parts: [`${projectBindingCapitalized} unchanged for `, project],
    });
  } else {
    nodes.push({
      kind: "sentence",
      parts: [
        `${input.outcome === "replaced" ? "Replaced" : "Recorded"} ${projectBindingSingular} for `,
        project,
      ],
      category: "success",
    });
  }
  if (input.outcome === "replaced") {
    const { previousProfile, previousHosts } = input;
    if (previousProfile !== input.profile) {
      nodes.push({
        kind: "key-value",
        key: "  Profile",
        value: { kind: "identifier", value: `${previousProfile} → ${input.profile}` },
        category: "path",
      });
    }
    if (!hostsEqual(previousHosts, input.hosts)) {
      nodes.push({
        kind: "key-value",
        key: "  Hosts",
        value: { kind: "identifier", value: `${previousHosts.join(", ")} → ${input.hosts.join(", ")}` },
      });
    }
  } else {
    nodes.push(
      {
        kind: "key-value",
        key: "  Profile",
        value: { kind: "identifier", value: input.profile },
        category: "path",
      },
      {
        kind: "key-value",
        key: "  Hosts",
        value: { kind: "identifier", value: input.hosts.join(", ") },
      },
    );
  }
  nodes.push(nextCommandNode("status"));
  return nodes;
}

export type UnbindReceiptInput =
  | { readonly outcome: "unchanged"; readonly requestedProject: string }
  | {
      readonly outcome: "removed";
      readonly canonicalProject?: string;
      readonly configurationPath?: string;
      readonly generatedOutputSurvives: boolean;
      readonly hosts: readonly string[];
      readonly profile: string;
      readonly project: string;
      readonly recovery: "canonical" | "authored-path";
    };

/** The receipt document for one `unbind` invocation. */
export function unbindReceiptDocument(
  input: UnbindReceiptInput,
): PresentationDocument {
  if (input.outcome === "unchanged") {
    return [{
      kind: "sentence",
      parts: [
        `${projectBindingCapitalized} unchanged; no ${projectBindingSingular} matched `,
        identifierPart(input.requestedProject),
      ],
    }];
  }
  const presentedProject = input.recovery === "canonical"
    ? displayProjectPath(input.canonicalProject ?? input.project, input.project, "project")
    : displayProjectPath(input.project, input.project, "project");
  const nodes: PresentationNode[] = [{
    kind: "sentence",
    parts: [`Removed ${projectBindingSingular} for `, pathPart(
      input.recovery === "canonical"
        ? input.canonicalProject ?? input.project
        : input.project,
      "project",
      presentedProject,
    )],
    category: "success",
  }];
  if (input.recovery === "authored-path") {
    nodes.push(
      {
        kind: "key-value",
        key: "  Recovery",
        value: {
          kind: "identifier",
          value: "exact authored path match; canonical project identity could not be proven",
        },
      },
      {
        kind: "key-value",
        key: "  Local Configuration",
        value: { kind: "identifier", value: input.configurationPath ?? "" },
        category: "path",
      },
    );
  }
  nodes.push(
    {
      kind: "key-value",
      key: "  Profile",
      value: { kind: "identifier", value: input.profile },
      category: "path",
    },
    {
      kind: "key-value",
      key: "  Hosts",
      value: { kind: "identifier", value: input.hosts.join(", ") },
    },
  );
  if (input.generatedOutputSurvives) {
    nodes.push(
      { kind: "prose", parts: ["Generated files remain until apply"] },
      nextCommandNode("status --all"),
    );
  }
  return nodes;
}

/** The `Next:` line as one atomic command (the sibling receipt convention). */
function nextCommandNode(arguments_: string): PresentationNode {
  return {
    kind: "key-value",
    key: "Next",
    value: {
      kind: "command",
      program: COMMAND_NAME,
      args: arguments_
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => ({ kind: "text" as const, value: token })),
    },
    category: "command",
  };
}