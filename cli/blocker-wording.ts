import { COMMAND_NAME } from "../installer/version.js";
import { OPENCODE_UNCLAIMED_CONFIG_LOCATIONS } from "../adapters/opencode.js";

import {
  INSTALLATION_OWNERSHIP,
  INSTALLATION_STATE_UNREADABLE,
  normalizeBlocker,
  OCCUPIED_OUTPUT,
  OUTPUT_OWNERSHIP_CONFLICT,
  TEMPORARY_INSTALLATION_CONFLICT,
  TEMPORARY_INSTALLATION_REMOVAL,
  type BlockerKind,
  type OccupiedOutputFact,
  type OutputOccupation,
  type OwnershipBlockerAction,
  type OwnershipFailureFact,
  type ReconciliationBlocker,
  type StateReadFailureFact,
  type TemporaryRemovalFailureFact,
} from "../installer/blockers.js";
import { occupiedOutputBlocker } from "../installer/blockers.js";
import { compareCanonicalStrings } from "../schemas/canonical.js";
import {
  commandPart,
  flatInlineText,
  safeShellQuoted,
  shellSingleQuoted,
  type CommandArg,
  type CommandPart,
  type InlineContent,
} from "./inline-content.js";

/** One carried command argument. */
const arg = (value: string): CommandArg => ({ kind: "text", value });

/**
 * Presentation-owned blocker wording, keyed by typed {@link BlockerKind}.
 *
 * The Installer emits blockers as typed facts only; this module is the single
 * home of every problem, requirement, and remedy sentence (#440). Each sentence
 * is authored once, in plain newcomer language, as inline content whose
 * recovery commands are atomic {@link CommandPart} atoms derived from the
 * carried evidence. Two projections exist:
 *
 * - {@link blockerWording} — the plain-text projection. The machine JSON
 *   publishes these values unchanged (same shape, same verbatim contract).
 * - {@link humanBlockerWording} — the same authored parts as-is; the renderer
 *   keeps command atoms whole and copyable.
 *
 * There is no second human variant and no regex substitution for blocker
 * prose: the sentences are written in the default-view lexicon directly.
 */

export interface BlockerWording {
  readonly message: string;
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;
}

/** The authored inline content for one blocker: the single wording source. */
export interface BlockerWordingParts {
  readonly message: readonly InlineContent[];
  readonly problem: readonly InlineContent[];
  readonly remedy: readonly InlineContent[];
  readonly requirement: readonly InlineContent[];
}

export interface HumanBlockerWording {
  readonly message: readonly InlineContent[];
  readonly problem: readonly InlineContent[];
  readonly remedy: readonly InlineContent[];
  readonly requirement: readonly InlineContent[];
}

/** One scoped apkit command part with pre-rendered argument strings. */
function apkit(...args: readonly string[]): CommandPart {
  return commandPart(COMMAND_NAME, args.map(arg));
}

/**
 * One scoped non-apkit command part: flags stay bare, every path-like value is
 * POSIX-quoted, and any value that cannot be quoted safely fails closed to
 * `undefined` (#440).
 */
function externalCommand(
  program: string,
  flags: readonly string[],
  values: readonly string[],
): CommandPart | undefined {
  const quotedValues = values.map((value) => safeShellQuoted(value));
  if (quotedValues.some((value) => value === undefined)) return undefined;
  return commandPart(program, [
    ...flags.map(arg),
    ...quotedValues.map((value) => arg(value!)),
  ]);
}

/**
 * A single-quoted file-system path argument for an `apkit` command. POSIX
 * quoting preserves every byte — even control characters inside single quotes
 * survive copy-paste — so the command always carries the true evidence path;
 * the stricter refusal in {@link safeShellQuoted} is reserved for authoring
 * that reinterprets argument content, like Git pathspecs.
 */
function quoted(value: string): string {
  return shellSingleQuoted(value);
}

/** The project-relative path of one recorded output inside its Project. */
function projectPath(project: string, relative: string): string {
  return `${project}/${relative}`;
}

