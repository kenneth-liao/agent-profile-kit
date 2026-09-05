import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { COMMAND_NAME } from "../installer/version.js";
import {
  capitalize,
  DEFAULT_VIEW_LEXICON,
  displayProjectPath,
} from "./presentation.js";
import type {
  PresentationDocument,
  PresentationNode,
} from "./presentation-document.js";

/**
 * One authored receipt: its document plus the presented values whose spaces
 * must survive sentence wrapping (the temporary-blocked-view convention).
 */
export interface ReceiptDocument {
  readonly document: PresentationDocument;
  readonly copyableValues: readonly string[];
}

/**
 * Authoring and teardown receipt views as presentation documents. Every node
 * carries its semantic category where the meaning is known (DEC-003); wording
 * is the view's carried text.
 */

const localConfiguration = DEFAULT_VIEW_LEXICON.localConfiguration;
const projectBindingSingular = DEFAULT_VIEW_LEXICON.projectBinding.singular;
const projectBindingCapitalized = capitalize(projectBindingSingular);

/** The receipt document for one `init` invocation. */
export function initReceiptDocument(input: {
  readonly outcome: "created" | "migrated" | "unchanged";
  readonly path: string;
  readonly workspaceScaffolded?: boolean;
}): ReceiptDocument {
  if (input.outcome === "unchanged") {
    return receipt([{
      kind: "sentence",
      text: `Workspace and ${localConfiguration} already initialized at ${input.path}; unchanged.`,
    }], [input.path]);
  }
  if (input.outcome === "migrated") {
    return receipt([
      {
        kind: "sentence",
        text: `Migrated ${localConfiguration} and validated the Agent Profile Kit Workspace at ${input.path}`,
        category: "success",
      },
      {
        kind: "sentence",
        text: `Next: run ${COMMAND_NAME} validate, then status and apply as needed`,
        category: "command",
      },
    ], [input.path]);
  }
  return receipt([
    {
      kind: "sentence",
      text: `Initialized Agent Profile Kit Workspace and ${localConfiguration} at ${input.path}`,
      category: "success",
    },
    {
      kind: "sentence",
      text: input.workspaceScaffolded === true
        ? `Next: from the project you want to try, run ${COMMAND_NAME} bind ${AUTHORING_EXAMPLES.profile.id} --host codex`
        : `Next: run ${COMMAND_NAME} validate`,
      category: "command",
    },
  ], [input.path]);
}

/** Bundles one receipt document with the presented values that must not split. */
function receipt(
  document: PresentationDocument,
  copyableValues: readonly string[],
): ReceiptDocument {
  return { document, copyableValues: copyableValues.filter((value) => value.includes(" ")) };
}

export type BindReceiptInput = {
  readonly outcome: "created" | "unchanged" | "replaced";
  readonly canonicalProject: string;
  readonly project: string;
  readonly profile: string;
  readonly hosts: readonly string[];
} & (BindReceiptInputBase | {
  readonly outcome: "replaced";
  readonly previousProfile: string;
  readonly previousHosts: readonly string[];
});

type BindReceiptInputBase = {
  readonly outcome: "created" | "unchanged";
};

/** The receipt document for one `bind` invocation. */
export function bindReceiptDocument(
  input: BindReceiptInput,
): ReceiptDocument {
  const project = displayProjectPath(input.canonicalProject, input.project, "project");
  const nodes: PresentationNode[] = [];
  if (input.outcome === "unchanged") {
    nodes.push({ kind: "sentence", text: `${projectBindingCapitalized} unchanged for ${project}` });
  } else {
    nodes.push({
      kind: "sentence",
      text: `${input.outcome === "replaced" ? "Replaced" : "Recorded"} ${projectBindingSingular} for ${project}`,
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
    if (!hostsUnchanged(previousHosts, input.hosts)) {
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
  return receipt(nodes, [project]);
}

function hostsUnchanged(
  previous: readonly string[],
  next: readonly string[],
): boolean {
  return previous.length === next.length &&
    next.every((host, index) => previous[index] === host);
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
): ReceiptDocument {
  if (input.outcome === "unchanged") {
    return receipt([{
      kind: "sentence",
      text: `${projectBindingCapitalized} unchanged; no ${projectBindingSingular} matched ${input.requestedProject}`,
    }], [input.requestedProject]);
  }
  const presentedProject = input.recovery === "canonical"
    ? displayProjectPath(input.canonicalProject ?? input.project, input.project, "project")
    : displayProjectPath(input.project, input.project, "project");
  const nodes: PresentationNode[] = [{
    kind: "sentence",
    text: `Removed ${projectBindingSingular} for ${presentedProject}`,
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
      { kind: "prose", text: "Generated files remain until apply" },
      nextCommandNode("status --all"),
    );
  }
  return receipt(nodes, [
    presentedProject,
    ...(input.recovery === "authored-path" && input.configurationPath !== undefined
      ? [input.configurationPath]
      : []),
  ]);
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