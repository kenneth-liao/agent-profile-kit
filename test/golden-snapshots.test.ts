import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COMMANDS } from "../cli/command-help.js";
import { AUTHORING_EXAMPLES } from "../installer/authoring-examples.js";
import { MAX_HUMAN_WIDTH, MIN_HUMAN_WIDTH } from "../cli/terminal-presentation.js";
import { humanGuide, agentGuide } from "../cli/guides.js";
import { readSnapshotBodies } from "./support/snapshot-file.js";
import { UPDATE_SNAPSHOTS_ENV } from "./support/suite-supervisor.js";
import {
  checkAtomicRendering,
  collectSpellings,
} from "./support/rendered-atomicity.js";
import { obtainPackageArchive } from "./support/package-archive.js";
import {
  TEST_CHILD_DEADLINE_MS,
  expectExitCode,
  runProcess,
  type ProcessResult,
} from "./support/process-executor.js";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const temporaryDirectories: string[] = [];
let packageArchiveCleanup = (): void => undefined;
let cliPath = join(repositoryRoot, "dist", "cli.js");
let authoredVerbatimLines: readonly string[] = [];
let snapshotBodies: Map<string, string>;

const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const STABLE_UUID = "00000000-0000-4000-8000-000000000000";
const COLOR_TERMINAL_ENVIRONMENT: NodeJS.ProcessEnv = {
  NO_COLOR: undefined,
  TERM: "xterm-256color",
};

beforeAll(async () => {
  const archive = obtainPackageArchive(repositoryRoot, "agent-profile-kit-golden-pack-");
  packageArchiveCleanup = archive.cleanup;
  const extracted = mkdtempSync(join(tmpdir(), "agent-profile-kit-golden-packed-"));
  temporaryDirectories.push(extracted);
  execFileSync("tar", ["-xzf", archive.path, "-C", extracted]);
  cliPath = join(extracted, "package", "dist", "cli.js");
  // Verbatim regions are matched line-consecutively, so blank lines stay in
  // the corpus; authored example and guide bodies are reproduced verbatim.
  authoredVerbatimLines = [
    ...Object.values(AUTHORING_EXAMPLES).flatMap((example) => example.contents.split("\n")),
    ...(await humanGuide()).split("\n"),
    ...(await agentGuide()).split("\n"),
  ];
  snapshotBodies = readSnapshotBodies(
    resolve(repositoryRoot, "test/__snapshots__/golden-snapshots.test.ts.snap"),
  );
});

afterAll(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  packageArchiveCleanup();
});

function isolatedHome(): string {
  const home = mkdtempSync("/tmp/apkit-gldn-");
  temporaryDirectories.push(home);
  return realpathSync(home);
}

function sameLengthPlaceholder(path: string): string {
  const prefix = "/private/tmp/apkit-golden-";
  if (path.length <= prefix.length) return "H".repeat(path.length);
  return `${prefix}${"x".repeat(path.length - prefix.length)}`;
}

function stabilize(text: string, home: string): string {
  const replacements = [...new Set([home, realpathSync(home)])].sort(
    (left, right) => right.length - left.length,
  );
  let next = text;
  for (const path of replacements) {
    next = next.split(path).join(sameLengthPlaceholder(path));
  }
  return next.replace(UUID_PATTERN, STABLE_UUID);
}

function snapshotBody(result: ProcessResult, home: string): string {
  return stabilize(`--- stdout ---\n${result.stdout}--- stderr ---\n${result.stderr}`, home);
}

/**
 * The atomicity corpus: authored verbatim lines only. Expected spellings come
 * from each capture's own committed golden baseline, never a global corpus.
 */
function goldenCorpus(): { verbatimLines: readonly string[] } {
  return { verbatimLines: authoredVerbatimLines };
}