/** The user-owned Git untracking command for proven tracked paths (#440). */
function gitUntrackCommand(
  project: string,
  paths: readonly string[],
): CommandPart | undefined {
  const projectArg = safeShellQuoted(project);
  if (projectArg === undefined) return undefined;
  const ordered = [...paths].sort(compareCanonicalStrings);
  const pathArgs = ordered.map((path) => safeShellQuoted(path));
  if (pathArgs.length === 0 || pathArgs.some((path) => path === undefined)) {
    return undefined;
  }
  return commandPart("git", [
    arg("--literal-pathspecs"),
    arg("-C"),
    arg(projectArg),
    arg("rm"),
    arg("-r"),
    arg("--cached"),
    arg("--"),
    ...pathArgs.map((path) => arg(path!)),
  ]);
}

/** Git-tracked material is repository-owned; Agent Profile Kit never touches it. */
const GIT_OWNED_CLAUSE =
  "Agent Profile Kit will not delete or untrack repository-owned material";

/** List recorded paths the way the Git fact carries them (sorted, quoted). */
function pathList(paths: readonly string[]): string {
  return [...paths]
    .sort(compareCanonicalStrings)
    .map((path) => `'${path}'`)
    .join(", ");
}

/** The subject-verb agreement for a recorded-path list. */
function pathListVerb(paths: readonly string[]): string {
  return paths.length === 1 ? "is" : "are";
}

/** The carried fact sentence for one typed ownership-failure failure. */
function ownershipFailureSentence(failure: OwnershipFailureFact): string {
  switch (failure.case) {
    case "git-tracked-output":
      return `the generated file ${pathList(failure.outputs)} ` +
        `${pathListVerb(failure.outputs)} tracked by Git, and ${GIT_OWNED_CLAUSE}.`;
    case "no-ownership-continuity":
      return `the recorded generated file '${failure.output}' does not match the ` +
        "installation record and no other recorded file proves ownership.";
    case "type-mismatch":
      return `the recorded generated file '${failure.output}' is not a ${failure.expected}.`;
    case "unsafe-parent":
      return `the recorded generated file '${failure.output}' has a parent path ` +
        `'${failure.parent}' that is not a regular directory inside the Project.`;
    case "unreadable-output":
      return `the recorded generated file '${failure.output}' could not be read.`;
    case "unproven":
      return "ownership could not be proven from the installation record.";
    case "unsupported-entry":
      return `the recorded directory '${failure.output}' contains an unsupported ` +
        `file system entry at '${projectPath(failure.output, failure.member)}'.`;
  }
}

/** The carried fact sentence for one typed temporary-removal failure. */
function temporaryRemovalFailureSentence(failure: TemporaryRemovalFailureFact): string {
  switch (failure.case) {
    case "git-tracked-output":
      return `the temporary Profile's generated file ${pathList(failure.outputs)} ` +
        `${pathListVerb(failure.outputs)} tracked by Git, and ${GIT_OWNED_CLAUSE}.`;
    case "symlink-output":
      return `the recorded generated file '${failure.output}' is a symlink.`;
    case "unsafe-parent":
      return `the recorded generated file '${failure.output}' has a parent path ` +
        `'${failure.parent}' that is not a regular directory inside the Project.`;
  }
}

function blockerDetail(blocker: ReconciliationBlocker): string {
  if (blocker.detail === undefined) {
    throw new TypeError(`Blocker kind ${blocker.kind} requires a detail fact`);
  }
  return blocker.detail;
}

function blockerOwnershipFailure(
  blocker: ReconciliationBlocker & { readonly kind: typeof INSTALLATION_OWNERSHIP },
): OwnershipFailureFact {
  if (blocker.failure === undefined) {
    throw new TypeError(`Blocker kind ${blocker.kind} requires a failure fact`);
  }
  return blocker.failure;
}

function blockerRemovalFailure(
  blocker: ReconciliationBlocker & { readonly kind: typeof TEMPORARY_INSTALLATION_REMOVAL },
): TemporaryRemovalFailureFact {
  if (blocker.failure === undefined) {
    throw new TypeError(`Blocker kind ${blocker.kind} requires a failure fact`);
  }
  return blocker.failure;
}

