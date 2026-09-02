import { join } from "node:path";

import {
  INSTALLATION_OWNERSHIP,
  INSTALLATION_STATE_UNREADABLE,
  OCCUPIED_OUTPUT,
  OUTPUT_OWNERSHIP_CONFLICT,
  TEMPORARY_INSTALLATION_CONFLICT,
  TEMPORARY_INSTALLATION_REMOVAL,
  type BlockerKind,
  type OccupiedOutputFact,
  type OwnershipBlockerAction,
  type ReconciliationBlocker,
} from "../installer/blockers.js";
import { compareCanonicalStrings } from "../schemas/installation-manifest.js";

/**
 * Presentation-owned blocker wording, keyed by typed {@link BlockerKind}.
 *
 * The Installer emits blockers as typed facts only; this module is the single
 * home of every problem, requirement, and remedy sentence. Wording is carried
 * over verbatim from the pre-relocation Installer strings. Two projections
 * exist:
 *
 * - {@link blockerWording} — the verbatim stored sentences. The machine JSON
 *   publishes these values unchanged.
 * - {@link humanBlockerWording} — the human rendering: internal terms become
 *   newcomer terms via {@link DEFAULT_BLOCKER_SUBSTITUTIONS}, machine-namespace
 *   command references reflect the published command surface, and a runnable
 *   command is appended where the carried remedy names none.
 */

export interface BlockerWording {
  readonly message: string;
  readonly problem: string;
  readonly remedy: string;
  readonly requirement: string;
}

export const OPENCODE_CONFIG_OCCUPIED_REMEDY =
  "move authored OpenCode configuration to opencode.json or .opencode/opencode.json, " +
  "or change the Project Binding or Host selection so Agent Profile Kit does not plan output at that path, then retry";

