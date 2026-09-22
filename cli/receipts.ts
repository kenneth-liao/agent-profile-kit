import { hostsEqual } from "../installer/bind-project.js";
import type { SupportedHost } from "../adapters/host-catalog.js";
import { COMMAND_NAME } from "../installer/version.js";
import type { CreationArtifactType } from "../installer/tool-errors.js";
import {
  configureProfileRouting,
  createdProfileInstallRouting,
} from "./command-help.js";
import { capitalize, DEFAULT_VIEW_LEXICON, singleProjectIdentity } from "./presentation.js";
import { displayPath, displayProjectPath } from "./display-path.js";
import {
  commandPart,
  identifierPart,
  pathPart,
  stateHeadline,
  type InlineContent,
  type PathPart,
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

/**
 * The one install next action for a Profile an invocation just left in the
 * Workspace (spec #491, US-016): the guided and example-only initialization
 * completions and the `apkit new profile` receipt share this derivation so
 * they cannot disagree. Host choice stays with install's searchable choices
 * (ADR-0034) — this guidance never names a Host.
 */
export function createdProfileInstallNextActionDocument(profile: string): PresentationDocument {
  return [{
    kind: "sentence",
    parts: [
      "Next: from the project you want to try, run ",
      createdProfileInstallRouting(profile),
    ],
    category: "command",
  }];
}

/**
 * The created-fact nodes of one Profile creation receipt: the created
 * sentence, the selected membership, and the available-material guidance
 * (US-045). One home shared by the `apkit new` receipt and the guided
 * initialization completion, so the two flows cannot disagree on the facts.
 */
export function newArtifactCreatedNodes(input: NewArtifactReceiptInput): PresentationNode[] {
  const created: PresentationNode = stateHeadline([
    `Created ${input.artifactType} `,
    identifierPart(input.id),
    " at ",
    identifierPart(input.path),
  ], "success");
  const selectedContexts = input.selectedContexts ?? [];
  const selectedSkills = input.selectedSkills ?? [];
  const nodes: PresentationNode[] = [created];
  if (input.selectedContexts === undefined && input.selectedSkills === undefined) {
    // Plain `apkit new` receipts carry no Profile membership or
    // available-material guidance (US-042–US-046).
    return nodes;
  }
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
  return nodes;
}

/**
 * The guided initialization completion (spec #491, US-016): the created
 * Profile's receipt facts plus the one install next action naming the
 * Profile actually created. It replaces the parallel stale lines the guided
 * flow used to print — the vague validate-then-install sentence and the
 * equivalent `apkit new profile` command, which would fail with
 * `duplicate-artifact-name` because the Profile it describes already exists.
 */
export function guidedInitCompletionDocument(
  input: NewArtifactReceiptInput,
): PresentationDocument {
  return [
    ...newArtifactCreatedNodes(input),
    ...createdProfileInstallNextActionDocument(input.id),
  ];
}

/** The receipt document for one `apkit new` invocation (US-042–US-046,
 * #509): a new Skill or Context Module is selected into a Profile with
 * configure, and a new Profile is installed — the same routing the `new`
 * help entry carries, derived from one home in cli/command-help.ts. */
export function newArtifactReceiptDocument(input: NewArtifactReceiptInput): PresentationDocument {
  if (input.selectedContexts === undefined && input.selectedSkills === undefined) {
    return [
      ...newArtifactCreatedNodes(input),
      {
        kind: "sentence",
        parts: [
          "Next: select it into a Profile with ",
          configureProfileRouting(),
        ],
        category: "command",
      },
    ];
  }
  return [
    ...newArtifactCreatedNodes(input),
    ...createdProfileInstallNextActionDocument(input.id),
  ];
}

const localConfiguration = DEFAULT_VIEW_LEXICON.localConfiguration;
const projectBindingSingular = DEFAULT_VIEW_LEXICON.projectBinding.singular;
const projectBindingCapitalized = capitalize(projectBindingSingular);

export interface MissingProfileBindingReport {
  readonly project: string;
  readonly profile: string;
}

export interface InitReceiptInput {
  readonly outcome: "created" | "migrated" | "unchanged" | "connected";
  readonly path: string;
  readonly authoredPath: string;
  /**
   * True when setup created the named Workspace folder itself (it did not
   * exist; spec #593 #599). The created folder is reported in the receipt so
   * the user sees exactly what setup wrote.
   */
  readonly folderCreated?: boolean;
  readonly detectedHosts?: readonly SupportedHost[];
  /**
   * The guided flow reports the Profile it just created — and that
   * completion's one install next action — right after this receipt, so the
   * receipt carries no parallel next action of its own (spec #491, US-016).
   */
  readonly guidedProfileFollows?: boolean;
  readonly missingProfileBindings?: readonly MissingProfileBindingReport[];
}

export interface InitConfirmationInput {
  /** The resolved absolute destination folder. */
  readonly destinationPath: string;
  /** The authored Workspace spelling, kept for the display identity. */
  readonly authoredPath: string;
  /** True when setup must create the named folder itself. */
  readonly folderMissing: boolean;
  /** The required parts setup would add, in canonical order. */
  readonly missingParts: readonly string[];
  /** When connecting again, the currently configured Workspace absolute path. */
  readonly currentDestinationPath?: string | undefined;
  /** When connecting again, the currently configured Workspace authored path. */
  readonly currentAuthoredPath?: string | undefined;
}

/** The displayed spelling of one setup folder: never elided — the
 * confirmation and the location question show the full path (ISC-24.2). */
function initSetupPathPart(destinationPath: string, authoredPath?: string): PathPart {
  return pathPart(destinationPath, "fleet", authoredPath);
}

/**
 * The setup parts in presentation order, as the USER-JOURNEY Initialize stage
 * names them (one home beside that stage's wording). Every canonical part
 * must have a display label here: a part planned for writing but missing
 * from this map fails fast, so the confirmation can never understate the
 * write.
 */
const SETUP_PART_LABELS: Record<string, string> = {
  "workspace.yaml": "workspace.yaml",
  context: "context/",
  skills: "skills/",
  profiles: "profiles/",
};

/**
 * The ordered display spelling of the parts setup will add. An unknown part
 * is an authoring error at this boundary, never a silently dropped list item.
 */
function orderedSetupParts(missingParts: readonly string[]): readonly string[] {
  const ordered = [
    ...missingParts.filter((part) => part === "workspace.yaml"),
    ...["context", "skills", "profiles"].filter((part) => missingParts.includes(part)),
  ];
  if (ordered.length !== missingParts.length ||
    ordered.some((part) => SETUP_PART_LABELS[part] === undefined)
  ) {
    throw new Error(`unpresentable setup part: ${missingParts.join(", ")}`);
  }
  return ordered.map((part) => SETUP_PART_LABELS[part]!);
}

/**
 * The pre-write confirmation screen for one interactive first-connection
 * setup (spec #593 #603, US-001, ISC-24.2–24.3): the full chosen path, what
 * making it the Workspace means, and exactly the parts setup would add — or
 * that nothing will be. The canonical home of the confirmation copy; the
 * principal's rendered-screen review (#610) tunes the wording here.
 */
export function initConfirmationDocument(input: InitConfirmationInput): PresentationDocument {
  const workspace = initSetupPathPart(input.destinationPath, input.authoredPath);
  const nodes: PresentationNode[] = [];
  if (input.currentDestinationPath !== undefined) {
    const currentWorkspace = initSetupPathPart(input.currentDestinationPath, input.currentAuthoredPath);
    nodes.push(
      {
        kind: "sentence",
        parts: ["Current Workspace: ", currentWorkspace],
      },
      {
        kind: "sentence",
        parts: ["Requested Workspace: ", workspace],
      },
    );
  }
  nodes.push({
    kind: "sentence",
    parts: ["Context and Skill files will be stored in and loaded from ", workspace, "."],
  });
  if (input.folderMissing) {
    nodes.push({
      kind: "sentence",
      parts: ["The folder does not exist yet; setup will create it."],
    });
  }
  if (input.missingParts.length === 0) {
    nodes.push({
      kind: "sentence",
      parts: ["Nothing needs to be added — ", workspace, " already satisfies the Workspace contract."],
    });
  } else {
    const ordered = orderedSetupParts(input.missingParts);
    const partParts: InlineContent[] = [];
    ordered.forEach((label, index) => {
      if (index > 0) partParts.push(index === ordered.length - 1 ? " and " : ", ");
      partParts.push(identifierPart(label));
    });
    nodes.push({ kind: "sentence", parts: ["Setup will add ", ...partParts, "."] });
  }
  return nodes;
}

/**
 * The location question's screen for one interactive first-connection setup
 * without a path (spec #593 #603, US-001, ISC-24.2): the current folder,
 * shown as its full path, is the first offered choice.
 */
export function initLocationDocument(input: {
  readonly destinationPath: string;
  readonly authoredPath?: string;
}): PresentationDocument {
  return [
    {
      kind: "sentence",
      parts: [
        "Your Workspace is a folder you choose.",
      ],
    },
    {
      kind: "sentence",
      parts: ["Current folder: ", initSetupPathPart(input.destinationPath, input.authoredPath)],
    },
  ];
}

function appendMissingProfileBindings(
  nodes: PresentationNode[],
  missingProfileBindings: readonly MissingProfileBindingReport[],
): void {
  nodes.push(stateHeadline([
    "Project Bindings whose Profile this Workspace lacks:",
  ], "warning"));
  for (const missing of missingProfileBindings) {
    nodes.push({
      kind: "sentence",
      parts: [
        `- `,
        pathPart(missing.project, "fleet"),
        `: Profile '${missing.profile}' does not exist in this Workspace.`,
      ],
    });
    nodes.push({
      kind: "sentence",
      parts: [
        `  Next: create it with `,
        commandPart(COMMAND_NAME, [arg("new"), arg("profile"), arg(missing.profile)]),
        `, or install an available Profile with `,
        commandPart(COMMAND_NAME, [arg("install"), arg(missing.profile), arg(missing.project)]),
        `.`,
      ],
      category: "command",
    });
  }
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
  if (input.outcome === "connected") {
    const nodes: PresentationNode[] = [
      stateHeadline(input.folderCreated === true
        ? [`Created the Workspace folder and connected Agent Profile Kit Workspace at `, workspace]
        : [`Connected Agent Profile Kit Workspace at `, workspace], "success"),
    ];
    if (input.missingProfileBindings && input.missingProfileBindings.length > 0) {
      appendMissingProfileBindings(nodes, input.missingProfileBindings);
    }
    nodes.push({
      kind: "sentence",
      parts: [
        "Next: run ",
        commandPart(COMMAND_NAME, [arg("validate")]),
      ],
      category: "command",
    });
    return nodes;
  }
  if (input.outcome === "migrated") {
    const nodes: PresentationNode[] = [
      stateHeadline([
        `Migrated ${localConfiguration} and validated the Agent Profile Kit Workspace at `,
        workspace,
      ], "success"),
    ];
    if (input.missingProfileBindings && input.missingProfileBindings.length > 0) {
      appendMissingProfileBindings(nodes, input.missingProfileBindings);
    }
    nodes.push({
      kind: "sentence",
      parts: [
        "Next: run ",
        commandPart(COMMAND_NAME, [arg("validate")]),
        ", then status and update as needed",
      ],
      category: "command",
    });
    return nodes;
  }
  // The one next action is the delivered validate pointer: setup adds no
  // example material (spec #593 DEC-003, #599), so there is no scaffolded
  // Profile to recommend. Detection is advisory (DEC-011) and Host choice
  // stays with install's searchable choices (ADR-0034), so the next action
  // never names a Host. When the guided flow's Profile completion follows, it
  // owns the one next action and the receipt prints none.
  const nextAction = input.guidedProfileFollows === true
    ? undefined
    : [{
      kind: "sentence" as const,
      parts: [
        "Next: run ",
        commandPart(COMMAND_NAME, [arg("validate")]),
      ],
      category: "command" as const,
    }];
  const detectedHosts = input.detectedHosts ?? [];

  return [
    stateHeadline(input.folderCreated === true
      ? ["Created the Workspace folder and initialized Agent Profile Kit Workspace and ", localConfiguration, " at ", workspace]
      : [`Initialized Agent Profile Kit Workspace and ${localConfiguration} at `, workspace], "success"),
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
    ...(nextAction ?? []),
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
  // The installed Project is this receipt's whole view, so its
  // shortest-unambiguous identity is the label it carries (US-013).
  const project: PathPart = {
    ...pathPart(
      input.canonicalProject,
      "fleet",
      displayProjectPath(input.canonicalProject, input.project, "fleet"),
    ),
    identity: singleProjectIdentity({
      canonicalProject: input.canonicalProject,
      project: input.project,
    }),
  };
  const nodes: PresentationNode[] = [];
  if (input.outcome === "unchanged") {
    nodes.push({
      kind: "sentence",
      parts: ["Installation unchanged for ", project],
    });
  } else {
    nodes.push(stateHeadline([
      `${input.outcome === "replaced" ? "Replaced installation" : "Installed"} ${input.profile} for `,
      project,
    ], "success"));
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
  const nodes: PresentationNode[] = [stateHeadline([input.changed
    ? `Updated reusable Profile '${input.profile}'.`
    : `Reusable Profile '${input.profile}' already has exactly this membership.`], "success")];
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