function blockerOccupied(blocker: ReconciliationBlocker): OccupiedOutputFact {
  if (blocker.occupied === undefined) {
    throw new TypeError(`Blocker kind ${blocker.kind} requires an occupied fact`);
  }
  return blocker.occupied;
}

function blockerAction(blocker: ReconciliationBlocker): OwnershipBlockerAction {
  if (blocker.action !== "remove" && blocker.action !== "verify") {
    throw new TypeError(`Blocker kind ${blocker.kind} requires an ownership action`);
  }
  return blocker.action;
}

function blockerRemovalIdentity(blocker: ReconciliationBlocker): string {
  const identity = blocker.affectedItems.find((item) => item.kind === "installation-id")?.value;
  if (identity === undefined) {
    throw new TypeError(`Blocker kind ${blocker.kind} requires an installation identity`);
  }
  return identity;
}

/** The English indefinite article for one occupation noun. */
function article(noun: string): string {
  return /^[aeiou]/.test(noun) ? "an" : "a";
}

/** The plain noun for one typed occupation fact. */
function occupationNoun(occupation: OutputOccupation): string {
  switch (occupation) {
    case "file":
      return "file";
    case "directory":
      return "directory";
    case "symlink":
      return "symlink";
    case "other":
      return "file system entry of an unknown kind";
  }
}

function occupiedOutputProblem(blocker: ReconciliationBlocker): string {
  if (blocker.kind !== OCCUPIED_OUTPUT) {
    throw new TypeError("occupiedOutputProblem requires an occupied-output blocker");
  }
  const path = blocker.affectedItems.find((item) => item.kind === "path")?.value ?? "";
  const occupied = blockerOccupied(blocker);
  switch (occupied.case) {
    case "occupied-parent":
      return `${path} cannot be used because its parent path is already occupied by ` +
        `${article(occupationNoun(occupied.occupation))} ${occupationNoun(occupied.occupation)}.`;
    case "occupied-destination":
      return `${path} is already occupied by ${article(occupationNoun(occupied.occupation))} ` +
        `${occupationNoun(occupied.occupation)}.`;
    case "drifted-output":
      return `${path} already contains a file Agent Profile Kit did not install.`;
    case "unowned-artifact-directory":
      return `${path} is an occupied directory Agent Profile Kit did not install.`;
  }
}

/** The remedial choice between Agent Profile Kit management and Git ownership. */
function untrackChoiceRemedy(
  project: string,
  paths: readonly string[],
  applyArgs: readonly string[],
): readonly InlineContent[] {
  const untrack = gitUntrackCommand(project, paths);
  if (untrack === undefined) {
    return [
      "Manual recovery is required: Agent Profile Kit could not derive a safe " +
        `untracking command from the recorded paths (${pathList(paths)}). Untrack them ` +
        "in Git yourself without reinterpreting special characters, then run ",
      apkit(...applyArgs),
      "; or leave the files in place to keep Git ownership.",
    ];
  }
  return [
    "Choose one. To let Agent Profile Kit manage these files, run ",
    untrack,
    " — it stages their removal from the Git index while the files stay on " +
      "disk; commit afterwards to keep the change — then run ",
    apkit(...applyArgs),
    ". To keep Git ownership instead, leave the files in place.",
  ];
}

/** The scoped uninstall alternative with its honest consequence: removal plus
 * forgetting, so a later update does not reinstall (DEC-001). */
function uninstallAlternative(project: string): readonly InlineContent[] {
  return [
    "; or run ",
    apkit("uninstall", "--project", quoted(project)),
    " to remove its generated files and stop managing this Project.",
  ];
}

/** A non-following inspection command for one recorded path, when derivable. */
function inspectCommand(path: string): CommandPart | undefined {
  return externalCommand("ls", ["-ld"], [path]);
}

/** A non-recursive listing command for one occupied path, when derivable. */
function listCommand(path: string): CommandPart | undefined {
  return externalCommand("ls", ["-la"], [path]);
}

/** A size listing command for one machine-internal record, when derivable. */
function sizeCommand(path: string): CommandPart | undefined {
  return externalCommand("ls", ["-lh"], [path]);
}