function blockerDetail(blocker: ReconciliationBlocker): string {
  if (blocker.detail === undefined) {
    throw new TypeError(`Blocker kind ${blocker.kind} requires a detail fact`);
  }
  return blocker.detail;
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

function occupiedOutputProblem(blocker: ReconciliationBlocker): string {
  if (blocker.kind !== OCCUPIED_OUTPUT) {
    throw new TypeError("occupiedOutputProblem requires an occupied-output blocker");
  }
  const path = blocker.affectedItems.find((item) => item.kind === "path")?.value ?? "";
  const occupied = blockerOccupied(blocker);
  switch (occupied.case) {
    case "occupied-parent":
      return `${path} is an occupied ${occupied.occupation} parent path`;
    case "occupied-destination":
      return `${path} is an occupied ${occupied.occupation} path`;
    case "drifted-output":
      return `${path} is occupied by unowned or drifted output`;
    case "unowned-artifact-directory":
      return `${path} is an occupied unowned artifact directory`;
  }
}

/** The verbatim stored wording for one blocker; machine JSON publishes these values. */
export function blockerWording(blocker: ReconciliationBlocker): BlockerWording {
  switch (blocker.kind) {
    case INSTALLATION_STATE_UNREADABLE:
      return {
        message: blockerDetail(blocker),
        problem: blockerDetail(blocker),
        remedy: "Restore or repair the Installation State file, then retry",
        requirement: "Lifecycle commands require readable Installation State",
      };
    case OCCUPIED_OUTPUT: {
      const problem = occupiedOutputProblem(blocker);
      return {
        message: problem,
        problem,
        remedy: blocker.remedyKey === "opencode-config-occupied"
          ? OPENCODE_CONFIG_OCCUPIED_REMEDY
          : "Remove, move, or adopt the occupying material yourself, or change the Project " +
            "Binding or Host selection so Agent Profile Kit does not plan output at that path, " +
            "then retry",
        requirement:
          "Generated files are installed only at new or Agent Profile Kit-managed destinations; " +
          "occupied unowned material is never overwritten or adopted",
      };
    }
    case INSTALLATION_OWNERSHIP: {
      const problem = blockerAction(blocker) === "verify"
        ? `Cannot verify generated-file ownership: ${blockerDetail(blocker)}`
        : `Cannot remove stale generated files: ${blockerDetail(blocker)}`;
      return {
        message: problem,
        problem,
        remedy:
          "Remove the conflicting generated files yourself after verifying the paths, then retry",
        requirement:
          "Agent Profile Kit syncs or removes only files whose ownership is proven by the " +
          "active installation record at safe paths",
      };
    }
    case OUTPUT_OWNERSHIP_CONFLICT: {
      const paths = blocker.affectedItems
        .filter((item) => item.kind === "path")
        .map((item) => item.value)
        .sort(compareCanonicalStrings);
      const message = paths.length > 0
        ? (() => {
          const first = join(blocker.project!, paths[0]!);
          return paths.length === 1
            ? `${first} is a tracked project path`
            : `${first} and ${paths.length - 1} more tracked project ` +
              `${paths.length === 2 ? "path" : "paths"}`;
        })()
        : "These generated paths are tracked by Git";
      return {
        message,
        problem:
          "These generated paths are tracked by Git, so Agent Profile Kit cannot write to them " +
          "without conflicting with repository ownership.",
        remedy:
          "Choose one: keep repository ownership and change the Project Binding or its Host " +
          "selection so Agent Profile Kit does not plan output at these paths, or intentionally " +
          "remove the conflicting paths from repository ownership yourself before retrying. " +
          "Agent Profile Kit will not delete, untrack, adopt, or overwrite repository-owned material.",
        requirement:
          "Generated files must be exclusively managed by Agent Profile Kit; repository-owned " +
          "paths cannot be replaced.",
      };
    }
    case TEMPORARY_INSTALLATION_CONFLICT: {
      const installationId = blocker.affectedItems.find(
        (item) => item.kind === "installation-id",
      )?.value;
      const problem = installationId === undefined
        ? "Generated files are already managed through a Project Binding; remove them " +
          "before installing a temporary Profile"
        : `An active Temporary Profile Installation already owns generated files ` +
          `(${installationId})`;
      return {
        message: problem,
        problem,
        remedy:
          "Remove the existing Project Binding-managed files or the active Temporary Profile " +
          "Installation, then retry install-temp",
        requirement:
          "A Project hosts at most one managed installation at a time; temporary lifetime is " +
          "receipt-owned under ADR-0015",
      };
    }
    case TEMPORARY_INSTALLATION_REMOVAL: {
      const problem = `Cannot remove Temporary Profile Installation: ${blockerDetail(blocker)}`;
      return {
        message: problem,
        problem,
        remedy:
          "Remove the owned output yourself after verifying the paths, then retry remove-temp",
        requirement:
          "remove-temp removes only ownership-proven temporary-owned roots and never " +
          "traverses outside recorded project-relative roots",
      };
    }
  }
}

/**
 * Newcomer substitutions applied when rendering blocker wording for humans.
 * Internal domain terms become their default-view lexicon equivalents, and
 * machine-namespace command references reflect the published command surface.
 * Ordered: plural forms before singular, longest first.
 */
export const DEFAULT_BLOCKER_SUBSTITUTIONS: readonly {
  readonly replacement: string;
  readonly term: RegExp;
}[] = [
  { replacement: "configured Projects", term: /Project Bindings/g },
  { replacement: "configured Project", term: /Project Binding/g },
  { replacement: "temporary Profiles", term: /Temporary Profile Installations/g },
  { replacement: "temporary Profile", term: /Temporary Profile Installation/g },
  { replacement: "installation record", term: /Installation State/g },
  { replacement: "apkit machine install-temp", term: /\binstall-temp\b/g },
  { replacement: "apkit machine remove-temp", term: /\bremove-temp\b/g },
];

function substitute(text: string): string {
  return DEFAULT_BLOCKER_SUBSTITUTIONS.reduce(
    (rendered, substitution) => rendered.replaceAll(substitution.term, substitution.replacement),
    text,
  );
}

/**
 * The runnable command appended to a rendered remedy where the carried remedy
 * names none. Kinds whose carried remedy already names a command after
 * substitution (temporary installation) or whose rendering includes dedicated
 * recovery command lines (tracked-output conflicts) need no addition.
 */
function remedyCommand(blocker: ReconciliationBlocker): string | undefined {
  switch (blocker.kind) {
    case INSTALLATION_STATE_UNREADABLE:
      return "Run apkit status to retry.";
    case OCCUPIED_OUTPUT:
      return "Run apkit bind <profile> --host <host> to change the configured Project, " +
        "or apkit apply to retry.";
    case INSTALLATION_OWNERSHIP:
      return blockerAction(blocker) === "verify"
        ? "Run apkit apply to retry."
        : "Run apkit uninstall to retry.";
    case OUTPUT_OWNERSHIP_CONFLICT:
    case TEMPORARY_INSTALLATION_CONFLICT:
    case TEMPORARY_INSTALLATION_REMOVAL:
      return undefined;
  }
}

/** The human rendering of one blocker: newcomer terms plus a runnable command where needed. */
export function humanBlockerWording(blocker: ReconciliationBlocker): BlockerWording {
  const wording = blockerWording(blocker);
  const command = remedyCommand(blocker);
  return {
    message: substitute(wording.message),
    problem: substitute(wording.problem),
    remedy: command === undefined
      ? substitute(wording.remedy)
      : `${substitute(wording.remedy)}. ${command}`,
    requirement: substitute(wording.requirement),
  };
}
