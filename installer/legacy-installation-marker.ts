import type { OwnershipOutputReceipt, OwnershipReceipt } from "../schemas/ownership-state.js";

/**
 * The one private home for the output path the removed ownership token used to
 * occupy. Migration code deletes a leftover file at this path during ordinary
 * apply reconciliation; nothing else may read, write, or reserve it.
 */
export const LEGACY_INSTALLATION_MARKER_PATH = ".agent-profile-kit/installation.json";

export function isLegacyInstallationMarkerOutput(
  output: Pick<OwnershipOutputReceipt, "path">,
): boolean {
  return output.path === LEGACY_INSTALLATION_MARKER_PATH;
}

/** Drop legacy ownership-token output entries recorded by the previous version. */
export function withoutLegacyInstallationMarkerOutputs(
  receipt: OwnershipReceipt,
): OwnershipReceipt {
  if (!receipt.outputs.some(isLegacyInstallationMarkerOutput)) return receipt;
  return {
    ...receipt,
    outputs: receipt.outputs.filter((output) => !isLegacyInstallationMarkerOutput(output)),
  };
}
