import { join, posix } from "node:path";
import { parseDocument, isMap, isScalar, Pair, Scalar, YAMLMap } from "yaml";
import type { Document } from "yaml";

import { capabilityFailure } from "./capability.js";
import {
  identifierPart,
  type ProposedDirectoryFileMember,
  type ProposedDirectoryMember,
  type ProposedProjectDirectoryOutput,
} from "./project-plan.js";
import {
  DEFAULT_ADAPTER_PLANNING_MATERIALS,
  DISABLED_MODEL_INVOCATION_REQUIREMENT,
  planSkillPackageDirectory,
  SKILL_PACKAGE_SIDECAR,
  type AdapterPlanningMaterials,
  type SkillPackageProjection,
} from "./skill-package.js";
import type { SupportedHost } from "../schemas/local-configuration.js";
import type { ModelInvocationPolicy, Skill } from "../schemas/skill.js";

/** Shared native Skill discovery root used by qualified Agent Hosts. */
export const SHARED_SKILLS_DISCOVERY_ROOT = posix.join(".agents", "skills");

/** Semantic requirement shared by every Adapter consuming the qualified package. */
export const SHARED_SKILL_DISCOVERY_REQUIREMENT =
  "Qualified Agent Hosts discover Skill packages through native project .agents/skills";

/** Codex's additional policy file inside a shared Skill package. */
export const SHARED_SKILL_OPENAI_YAML = "agents/openai.yaml";

const MODEL_INVOCATION_METADATA_FIELD =
  "metadata.agent-profile-kit.model-invocation";
const CODEX_INVOCATION_FIELD =
  "policy.allow_implicit_invocation";
const SKILL_INVOCATION_COMMENT =
  "Agent Profile Kit: keep Skill invocation explicit.";
const CODEX_INVOCATION_COMMENT =
  "Agent Profile Kit: prevent implicit Skill invocation.";

export interface SharedSkillPolicyInput {
  readonly id: string;
  readonly modelInvocation: ModelInvocationPolicy;
  readonly path: string;
  /** Consumer receiving the shared package. */
  readonly consumerHost: SupportedHost;
}

export type SharedSkillPolicyDecision =
  | { readonly action: "leave"; readonly bytes?: string }
  | { readonly action: "write"; readonly bytes: string };

function memberBytesAsString(bytes: string | Uint8Array): string {
  return typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("utf8");
}

function policyAuthorityFailure(
  skill: SharedSkillPolicyInput,
  detail: string,
  kind: "conflict" | "invalid",
): ReturnType<typeof capabilityFailure> {
  const canonical =
    `canonical Workspace ${MODEL_INVOCATION_METADATA_FIELD} is '${skill.modelInvocation}'`;
  const hostLabel = `${skill.consumerHost[0]?.toUpperCase() ?? ""}${skill.consumerHost.slice(1)}`;
  const host = `${hostLabel} ${SHARED_SKILL_OPENAI_YAML} ${detail}`;
  const problem =
    `Skill '${skill.id}' has ${kind === "conflict" ? "conflicting" : "invalid"} ` +
    `model-invocation authorities: ${canonical}; ${host}`;
  const remedy =
    `Repair the canonical Workspace Skill '${skill.id}' so ${MODEL_INVOCATION_METADATA_FIELD} ` +
    `remains authoritative and ${SHARED_SKILL_OPENAI_YAML} is absent or agrees, then retry`;
  const yamlPath = join(skill.path, SHARED_SKILL_OPENAI_YAML);
  return capabilityFailure(
    skill.consumerHost ?? "codex",
    "project",
    problem,
    remedy,
    [{ kind: "path", value: yamlPath }],
    [
      "Skill '",
      identifierPart(skill.id),
      `' has ${kind === "conflict" ? "conflicting" : "invalid"} model-invocation authorities: ${canonical}; ${host}; Repair the canonical Workspace Skill '`,
      identifierPart(skill.id),
      `' so ${MODEL_INVOCATION_METADATA_FIELD} remains authoritative and ${SHARED_SKILL_OPENAI_YAML} is absent or agrees, then retry`,
    ],
  );
}

function parseYamlDocument(
  skill: SharedSkillPolicyInput,
  source: string,
): Document {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    throw policyAuthorityFailure(
      skill,
      `${CODEX_INVOCATION_FIELD} cannot be read because the file is malformed YAML`,
      "invalid",
    );
  }
  if (!isMap(document.contents)) {
    throw policyAuthorityFailure(
      skill,
      `${CODEX_INVOCATION_FIELD} requires the file to be a YAML mapping`,
      "invalid",
    );
  }
  return document;
}

