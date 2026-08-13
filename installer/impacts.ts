import {
  INSTALLATION_MARKER_PATH,
  type ProjectInstallationManifest,
} from "../schemas/installation-manifest.js";
import {
  artifactReferenceKey,
  type ArtifactReference,
} from "../schemas/dependencies.js";
import type { DesiredInstallation } from "./project-plan.js";
import type { OutputReconciliationKind } from "./reconcile.js";

/**
 * Typed lifecycle impact records (DEC-023 of the fleet-synchronization spec).
 * Reconciliation derives one impact per project and distinct proven cause from
 * current desired state and prior receipt provenance. Kinds are exhaustive and
 * never inferred from generated path naming (OOS-012): Artifact identity and
 * change cause are proven at the Workspace/planning boundary, or the change
 * falls back to exact generated paths without guessing.
 *
 * `preview`, the apply receipt, and the post-apply resulting state all derive
 * impacts through this module so every surface uses the same canonical
 * comparison rules.
 */
export type LifecycleImpactKind =
  | "adapter-capability"
  | "artifact"
  | "binding"
  | "generated-path"
  | "installation-removal"
  | "metadata-only"
  | "repair";

/** Direction of a change against the prior receipt. */
export type LifecycleImpactOperation = "addition" | "removal" | "update";

/** Deterministic kind order for machine payloads and presentation grouping. */
export const LIFECYCLE_IMPACT_KIND_ORDER: readonly LifecycleImpactKind[] = [
  "binding",
  "artifact",
  "adapter-capability",
  "repair",
  "installation-removal",
  "metadata-only",
  "generated-path",
];

/** Deterministic operation order for machine payloads and presentation grouping. */
export const LIFECYCLE_IMPACT_OPERATION_ORDER: readonly LifecycleImpactOperation[] = [
  "addition",
  "update",
  "removal",
];

/**
 * One normalized lifecycle impact for one project. A project may carry several
 * impacts with distinct proven causes; ambiguous or legacy evidence is never
 * guessed and falls back to exact generated paths.
 */
export interface LifecycleImpact {
  /** The truthful change class (DEC-023). */
  readonly kind: LifecycleImpactKind;
  /** Direction of the change against the prior receipt. */
  readonly operation: LifecycleImpactOperation;
  /** Canonical project identity for this impact. */
  readonly project: string;
  /** Canonical Profile ID bound to the project. */
  readonly profile: string;
  /** Canonical Hosts bound to the project. */
  readonly hosts: readonly string[];
  /** Exact generated paths affected, sorted; empty for receipt-only changes. */
  readonly paths: readonly string[];
  /** Complete proven canonical source set; present only for artifact impacts. */
  readonly artifacts?: readonly ArtifactReference[];
  /** One deterministic user-facing reason. */
  readonly reason: string;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderIndexOf<T>(order: readonly T[], value: T): number {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function compareArtifactSets(
  left: readonly ArtifactReference[] | undefined,
  right: readonly ArtifactReference[] | undefined,
): number {
  const leftKeys = (left ?? []).map(artifactReferenceKey);
  const rightKeys = (right ?? []).map(artifactReferenceKey);
  const shorter = Math.min(leftKeys.length, rightKeys.length);
  for (let index = 0; index < shorter; index += 1) {
    const order = compareCanonical(leftKeys[index]!, rightKeys[index]!);
    if (order !== 0) return order;
  }
  return leftKeys.length - rightKeys.length;
}

/** Deterministic full ordering for impact records. */
export function compareLifecycleImpacts(
  left: LifecycleImpact,
  right: LifecycleImpact,
): number {
  return (
    orderIndexOf(LIFECYCLE_IMPACT_KIND_ORDER, left.kind) -
      orderIndexOf(LIFECYCLE_IMPACT_KIND_ORDER, right.kind) ||
    orderIndexOf(LIFECYCLE_IMPACT_OPERATION_ORDER, left.operation) -
      orderIndexOf(LIFECYCLE_IMPACT_OPERATION_ORDER, right.operation) ||
    compareCanonical(left.project, right.project) ||
    compareArtifactSets(left.artifacts, right.artifacts) ||
    left.hosts.join("\0").localeCompare(right.hosts.join("\0")) ||
    left.paths.join("\0").localeCompare(right.paths.join("\0")) ||
    left.reason.localeCompare(right.reason)
  );
}

/** Sort an impact collection with the canonical deterministic ordering. */
export function sortLifecycleImpacts(
  impacts: readonly LifecycleImpact[],
): readonly LifecycleImpact[] {
  return [...impacts].sort(compareLifecycleImpacts);
}

/** Receipt Host-version evidence equality shared by reconciliation and impacts. */
export function hostVersionsEqual(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key, index) => key === rightKeys[index] && left[key] === right[key],
  );
}

