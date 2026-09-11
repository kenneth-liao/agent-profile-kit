/**
 * Legacy retirement setup (ticket #496): public `unbind` is retired, but
 * `update` still honors receipts retired by older machines, so tests for the
 * retirement path hand-roll the retired shape instead of calling the removed
 * command. Forgetting the binding plus marking its ordinary receipt retired
 * reproduces exactly the record `unbind` used to leave behind.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

import { readInstallationState, writeInstallationState } from "../../installer/installation-state.js";

/** Forget one binding and retire its ordinary receipt, like `unbind` did. */
export async function retireBindingByHand(home: string, project: string): Promise<void> {
  const configuration = join(home, ".agents", "agent-profile-kit", "config.yaml");
  const parsed = parse(readFileSync(configuration, "utf8")) as {
    readonly bindings?: readonly { readonly project?: unknown }[];
  };
  const bindings = (parsed.bindings ?? []).filter((binding) => binding.project !== project);
  writeFileSync(
    configuration,
    stringify({ ...(parsed as Record<string, unknown>), bindings }),
  );
  const state = await readInstallationState(home);
  let canonical: string | undefined;
  try {
    canonical = realpathSync(project);
  } catch {
    canonical = undefined;
  }
  const retired = state.receipts.find(
    (receipt) => receipt.lifetime === "ordinary" && receipt.retired !== true &&
      (receipt.project === project || (canonical !== undefined && receipt.project === canonical)),
  );
  if (retired === undefined) return;
  await writeInstallationState(home, {
    ...state,
    receipts: state.receipts.map((receipt) =>
      receipt.installationId === retired.installationId
        ? { ...receipt, retired: true as const }
        : receipt),
  });
}
