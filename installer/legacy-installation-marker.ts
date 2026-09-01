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
 * Parse the bytes at the legacy pathname as the previous version's ownership
 * token: one JSON object with exactly `installation_id` (non-empty string) and
 * `schema_version` 1, matching the removed parser's accepted shape. Returns
 * undefined for anything else — unknown user content that migration must
 * preserve. Shape alone is not authority: callers must additionally match the
 * parsed `installationId` against the authoritative Installation Receipt.
 */
export function parseLegacyInstallationMarkerSource(
  content: string,
): { readonly installationId: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort();
  if (fields.length !== 2 || fields[0] !== "installation_id" || fields[1] !== "schema_version") {
    return undefined;
  }
  if (
    typeof record.installation_id !== "string" ||
    record.installation_id.length === 0 ||
    record.schema_version !== 1
  ) {
    return undefined;
  }
  return { installationId: record.installation_id };
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
 * Project. The token is authoritative only when its parsed `installation_id`
 * matches the expected id of the Installation Receipt that owns this Project —
 * a token naming any other installation (or a copy of one) is not this
 * Project's cleanup evidence. Returns the verified token content, or
 * undefined when the path is absent, unreadable, holds unknown user content,
 * names a different installation, or no authoritative Receipt id is given.
 */
export async function readVerifiedLegacyInstallationMarker(
  project: string,
  expectedInstallationId: string | undefined,
): Promise<string | undefined> {
  if (expectedInstallationId === undefined) return undefined;
  let content: string;
  try {
    content = await readFile(join(project, LEGACY_INSTALLATION_MARKER_PATH), "utf8");
  } catch {
    return undefined;
  }
  const token = parseLegacyInstallationMarkerSource(content);
  return token !== undefined && token.installationId === expectedInstallationId
    ? content
    : undefined;
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
