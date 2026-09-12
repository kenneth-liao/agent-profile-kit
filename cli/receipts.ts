import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { hostsEqual } from "../installer/bind-project.js";
import type { SupportedHost } from "../adapters/host-catalog.js";
import { COMMAND_NAME } from "../installer/version.js";
import type { CreationArtifactType } from "../installer/tool-errors.js";
import { capitalize, DEFAULT_VIEW_LEXICON } from "./presentation.js";
import { displayPath, displayProjectPath } from "./display-path.js";
import {
  commandPart,
  identifierPart,
  pathPart,
  type CommandArg,
  type PresentationDocument,
  type PresentationNode,
} from "./presentation-document.js";

/** One carried command argument. */
const arg = (value: string): CommandArg => ({ kind: "text", value });

/**
 * The one-sentence Profile explanation shown at the moment a user is asked to
 * choose one (US-033): the initialization receipt and the interactive bind
 * Profile prompt share this single home so the wording cannot drift.
 */
export const PROFILE_EXPLANATION_SENTENCE =
  "A Profile is a named selection of Context and Skills to adapt for your projects.";

/**
 * Authoring and teardown receipt views as presentation documents. Every node
 * carries its semantic category where the meaning is known (DEC-003); wording
 * is the view's carried text, and every structurally supplied value is an
 * atomic inline part the renderer never re-identifies (DEC-009).
 */

/** The receipt input for one `apkit new` invocation. */
export interface NewArtifactReceiptInput {
  /** The display noun of the created artifact kind. */
  readonly artifactType: CreationArtifactType;
  readonly id: string;
  /** Absolute path of the file actually created. */
  readonly path: string;
  /** Profile creation only: the explicitly selected existing material. */
  readonly selectedContexts?: readonly string[];
  readonly selectedSkills?: readonly string[];
  /** Profile creation only: available names shown as selection guidance. */
  readonly availableContexts?: readonly string[];
  readonly availableSkills?: readonly string[];
}

/** One available-material guidance sentence; absence renders as `none`. */
function availableMaterialNode(label: string, names: readonly string[] | undefined): PresentationNode {
  return {
    kind: "sentence",
    parts: names !== undefined && names.length > 0
      ? [`Available ${label}s: `, identifierPart(names.join(", "))]
      : [`Available ${label}s: none`],
  };
}

/** The receipt document for one `apkit new` invocation (US-042–US-046). */
export function newArtifactReceiptDocument(input: NewArtifactReceiptInput): PresentationDocument {
  const created: PresentationNode = {
    kind: "sentence",
    parts: [
      `Created ${input.artifactType} `,
      identifierPart(input.id),
      " at ",
      identifierPart(input.path),
    ],
    category: "success",
  };
  if (input.selectedContexts === undefined && input.selectedSkills === undefined) {
    return [
      created,
      {
        kind: "sentence",
        parts: [
          `Next: select the ${input.artifactType} from a Profile, then run `,
          commandPart(COMMAND_NAME, [arg("validate")]),
        ],
        category: "command",
      },
    ];
  }
  const nodes: PresentationNode[] = [created];
  const selectedContexts = input.selectedContexts ?? [];
  const selectedSkills = input.selectedSkills ?? [];
  if (selectedContexts.length > 0) {
    nodes.push({
      kind: "key-value",
      key: "  Context",
      value: { kind: "identifier", value: selectedContexts.join(", ") },
      category: "path",
    });
  }
  if (selectedSkills.length > 0) {
    nodes.push({
      kind: "key-value",
      key: "  Skills",
      value: { kind: "identifier", value: selectedSkills.join(", ") },
    });
  }
  // Available names are shown as guidance (US-045), so the author can extend
  // the Profile without hunting the Workspace.
  nodes.push(
    availableMaterialNode("Context Module", input.availableContexts),
    availableMaterialNode("Skill", input.availableSkills),
  );
  nodes.push({
    kind: "sentence",
    parts: [
      "Next: run ",
      commandPart(COMMAND_NAME, [arg("validate")]),
      ", then install the Profile into a Project",
    ],
    category: "command",
  });
  return nodes;
}

const localConfiguration = DEFAULT_VIEW_LEXICON.localConfiguration;
const projectBindingSingular = DEFAULT_VIEW_LEXICON.projectBinding.singular;
const projectBindingCapitalized = capitalize(projectBindingSingular);

export interface InitReceiptInput {
  readonly outcome: "created" | "migrated" | "unchanged";
  readonly path: string;
  readonly authoredPath: string;
  readonly workspaceScaffolded?: boolean;
  readonly detectedHosts?: readonly SupportedHost[];
}

