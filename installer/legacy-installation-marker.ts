import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

/**
 * Whether the bytes at the legacy pathname are exactly the previous version's
 * ownership token: one JSON object with exactly `installation_id` (non-empty
 * string) and `schema_version` 1, matching the removed parser's accepted
 * shape. Anything else is unknown user content that migration must preserve.
 */
export function isLegacyInstallationMarkerSource(content: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (fields.length !== 2 || fields[0] !== "installation_id" || fields[1] !== "schema_version") {
    return false;
  }
  return typeof record.installation_id === "string" &&
    record.installation_id.length > 0 &&
    record.schema_version === 1;
}

/**
 * Whether this installation records or desires an output at the legacy
 * pathname. The path is no longer reserved, so a legitimate Adapter output
 * there must never be treated as a leftover token.
 */
export function recordsLegacyInstallationMarkerPath(
  outputs: readonly { readonly path: string }[],
): boolean {
  return outputs.some(isLegacyInstallationMarkerOutput);
}

/**
 * Read and verify the bytes at the legacy ownership-token pathname under one
 * Project. Returns the verified legacy-token content, or undefined when the
 * path is absent, unreadable, or holds unknown user content that migration
 * must preserve.
 */
export async function readVerifiedLegacyInstallationMarker(
  project: string,
): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(join(project, LEGACY_INSTALLATION_MARKER_PATH), "utf8");
  } catch {
    return undefined;
  }
  return isLegacyInstallationMarkerSource(content) ? content : undefined;
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