function sameHosts(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((host, index) => host === right[index])
  );
}

function sortedPaths(paths: Iterable<string>): readonly string[] {
  return [...paths].sort(compareCanonical);
}

function sortedReferences(references: Iterable<ArtifactReference>): readonly ArtifactReference[] {
  return [...references].sort((left, right) =>
    compareCanonical(artifactReferenceKey(left), artifactReferenceKey(right))
  );
}

/** Per-project comparison flags consumed by {@link installationImpacts}. */
export interface InstallationImpactFlags {
  readonly intendedTeardown: boolean;
  readonly moved: boolean;
  readonly repairableMissingMarker: boolean;
}

interface ArtifactBucket {
  readonly artifacts: readonly ArtifactReference[];
  readonly operation: LifecycleImpactOperation;
  readonly paths: string[];
}

function resolvedReferenceSet(
  artifacts: readonly { readonly reference: ArtifactReference }[],
): Set<string> {
  return new Set(artifacts.map((artifact) => artifactReferenceKey(artifact.reference)));
}

function fingerprintMap(manifest: ProjectInstallationManifest): Map<string, string> {
  const fingerprints = new Map<string, string>();
  for (const artifact of manifest.resolvedArtifacts) {
    if (artifact.fingerprint !== undefined) {
      fingerprints.set(artifactReferenceKey(artifact.reference), artifact.fingerprint);
    }
  }
  return fingerprints;
}

const ARTIFACT_OPERATION_REASONS: Readonly<Record<LifecycleImpactOperation, string>> = {
  addition: "Workspace artifact added to the Profile",
  removal: "Workspace artifact removed from the Profile",
  update: "Workspace artifact content changed",
};

function artifactReason(operation: LifecycleImpactOperation): string {
  return ARTIFACT_OPERATION_REASONS[operation];
}

/**
 * Derive the typed impacts for one desired Profile Installation against its
 * prior receipt. Preview, the apply receipt, and the post-apply resulting state
 * share this comparison so the same canonical rules produce the same facts.
 *
 * Attribution is conservative: an output is attributed to one or more
 * canonical Artifacts only when the prior receipt provenance and normalized
 * planning fingerprints prove that cause (DEC-024, DEC-027). Binding/Host,
 * Adapter/capability, and unclassified changes are never presented as Workspace
 * artifact edits when artifact fingerprints are unchanged (DEC-028), and legacy
 * receipts lacking provenance fall back to exact generated paths (OOS-012).
 */