/** An editor command for one machine-internal record, when derivable. */
function editorCommand(path: string): CommandPart | undefined {
  return externalCommand("vi", [], [path]);
}

/** The plain-text projection of inline content. */
function flat(parts: readonly InlineContent[]): string {
  return flatInlineText(parts);
}

/** Drop the `undefined` entries a fail-closed command authoring produced. */
function compact(parts: readonly (InlineContent | undefined)[]): readonly InlineContent[] {
  return parts.filter((part): part is InlineContent => part !== undefined);
}

/**
 * Manual recovery for one machine-internal record: the rich phrasing carries
 * the inspect and editor commands; when the recorded path cannot be quoted
 * safely, the remedy degrades to honest prose naming the raw path — it never
 * emits an unusable command and never hides the manual requirement (#440).
 */
function recordRecovery(
  path: string,
  rich: readonly (InlineContent | undefined)[],
  fallbackLead: string,
  fallbackBody = "Inspect and repair",
): readonly InlineContent[] {
  const hasCommands = rich.some((part) => typeof part !== "string" && part !== undefined);
  if (hasCommands) return compact(rich);
  return [
    `${fallbackLead} ${fallbackBody} '${path}' yourself, then run `,
    apkit("status"),
    " to verify.",
  ];
}

/**
 * The single authored wording source for one blocker (#440): plain newcomer
 * sentences whose recovery commands are derived from the carried evidence.
 * Scope identity is never duplicated in the sentences — presentation owns the
 * Project identity line; commands carry the explicit project argument.
 */
