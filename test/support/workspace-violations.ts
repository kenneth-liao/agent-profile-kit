import { collectWorkspaceViolations } from "../../installer/ingest-workspace.js";
import {
  InstallerToolError,
  workspaceViolationToken,
  type InstallerAuthoredError,
  type WorkspaceIngestionErrorFact,
  type WorkspaceViolation,
} from "../../installer/tool-errors.js";
import { SchemaRejectionError } from "../../schemas/schema-rejections.js";

/**
 * Shared helpers for tests exercising Workspace violation collection
 * (spec #593 DEC-009, #604): the collecting parser is the one ingestion
 * behavior, so tests inspect the collected list instead of catching the
 * first thrown error.
 */

/** The violation tokens of one collected run, sorted. */
export function violationTokens(violations: readonly WorkspaceViolation[]): readonly string[] {
  return violations.map(workspaceViolationToken).sort();
}

/** Collect every violation of one Workspace in one run. */
export async function collectViolations(workspace: string): Promise<readonly WorkspaceViolation[]> {
  return (await collectWorkspaceViolations(workspace)).violations;
}

/**
 * The one violation of a Workspace seeded with exactly one: fails with the
 * collected token list when the tree carries more (or fewer).
 */
export async function singleViolation(workspace: string): Promise<WorkspaceViolation> {
  const violations = await collectViolations(workspace);
  if (violations.length !== 1) {
    throw new Error(
      `expected exactly one violation, collected ${violations.length}: ${violationTokens(violations).join(", ")}`,
    );
  }
  return violations[0]!;
}

/** The typed ingestion fact behind one collected violation. */
export function ingestionFactOf(violation: WorkspaceViolation): WorkspaceIngestionErrorFact {
  if (violation.via !== "ingestion") {
    throw new Error(`expected an ingestion fact, collected ${workspaceViolationToken(violation)}`);
  }
  return violation.fact;
}

/** The portable-schema rejection detail behind one collected violation. */
export function rejectionDetailOf(
  violation: WorkspaceViolation,
): WorkspaceViolation extends never ? never : Exclude<WorkspaceViolation, { via: "ingestion" }>["detail"] {
  if (violation.via === "ingestion") {
    throw new Error(`expected a schema rejection, collected ${workspaceViolationToken(violation)}`);
  }
  return violation.detail;
}

/**
 * The evidence of one collected violation in the shape the pre-collection
 * tests asserted: the ingestion fact, or the flattened rejection detail.
 */
export function violationEvidence(violation: WorkspaceViolation): Record<string, unknown> {
  return violation.via === "ingestion" ? { ...violation.fact } : { ...violation.detail };
}

/** The violation re-raised in its original typed-error form. */
export function violationError(violation: WorkspaceViolation): InstallerAuthoredError {
  switch (violation.via) {
    case "ingestion":
      return new InstallerToolError(violation.fact);
    case "manifest":
      return new SchemaRejectionError({ schema: "workspace-manifest", detail: violation.detail });
    case "artifact":
      return new SchemaRejectionError({ schema: "workspace-artifact", detail: violation.detail });
  }
}