/** The receipt document for one `init` invocation. */
export function initReceiptDocument(input: InitReceiptInput): PresentationDocument {
  const workspace = pathPart(
    input.path,
    "fleet",
    displayPath(input.path, input.authoredPath, "fleet"),
  );
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
          commandPart(COMMAND_NAME, [arg("validate")]),
          ", then status and update as needed",
        ],
        category: "command",
      },
    ];
  }
  const detectedHosts = input.detectedHosts ?? [];
  const firstDetectedHost = detectedHosts[0];
  const nextCommandParts =
    input.workspaceScaffolded === true && firstDetectedHost !== undefined
      ? [
        "Next: from the project you want to try, run ",
        commandPart(COMMAND_NAME, [
          arg("install"),
          arg(AUTHORING_EXAMPLES.profile.id),
          arg("--host"),
          arg(firstDetectedHost),
        ]),
      ]
      : [
        "Next: run ",
        commandPart(COMMAND_NAME, [arg("validate")]),
      ];

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
      parts: [PROFILE_EXPLANATION_SENTENCE],
    },
    {
      kind: "sentence",
      parts:
        detectedHosts.length > 0
          ? ["Detected Agent Hosts: ", identifierPart(detectedHosts.join(", "))]
          : ["Detected Agent Hosts: none"],
    },
    {
      kind: "sentence",
      parts: nextCommandParts,
      category: "command",
    },
  ];
}

export type InstallReceiptInput = {
  readonly outcome: "created" | "unchanged";
  readonly canonicalProject: string;
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
} | {
  readonly outcome: "replaced";
  readonly canonicalProject: string;
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly SupportedHost[];
  /** The replaced selection; required exactly when outcome is "replaced". */
  readonly previous: {
    readonly profile: string;
    readonly hosts: readonly SupportedHost[];
  };
};

/** The receipt document for one `install` invocation: the installed
 * selection and its verified outcome in one action (US-001). */
export function installReceiptDocument(
  input: InstallReceiptInput,
): PresentationDocument {
  const project = pathPart(
    input.canonicalProject,
    "fleet",
    displayProjectPath(input.canonicalProject, input.project, "fleet"),
  );
  const nodes: PresentationNode[] = [];
  if (input.outcome === "unchanged") {
    nodes.push({
      kind: "sentence",
      parts: ["Installation unchanged for ", project],
    });
  } else {
    nodes.push({
      kind: "sentence",
      parts: [
        `${input.outcome === "replaced" ? "Replaced installation" : "Installed"} ${input.profile} for `,
        project,
      ],
      category: "success",
    });
  }
  if (input.outcome === "replaced") {
    const { profile: previousProfile, hosts: previousHosts } = input.previous;
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

export interface ConfigureReceiptInput {
  readonly profile: string;
  readonly previousContexts: readonly string[];
  readonly previousSkills: readonly string[];
  readonly contexts: readonly string[];
  readonly skills: readonly string[];
  readonly changed: boolean;
  /** The executable explicit equivalent, as command arguments. */
  readonly equivalent: readonly CommandArg[];
}

/** The receipt document for one `configure profile` invocation (US-009):
 * the saved membership, its executable explicit equivalent, and update as
 * the next action. An unchanged membership says so instead of claiming
 * an update. */
export function configureReceiptDocument(
  input: ConfigureReceiptInput,
): PresentationDocument {
  const change = (previous: readonly string[], next: readonly string[]): string => {
    const before = previous.length === 0 ? "(none)" : previous.join(", ");
    const after = next.length === 0 ? "(none)" : next.join(", ");
    return before === after ? after : `${before} → ${after}`;
  };
  const nodes: PresentationNode[] = [{
    kind: "sentence",
    parts: [input.changed
      ? `Updated reusable Profile '${input.profile}'.`
      : `Reusable Profile '${input.profile}' already has exactly this membership.`],
    category: "success",
  }];
  nodes.push(
    {
      kind: "key-value",
      key: "  Context",
      value: { kind: "identifier", value: change(input.previousContexts, input.contexts) },
      category: "path",
    },
    {
      kind: "key-value",
      key: "  Skills",
      value: { kind: "identifier", value: change(input.previousSkills, input.skills) },
      category: "path",
    },
    {
      kind: "key-value",
      key: "Equivalent",
      value: { kind: "command", program: COMMAND_NAME, args: [...input.equivalent] },
      category: "command",
    },
  );
  nodes.push(nextCommandNode("update"));
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
        .map(arg),
    },
    category: "command",
  };
}