function pairKeyValue(pair: Pair<unknown, unknown>): unknown {
  return isScalar(pair.key) ? pair.key.value : pair.key;
}

function setGeneratedBooleanField(
  document: Document,
  field: string,
  comment: string,
): void {
  if (!isMap(document.contents)) {
    throw new Error("generated YAML document must be a mapping");
  }
  const existing = document.contents.items.find(
    (pair) => pairKeyValue(pair) === field,
  );
  const pair = existing ?? new Pair<unknown, unknown>(field, false);
  if (existing === undefined) document.contents.add(pair);
  pair.key = new Scalar(field);
  pair.value = new Scalar(true);
  if (isScalar(pair.key)) pair.key.commentBefore = ` ${comment}`;
}

function appendGeneratedBooleanField(
  mapping: YAMLMap<unknown, unknown>,
  field: string,
  comment: string,
): void {
  const pair = new Pair(new Scalar(field), new Scalar(false));
  pair.key.commentBefore = ` ${comment}`;
  mapping.add(pair);
}

function emitSharedSkillMarkdown(
  skillId: string,
  source: string,
  modelInvocation: ModelInvocationPolicy,
): string {
  if (modelInvocation === "allowed") return source;
  const delimiter = "---\n";
  if (!source.startsWith(delimiter)) {
    throw new Error(`Skill '${skillId}' SKILL.md must start with YAML frontmatter`);
  }
  const closing = source.indexOf(delimiter, delimiter.length);
  if (closing === -1) {
    throw new Error(`Skill '${skillId}' SKILL.md must close its YAML frontmatter`);
  }
  const document = parseDocument(source.slice(delimiter.length, closing));
  if (document.errors.length > 0 || !isMap(document.contents)) {
    throw new Error(`Skill '${skillId}' SKILL.md frontmatter must be a YAML mapping`);
  }
  const name = document.get("name");
  if (name !== skillId) {
    throw new Error(
      `Skill '${skillId}' SKILL.md name must remain the canonical name '${skillId}'`,
    );
  }
  setGeneratedBooleanField(
    document,
    "disable-model-invocation",
    SKILL_INVOCATION_COMMENT,
  );
  const body = source.slice(closing + delimiter.length);
  return `${delimiter}${document.toString().trimEnd()}\n---\n${body}`;
}

function addCodexPolicy(document: Document): string {
  if (!isMap(document.contents)) {
    throw new Error("Codex Skill policy document must be a YAML mapping");
  }
  const policy = document.get("policy", true);
  if (policy === undefined) {
    const created = new YAMLMap<unknown, unknown>();
    document.set("policy", created);
    appendGeneratedBooleanField(
      created,
      "allow_implicit_invocation",
      CODEX_INVOCATION_COMMENT,
    );
  } else {
    if (!isMap(policy)) {
      throw new Error("Codex Skill policy must be a YAML mapping");
    }
    appendGeneratedBooleanField(
      policy,
      "allow_implicit_invocation",
      CODEX_INVOCATION_COMMENT,
    );
  }
  return `${document.toString().trimEnd()}\n`;
}

function readCodexAllowImplicitInvocation(
  skill: SharedSkillPolicyInput,
  source: string,
): { readonly document: Document; readonly allow: boolean | undefined } {
  const document = parseYamlDocument(skill, source);
  const policy = document.get("policy", true);
  if (policy === undefined) return { allow: undefined, document };
  if (!isMap(policy)) {
    throw policyAuthorityFailure(
      skill,
      `${CODEX_INVOCATION_FIELD} requires its parent policy to be a YAML mapping`,
      "invalid",
    );
  }
  const allow = policy.get("allow_implicit_invocation", true);
  if (allow === undefined) return { allow: undefined, document };
  if (!isScalar(allow) || typeof allow.value !== "boolean") {
    throw policyAuthorityFailure(
      skill,
      `${CODEX_INVOCATION_FIELD} must be a boolean`,
      "invalid",
    );
  }
  return { allow: allow.value, document };
}

/**
 * Normalize one shared Skill package's Codex policy against canonical Workspace
 * metadata. Equivalent policy is retained; contradictory or malformed policy
 * fails before the package can reach output reconciliation.
 */