function wordingParts(blocker: ReconciliationBlocker): BlockerWordingParts {
  switch (blocker.kind) {
    case INSTALLATION_STATE_UNREADABLE: {
      const statePath = blocker.affectedItems.find((item) => item.kind === "path")?.value ?? "";
      const requirement: readonly InlineContent[] = [
        "Agent Profile Kit lifecycle commands require a readable installation record.",
      ];
      if (blocker.stateFailure?.case === "legacy-yaml-state-expired") {
        const retiredPath = blocker.stateFailure.retiredPath;
        const problem: readonly InlineContent[] = [
          `The retired legacy record at ${blocker.stateFailure.retiredPath} is unsupported ` +
            "because the migration window is closed.",
        ];
        return {
          message: problem,
          problem,
          remedy: recordRecovery(retiredPath, [
            "Manual recovery is required: Agent Profile Kit cannot read this record " +
              "and will not rename, delete, or migrate it itself. Inspect ",
            inspectCommand(retiredPath),
            " and ",
            editorCommand(retiredPath),
            `, migrate it to ${statePath} with Agent Profile Kit 0.95.0 as documented, ` +
              "then run ",
            apkit("status"),
            " to verify.",
          ],
            "Manual recovery is required: Agent Profile Kit cannot read this record " +
              "and will not rename, delete, or migrate it itself; migrate it with " +
              "Agent Profile Kit 0.95.0 as documented",
            "Inspect and migrate",
          ),
          requirement,
        };
      }
      if (blocker.stateFailure?.case === "oversize-state") {
        const problem: readonly InlineContent[] = [
          `The installation record at ${statePath} exceeds the ` +
            `${blocker.stateFailure.limitBytes} byte limit.`,
        ];
        return {
          message: problem,
          problem,
          remedy: recordRecovery(statePath, [
            "Manual recovery is required: Agent Profile Kit cannot read or repair its " +
              "own record. Inspect ",
            sizeCommand(statePath),
            ", edit it with ",
            editorCommand(statePath),
            ` to bring it under ${blocker.stateFailure.limitBytes} bytes, then run `,
            apkit("status"),
            " to verify.",
          ], "Manual recovery is required: Agent Profile Kit cannot read or repair its own record."),
          requirement,
        };
      }
      if (blocker.stateFailure?.case === "receipt-records-no-outputs") {
        const problem: readonly InlineContent[] = [
          `The installation record at ${statePath} records no generated files for the ` +
            `installation at ${blocker.stateFailure.project}.`,
        ];
        return {
          message: problem,
          problem,
          remedy: recordRecovery(statePath, [
            "Manual recovery is required: Agent Profile Kit cannot repair its own " +
              "record. Inspect ",
            sizeCommand(statePath),
            ", edit it with ",
            editorCommand(statePath),
            ` to restore the recorded generated files for ` +
              `${blocker.stateFailure.project}, then run `,
            apkit("status"),
            " to verify.",
          ], "Manual recovery is required: Agent Profile Kit cannot repair its own record."),
          requirement,
        };
      }
      const detail = blockerDetail(blocker);
      const problem: readonly InlineContent[] = [
        `Cannot read the installation record at ${statePath}: ${detail}`,
      ];
      return {
        message: problem,
        problem,
        remedy: recordRecovery(statePath, [
          "Manual recovery is required: Agent Profile Kit cannot read this record. " +
            "Inspect ",
          inspectCommand(statePath),
          ", restore access or repair the file with ",
          editorCommand(statePath),
          ", then run ",
          apkit("status"),
          " to verify.",
        ], "Manual recovery is required: Agent Profile Kit cannot read this record."),
        requirement,
      };
    }
    case OCCUPIED_OUTPUT: {
      const path = blocker.affectedItems.find((item) => item.kind === "path")?.value ?? "";
      const problem: readonly InlineContent[] = [occupiedOutputProblem(blocker)];
      const requirement: readonly InlineContent[] = [
        "Agent Profile Kit installs generated files only at new or managed " +
          "destinations; it never overwrites files it did not install.",
      ];
      if (blocker.remedyKey === "opencode-config-occupied") {
        const remedy = compact([
          `Move your OpenCode configuration to ${OPENCODE_UNCLAIMED_CONFIG_LOCATIONS.join(" or ")} ` +
            "yourself, then run ",
          apkit("update", quoted(blocker.project!)),
          ...uninstallAlternative(blocker.project!),
        ]);
        return { message: problem, problem, remedy, requirement };
      }
      const inspectParent = blocker.occupied?.case === "occupied-parent";
      const inspected = inspectParent ? path.replace(/\/?[^/]+$/, "") : path;
      const remedy = compact([
        "Manual recovery is required: Agent Profile Kit will not remove or overwrite " +
          "these files. Inspect ",
        inspectParent
          ? inspectCommand(projectPath(blocker.project!, inspected))
          : listCommand(projectPath(blocker.project!, inspected)),
        ", move or remove it yourself only if you do not need it, then run ",
        apkit("update", quoted(blocker.project!)),
        ...uninstallAlternative(blocker.project!),
      ]);
      return { message: problem, problem, remedy, requirement };
    }
    case INSTALLATION_OWNERSHIP: {
      const failure = blockerOwnershipFailure(blocker);
      const verify = blockerAction(blocker) === "verify";
      const problem: readonly InlineContent[] = [
        verify
          ? "Cannot verify ownership of generated files: "
          : "Cannot remove stale generated files: ",
        ownershipFailureSentence(failure),
      ];
      const requirement: readonly InlineContent[] = [
        "Agent Profile Kit changes or removes generated files only when ownership " +
          "is proven by the installation record at safe paths.",
      ];
      if (failure.case === "git-tracked-output") {
        if (verify) {
          const remedy = untrackChoiceRemedy(
            blocker.project!,
            failure.outputs,
            ["update", quoted(blocker.project!)],
          );
          return { message: problem, problem, remedy, requirement };
        }
        const untrack = gitUntrackCommand(blocker.project!, failure.outputs);
        const remedy = compact(untrack === undefined
          ? [
              "Manual recovery is required: Agent Profile Kit could not derive a safe " +
                `untracking command from the recorded paths (${pathList(failure.outputs)}). ` +
                "Untrack them in Git yourself without reinterpreting special characters, " +
                "then run ",
              apkit("update", "--all"),
              " — it updates every pending Project, not only this one.",
            ]
          : [
              "These stale generated files are tracked by Git; " + GIT_OWNED_CLAUSE +
                ". Run ",
              untrack,
              " to stage their removal from the Git index while the files stay on " +
                "disk (commit afterwards to keep the change), then run ",
              apkit("update", "--all"),
              " — it updates every pending Project, not only this one.",
            ]);
        return { message: problem, problem, remedy, requirement };
      }
      if (failure.case === "unproven") {
        if (verify) {
          const remedy = compact([
            "No specific file is recorded, so manual inspection of the Project is " +
              "required. Run ",
            apkit("uninstall", "--project", quoted(blocker.project!)),
            " to remove its generated files and stop managing this Project — or inspect " +
              "the Project's generated files yourself, restore what matches the " +
              "installation record, then run ",
            apkit("update", quoted(blocker.project!)),
            ".",
          ]);
          return { message: problem, problem, remedy, requirement };
        }
        const remedy = compact([
          "Manual recovery is required: no specific file is recorded. Remove or " +
            "restore the stale generated files yourself, then run ",
          apkit("update", "--all"),
          " — it updates every pending Project, not only this one.",
        ]);
        return { message: problem, problem, remedy, requirement };
      }
      const inspected = failure.case === "unsupported-entry"
        ? projectPath(failure.output, failure.member)
        : failure.output;
      const inspectTarget = failure.case === "unsafe-parent"
        ? failure.parent
        : projectPath(blocker.project!, inspected);
      const restoreClause = failure.case === "unsafe-parent"
        ? ", restore it to a regular directory inside the Project yourself, then run "
        : ", remove or restore it yourself, then run ";
      const remedy = compact(verify
        ? [
            "Manual recovery is required: Agent Profile Kit will not adopt or delete " +
              "files it cannot prove. Inspect ",
            inspectCommand(inspectTarget),
            restoreClause,
            apkit("update", quoted(blocker.project!)),
            ...uninstallAlternative(blocker.project!),
          ]
        : [
            "Manual recovery is required: Agent Profile Kit will not delete files it " +
              "cannot prove. Inspect ",
            inspectCommand(inspectTarget),
            restoreClause,
            apkit("update", "--all"),
            " — it updates every pending Project, not only this one.",
          ]);
      return { message: problem, problem, remedy, requirement };
    }
    case OUTPUT_OWNERSHIP_CONFLICT: {
      const paths = blocker.affectedItems
        .filter((item) => item.kind === "path")
        .map((item) => item.value)
        .sort(compareCanonicalStrings);
      const problem: readonly InlineContent[] = paths.length === 1
        ? [`${paths[0]} is tracked by Git, so Agent Profile Kit cannot write to it.`]
        : [
            `${paths[0]} and ${paths.length - 1} more files are tracked by Git, so ` +
              "Agent Profile Kit cannot write to them.",
          ];
      const requirement: readonly InlineContent[] = [
        "Agent Profile Kit must exclusively manage its generated files; Git-tracked " +
          "paths cannot be replaced.",
      ];
      const remedy = untrackChoiceRemedy(blocker.project!, paths, [
        "update",
        quoted(blocker.project!),
      ]);
      return { message: problem, problem, remedy, requirement };
    }
    case TEMPORARY_INSTALLATION_CONFLICT: {
      const identity = blocker.affectedItems.find((item) => item.kind === "installation-id")?.value;
      const requirement: readonly InlineContent[] = [
        "A Project hosts at most one managed installation at a time.",
      ];
      if (identity !== undefined) {
        const problem: readonly InlineContent[] = [
          `A temporary Profile already owns generated files in this Project ` +
            `(installation identity ${identity}).`,
        ];
        return {
          message: problem,
          problem,
          remedy: compact([
            "Run ",
            apkit("machine", "remove-temp", quoted(identity)),
            " to remove the temporary Profile, then retry your original command.",
          ]),
          requirement,
        };
      }
      const problem: readonly InlineContent[] = [
        "Generated files in this Project are already managed through a configured " +
          "Project installation.",
      ];
      return {
        message: problem,
        problem,
        remedy: compact([
          "Run ",
          apkit("uninstall", "--project", quoted(blocker.project!)),
          " to remove its generated files and stop managing this Project, " +
            "then retry your original command.",
        ]),
        requirement,
      };
    }
    case TEMPORARY_INSTALLATION_REMOVAL: {
      const identity = blockerRemovalIdentity(blocker);
      const failure = blockerRemovalFailure(blocker);
      const problem: readonly InlineContent[] = [
        `Cannot remove the temporary Profile (installation identity ${identity}): `,
        temporaryRemovalFailureSentence(failure),
      ];
      const requirement: readonly InlineContent[] = [
        "Agent Profile Kit removes temporary Profiles only from recorded paths that " +
          "are proven safe.",
      ];
      const removeTemp = apkit("machine", "remove-temp", quoted(identity));
      if (failure.case === "git-tracked-output") {
        const untrack = gitUntrackCommand(blocker.project!, failure.outputs);
        const remedy = compact(untrack === undefined
          ? [
              "Manual recovery is required: Agent Profile Kit could not derive a safe " +
                `untracking command from the recorded paths (${pathList(failure.outputs)}). ` +
                "Untrack them in Git yourself without reinterpreting special characters, " +
                "then run ",
              removeTemp,
              ".",
            ]
          : [
              "Run ",
              untrack,
              " to stage their removal from the Git index while the files stay on " +
                "disk (commit afterwards to keep the change), then run ",
              removeTemp,
              " — it deletes the generated files from disk.",
            ]);
        return { message: problem, problem, remedy, requirement };
      }
      if (failure.case === "symlink-output") {
        return {
          message: problem,
          problem,
          remedy: compact([
            "Manual recovery is required: Agent Profile Kit will not follow or remove " +
              "the symlink. Inspect ",
            inspectCommand(projectPath(blocker.project!, failure.output)),
            ", preserve or remove the symlink yourself, then run ",
            removeTemp,
            ".",
          ]),
          requirement,
        };
      }
      return {
        message: problem,
        problem,
        remedy: compact([
          "Manual recovery is required: Agent Profile Kit will not traverse outside " +
            "the Project. Inspect ",
          inspectCommand(failure.parent),
          ", restore it to a regular directory inside the Project yourself, then run ",
          removeTemp,
          ".",
        ]),
        requirement,
      };
    }
  }
}

