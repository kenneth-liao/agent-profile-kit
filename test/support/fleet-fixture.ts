import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Shared isolated 12-Project fleet fixture for fleet-wide synchronization
 * qualification (issue #205). The packed CLI journey, the operation-budget
 * instrumentation tests, and the warm-run benchmark all consume the same
 * fixture so the qualification evidence describes one representative workload:
 * one shared Profile with a Context Module and a Skill across twelve Projects
 * with mixed Host sets, alternating Git and plain roots.
 */

/** Mixed Host sets for the 12-Project fleet: single and multi-Host. */
export const FLEET_HOSTS: readonly (readonly string[])[] = [
  ["codex"], ["codex"], ["codex"],
  ["codex", "claude"], ["codex", "claude"], ["codex", "claude"],
  ["codex", "pi"], ["codex", "pi"], ["codex", "pi"],
  ["codex", "claude", "grok", "pi"],
  ["codex", "claude", "grok", "pi"],
  ["codex", "claude", "grok", "pi"],
];

/** The shared Skill Artifact ID carried by every Project of the fleet. */
export const FLEET_SKILL = "review-pr";

/** The shared Profile Artifact ID bound across the fleet. */
export const FLEET_PROFILE = "engineering";

export function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

export function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

/** Rewrite the shared Skill's canonical content (used to model the re-sync change). */
export function writeSkill(home: string, id: string, body = `# ${id}\n`): void {
  const skillRoot = join(workspacePath(home), "skills", id);
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${id}\ndescription: Skill ${id}.\n---\n\n${body}`,
  );
}

/** Rewrite the full Project Binding set (used to model a Host addition). */
export function writeBindings(
  home: string,
  bindings: readonly {
    readonly project: string;
    readonly hosts: readonly string[];
    readonly profile?: string;
  }[],
): void {
  const body = bindings
    .map(
      (binding) =>
        `  - project: ${binding.project}\n    profile: ${binding.profile ?? FLEET_PROFILE}\n    hosts:\n${binding.hosts
          .map((host) => `      - ${host}\n`)
          .join("")}`,
    )
    .join("");
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n${body}`,
  );
}

const temporaryDirectories: string[] = [];

function createTempDirectory(prefix: string): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryDirectories.push(path);
  return path;
}

/** Remove every temporary directory created through this module. */
export function cleanupFleetFixtures(): void {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
}

function plainProject(): string {
  return createTempDirectory("agent-profile-kit-fleet-plain-");
}

function gitRepository(): string {
  const path = createTempDirectory("agent-profile-kit-fleet-git-");
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
  return path;
}

export interface FleetFixture {
  readonly home: string;
  /** Canonical project roots, one per configured fleet entry. */
  readonly projects: readonly string[];
  /** Path value that prepends controlled Host CLI stubs. */
  readonly pathWithHosts: string;
}

export interface FleetFixtureOptions {
  readonly dependencyRich?: boolean;
  readonly projectCount?: number;
}

/**
 * Build one isolated Workspace, Local Configuration, and fleet inside `home`.
 * Projects alternate Git and plain roots; Host sets repeat {@link FLEET_HOSTS}.
 * Controlled Host CLI stubs are installed under the HOME.
 */
export function createFleetFixture(
  home: string,
  options: FleetFixtureOptions = {},
): FleetFixture {
  mkdirSync(workspacePath(home), { recursive: true });
  for (const category of ["agents", "context", "hooks", "profiles", "skills", "tools"]) {
    mkdirSync(join(workspacePath(home), category), { recursive: true });
  }
  writeFileSync(join(workspacePath(home), "workspace.yaml"), "schema_version: 1\n");
  writeFileSync(
    join(home, ".agents", "agent-profile-kit", "config.yaml"),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings: []\n`,
  );
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
  writeFileSync(
    join(workspacePath(home), "context", "team-rules.md"),
    "---\nid: team-rules\ndependencies: []\n---\nAlways preserve the project boundary.\n",
  );
  writeSkill(home, FLEET_SKILL);
  if (options.dependencyRich) {
    const branches = Array.from({ length: 12 }, (_, index) => `branch-${index + 1}`);
    writeSkill(home, "shared-base");
    for (const id of branches) {
      writeSkill(home, id);
      writeFileSync(
        join(workspacePath(home), "skills", id, "agent-profile-kit.yaml"),
        "dependencies:\n  - type: skill\n    id: shared-base\n",
      );
    }
    writeFileSync(
      join(workspacePath(home), "skills", FLEET_SKILL, "agent-profile-kit.yaml"),
      `dependencies:\n${branches.map((id) => `  - type: skill\n    id: ${id}\n`).join("")}`,
    );
  }
  writeFileSync(
    join(workspacePath(home), "profiles", `${FLEET_PROFILE}.yaml`),
    `id: ${FLEET_PROFILE}\ncontext: [team-rules]\nskills: [${FLEET_SKILL}]\n`,
  );
  const projectCount = options.projectCount ?? FLEET_HOSTS.length;
  const projects = Array.from({ length: projectCount }, (_, index) =>
    index % 2 === 0 ? gitRepository() : plainProject(),
  );
  const body = projects
    .map(
      (project, index) =>
        `  - project: ${project}\n    profile: ${FLEET_PROFILE}\n    hosts:\n${FLEET_HOSTS[index % FLEET_HOSTS.length]!
          .map((host) => `      - ${host}\n`)
          .join("")}`,
    )
    .join("");
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n${body}`,
  );
  return { home, pathWithHosts: installControlledHosts(home), projects };
}

/** Prepend controlled Host CLI stubs on PATH so lifecycle runs are hermetic. */
export function installControlledHosts(home: string): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "2.1.0 (Claude Code)"\n`);
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh\nif [ -n "\${APKIT_TEST_CODEX_DELAY:-}" ]; then sleep "$APKIT_TEST_CODEX_DELAY"; fi\necho "codex-cli 0.145.0"\n`,
  );
  writeFileSync(
    join(bin, "grok"),
    `#!/bin/sh\nif [ "$1" = "version" ]; then\n  echo "grok 0.2.111 (fake) [stable]"\n  exit 0\nfi\nif [ "$1" = "inspect" ] && [ "$2" = "--json" ]; then\n  cat <<'EOF'\n{"externalCompat":{"cells":[{"enabled":true,"source":"default","surface":"rules","vendor":"claude"}],"remoteSettingsLoaded":false},"groKVersion":"0.2.111","projectInstructions":[],"skills":[]}\nEOF\n  exit 0\nfi\necho "unexpected grok invocation: $*" >&2\nexit 2\n`,
  );
  writeFileSync(join(bin, "pi"), `#!/bin/sh\necho "pi 0.82.1"\n`);
  for (const name of ["claude", "codex", "grok", "pi"]) {
    execFileSync("chmod", ["+x", join(bin, name)]);
  }
  return `${bin}:${process.env.PATH ?? ""}`;
}
