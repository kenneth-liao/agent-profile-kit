import { hostsEqual } from "../installer/bind-project.js";
import type { SupportedHost } from "../adapters/host-catalog.js";
import { COMMAND_NAME } from "../installer/version.js";
import type { CreationArtifactType } from "../installer/tool-errors.js";
import {
  configureProfileRouting,
  createdProfileInstallRouting,
  guidedInstallRouting,
  newProfileCreationCommands,
} from "./command-help.js";
import { capitalize, DEFAULT_VIEW_LEXICON } from "./presentation.js";
import { displayPath, stableProjectDisplay, workspaceSubfolderDisplay } from "./display-path.js";
import {
  commandNode,
  commandPart,
  footerNodes,
  identifierPart,
  list,
  neutralStatementDocument,
  notedCommand,
  part,
  pathPart,
  stateHeadline,
  type InlineContent,
  type PathPart,
  type CommandArg,
  type PresentationDocument,
  type PresentationNode,
} from "./presentation-document.js";
import {
  PROFILE_EXPLANATION_PARAGRAPH,
  PROFILE_EXPLANATION_SENTENCE,
  WORKSPACE_EXPLANATION_SENTENCE,
  WORKSPACE_SCOPE_EXPLANATION_SENTENCE,
  contextExplanationParagraph,
  skillExplanationParagraph,
} from "./concept-explanations.js";

/** One carried command argument. */
const arg = (value: string): CommandArg => ({ kind: "text", value });

/**
 * Re-exported so existing callers keep one authority for the Profile
 * explanation (US-001, DEC-003): `cli/concept-explanations.ts` is its home.
 */
export { PROFILE_EXPLANATION_SENTENCE };

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
 * Guidance document when creating a Profile in an empty Workspace (US-004,
 * Screen P1): explains what a Profile needs, shows how to add material, and
 * creates nothing.
 */
export function emptyWorkspaceProfileCreationDocument(
  workspacePath?: string,
  authoredPath?: string,
): PresentationDocument {
  const skillsFolder = workspacePath !== undefined
    ? workspaceSubfolderDisplay(workspacePath, "skills", authoredPath)
    : "skills/";
  const part1 = part({
    kind: "sentence",
    parts: ["A Profile needs at least one Context file or Skill, and your Workspace has none yet."],
  });
  const part2 = part(
    { kind: "sentence", parts: ["Add some first:"] },
    list([
      [`Put skill folders in ${skillsFolder}`],
      [
        notedCommand(
          commandNode(COMMAND_NAME, [arg("new"), arg("context"), arg("<name>")]),
          "create a Context file to fill in",
        ),
      ],
    ]),
  );
  const part3 = part({
    kind: "sentence",
    parts: [
      "Then run ",
      commandPart(COMMAND_NAME, [arg("new"), arg("profile")]),
      " again.",
    ],
  });
  return [part1, part2, part3];
}

/** One concept sentence explaining what a Profile is (US-004, Screen P2). */
export function newProfileExplanationDocument(): PresentationDocument {
  return [
    part({
      kind: "sentence",
      parts: [
        'A Profile groups Context and Skills for one kind of work, like "engineering" or "writing".',
      ],
    }),
  ];
}

/** Note before Context selection (US-004, Screen P3). */
export function newProfileContextNoteDocument(): PresentationDocument {
  return [
    part({
      kind: "sentence",
      parts: ["Context is loaded in every agent session that uses this Profile."],
    }),
  ];
}

/** Note before Skill selection (US-004, Screen P4). */
export function newProfileSkillsNoteDocument(): PresentationDocument {
  return [
    part({
      kind: "sentence",
      parts: ["Agents load Skills only when they need them."],
    }),
  ];
}

/**
 * The receipt document for Profile creation (US-004, Screen P5): states the
 * created Profile, its Context and Skills, how to change it later with
 * configure, and installs it as the next step.
 */