/** The verbatim stored wording for one blocker; machine JSON publishes these values. */
export function blockerWording(blocker: ReconciliationBlocker): BlockerWording {
  const parts = wordingParts(blocker);
  return {
    message: flat(parts.message),
    problem: flat(parts.problem),
    remedy: flat(parts.remedy),
    requirement: flat(parts.requirement),
  };
}

/** The human parts rendering of one blocker: the same authored plain sentences. */
export function humanBlockerWording(blocker: ReconciliationBlocker): HumanBlockerWording {
  const parts = wordingParts(blocker);
  return {
    message: parts.message,
    problem: parts.problem,
    remedy: parts.remedy,
    requirement: parts.requirement,
  };
}

/**
 * The remedy wording for an occupied OpenCode configuration destination, as a
 * plain-text projection of the authored remedy for the named Project.
 */
export function opencodeConfigOccupiedRemedy(project: string): string {
  const occupied = normalizeBlocker(occupiedOutputBlocker({
    occupied: { case: "occupied-destination", occupation: "file" },
    path: ".opencode/opencode.json",
    project,
    remedyKey: "opencode-config-occupied",
  }));
  return blockerWording(occupied).remedy;
}

/**
 * Newcomer substitutions applied when rendering Installer-error wording for
 * humans outside the blocker lexicon; keeps every human error surface inside
 * the vocabulary guard. Blocker wording is authored plain at the source and
 * does not pass through substitutions.
 */