/** The committed baseline body for one capture's snapshot key, when one exists. */
function committedBaseline(baselineKey: string): string | undefined {
  const body = snapshotBodies.get(baselineKey);
  if (body !== undefined) return body;
  if (process.env[UPDATE_SNAPSHOTS_ENV] !== "1") {
    throw new Error(
      `No committed golden baseline for ${JSON.stringify(baselineKey)}; the atomicity` +
        " gate requires one. Create and review it through the explicit local" +
        " snapshot-update workflow (`bun run test:focused -- --update-snapshots" +
        " test/golden-snapshots.test.ts` locally; CI never enables snapshot" +
        " updating).",
    );
  }
  return undefined;
}

/** One half of a committed baseline body: the named stream's captured text. */
function baselineStream(baselineBody: string, stream: "stdout" | "stderr"): string {
  const stdoutMarker = "--- stdout ---\n";
  const stderrMarker = "--- stderr ---\n";
  const stderrStart = baselineBody.indexOf(stderrMarker);
  if (stderrStart < 0) {
    throw new Error("Committed baseline is missing its stderr section");
  }
  const stdoutStart = baselineBody.indexOf(stdoutMarker);
  if (stdoutStart < 0) {
    throw new Error("Committed baseline is missing its stdout section");
  }
  const stdout = baselineBody.slice(stdoutStart + stdoutMarker.length, stderrStart);
  const stderr = baselineBody.slice(stderrStart + stderrMarker.length);
  return stream === "stdout" ? stdout : stderr;
}

function expectGolden(
  name: string,
  baselineKey: string,
  result: ProcessResult,
  home: string,
): void {
  const baselineBody = committedBaseline(baselineKey);
  if (baselineBody !== undefined) {
    const corpus = goldenCorpus();
    checkAtomicRendering(stabilize(result.stdout, home), baselineStream(baselineBody, "stdout"), corpus);
    checkAtomicRendering(stabilize(result.stderr, home), baselineStream(baselineBody, "stderr"), corpus);
  }
  expect(snapshotBody(result, home)).toMatchSnapshot(name);
}

function installFakeCodex(home: string, version = "0.145.0"): string {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "codex"),
    `#!/bin/sh
echo "codex-cli ${version}"
`,
  );
  chmodSync(join(bin, "codex"), 0o755);
  return bin;
}

function defaultPath(home: string): string {
  return `${installFakeCodex(home)}:${process.env.PATH ?? ""}`;
}