export function newProfileReceiptDocument(input: {
  readonly id: string;
  readonly selectedContexts?: readonly string[] | undefined;
  readonly selectedSkills?: readonly string[] | undefined;
}): PresentationDocument {
  const headline = stateHeadline([
    "Created the ",
    identifierPart(input.id),
    " Profile",
  ], "success");
  const membershipNodes: PresentationNode[] = [];
  const selectedContexts = input.selectedContexts ?? [];
  const selectedSkills = input.selectedSkills ?? [];
  if (selectedContexts.length > 0) {
    membershipNodes.push({
      kind: "key-value",
      key: "  Context",
      value: { kind: "identifier", value: selectedContexts.join(", ") },
      category: "path",
    });
  }
  if (selectedSkills.length > 0) {
    membershipNodes.push({
      kind: "key-value",
      key: "  Skills",
      value: { kind: "identifier", value: selectedSkills.join(", ") },
    });
  }
  const part1 = part(headline, ...membershipNodes);
  const part2 = part({
    kind: "sentence",
    parts: [
      "Change it later with ",
      commandPart(COMMAND_NAME, [arg("configure"), arg("profile"), arg(input.id)]),
      ".",
    ],
  });
  const part3 = footerNodes({
    next: {
      kind: "command",
      value: notedCommand(
        commandNode(COMMAND_NAME, [arg("install"), arg(input.id)]),
        "run it inside a Project folder",
      ),
    },
  });
  return [part1, part2, part3];
}

/**
 * The receipt document for Context Module creation (US-004, Screen P6): states
 * the created file, instructs what to write in it, and points to
 * `apkit new profile`.
 */
export function newContextReceiptDocument(input: {
  readonly path: string;
}): PresentationDocument {
  const part1 = part(
    stateHeadline([
      "Created ",
      pathPart(input.path, "fleet"),
    ], "success"),
  );
  const part2 = part({
    kind: "sentence",
    parts: ["Open it and write the rules every agent session should follow."],
  });
  const part3 = footerNodes({
    next: {
      kind: "command",
      value: notedCommand(
        commandNode(COMMAND_NAME, [arg("new"), arg("profile")]),
        "make a Profile that uses it",
      ),
    },
  });
  return [part1, part2, part3];
}