export const DEFAULT_BLOCKER_SUBSTITUTIONS: readonly {
  readonly replacement: string | CommandPart;
  readonly term: RegExp;
}[] = [
  { replacement: "configured Projects", term: /Project Bindings/g },
  { replacement: "configured Project", term: /Project Binding/g },
  { replacement: "temporary Profiles", term: /Temporary Profile Installations/g },
  { replacement: "temporary Profile", term: /Temporary Profile Installation/g },
  { replacement: "installation record", term: /Installation State/g },
  { replacement: "generated files", term: /\bgenerated outputs\b/gi },
  { replacement: "generated file", term: /\bgenerated output\b/gi },
  {
    replacement: commandPart("apkit", [arg("machine"), arg("install-temp")]),
    term: /\binstall-temp\b/g,
  },
  {
    replacement: commandPart("apkit", [arg("machine"), arg("remove-temp")]),
    term: /\bremove-temp\b/g,
  },
];

/**
 * Apply the newcomer substitutions to inline content: string spans split at
 * term matches and the replacement is authored in place — a command
 * replacement becomes an atomic command part (DEC-009). Atomic parts pass
 * through untouched: a carried value is never rewritten.
 */
export function substituteInline(
  content: readonly InlineContent[],
): readonly InlineContent[] {
  return content.flatMap((part) => {
    if (typeof part !== "string") return [part];
    let spans: readonly InlineContent[] = [part];
    for (const substitution of DEFAULT_BLOCKER_SUBSTITUTIONS) {
      spans = spans.flatMap((span) => {
        if (typeof span !== "string") return [span];
        const pieces: InlineContent[] = [];
        let cursor = 0;
        for (const match of span.matchAll(substitution.term)) {
          const start = match.index;
          if (start === undefined || match[0].length === 0) continue;
          if (start > cursor) pieces.push(span.slice(cursor, start));
          pieces.push(substitution.replacement);
          cursor = start + match[0].length;
        }
        if (pieces.length === 0) return [span];
        if (cursor < span.length) pieces.push(span.slice(cursor));
        return pieces;
      });
    }
    return spans;
  });
}

