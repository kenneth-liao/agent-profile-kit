import { isAbsolute, normalize, win32 } from "node:path";

import {
  HOST_CATALOG,
  isSupportedHost,
  type SupportedHost,
} from "../adapters/host-catalog.js";
import { requireArtifactId } from "./dependencies.js";
import {
  compareCanonicalStrings,
  parseFileMode,
} from "./installation-manifest.js";

export const OWNERSHIP_STATE_SCHEMA_VERSION = 9;

/**
 * Every Ownership State schema version the on-disk reader accepts: the current
 * version plus every version published from the v0.132.0 spec baseline onward,
 * so a direct upgrade keeps existing receipts without re-binding or re-applying.
 */
export const ACCEPTED_OWNERSHIP_STATE_SCHEMA_VERSIONS = [9, 8, 7, 6] as const;

/** Explicit trust-boundary limits for the final ownership-state document. */
export const OWNERSHIP_STATE_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxCollectionEntries: 100_000,
  maxNestingDepth: 32,
  maxPaths: 50_000,
  maxStringBytes: 64 * 1024,
} as const;

export interface OwnershipHostReceipt {
  readonly adapterVersion: string;
  readonly capabilityContract: string;
}

export interface OwnershipOutputReceipt {
  readonly hash: string;
  readonly mode: number;
  readonly path: string;
  readonly type: "directory" | "file";
}

export interface OwnershipReceipt {
  readonly desiredInputDigest: string;
  readonly hosts: Readonly<Partial<Record<SupportedHost, OwnershipHostReceipt>>>;
  readonly installationId: string;
  readonly lifetime: "ordinary" | "temporary";
  /**
   * Retired by `unbind`: the receipt no longer proves active ownership and is
   * invisible to uninstall, but keeps exactly its previously recorded detail
   * as the one teardown authority while a later `apply` proves and removes its
   * output. No detail is added or derived at retirement.
   */
  readonly retired?: true;
  readonly outputs: readonly OwnershipOutputReceipt[];
  readonly profileId: string;
  readonly project: string;
}

export interface OwnershipState {
  readonly receipts: readonly OwnershipReceipt[];
  readonly removedTemporaryInstallationIds: readonly string[];
  readonly schemaVersion: typeof OWNERSHIP_STATE_SCHEMA_VERSION;
}

function requireMapping(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  description: string,
): void {
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length > 0) {
    throw new Error(`${description} does not allow fields: ${unknown.join(", ")}`);
  }
  for (const field of fields) {
    if (!(field in value)) throw new Error(`${description} requires field '${field}'`);
  }
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

function requireHash(value: unknown, description: string): string {
  const hash = requireString(value, description);
  if (!/^sha256:[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${description} must be a SHA-256 hash`);
  }
  return hash;
}

function requireProject(value: unknown, description: string): string {
  const project = requireString(value, description);
  if (!isAbsolute(project) || normalize(project) !== project || /^[A-Za-z]:/.test(project)) {
    throw new Error(`${description} must be a normalized absolute path`);
  }
  return project;
}

function requireOutputPath(value: unknown, description: string): string {
  const path = requireString(value, description);
  if (
    path.startsWith("/") ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${description} must be a normalized safe relative Project path`);
  }
  return path;
}

function parseOutput(value: unknown, description: string): OwnershipOutputReceipt {
  const output = requireMapping(value, description);
  requireExactFields(output, ["path", "type", "mode", "hash"], description);
  if (output.type !== "file" && output.type !== "directory") {
    throw new Error(`${description} type must be 'file' or 'directory'`);
  }
  const path = requireOutputPath(output.path, `${description} path`);
  return {
    hash: requireHash(output.hash, `${description} hash`),
    mode: parseFileMode(output.mode, `${description} mode`),
    path,
    type: output.type,
  };
}