export function installationImpacts(
  previous: ProjectInstallationManifest | undefined,
  desired: DesiredInstallation,
  outputChanges: ReadonlyMap<string, OutputReconciliationKind>,
  flags: InstallationImpactFlags,
): readonly LifecycleImpact[] {
  const project = desired.binding.canonicalProject;
  const profile = desired.profile.id;
  const hosts = [...desired.binding.hosts];
  const makeImpact = (
    kind: LifecycleImpactKind,
    operation: LifecycleImpactOperation,
    paths: readonly string[],
    artifacts: readonly ArtifactReference[] | undefined,
    reason: string,
  ): LifecycleImpact => ({
    kind,
    operation,
    project,
    profile,
    hosts,
    paths: sortedPaths(paths),
    ...(artifacts === undefined
      ? {}
      : { artifacts: sortedReferences(artifacts) }),
    reason,
  });

  if (previous === undefined) {
    const paths = [...desired.outputs.map((output) => output.path), INSTALLATION_MARKER_PATH];
    if (flags.intendedTeardown) {
      return [makeImpact(
        "repair",
        "addition",
        paths,
        undefined,
        "Output was removed by uninstall; Project Binding was preserved",
      )];
    }
    return [makeImpact(
      "binding",
      "addition",
      paths,
      undefined,
      "Project Binding installs this Profile into the project for the first time",
    )];
  }

  const provenanceComplete = previous.outputOrigins !== undefined;
  const previousFingerprints = fingerprintMap(previous);
  const desiredFingerprints = new Map(
    desired.artifactFingerprints.map((fingerprint) => [
      artifactReferenceKey(fingerprint.reference),
      fingerprint.fingerprint,
    ]),
  );
  const previousReferences = resolvedReferenceSet(previous.resolvedArtifacts);
  const desiredReferences = resolvedReferenceSet(desired.resolvedProfile.artifacts);
  const newReferences = new Set(
    [...desiredReferences].filter((reference) => !previousReferences.has(reference)),
  );
  const removedReferences = new Set(
    [...previousReferences].filter((reference) => !desiredReferences.has(reference)),
  );
  const changedReferences = new Set<string>();
  for (const [reference, fingerprint] of previousFingerprints) {
    const next = desiredFingerprints.get(reference);
    if (next !== undefined && fingerprint !== next) changedReferences.add(reference);
  }
  const referenceByKey = new Map<string, ArtifactReference>();
  for (const artifact of [...previous.resolvedArtifacts, ...desired.resolvedProfile.artifacts]) {
    referenceByKey.set(artifactReferenceKey(artifact.reference), artifact.reference);
  }

  const profileSwitched = previous.profileId !== profile;
  const bindingChanged =
    flags.moved || !sameHosts(previous.hosts, hosts) || profileSwitched;
  const adapterChanged =
    previous.adapterVersion !== desired.adapterVersion ||
    !hostVersionsEqual(previous.hostVersions, desired.hostVersions);

  const changedPaths = sortedPaths(
    [...outputChanges.entries()]
      .filter(([path, kind]) => path !== INSTALLATION_MARKER_PATH && kind !== "unchanged")
      .map(([path]) => path),
  );

  const artifactBuckets = new Map<string, ArtifactBucket>();
  const bindingPaths: string[] = [];
  const adapterPaths: string[] = [];
  const generatedPaths: string[] = [];
  const repairPaths: string[] = [];
  for (const path of changedPaths) {
    const changeKind = outputChanges.get(path) ?? "removal";
    if (changeKind === "repair") {
      repairPaths.push(path);
      continue;
    }
    if (!provenanceComplete) {
      generatedPaths.push(path);
      continue;
    }
    const desiredOrigins = desired.outputs.find((output) => output.path === path)?.origins ?? [];
    const previousOrigins = previous.outputOrigins?.[path] ?? [];
    const desiredOriginKeys = desiredOrigins.map(artifactReferenceKey);
    const previousOriginKeys = previousOrigins.map(artifactReferenceKey);
    const contentChangedKeys = new Set(
      [...desiredOriginKeys, ...previousOriginKeys].filter((reference) =>
        changedReferences.has(reference)
      ),
    );
    let sourceKeys: Set<string>;
    let operation: LifecycleImpactOperation;
    if (profileSwitched) {
      if (contentChangedKeys.size === 0) {
        bindingPaths.push(path);
        continue;
      }
      sourceKeys = contentChangedKeys;
      operation = "update";
    } else {
      sourceKeys = new Set(contentChangedKeys);
      for (const reference of desiredOriginKeys) {
        if (newReferences.has(reference)) sourceKeys.add(reference);
      }
      for (const reference of previousOriginKeys) {
        if (removedReferences.has(reference)) sourceKeys.add(reference);
      }
      if (sourceKeys.size === 0) {
        if (bindingChanged) {
          bindingPaths.push(path);
          continue;
        }
        if (adapterChanged) {
          adapterPaths.push(path);
          continue;
        }
        generatedPaths.push(path);
        continue;
      }
      operation = [...sourceKeys].some((reference) => removedReferences.has(reference))
        ? "removal"
        : [...sourceKeys].some((reference) => newReferences.has(reference))
          ? "addition"
          : "update";
    }
    const bucketKey = [...sourceKeys].sort(compareCanonical).join("\0");
    const existing = artifactBuckets.get(bucketKey);
    if (existing) {
      existing.paths.push(path);
    } else {
      artifactBuckets.set(bucketKey, {
        artifacts: sortedReferences(
          [...sourceKeys].map((reference) => referenceByKey.get(reference)!),
        ),
        operation,
        paths: [path],
      });
    }
  }

  if (changedPaths.length === 0) {
    if (flags.repairableMissingMarker) {
      return [makeImpact(
        "metadata-only",
        "update",
        [],
        undefined,
        "Installation Marker is missing and repairable",
      )];
    }
    if (flags.moved) {
      return [makeImpact(
        "binding",
        "update",
        [],
        undefined,
        "Project moved; receipt tracks the new project root",
      )];
    }
    const presenceChanged = new Set([...newReferences, ...removedReferences, ...changedReferences]);
    if (presenceChanged.size > 0 && !profileSwitched) {
      const operation = removedReferences.size > 0
        ? "removal"
        : newReferences.size > 0
          ? "addition"
          : "update";
      return [makeImpact(
        "artifact",
        operation,
        [],
        sortedReferences(
          [...presenceChanged].map((reference) => referenceByKey.get(reference)!),
        ),
        artifactReason(operation),
      )];
    }
    if (profileSwitched) {
      return [makeImpact(
        "binding",
        "update",
        [],
        undefined,
        "Profile changed; receipt will track the newly bound Profile",
      )];
    }
    if (bindingChanged) {
      return [makeImpact(
        "binding",
        "update",
        [],
        undefined,
        "Project Binding or Host selection changed",
      )];
    }
    if (adapterChanged) {
      return [makeImpact(
        "adapter-capability",
        "update",
        [],
        undefined,
        "Adapter version or Host capability changed",
      )];
    }
    if (previous.gitProject !== (desired.gitProject !== undefined)) {
      return [makeImpact(
        "metadata-only",
        "update",
        [],
        undefined,
        "Git project classification changed",
      )];
    }
    if (previous.workspaceInputHash !== desired.sourceHash) {
      return [makeImpact(
        "metadata-only",
        "update",
        [],
        undefined,
        "Workspace source inputs changed; receipt will be refreshed",
      )];
    }
    return [];
  }

  const impacts: LifecycleImpact[] = [];
  for (const bucket of artifactBuckets.values()) {
    impacts.push(makeImpact(
      "artifact",
      bucket.operation,
      bucket.paths,
      bucket.artifacts,
      artifactReason(bucket.operation),
    ));
  }
  if (bindingPaths.length > 0) {
    impacts.push(makeImpact(
      "binding",
      "update",
      bindingPaths,
      undefined,
      "Project Binding or Host selection changed",
    ));
  }
  if (adapterPaths.length > 0) {
    impacts.push(makeImpact(
      "adapter-capability",
      "update",
      adapterPaths,
      undefined,
      "Adapter version or Host capability changed",
    ));
  }
  if (repairPaths.length > 0) {
    impacts.push(makeImpact(
      "repair",
      "update",
      repairPaths,
      undefined,
      "Owned generated file is missing; apply will recreate it from current Workspace source",
    ));
  }
  if (generatedPaths.length > 0) {
    impacts.push(makeImpact(
      "generated-path",
      "update",
      generatedPaths,
      undefined,
      "Exact generated paths changed without a proven source cause",
    ));
  }
  return sortLifecycleImpacts(impacts);
}

/** One installation-removal impact for a Profile Installation with no remaining Project Binding. */
export function removalImpacts(
  previous: ProjectInstallationManifest,
  intentionallyDeleted: boolean,
): readonly LifecycleImpact[] {
  return [{
    kind: "installation-removal",
    operation: "removal",
    project: previous.project,
    profile: previous.profileId,
    hosts: [...previous.hosts].sort(compareCanonical),
    paths: previous.outputs.map((output) => output.path).sort(compareCanonical),
    reason: intentionallyDeleted
      ? "project intentionally deleted"
      : "Project Binding no longer selects this project",
  }];
}
