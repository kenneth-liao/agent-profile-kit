// Turns a Profile into the desired installed state: Skill files at each agent's
// native discovery path, plus one combined Context block for AGENTS.md.
import { join, relative, sep } from "node:path";
import { parseDocument } from "yaml";
import type { Workspace } from "./workspace.js";

/** Where each supported agent discovers project Skills. Everything else is native. */
export const AGENTS = {
  antigravity: { name: "Antigravity", skillsRoot: ".agents/skills" },
  claude: { name: "Claude Code", skillsRoot: ".claude/skills" },
  codex: { name: "Codex", skillsRoot: ".agents/skills" },
  grok: { name: "Grok", skillsRoot: ".grok/skills" },
  opencode: { name: "OpenCode", skillsRoot: ".agents/skills" },
  pi: { name: "Pi", skillsRoot: ".agents/skills" },
} as const;

export type AgentId = keyof typeof AGENTS;

export function isAgentId(value: string): value is AgentId {
  return Object.hasOwn(AGENTS, value);
}

export interface DesiredFile {
  readonly bytes: Uint8Array;
  readonly executable: boolean;
}

export interface Desired {
  readonly profile: string;
  readonly agents: readonly AgentId[];
  /** POSIX paths relative to the target folder. */
  readonly files: ReadonlyMap<string, DesiredFile>;
  /** Body of the AGENTS.md block, or null when the Profile selects no Context. */
  readonly context: string | null;
  /** "user" for a Skills install into the home folder's user-level Skills folders. */
  readonly scope?: "user";
}

/** Codex reads this file to stop implicit invocation (`disable-model-invocation`). */
const CODEX_POLICY_PATH = "agents/openai.yaml";

/** Each agent's Skills folder, as a POSIX path relative to the install target. */
export type SkillRoots = Readonly<Record<AgentId, string>>;

export const PROJECT_ROOTS: SkillRoots = Object.fromEntries(
  Object.entries(AGENTS).map(([id, agent]) => [id, agent.skillsRoot]),
) as Record<AgentId, string>;

/**
 * User-level Skills folders, relative to the home folder. Verified 2026-10-30
 * against each agent (see the prototype's README).
 */
export function userRoots(home: string, env: Readonly<Record<string, string | undefined>>): SkillRoots {
  const rel = (path: string) => relative(home, path).split(sep).join("/");
  return {
    antigravity: ".gemini/config/skills",
    claude: `${rel(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"))}/skills`,
    codex: ".agents/skills",
    grok: `${rel(env.GROK_HOME ?? join(home, ".grok"))}/skills`,
    opencode: ".agents/skills",
    pi: ".agents/skills",
  };
}

export function render(
  workspace: Workspace,
  profileId: string,
  agents: readonly AgentId[],
  skillRoots: SkillRoots = PROJECT_ROOTS,
): Desired {
  const profile = workspace.profiles.get(profileId);
  if (profile === undefined) throw new Error(`No Profile named '${profileId}' in the Workspace.`);
  const sorted = [...new Set(agents)].sort();
  const roots = [...new Set(sorted.map((agent) => skillRoots[agent]))];

  const files = new Map<string, DesiredFile>();
  for (const name of profile.skills) {
    const skill = workspace.skills.get(name);
    if (skill === undefined) throw new Error(`Profile '${profileId}' names Skill '${name}', which does not exist.`);
    for (const root of roots) {
      for (const file of skill.files) {
        files.set(`${root}/${name}/${file.path}`, { bytes: file.bytes, executable: file.executable });
      }
      if (skill.disableModelInvocation && root === skillRoots.codex) {
        const existing = skill.files.find((file) => file.path === CODEX_POLICY_PATH);
        files.set(`${root}/${name}/${CODEX_POLICY_PATH}`, {
          bytes: new TextEncoder().encode(codexPolicy(existing?.bytes)),
          executable: false,
        });
      }
    }
  }

  let context: string | null = null;
  if (profile.context.length > 0) {
    const sections = profile.context.map((id) => {
      const module = workspace.context.get(id);
      if (module === undefined) throw new Error(`Profile '${profileId}' names Context '${id}', which does not exist.`);
      return `<!-- context: ${id} -->\n${module.text.replace(/\r\n/g, "\n").trimEnd()}\n`;
    });
    // Plain text, not a comment: some agents drop HTML comments before the model sees them.
    context =
      `<!-- Installed by apkit from the '${profileId}' Profile. Edit your Workspace and run \`apkit update\`; edits here are replaced. -->\n` +
      `Profile Context (${profileId}). This project's own instructions take precedence when they conflict with it.\n\n` +
      sections.join("\n");
  }
  return { profile: profileId, agents: sorted, files, context };
}

function codexPolicy(existing: Uint8Array | undefined): string {
  if (existing === undefined) return "policy:\n  allow_implicit_invocation: false\n";
  const document = parseDocument(new TextDecoder().decode(existing));
  document.setIn(["policy", "allow_implicit_invocation"], false);
  return document.toString();
}