/** The receipt document for one `apkit new` invocation (US-004, US-042–US-046). */
export function newArtifactReceiptDocument(input: NewArtifactReceiptInput): PresentationDocument {
  if (input.artifactType === "Profile") {
    return newProfileReceiptDocument({
      id: input.id,
      selectedContexts: input.selectedContexts,
      selectedSkills: input.selectedSkills,
    });
  }
  if (input.artifactType === "Context Module") {
    return newContextReceiptDocument({ path: input.path });
  }
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
   * exist; spec #593 #599). The receipt's created/connected verb is decided
   * from this fact and no other input (spec #672 US-003, screen 21).
   */
  readonly folderCreated: boolean;
  readonly detectedHosts?: readonly SupportedHost[];
  readonly missingProfileBindings?: readonly MissingProfileBindingReport[];
  /** The parts setup actually added (SETUP_PART_LABELS keys), never planned-but-absent. */
  readonly addedParts?: readonly string[];
  /**
   * True when this run wrote Local Configuration (created, replaced, or
   * migrated it). Set at each installer commit site — never derived from
   * `outcome`.
   */
  readonly configurationWritten: boolean;
  /** Absolute Local Configuration path this commit read or wrote. */
  readonly configurationPath: string;
  /** Profiles present in the resulting Workspace; routes the handoff (US-002). */
  readonly profileCount: number;
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
  const part1Nodes: PresentationNode[] = [];
  if (input.currentDestinationPath !== undefined) {
    const currentWorkspace = initSetupPathPart(input.currentDestinationPath, input.currentAuthoredPath);
    part1Nodes.push(
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
  part1Nodes.push({
    kind: "sentence",
    parts: ["Context, Skills, and Profiles will be stored in and loaded from ", workspace, "."],
  });
  const part1 = part(...part1Nodes);

  let part2: PresentationNode;
  if (input.missingParts.length === 0) {
    part2 = part({
      kind: "sentence",
      parts: ["This folder already has everything it needs."],
    });
  } else {
    const ordered = orderedSetupParts(input.missingParts);
    const prefix = input.folderMissing
      ? "This folder doesn't exist yet. Setup will create it and add:"
      : "Setup will add:";
    part2 = part(
      {
        kind: "sentence",
        parts: [prefix],
      },
      list(ordered.map((part) => [identifierPart(part)])),
    );
  }
  return [part1, part2];
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
  // Workspace first, before the folder choice (US-001, DEC-003).
  return [
    {
      kind: "sentence",
      parts: [WORKSPACE_EXPLANATION_SENTENCE],
    },
    {
      kind: "sentence",
      parts: [WORKSPACE_SCOPE_EXPLANATION_SENTENCE],
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
  const section: PresentationNode[] = [stateHeadline([
    "Project Bindings whose Profile this Workspace lacks:",
  ], "warning")];
  for (const missing of missingProfileBindings) {
    section.push(
      {
        kind: "sentence",
        parts: [
          `- `,
          pathPart(missing.project, "fleet"),
          `: Profile '${missing.profile}' does not exist in this Workspace.`,
        ],
      },
      {
        kind: "sentence",
        parts: [
          `  Next: create it with `,
          commandPart(COMMAND_NAME, [arg("new"), arg("profile"), arg(missing.profile)]),
          `, or install an available Profile with `,
          commandPart(COMMAND_NAME, [arg("install"), arg(missing.profile), arg(missing.project)]),
          `.`,
        ],
        category: "command",
      },
    );
  }
  nodes.push(part(...section));
}

/**
 * Single authority for whether a Workspace already has Profiles (US-002, spec #672 DEC-003, #676).
 * Routes setup receipt concept explanations and next step guidance.
 */
export function hasProfiles(input: { readonly profileCount: number }): boolean {
  return input.profileCount > 0;
}

/**
 * The one setup handoff footer (spec #640 US-002, DEC-005, spec #672 DEC-003, #676):
 * routes from the resulting content. Zero Profiles lead to guided Profile creation;
 * existing Profiles lead to bare install.
 */
function setupHandoffFooter(input: InitReceiptInput): PresentationNode[] {
  if (hasProfiles(input)) {
    return [footerNodes({
      next: { kind: "command", value: guidedInstallRouting() },
    })];
  }
  return [footerNodes({
    next: {
      kind: "actions",
      items: newProfileCreationCommands(),
    },
  })];
}

/** The receipt document for one `init` invocation (spec #672, #676). */
export function initReceiptDocument(input: InitReceiptInput): PresentationDocument {
  const workspace = pathPart(
    input.path,
    "fleet",
    displayPath(input.path, input.authoredPath, "fleet"),
  );
  if (input.outcome === "unchanged") {
    return neutralStatementDocument([
      `Workspace and ${localConfiguration} already initialized at `,
      workspace,
      "; unchanged.",
    ]);
  }
  const nodes: PresentationNode[] = [];
  // The verb is the folder fact (spec #672 US-003, screen 21): setup created
  // the named folder, or the folder already existed and this machine's
  // settings were written. Never the outcome's copy.
  const folderVerb = input.folderCreated ? "Created" : "Connected";
  const headline = input.outcome === "migrated"
    ? stateHeadline([
      `Migrated Local Configuration and ${folderVerb.toLowerCase()} your Workspace at `,
      workspace,
    ], "success")
    : stateHeadline([`${folderVerb} your Workspace at `, workspace], "success");
  nodes.push(part(headline));

  if (!hasProfiles(input)) {
    const skillsFolder = workspaceSubfolderDisplay(input.path, "skills", input.authoredPath);
    const contextFolder = workspaceSubfolderDisplay(input.path, "context", input.authoredPath);
    nodes.push(
      part({ kind: "prose", parts: [PROFILE_EXPLANATION_PARAGRAPH] }),
      part({ kind: "prose", parts: [skillExplanationParagraph(skillsFolder)] }),
      part({ kind: "prose", parts: [contextExplanationParagraph(contextFolder)] }),
    );
  }

  if (input.detectedHosts !== undefined) {
    const detectedHosts = input.detectedHosts;
    nodes.push(part({
      kind: "sentence",
      parts:
        detectedHosts.length > 0
          ? ["Agents found: ", identifierPart(detectedHosts.join(", "))]
          : ["Agents found: none"],
    }));
  }

  if (input.missingProfileBindings && input.missingProfileBindings.length > 0) {
    appendMissingProfileBindings(nodes, input.missingProfileBindings);
  }
  nodes.push(...setupHandoffFooter(input));
  return nodes;
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

/** The receipt document for one `install` invocation (US-001, US-005, US-006,
 * spec #677 screen 04): the installed selection and its verified outcome in
 * one action. The created receipt names the Profile in its headline, then the
 * full Project path (stable home-relative or absolute, DEC-006) and the
 * agents; a replaced receipt keeps the old → new deltas. No routine file
 * inventory. */
export function installReceiptDocument(
  input: InstallReceiptInput,
): PresentationDocument {
  const project = pathPart(input.canonicalProject, "fleet", input.project);
  const nodes: PresentationNode[] = [];
  if (input.outcome === "unchanged") {
    // One neutral statement (US-003, US-010): a clean no-op invents no next
    // action and omits the details hint.
    return neutralStatementDocument([
      "Installation unchanged for ",
      project,
      ".",
    ]);
  }
  const facts: PresentationNode[] = [stateHeadline(
    input.outcome === "replaced"
      ? ["Replaced installation for ", project]
      : ["Installed the ", identifierPart(input.profile), " Profile"],
    "success",
  )];
  if (input.outcome === "replaced") {
    const { profile: previousProfile, hosts: previousHosts } = input.previous;
    facts.push(
      {
        kind: "key-value",
        key: "  Profile",
        value: {
          kind: "identifier",
          value: previousProfile !== input.profile
            ? `${previousProfile} → ${input.profile}`
            : input.profile,
        },
        category: "path",
      },
      {
        kind: "key-value",
        key: "  Agents",
        value: {
          kind: "identifier",
          value: hostsEqual(previousHosts, input.hosts)
            ? input.hosts.join(", ")
            : `${previousHosts.join(", ")} → ${input.hosts.join(", ")}`,
        },
      },
    );
  } else {
    facts.push(
      {
        kind: "key-value",
        key: "  Project",
        value: {
          kind: "path",
          canonicalPath: input.canonicalProject,
          authoredPath: input.project,
          scope: "fleet",
          // The receipt names the full Project path (US-005, #647, spec #677
          // screen 04): the stable home-relative or absolute display is the
          // shown value, rendered whole — it wraps at path-segment boundaries
          // and is never middle-elided, exactly like the former "Installed
          // for <path>" headline. ADR-0042's shortest-alias rule governs
          // scanning views, not this single-Project action location.
          identity: stableProjectDisplay({
            canonicalProject: input.canonicalProject,
            project: input.project,
          }),
        },
        category: "path",
      },
      {
        kind: "key-value",
        key: "  Agents",
        value: { kind: "identifier", value: input.hosts.join(", ") },
      },
    );
  }
  nodes.push(part(...facts));
  // The install `Next:` action list is the one footer (US-010) and is
  // appended by the command after body guidance (loading checks and the
  // equivalent command), so no output prints two footers.
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
  const nodes: PresentationNode[] = [];
  nodes.push(part(
    stateHeadline([input.changed
      ? `Updated reusable Profile '${input.profile}'.`
      : `Reusable Profile '${input.profile}' already has exactly this membership.`], "success"),
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
  ));
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