function redirectedEnvironment(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    PATH: defaultPath(home),
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

async function runCli(
  home: string,
  args: readonly string[],
  cwd?: string,
): Promise<ProcessResult> {
  return runProcess({
    executable: process.env.NODE_BINARY ?? "node",
    arguments_: [cliPath, ...args],
    ...(cwd === undefined ? {} : { cwd }),
    environment: redirectedEnvironment(home),
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI golden",
  });
}

function stripPtyControlArtifacts(text: string): string {
  return text.replace(/^\^D/, "").replace(/[\u0004\u0008]/g, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runCliInPty(
  home: string,
  columns: number,
  environment: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<ProcessResult> {
  const command = [
    `stty cols ${columns};`,
    "exec",
    ...[process.env.NODE_BINARY ?? "node", cliPath, ...args].map(shellQuote),
  ].join(" ");
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...environment,
    COLUMNS: String(columns),
    HOME: home,
    PATH: defaultPath(home),
  };
  if (
    Object.prototype.hasOwnProperty.call(environment, "NO_COLOR") &&
    environment.NO_COLOR === undefined
  ) {
    delete childEnvironment.NO_COLOR;
  }
  const result = await runProcess({
    executable: "script",
    arguments_: ["-q", "/dev/null", "sh", "-c", command],
    environment: childEnvironment,
    deadlineMs: TEST_CHILD_DEADLINE_MS,
    commandLabel: "packed CLI golden PTY",
  });
  return {
    ...result,
    stdout: stripPtyControlArtifacts(result.stdout).replace(/\r/g, ""),
    stderr: stripPtyControlArtifacts(result.stderr).replace(/\r/g, ""),
  };
}

function workspacePath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "workspace");
}

function configPath(home: string): string {
  return join(home, ".agents", "agent-profile-kit", "config.yaml");
}

function demoProject(home: string, name = "demo"): string {
  const path = join(home, "projects", name);
  mkdirSync(path, { recursive: true });
  return path;
}

function gitProject(home: string, name: string): string {
  const path = demoProject(home, name);
  execFileSync("git", ["init", "-q", path]);
  execFileSync("git", ["-C", path, "config", "user.email", "tests@example.com"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Agent Profile Kit Tests"]);
  writeFileSync(join(path, "README.md"), "fixture\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-qm", "fixture"]);
  return path;
}

async function initialize(home: string): Promise<void> {
  expectExitCode(await runCli(home, ["init"]), 0);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "[features]\nhooks = true\n");
}

async function bindExample(home: string, projectPath: string): Promise<void> {
  expectExitCode(
    await runCli(home, ["bind", AUTHORING_EXAMPLES.profile.id, projectPath, "--host", "codex"]),
    0,
  );
}

async function initializedHome(): Promise<{ home: string; project: string }> {
  const home = isolatedHome();
  await initialize(home);
  const project = demoProject(home);
  return { home, project };
}

async function pendingHome(): Promise<{ home: string; project: string }> {
  const prepared = await initializedHome();
  await bindExample(prepared.home, prepared.project);
  return prepared;
}

async function currentHome(): Promise<{ home: string; project: string }> {
  const prepared = await pendingHome();
  expectExitCode(await runCli(prepared.home, ["apply", prepared.project]), 0);
  return prepared;
}

async function blockedHome(): Promise<{ home: string; project: string }> {
  const home = isolatedHome();
  await initialize(home);
  const project = gitProject(home, "blocked");
  mkdirSync(join(project, ".codex"));
  writeFileSync(join(project, ".codex", "hooks.json"), "tracked placeholder\n");
  execFileSync("git", ["-C", project, "add", ".codex/hooks.json"]);
  execFileSync("git", ["-C", project, "commit", "-qm", "track generated path"]);
  writeFileSync(
    configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${project}\n    profile: ${AUTHORING_EXAMPLES.profile.id}\n    hosts: [codex]\n`,
  );
  return { home, project };
}

/** Real selected Skill roots tracked by Git, observed through the packed CLI.
 * No report injection or direct presentation call is used by these fixtures. */
async function trackedSkillsHome(paths: readonly string[]): Promise<{ home: string; project: string }> {
  const home = isolatedHome();
  await initialize(home);
  const project = gitProject(home, "tracked-counts");
  const skills = [...new Set(paths.map((path) => path.split("/").at(-1)!))];
  const hosts = [...new Set(paths.map((path) =>
    path.startsWith(".agents/") ? "codex" : path.startsWith(".claude/") ? "claude" : "grok"))];
  for (const [binary, version] of [["claude", "2.1.78 (Claude Code)"], ["grok", "grok 0.2.0"]]) {
    const executable = join(home, "bin", binary!);
    writeFileSync(executable, `#!/bin/sh\necho '${version}'\n`);
    chmodSync(executable, 0o755);
  }
  for (const skill of skills) {
    const directory = join(workspacePath(home), "skills", skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), `---\nname: ${skill}\ndescription: Count fixture.\n---\nFixture content.\n`);
  }
  writeFileSync(join(workspacePath(home), "profiles", "counts.yaml"),
    `id: counts\ncontext: []\nskills: ${JSON.stringify(skills)}\n`);
  for (const path of paths) {
    mkdirSync(join(project, path), { recursive: true });
    writeFileSync(join(project, path, "SKILL.md"), "tracked fixture content\n");
  }
  execFileSync("git", ["-C", project, "add", "--", ...paths]);
  writeFileSync(configPath(home),
    `schema_version: 2\nworkspace: ${workspacePath(home)}\nbindings:\n  - project: ${project}\n    profile: counts\n    hosts: ${JSON.stringify(hosts)}\n`);
  return { home, project };
}