/**
 * Newcomer substitution for presentation-owned error text rendered outside the
 * blocker lexicon; keeps every human error surface inside the vocabulary guard.
 */
export function applyNewcomerSubstitutions(text: string): string {
  return substitute(text);
}

function substitute(text: string): string {
  return DEFAULT_BLOCKER_SUBSTITUTIONS.reduce(
    (rendered, substitution) => {
      const replacement = typeof substitution.replacement === "string"
        ? substitution.replacement
        : flatInlineText([substitution.replacement]);
      return rendered.replaceAll(substitution.term, replacement);
    },
    text,
  );
}

/** The carried sentence for one typed Installation State read-failure fact. */
export function describeStateReadFailure(failure: StateReadFailureFact): string {
  switch (failure.case) {
    case "legacy-yaml-state-expired":
      return `Legacy YAML Installation State at ${failure.retiredPath} is unsupported because ` +
        "the migration window is closed. Use Agent Profile Kit 0.95.0 to migrate it to " +
        "manifest.json, then retry this command. Agent Profile Kit never reconstructs " +
        "ownership from generated output.";
    case "oversize-state":
      return `Installation State exceeds the ${failure.limitBytes} byte limit`;
    case "receipt-records-no-outputs":
      return `Installation State receipts record no generated outputs for the installation ` +
        `at ${failure.project}`;
  }
}

/** The carried sentence for one typed ownership-failure fact. */
export function describeOwnershipFailure(failure: OwnershipFailureFact): string {
  switch (failure.case) {
    case "git-tracked-output":
      return `owned output ${failure.outputs.join(", ")} is tracked by Git; ` +
        "Agent Profile Kit will not delete or untrack repository-owned material";
    case "no-ownership-continuity":
      return `recorded output ${failure.output} does not match the recorded installation and ` +
        "no other recorded root proves ownership continuity; restore the recorded " +
        "output or remove the generated files, then retry";
    case "type-mismatch":
      return `owned output ${failure.output} is not a ${failure.expected}`;
    case "unsafe-parent":
      return `owned output ${failure.output} has unsafe parent: ${failure.parent}`;
    case "unreadable-output":
      return `owned output ${failure.output} could not be inspected`;
    case "unproven":
      return "ownership could not be proven";
    case "unsupported-entry":
      return `owned output ${failure.output} contains an unsupported entry at ${failure.member}`;
  }
}

/** The carried sentence for one typed temporary-removal failure fact. */
export function describeTemporaryRemovalFailure(failure: TemporaryRemovalFailureFact): string {
  switch (failure.case) {
    case "git-tracked-output":
      return describeOwnershipFailure(failure);
    case "symlink-output":
      return `owned output ${failure.output} is a symlink`;
    case "unsafe-parent":
      return describeOwnershipFailure(failure);
  }
}
