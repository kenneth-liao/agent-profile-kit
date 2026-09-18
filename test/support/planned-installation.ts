import { isPlannedInstallation } from "../../installer/project-plan.js";
import type {
  DesiredInstallation,
  PlannedInstallation,
} from "../../installer/project-plan.js";

/**
 * Test narrowing for the desired-installation union (#606): every scenario in
 * these suites plans healthy Profiles, so a blocked installation here is a
 * fixture bug and fails loudly instead of silently reading phantom fields.
 */
export function plannedInstallation(installation: DesiredInstallation): PlannedInstallation {
  if (!isPlannedInstallation(installation)) {
    throw new Error(
      `expected a planned installation for ${installation.binding.canonicalProject}, got a blocked one`,
    );
  }
  return installation;
}
export function plannedInstallations(
  installations: readonly DesiredInstallation[],
): readonly PlannedInstallation[] {
  return installations.map(plannedInstallation);
}

export type { PlannedInstallation };
