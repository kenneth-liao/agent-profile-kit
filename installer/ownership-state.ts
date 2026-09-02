import { compareCanonicalStrings } from "../schemas/installation-manifest.js";
import {
  OWNERSHIP_STATE_SCHEMA_VERSION,
  type OwnershipReceipt,
  type OwnershipState,
} from "../schemas/ownership-state.js";

export function ordinaryReceipts(state: OwnershipState): readonly OwnershipReceipt[] {
  return state.receipts.filter(
    (receipt) => receipt.lifetime === "ordinary" && receipt.retired !== true,
  );
}

/**
 * The one reader for receipts `unbind` retired: no longer active ownership,
 * invisible to uninstall and receipt replacement, still the sole teardown
 * authority whose recorded detail a later `apply` consumes to prove and remove
 * generated output. Carries exactly the detail the active receipt recorded;
 * retirement adds nothing.
 */
export function retiredReceipts(state: OwnershipState): readonly OwnershipReceipt[] {
  return state.receipts.filter(
    (receipt) => receipt.lifetime === "ordinary" && receipt.retired === true,
  );
}

export function temporaryReceipts(state: OwnershipState): readonly OwnershipReceipt[] {
  return state.receipts.filter((receipt) => receipt.lifetime === "temporary");
}

export function withReceipts(
  state: OwnershipState,
  receipts: readonly OwnershipReceipt[],
): OwnershipState {
  return {
    ...state,
    receipts: [...receipts].sort((left, right) => compareCanonicalStrings(left.project, right.project)),
    schemaVersion: OWNERSHIP_STATE_SCHEMA_VERSION,
  };
}
