# apkit-next (prototype)

An agent-first prototype of Agent Profile Kit. It installs Workspace Profiles
into any folder with plain file writes, so it works the same on macOS, Linux,
and Windows. It reads today's Workspace format unchanged. It is not released;
it lives here to prove the design before any cutover.

- **Engine** (`src/`): a small non-interactive command, `apkit-next`. It never
  prompts; a step that needs the user's decision changes nothing and exits 3.
- **Built-in guide** (`apkit-next guide`, in `src/guide.ts`): teaches any agent to
  author the Workspace and drive the engine. Nothing to install first.

## Get started

Keep your Skills and always-on agent instructions in one place, and install
them into any project for Claude Code, Codex, OpenCode, Pi, Grok, or
Antigravity. You don't need to learn the commands: ask your coding agent.

> Run `apkit-next guide` and follow it to help me set up Agent Profile Kit.

(The prototype is not on npm yet. Once published, agents will run it with
`npx`.)

## How installs work

- **Skills** are copied to each agent's native path: `.claude/skills/`,
  `.grok/skills/`, and `.agents/skills/` (Antigravity, Codex, OpenCode, Pi).
- **Context** goes into one marked section in `AGENTS.md`, which every
  supported agent loads. When `CLAUDE.md` exists and Claude Code is selected,
  `CLAUDE.md` gets one `@AGENTS.md` line, because Claude Code reads `CLAUDE.md`
  instead of `AGENTS.md` when both exist. The section is never put in
  `CLAUDE.md`: Grok loads both files.
- **Safety**: `.agents/apkit.json` in each folder records a hash of every file
  apkit wrote. apkit replaces or deletes only files that still match it.
  Edits to `AGENTS.md`/`CLAUDE.md` need `--yes`; replacing changed or foreign
  files needs `--overwrite`. Nothing is written until every decision is made.
- **Git**: in a repository root (including a linked worktree), the installed
  Skill folders, the manifest, and an `AGENTS.md` apkit created are listed in
  a marked block in `.git/info/exclude`, so they stay out of `git status`.
  Edits to files the user already tracks (such as the `CLAUDE.md` import line)
  still show as changes.
- **User level** (`install --global`): a Skills-only Profile goes to each
  agent's user-level Skills folder, so it applies in every project. Context
  stays per project, so `--global` refuses a Profile with Context.
- **Registry**: `~/.agents/apkit/config.json` holds the selected Workspace and
  the list of installed folders, for `--all`. `APKIT_HOME` overrides the
  location.

## Project-level locations

Verified 2026-10-30 in one Git project installed for all six agents. Each
agent, with no tools, quoted both Context markers from the `AGENTS.md` section
and named the marker Skill. A Skill with `disable-model-invocation: true` was
hidden every time.

| Agent | Context | Skills | Evidence |
|---|---|---|---|
| Claude Code | `AGENTS.md` through the `@AGENTS.md` line in `CLAUDE.md` | `.claude/skills` | `claude -p` |
| Antigravity | `AGENTS.md`, in a trusted project | `.agents/skills`, in a trusted project | `agy -p`, and the interactive app after trust |
| Codex | `AGENTS.md`, also in an untrusted project | `.agents/skills`, in a trusted project only | `codex exec` |
| Grok | `AGENTS.md`, in a trusted project only | `.grok/skills`, in a trusted project only | interactive `grok` session |
| OpenCode | `AGENTS.md` | `.agents/skills` | `opencode run` (v2.2.4, `opencode/deepseek-v4.1-flash`) |
| Pi | `AGENTS.md`, also in an untrusted project | `.agents/skills`, in a trusted project only | `pi -p` and `pi -p --approve` (1.4.0) |

## The user-level note (`setup`)

`apkit-next setup` adds a two-line marked note to each installed agent's
user-level instructions, telling every session to run `apkit-next guide`
before changing Skills, Context, or Profiles. The note names only the guide
command, so a newer guide never makes it stale. It follows the same consent
and safety rules as project installs, writes through symlinked files, and
`setup --remove` restores each file exactly.

Each agent's user-level file, and how it was verified (2026-10-30):

| Agent | File | Evidence |
|---|---|---|
| Claude Code | `$CLAUDE_CONFIG_DIR` or `~/.claude`, `CLAUDE.md` | Marker reached the model request |
| Codex | `$CODEX_HOME` or `~/.codex`, `AGENTS.override.md` if present, else `AGENTS.md` | Marker reached the model request |
| OpenCode | `~/.config/opencode/AGENTS.md`, else `~/.claude/CLAUDE.md` (first that exists) | Marker reached the model request, in both orders |
| Pi | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, `AGENTS.md` | Marker reached the model request |
| Grok | `$GROK_HOME` or `~/.grok`, `rules/*.md` (loaded without folder trust) | Grok's bundled user guide |
| Antigravity | `~/.gemini/AGENTS.md` or `GEMINI.md` | Live session quoted the marker |

User-level Skills folders used by `install --global` (verified the same way):

| Agent | Folder | Evidence |
|---|---|---|
| Claude Code | `~/.claude/skills` | Marker Skill reached the model request |
| Codex | `~/.agents/skills` (also reads `$CODEX_HOME/skills`) | Marker Skill reached the model request |
| OpenCode | `~/.agents/skills` (also `~/.claude/skills`, `~/.config/opencode/skills`) | `opencode debug skill` listed it |
| Pi | `~/.agents/skills` (also `~/.pi/agent/skills`) | Marker Skill reached the model request |
| Grok | `~/.grok/skills` (also `~/.claude/skills`) | Grok's bundled user guide |
| Antigravity | `~/.gemini/config/skills` | Live session listed the marker Skill |

Because OpenCode reads only the first file that exists, setup never creates
`~/.config/opencode/AGENTS.md` when `~/.claude/CLAUDE.md` exists: that would
hide the user's `CLAUDE.md` from OpenCode. The note goes in `CLAUDE.md`
instead. Grok also reads `~/.claude/CLAUDE.md` by default, so it may see the
note twice; that is harmless.

## Develop

```sh
cd next
bun install
bun run test        # Bun runtime
bun run build       # typecheck + bundle to dist/cli.js
APKIT_NEXT_CLI=dist/cli.js bun test ./test/cli.check.ts   # CLI journey on Node
```

Tests are named `*.check.ts` so the repository's root `bun test` does not pick
them up.
