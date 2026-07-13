import {
  applyReconciliation,
  previewReconciliation,
  type ReconciliationReport,
} from "./reconcile.js";
import { buildDesiredState, stateManifestPath } from "./project-plan.js";
import {
  proveOwnedInstallation,
  readInstallationState,
  stageProvenInstallationRemoval,
  writeInstallationState,
} from "./installation-state.js";

export async function validateApplication(home: string): Promise<{
  readonly bindings: number;
  readonly profiles: number;
}> {
  const desired = await buildDesiredState(home, { checkHostCapability: false });
  return {
    bindings: desired.installations.length,
    profiles: desired.workspace.profiles.size,
  };
}

export async function previewApplication(home: string): Promise<ReconciliationReport> {
  const desired = await buildDesiredState(home);
  let state;
  try {
    state = await readInstallationState(home);
  } catch (error) {
    const desiredReport = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 1,
    });
    return {
      ...desiredReport,
      blockers: [error instanceof Error ? error.message : String(error), ...desiredReport.blockers],
    };
  }
  return previewReconciliation(desired.installations, state);
}

export async function applyApplication(home: string): Promise<ReconciliationReport> {
  const desired = await buildDesiredState(home);
  return applyReconciliation(home, desired.installations);
}

export async function statusApplication(home: string): Promise<ReconciliationReport> {
  const desired = await buildDesiredState(home, { checkHostCapability: false });
  let state;
  try {
    state = await readInstallationState(home);
  } catch (error) {
    const desiredReport = await previewReconciliation(desired.installations, {
      installations: [],
      schemaVersion: 1,
    });
    return {
      ...desiredReport,
      items: [
        ...desiredReport.items,
        {
          kind: "malformed ownership state",
          project: stateManifestPath(home),
          reason: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
  return previewReconciliation(desired.installations, state);
}

export async function uninstallApplication(home: string): Promise<number> {
  const state = await readInstallationState(home);
  if (state.installations.length === 0) return 0;
  const failures: string[] = [];
  for (const installation of state.installations) {
    const proof = await proveOwnedInstallation(installation);
    if (!proof.owned) {
      failures.push(
        `${installation.project}: ${proof.reason ?? "ownership could not be proven"}`,
      );
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Uninstall blocked; generated output was not removed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }
  const transactions: Awaited<ReturnType<typeof stageProvenInstallationRemoval>>[] = [];
  try {
    for (const installation of state.installations) {
      transactions.push(await stageProvenInstallationRemoval(installation));
    }
    await writeInstallationState(home, { installations: [], schemaVersion: 1 });
    for (const transaction of transactions) await transaction.commit();
  } catch (error) {
    for (const transaction of transactions.reverse()) await transaction.rollback();
    throw error;
  }
  return state.installations.length;
}