function parseHosts(value: unknown, description: string): OwnershipReceipt["hosts"] {
  const mapping = requireMapping(value, description);
  if (Object.keys(mapping).length === 0) throw new Error(`${description} must not be empty`);
  const hosts: Partial<Record<SupportedHost, OwnershipHostReceipt>> = {};
  for (const host of Object.keys(mapping)) {
    if (!isSupportedHost(host)) {
      throw new Error(`${description} does not support Host '${host}'`);
    }
    const hostDescription = `${description}.${host}`;
    const record = requireMapping(mapping[host], hostDescription);
    requireExactFields(record, ["adapter_version", "capability_contract"], hostDescription);
    hosts[host] = {
      adapterVersion: requireString(record.adapter_version, `${hostDescription} adapter_version`),
      capabilityContract: requireString(
        record.capability_contract,
        `${hostDescription} capability_contract`,
      ),
    };
  }
  return Object.fromEntries(HOST_CATALOG.flatMap(({ host }) => {
    const receipt = hosts[host];
    return receipt === undefined ? [] : [[host, receipt]];
  }));
}

function parseReceipt(value: unknown, index: number): OwnershipReceipt {
  const description = `Ownership State receipts[${index}]`;
  const receipt = requireMapping(value, description);
  const required = [
    "installation_id",
    "lifetime",
    "project",
    "profile_id",
    "desired_input_digest",
    "hosts",
    "outputs",
  ] as const;
  // `repository_exclusion` was dropped by the schema change that made the
  // Repository Exclusion Contribution derived, best-effort bookkeeping: stored
  // fields from earlier documents are ignored here so every downstream reader
  // sees the current receipt shape.
  const allowed = [...required, "repository_exclusion", "retired"];
  const unknown = Object.keys(receipt).filter((field) => !allowed.includes(field as typeof allowed[number]));
  if (unknown.length > 0) {
    throw new Error(`${description} does not allow fields: ${unknown.join(", ")}`);
  }
  for (const field of required) {
    if (!(field in receipt)) throw new Error(`${description} requires field '${field}'`);
  }
  if (receipt.lifetime !== "ordinary" && receipt.lifetime !== "temporary") {
    throw new Error(`${description} lifetime must be 'ordinary' or 'temporary'`);
  }
  if (!Array.isArray(receipt.outputs) || receipt.outputs.length === 0) {
    throw new Error(`${description} outputs must be a non-empty array`);
  }
  const outputs = receipt.outputs.map((output, outputIndex) =>
    parseOutput(output, `${description} outputs[${outputIndex}]`),
  );
  const outputPaths = new Set(outputs.map((output) => output.path));
  if (outputPaths.size !== outputs.length) {
    throw new Error(`${description} outputs must not contain a path more than once`);
  }
  for (const output of outputs) {
    const parts = output.path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      if (outputPaths.has(parts.slice(0, index).join("/"))) {
        throw new Error(`${description} outputs must not contain overlapping output roots`);
      }
    }
  }
  const hosts = parseHosts(receipt.hosts, `${description} hosts`);
  if (receipt.lifetime === "temporary" && Object.keys(hosts).length !== 1) {
    throw new Error(`${description} temporary receipt must contain exactly one Host`);
  }
  if (receipt.retired !== undefined && receipt.retired !== true) {
    throw new Error(`${description} retired must be true when present`);
  }
  if (receipt.retired === true && receipt.lifetime !== "ordinary") {
    throw new Error(`${description} only ordinary receipts can be retired`);
  }
  return {
    desiredInputDigest: requireHash(
      receipt.desired_input_digest,
      `${description} desired_input_digest`,
    ),
    hosts,
    installationId: requireString(receipt.installation_id, `${description} installation_id`),
    lifetime: receipt.lifetime,
    outputs: [...outputs].sort((left, right) => compareCanonicalStrings(left.path, right.path)),
    profileId: requireArtifactId(receipt.profile_id, `${description} profile_id`),
    project: requireProject(receipt.project, `${description} project`),
    ...(receipt.retired === true ? { retired: true as const } : {}),
  };
}