export function coalesceSharedSkillPolicy(
  skill: SharedSkillPolicyInput,
  existingOpenAiYaml: string | undefined,
): SharedSkillPolicyDecision {
  if (existingOpenAiYaml === undefined) {
    if (skill.modelInvocation === "allowed") return { action: "leave" };
    const document = parseDocument("policy: {}\n");
    return { action: "write", bytes: addCodexPolicy(document) };
  }

  const { allow, document } = readCodexAllowImplicitInvocation(
    skill,
    existingOpenAiYaml,
  );
  if (skill.modelInvocation === "disabled") {
    if (allow === true) {
      throw policyAuthorityFailure(
        skill,
        `${CODEX_INVOCATION_FIELD} is true while the canonical policy is disabled`,
        "conflict",
      );
    }
    if (allow === false) return { action: "leave", bytes: existingOpenAiYaml };
    return { action: "write", bytes: addCodexPolicy(document) };
  }
  if (allow === false) {
    throw policyAuthorityFailure(
      skill,
      `${CODEX_INVOCATION_FIELD} is false while the canonical policy is allowed`,
      "conflict",
    );
  }
  return { action: "leave", bytes: existingOpenAiYaml };
}

/** Project one qualified shared `.agents` Skill package. */
export function projectSharedSkillMembers(
  skill: Skill,
  members: readonly ProposedDirectoryMember[],
  consumerHost: SupportedHost,
): readonly ProposedDirectoryMember[] {
  const policySkill: SharedSkillPolicyInput = {
    ...skill,
    consumerHost,
  };
  const packageMembers = members.filter(
    (member) =>
      member.path !== SKILL_PACKAGE_SIDECAR &&
      !member.path.startsWith(`${SKILL_PACKAGE_SIDECAR}/`),
  );
  const existingOpenAi = packageMembers.find(
    (member): member is ProposedDirectoryFileMember =>
      member.path === SHARED_SKILL_OPENAI_YAML && member.type === "file",
  );
  if (
    packageMembers.some(
      (member) =>
        member.path === SHARED_SKILL_OPENAI_YAML ||
        member.path.startsWith(`${SHARED_SKILL_OPENAI_YAML}/`),
    ) && existingOpenAi === undefined
  ) {
    throw policyAuthorityFailure(
      policySkill,
      `${CODEX_INVOCATION_FIELD} must be backed by a regular file`,
      "invalid",
    );
  }
  const decision = coalesceSharedSkillPolicy(
    policySkill,
    existingOpenAi === undefined
      ? undefined
      : memberBytesAsString(existingOpenAi.bytes),
  );
  const projected = packageMembers.map((member) => {
    if (member.type !== "file" || member.path !== "SKILL.md") return member;
    return skill.modelInvocation === "disabled"
      ? {
          ...member,
          bytes: emitSharedSkillMarkdown(
            skill.id,
            memberBytesAsString(member.bytes),
            skill.modelInvocation,
          ),
        }
      : member;
  });
  if (decision.action === "leave") return projected;

  const withoutOpenAi = projected.filter(
    (member) => member.path !== SHARED_SKILL_OPENAI_YAML,
  );
  const next: ProposedDirectoryMember[] = [...withoutOpenAi];
  if (
    !next.some(
      (member) => member.type === "directory" && member.path === "agents",
    )
  ) {
    next.push({ mode: 0o755, path: "agents", type: "directory" });
  }
  next.push({
    bytes: decision.bytes,
    mode: existingOpenAi?.mode ?? 0o644,
    path: SHARED_SKILL_OPENAI_YAML,
    type: "file",
  });
  return next.sort((left, right) => left.path.localeCompare(right.path));
}

/** Requirements for every qualified consumer of the shared disabled policy. */
export function sharedSkillRequirements(
  skill: Skill,
  base: readonly string[],
): readonly string[] {
  if (skill.modelInvocation !== "disabled") return base;
  return [
    ...base,
    DISABLED_MODEL_INVOCATION_REQUIREMENT,
    "Shared .agents Skill policy prevents implicit invocation in SKILL.md and Codex agents/openai.yaml",
  ];
}

/** Plan one Skill package at the shared `.agents/skills` discovery root. */
export async function planSharedSkillPackageDirectory(
  skill: Skill,
  baseRequirements: readonly string[],
  consumerHost: SupportedHost,
  materials: AdapterPlanningMaterials = DEFAULT_ADAPTER_PLANNING_MATERIALS,
): Promise<ProposedProjectDirectoryOutput> {
  const projection: SkillPackageProjection = {
    projectMembers: (candidate, members) =>
      projectSharedSkillMembers(candidate, members, consumerHost),
    requirements: sharedSkillRequirements,
  };
  return planSkillPackageDirectory(
    skill,
    SHARED_SKILLS_DISCOVERY_ROOT,
    baseRequirements,
    projection,
    materials,
  );
}

/** Shared frontmatter projection for qualified `.agents` consumers. */
export { emitSharedSkillMarkdown };