const trackedSkills = (root: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${root}/s${String(index + 1).padStart(3, "0")}`);

// Current Adapters plan flat Skill IDs below fixed Host roots. They cannot
// produce the synthetic root-level or ancestor/descendant roots in the semantic
// suite. The two sibling-directory cases are the approved observable equivalents;
// exact root/overlap identity and cardinality checks stay in presentation.test.ts.
const TRACKED_COUNT_CASES = [
  { name: "grouped-twelve", paths: [...trackedSkills(".agents/skills", 12), ".claude/skills/single", ".grok/skills/single"] },
  { name: "eleven-no-cap", paths: trackedSkills(".agents/skills", 11) },
  { name: "root-immediate-parent-equivalent", paths: [...trackedSkills(".agents/skills", 2), ...trackedSkills(".claude/skills", 2), ...trackedSkills(".grok/skills", 2)] },
  { name: "overlapping-parent-equivalent", paths: [...trackedSkills(".agents/skills", 2), ".claude/skills/single"] },
  { name: "deterministic-order", paths: [".grok/skills/zeta", ".claude/skills/beta", ".agents/skills/alpha"] },
  { name: "large-60-60-30", paths: [...trackedSkills(".agents/skills", 60), ...trackedSkills(".claude/skills", 60), ...trackedSkills(".grok/skills", 30)] },
] as const;

function publicCommandId(command: (typeof COMMANDS)[number]): string {
  return command.namespace === undefined ? command.name : `${command.namespace} ${command.name}`;
}

const EXTRA_ROUTES = [
  "root-help",
  "machine-help",
  "focused-command-help",
  "unknown-command",
  "unknown-machine-command",
  "unbound-directory-error",
] as const;

interface HumanView {
  readonly test: string;
  readonly snapshot: string;
  readonly commandId?: string;
  readonly extraRoute?: (typeof EXTRA_ROUTES)[number];
  readonly prepare: () => Promise<{ home: string; args: readonly string[] }>;
}

const HUMAN_VIEWS: readonly HumanView[] = [
  {
    test: "root help",
    snapshot: "root-help",
    extraRoute: "root-help",
    prepare: async () => ({ home: isolatedHome(), args: ["--help"] }),
  },
  {
    test: "machine help",
    snapshot: "machine-help",
    extraRoute: "machine-help",
    prepare: async () => ({ home: isolatedHome(), args: ["machine", "--help"] }),
  },
  {
    test: "focused command help",
    snapshot: "focused-command-help",
    extraRoute: "focused-command-help",
    prepare: async () => ({ home: isolatedHome(), args: ["status", "--help"] }),
  },
  {
    test: "unknown command",
    snapshot: "unknown-command",
    extraRoute: "unknown-command",
    prepare: async () => ({ home: isolatedHome(), args: ["nosuch"] }),
  },
  {
    test: "unknown machine command",
    snapshot: "unknown-machine-command",
    extraRoute: "unknown-machine-command",
    prepare: async () => ({ home: isolatedHome(), args: ["machine", "nosuch"] }),
  },
  {
    test: "guide index",
    snapshot: "guide-index",
    commandId: "guide",
    prepare: async () => ({ home: isolatedHome(), args: ["guide"] }),
  },
  {
    test: "focused guide",
    snapshot: "focused-guide",
    commandId: "guide",
    prepare: async () => ({ home: isolatedHome(), args: ["guide", "profile"] }),
  },
  {
    test: "focused guide context",
    snapshot: "focused-guide-context",
    commandId: "guide",
    prepare: async () => ({ home: isolatedHome(), args: ["guide", "context"] }),
  },
  {
    test: "focused guide skill",
    snapshot: "focused-guide-skill",
    commandId: "guide",
    prepare: async () => ({ home: isolatedHome(), args: ["guide", "skill"] }),
  },
  {
    test: "full guide",
    snapshot: "full-guide",
    commandId: "guide",
    prepare: async () => ({ home: isolatedHome(), args: ["guide", "--full"] }),
  },
  {
    test: "agent guide",
    snapshot: "agent-guide",
    commandId: "guide",
    prepare: async () => ({ home: isolatedHome(), args: ["guide", "--agent"] }),
  },
  {
    test: "info",
    snapshot: "info",
    commandId: "info",
    prepare: async () => {
      const { home } = await initializedHome();
      return { home, args: ["info"] };
    },
  },
  {
    test: "list index",
    snapshot: "list-index",
    commandId: "list",
    prepare: async () => {
      const { home } = await initializedHome();
      return { home, args: ["list"] };
    },
  },
  {
    test: "list projects",
    snapshot: "list-projects",
    commandId: "list",
    prepare: async () => {
      const { home } = await pendingHome();
      await bindExample(home, demoProject(home, "other"));
      return { home, args: ["list", "projects"] };
    },
  },
  {
    test: "list profiles",
    snapshot: "list-profiles",
    commandId: "list",
    prepare: async () => {
      const { home } = await initializedHome();
      return { home, args: ["list", "profiles"] };
    },
  },
  {
    test: "list hosts",
    snapshot: "list-hosts",
    commandId: "list",
    prepare: async () => {
      const { home } = await initializedHome();
      return { home, args: ["list", "hosts"] };
    },
  },
  {
    test: "machine list index",
    snapshot: "machine-list-index",
    commandId: "machine list",
    prepare: async () => {
      const { home } = await initializedHome();
      return { home, args: ["machine", "list"] };
    },
  },
  {
    test: "machine list temporary",
    snapshot: "machine-list-temporary",
    commandId: "machine list",
    prepare: async () => {
      const { home } = await initializedHome();
      return { home, args: ["machine", "list", "temporary"] };
    },
  },
  {
    test: "init",
    snapshot: "init",
    commandId: "init",
    prepare: async () => ({ home: isolatedHome(), args: ["init"] }),
  },
  {
    test: "bind success",
    snapshot: "bind-success",
    commandId: "bind",
    prepare: async () => {
      const { home, project } = await initializedHome();
      return {
        home,
        args: ["bind", AUTHORING_EXAMPLES.profile.id, project, "--host", "codex"],
      };
    },
  },
  {
    test: "validate",
    snapshot: "validate",
    commandId: "validate",
    prepare: async () => {
      const { home } = await pendingHome();
      return { home, args: ["validate"] };
    },
  },
  {
    test: "status current",
    snapshot: "status-current",
    commandId: "status",
    prepare: async () => {
      const { home, project } = await currentHome();
      return { home, args: ["status", project] };
    },
  },
  {
    test: "status pending",
    snapshot: "status-pending",
    commandId: "status",
    prepare: async () => {
      const { home, project } = await pendingHome();
      return { home, args: ["status", project] };
    },
  },
  {
    test: "status blocked",
    snapshot: "status-blocked",
    commandId: "status",
    prepare: async () => {
      const { home, project } = await blockedHome();
      return { home, args: ["status", project] };
    },
  },
  ...TRACKED_COUNT_CASES.map(({ name, paths }): HumanView => ({
    test: `status tracked counts ${name}`,
    snapshot: `status-tracked-counts-${name}`,
    commandId: "status",
    prepare: async () => {
      const { home, project } = await trackedSkillsHome(paths);
      return { home, args: ["status", project, "--blockers-only"] };
    },
  })),
  {
    test: "status verbose",
    snapshot: "status-verbose",
    commandId: "status",
    prepare: async () => {
      const { home, project } = await currentHome();
      return { home, args: ["status", project, "--verbose"] };
    },
  },
  {
    test: "status blockers-only",
    snapshot: "status-blockers-only",
    commandId: "status",
    prepare: async () => {
      const { home, project } = await blockedHome();
      return { home, args: ["status", project, "--blockers-only"] };
    },
  },
  {
    test: "apply receipt",
    snapshot: "apply-receipt",
    commandId: "apply",
    prepare: async () => {
      const { home, project } = await pendingHome();
      return { home, args: ["apply", project] };
    },
  },
  {
    test: "apply no-op",
    snapshot: "apply-noop",
    commandId: "apply",
    prepare: async () => {
      const { home, project } = await currentHome();
      return { home, args: ["apply", project] };
    },
  },
  {
    test: "apply blocked",
    snapshot: "apply-blocked",
    commandId: "apply",
    prepare: async () => {
      const { home, project } = await blockedHome();
      return { home, args: ["apply", project] };
    },
  },
  {
    test: "unbind",
    snapshot: "unbind",
    commandId: "unbind",
    prepare: async () => {
      const { home, project } = await pendingHome();
      return { home, args: ["unbind", project] };
    },
  },
  {
    test: "uninstall",
    snapshot: "uninstall",
    commandId: "uninstall",
    prepare: async () => {
      const { home } = await currentHome();
      return { home, args: ["uninstall"] };
    },
  },
  {
    test: "install-temp",
    snapshot: "install-temp",
    commandId: "machine install-temp",
    prepare: async () => {
      const { home } = await initializedHome();
      const project = gitProject(home, "temporary");
      return {
        home,
        args: [
          "machine",
          "install-temp",
          AUTHORING_EXAMPLES.profile.id,
          project,
          "--host",
          "codex",
        ],
      };
    },
  },
  {
    test: "remove-temp",
    snapshot: "remove-temp",
    commandId: "machine remove-temp",
    prepare: async () => {
      const { home } = await initializedHome();
      const project = gitProject(home, "temporary-remove");
      const installed = await runCli(home, [
        "machine",
        "install-temp",
        AUTHORING_EXAMPLES.profile.id,
        project,
        "--host",
        "codex",
      ]);
      expectExitCode(installed, 0);
      const identity = installed.stdout.match(/^  Temporary installation: (\S+)$/m)?.[1];
      expect(identity).toBeTruthy();
      return { home, args: ["machine", "remove-temp", identity!] };
    },
  },
  {
    test: "blocked temp",
    snapshot: "blocked-temp",
    commandId: "machine install-temp",
    prepare: async () => {
      const { home } = await initializedHome();
      const project = gitProject(home, "temporary-blocked");
      mkdirSync(join(project, ".codex"));
      writeFileSync(join(project, ".codex", "hooks.json"), "tracked placeholder\n");
      execFileSync("git", ["-C", project, "add", ".codex/hooks.json"]);
      execFileSync("git", ["-C", project, "commit", "-qm", "track generated path"]);
      return {
        home,
        args: [
          "machine",
          "install-temp",
          AUTHORING_EXAMPLES.profile.id,
          project,
          "--host",
          "codex",
        ],
      };
    },
  },
  {
    test: "unbound-directory error",
    snapshot: "unbound-directory-error",
    extraRoute: "unbound-directory-error",
    prepare: async () => {
      const { home } = await initializedHome();
      const unbound = demoProject(home, "unbound");
      return { home, args: ["status", unbound] };
    },
  },
];

test("records the bounded-diff review rule alongside the snapshots", () => {
  const rule = readFileSync(resolve(repositoryRoot, "test/__snapshots__/README.md"), "utf8");
  expect(rule).toMatch(/wrapping/i);
  expect(rule).toMatch(/elid/i);
  expect(rule).toMatch(/alignment/i);
  expect(rule).toMatch(/colour|color/i);
  expect(rule).toMatch(/content change/i);
});

describe("golden snapshots of every human view", () => {
  test("the catalog covers every public command and extra diagnostic route", () => {
    expect(
      HUMAN_VIEWS.every((view) => view.commandId !== undefined || view.extraRoute !== undefined),
    ).toBe(true);
    expect(
      [...new Set(HUMAN_VIEWS.flatMap((view) => view.commandId === undefined ? [] : [view.commandId]))].sort(),
    ).toEqual([...new Set(COMMANDS.map(publicCommandId))].sort());
    expect(
      [...new Set(HUMAN_VIEWS.flatMap((view) => view.extraRoute === undefined ? [] : [view.extraRoute]))].sort(),
    ).toEqual([...EXTRA_ROUTES].sort());
  });

  for (const view of HUMAN_VIEWS) {
    test(view.test, async () => {
      const { home, args } = await view.prepare();
      expectGolden(
        view.snapshot,
        `golden snapshots of every human view ${view.test}: ${view.snapshot} 1`,
        await runCli(home, args),
        home,
      );
    });
  }
});

describe("rendering matrix for a representative subset", () => {
  const cells = [
    { name: "interactive-narrow-nocolor", columns: MIN_HUMAN_WIDTH, environment: { NO_COLOR: "1" } },
    {
      name: "interactive-narrow-color",
      columns: MIN_HUMAN_WIDTH,
      environment: COLOR_TERMINAL_ENVIRONMENT,
    },
    { name: "interactive-wide-nocolor", columns: MAX_HUMAN_WIDTH, environment: { NO_COLOR: "1" } },
    {
      name: "interactive-wide-color",
      columns: MAX_HUMAN_WIDTH,
      environment: COLOR_TERMINAL_ENVIRONMENT,
    },
  ] as const;

  async function matrixSnapshot(
    matrixTest: string,
    view: string,
    home: string,
    args: readonly string[],
  ): Promise<void> {
    for (const cell of cells) {
      expectGolden(
        `${view}-${cell.name}`,
        `rendering matrix for a representative subset ${matrixTest}: ${view}-${cell.name} 1`,
        await runCliInPty(home, cell.columns, cell.environment, args),
        home,
      );
    }
  }

  test("root help matrix", async () => {
    const home = isolatedHome();
    await matrixSnapshot("root help matrix", "root-help", home, ["--help"]);
  });

  test("info matrix", async () => {
    const { home } = await initializedHome();
    await matrixSnapshot("info matrix", "info", home, ["info"]);
  });

  test("list projects matrix", async () => {
    const { home } = await pendingHome();
    await bindExample(home, demoProject(home, "other"));
    await matrixSnapshot("list projects matrix", "list-projects", home, ["list", "projects"]);
  });

  test("blocked status matrix", async () => {
    const { home, project } = await blockedHome();
    await matrixSnapshot("blocked status matrix", "status-blocked", home, ["status", project]);
  });

  test("status verbose matrix", async () => {
    const { home, project } = await currentHome();
    await matrixSnapshot("status verbose matrix", "status-verbose", home, ["status", project, "--verbose"]);
  });

  test("unbound error matrix", async () => {
    const { home } = await initializedHome();
    const unbound = demoProject(home, "unbound");
    await matrixSnapshot("unbound error matrix", "unbound-directory-error", home, ["status", unbound]);
  });
});

describe("rendered atomicity mutation evidence from real captures", () => {
  test("a pristine capture passes and its recognized spellings reject mutations", async () => {
    const { home, project } = await pendingHome();
    const args = ["status", project];
    const pristine = await runCli(home, args);
    const corpus = goldenCorpus();
    // The pristine capture is its own baseline: the oracle accepts it verbatim.
    const stabilized = stabilize(pristine.stdout, home);
    checkAtomicRendering(stabilized, stabilized, corpus);

    const spellings = new Set(collectSpellings(stabilized, corpus));
    const nextLine = stabilized.split("\n").find((line) => line.startsWith("Next: apkit apply "));
    expect(nextLine).toBeDefined();
    const command = nextLine!.slice("Next: ".length).trim();
    expect(spellings).toContain(command);
    const detailsLine = stabilized.split("\n").find((line) => line.startsWith("Details: apkit status "));
    expect(detailsLine).toBeDefined();

    const mutated = (replacement: string): string => stabilized.replace(`${nextLine!}\n`, replacement);

    // Two-line fold of a command with a path argument.
    expect(() =>
      checkAtomicRendering(
        mutated(`Next: apkit ap\n  ply ${command.slice("apkit apply ".length)}\n`),
        stabilized,
        corpus,
      ),
    ).toThrow(/fragmented/);

    // An intact occurrence elsewhere never excuses a second, split occurrence.
    expect(() =>
      checkAtomicRendering(
        mutated(`${nextLine!}\nAlso: apkit ap\n  ply ${command.slice("apkit apply ".length)}\n`),
        stabilized,
        corpus,
      ),
    ).toThrow(/fragmented/);

    // Fragmentation across three or more lines.
    expect(() =>
      checkAtomicRendering(mutated("Next: apkit\n  apply ~/pro\n  jects/demo\n"), stabilized, corpus),
    ).toThrow(/fragmented/);

    // A path argument split mid-token inside an intact command prefix.
    const pathSpelling = command.slice("apkit apply ".length);
    expect(() =>
      checkAtomicRendering(
        stabilized.replace(
          `${detailsLine!}\n`,
          `Details: apkit status ${pathSpelling.slice(0, -4)}\n  ${pathSpelling.slice(-4)} --verbose\n`,
        ),
        stabilized,
        corpus,
      ),
    ).toThrow(/fragmented/);
  });

  test("INT-1 original committed root-help syntax fold is rejected", () => {
    const key = "golden snapshots of every human view root help: root-help 1";
    const baseline = baselineStream(snapshotBodies.get(key)!, "stdout");
    const syntax = "status [project | --all]";
    expect(baseline).toContain(syntax);
    checkAtomicRendering(baseline, baseline, goldenCorpus());
    expect(() => checkAtomicRendering(
      baseline.replace(syntax, "status\n    [project | --all]"), baseline, goldenCorpus(),
    )).toThrow(/fragmented/);
    expect(collectSpellings(baseline, goldenCorpus()).some((value) => value.startsWith(syntax))).toBe(true);
  });

  test("committed baselines reject fragmenting their complete spellings", () => {
    const corpus = goldenCorpus();

    // Focused-command-help usage syntax (committed bytes): a fold after the
    // verb must not pass just because the bracketed syntax continues later.
    const helpKey = "golden snapshots of every human view focused command help: focused-command-help 1";
    const helpBaseline = baselineStream(snapshotBodies.get(helpKey)!, "stdout");
    checkAtomicRendering(helpBaseline, helpBaseline, corpus);
    const usageLine = helpBaseline.split("\n").find((line) => line.startsWith("Usage: apkit status "));
    expect(usageLine).toBeDefined();
    expect(() =>
      checkAtomicRendering(
        helpBaseline.replace("apkit status [", "apkit status\n      ["),
        helpBaseline,
        corpus,
      ),
    ).toThrow(/fragmented/);

    // Apply receipt (committed bytes): a relative dotted path folded after
    // its leading dot must be rejected, not excused by its continuation.
    const receiptEntry = [...snapshotBodies].find(([, body]) =>
      body.includes(".agent-profile-kit/codex/context.md"),
    );
    expect(receiptEntry).toBeDefined();
    const receiptBaseline = baselineStream(receiptEntry![1], "stdout");
    checkAtomicRendering(receiptBaseline, receiptBaseline, corpus);
    expect(() =>
      checkAtomicRendering(
        receiptBaseline.replace(".agent-profile-kit/", ".\n      agent-profile-kit/"),
        receiptBaseline,
        corpus,
      ),
    ).toThrow(/fragmented/);
  });

  test("a colored committed baseline guards its decoded styled paths", () => {
    const colorKey =
      "rendering matrix for a representative subset list projects matrix: list-projects-interactive-narrow-color 1";
    const colorBaseline = baselineStream(snapshotBodies.get(colorKey)!, "stdout");
    const corpus = goldenCorpus();
    checkAtomicRendering(colorBaseline, colorBaseline, corpus);
    const styledPathLine = colorBaseline.split("\n").find((line) => line.includes("~/projects/demo"));
    expect(styledPathLine).toBeDefined();
    expect(() =>
      checkAtomicRendering(
        colorBaseline.replace("~/projects/demo", "~/projects/de\n      mo"),
        colorBaseline,
        corpus,
      ),
    ).toThrow(/fragmented/);
  });

  test("missing baselines fail outside the update workflow and are tolerated within it", () => {
    const absentKey = "golden snapshots of every human view absent view: absent 1";
    const savedMarker = process.env[UPDATE_SNAPSHOTS_ENV];
    delete process.env[UPDATE_SNAPSHOTS_ENV];
    try {
      expect(() => committedBaseline(absentKey)).toThrow(/No committed golden baseline/);
      process.env[UPDATE_SNAPSHOTS_ENV] = "1";
      expect(committedBaseline(absentKey)).toBeUndefined();
    } finally {
      if (savedMarker === undefined) delete process.env[UPDATE_SNAPSHOTS_ENV];
      else process.env[UPDATE_SNAPSHOTS_ENV] = savedMarker;
    }
  });
});