function ownershipStateValue(state: OwnershipState): Record<string, unknown> {
  return {
    schema_version: state.schemaVersion,
    receipts: state.receipts.map((receipt) => ({
      installation_id: receipt.installationId,
      lifetime: receipt.lifetime,
      project: receipt.project,
      profile_id: receipt.profileId,
      desired_input_digest: receipt.desiredInputDigest,
      hosts: Object.fromEntries(HOST_CATALOG.flatMap(({ host }) => {
        const value = receipt.hosts[host];
        return value === undefined ? [] : [[host, {
          adapter_version: value.adapterVersion,
          capability_contract: value.capabilityContract,
        }]];
      })),
      outputs: receipt.outputs.map((output) => ({
        path: output.path,
        type: output.type,
        mode: output.mode,
        hash: output.hash,
      })),
      ...(receipt.retired === true ? { retired: true } : {}),
    })),
    removed_temporary_installation_ids: state.removedTemporaryInstallationIds,
  };
}

function assertJsonSourceBounds(source: string): void {
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes > OWNERSHIP_STATE_LIMITS.maxBytes) {
    throw new Error(
      `Ownership State exceeds the ${OWNERSHIP_STATE_LIMITS.maxBytes} byte limit`,
    );
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const character of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
      if (depth > OWNERSHIP_STATE_LIMITS.maxNestingDepth) {
        throw new Error(
          `Ownership State nesting exceeds the ${OWNERSHIP_STATE_LIMITS.maxNestingDepth} level limit`,
        );
      }
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
}

interface JsonObjectFrame {
  readonly keys: Set<string>;
  readonly kind: "object";
  expectsKey: boolean;
}

type JsonContainerFrame = JsonObjectFrame | { readonly kind: "array" };

function assertUniqueJsonObjectFields(source: string): void {
  const stack: JsonContainerFrame[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      const start = index;
      let escaped = false;
      while (++index < source.length) {
        const stringCharacter = source[index];
        if (escaped) escaped = false;
        else if (stringCharacter === "\\") escaped = true;
        else if (stringCharacter === '"') break;
      }
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.expectsKey) {
        let key: unknown;
        try {
          key = JSON.parse(source.slice(start, index + 1));
        } catch {
          continue;
        }
        if (typeof key === "string") {
          if (frame.keys.has(key)) {
            throw new Error(`Ownership State object contains field '${key}' more than once`);
          }
          frame.keys.add(key);
          frame.expectsKey = false;
        }
      }
      continue;
    }
    if (character === "{") {
      stack.push({ expectsKey: true, keys: new Set(), kind: "object" });
    } else if (character === "[") {
      stack.push({ kind: "array" });
    } else if (character === "}" || character === "]") {
      stack.pop();
    } else if (character === ",") {
      const frame = stack.at(-1);
      if (frame?.kind === "object") frame.expectsKey = true;
    }
  }
}

function assertParsedResourceBounds(value: unknown): void {
  let collectionEntries = 0;
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > OWNERSHIP_STATE_LIMITS.maxStringBytes) {
        throw new Error(
          `Ownership State string exceeds the ${OWNERSHIP_STATE_LIMITS.maxStringBytes} byte limit`,
        );
      }
      continue;
    }
    if (typeof current !== "object" || current === null) continue;
    if (!Array.isArray(current)) {
      for (const key of Object.keys(current)) {
        if (Buffer.byteLength(key, "utf8") > OWNERSHIP_STATE_LIMITS.maxStringBytes) {
          throw new Error(
            `Ownership State string exceeds the ${OWNERSHIP_STATE_LIMITS.maxStringBytes} byte limit`,
          );
        }
      }
    }
    const entries = Array.isArray(current) ? current : Object.values(current);
    collectionEntries += entries.length;
    if (collectionEntries > OWNERSHIP_STATE_LIMITS.maxCollectionEntries) {
      throw new Error(
        `Ownership State collection entries exceed the ${OWNERSHIP_STATE_LIMITS.maxCollectionEntries} limit`,
      );
    }
    for (const entry of entries) pending.push(entry);
  }
}

function assertPathBounds(state: OwnershipState): void {
  const paths = state.receipts.reduce((count, receipt) =>
    count + 1 + receipt.outputs.length, 0);
  if (paths > OWNERSHIP_STATE_LIMITS.maxPaths) {
    throw new Error(`Ownership State paths exceed the ${OWNERSHIP_STATE_LIMITS.maxPaths} limit`);
  }
}

function parseOwnershipStateWithVersion(
  source: string,
  acceptedVersions: readonly number[],
): ParsedOwnershipStateDocument {
  assertJsonSourceBounds(source);
  assertUniqueJsonObjectFields(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("Ownership State is invalid JSON");
  }
  assertParsedResourceBounds(parsed);
  const value = requireMapping(parsed, "Ownership State");
  requireExactFields(
    value,
    ["schema_version", "receipts", "removed_temporary_installation_ids"],
    "Ownership State",
  );
  if (
    typeof value.schema_version !== "number" ||
    !acceptedVersions.includes(value.schema_version)
  ) {
    throw new Error(
      `Ownership State schema_version must be ${acceptedVersions.join(" or ")}`,
    );
  }
  if (!Array.isArray(value.receipts)) throw new Error("Ownership State receipts must be an array");
  if (!Array.isArray(value.removed_temporary_installation_ids)) {
    throw new Error("Ownership State removed_temporary_installation_ids must be an array");
  }
  const receipts = value.receipts.map(parseReceipt);
  const receiptIds = receipts.map((receipt) => receipt.installationId);
  if (new Set(receiptIds).size !== receiptIds.length) {
    throw new Error("Ownership State must not contain an Installation ID more than once");
  }
  // Project uniqueness holds among active receipts only: a retired receipt
  // keeps its recorded detail until apply consumes it, and a re-bound Project
  // transiently owns a fresh active receipt for the same canonical path.
  const projects = receipts
    .filter((receipt) => receipt.retired !== true)
    .map((receipt) => receipt.project);
  if (new Set(projects).size !== projects.length) {
    throw new Error("Ownership State must not contain an active Project more than once");
  }
  const removed = value.removed_temporary_installation_ids.map((identity, index) =>
    requireString(identity, `Ownership State removed_temporary_installation_ids[${index}]`),
  );
  if (new Set(removed).size !== removed.length) {
    throw new Error("Ownership State must not contain a removed temporary identity more than once");
  }
  if (removed.some((identity) => receiptIds.includes(identity))) {
    throw new Error("Ownership State active and removed Installation IDs must not collide");
  }
  const state: ParsedOwnershipStateDocument = {
    receipts: [...receipts].sort((left, right) => compareCanonicalStrings(left.project, right.project)),
    removedTemporaryInstallationIds: [...removed].sort(compareCanonicalStrings),
    schemaVersion: value.schema_version as number,
  };
  assertPathBounds(state as OwnershipState);
  return state;
}

/**
 * The strict current-version Ownership State. The discriminated literal pins
 * every constructed state to the current schema version.
 */
export type ParsedOwnershipStateDocument = Omit<OwnershipState, "schemaVersion"> & {
  readonly schemaVersion: number;
};

/** Strict codec for the current schema version: the writer-side and test seam. */
export function parseOwnershipState(source: string): OwnershipState {
  const state = parseOwnershipStateWithVersion(source, [OWNERSHIP_STATE_SCHEMA_VERSION]);
  return state as OwnershipState;
}

/**
 * The one on-disk reader: accepts the current schema version and every schema
 * version the v0.132.0 baseline and successors published, preserving the
 * document's version so callers can normalize version-specific entries at
 * their single ingestion boundary.
 */
export function parseOwnershipStateDocument(source: string): ParsedOwnershipStateDocument {
  return parseOwnershipStateWithVersion(source, ACCEPTED_OWNERSHIP_STATE_SCHEMA_VERSIONS);
}

export function formatOwnershipState(state: OwnershipState): string {
  const normalized = parseOwnershipState(JSON.stringify(ownershipStateValue(state)));
  const source = `${JSON.stringify(ownershipStateValue(normalized), null, 2)}\n`;
  parseOwnershipState(source);
  return source;
}

