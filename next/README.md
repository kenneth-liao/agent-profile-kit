# apkit-next (prototype)

An agent-first prototype of Agent Profile Kit. It installs Workspace Profiles
into any folder with plain file writes, so it works the same on macOS, Linux,
and Windows. It reads today's Workspace format unchanged. It is not released;
it lives here to prove the design before any cutover.

- **Engine** (`src/`): a small non-interactive command, `apkit-next`. It never
  prompts; a step that needs the user's decision changes nothing and exits 3.
- **Built-in guide** (`apkit-next guide`, in `src/guide.ts`): teaches any agent to
  author the Workspace and drive the engine. Nothing to install first.

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
- **Registry**: `~/.agents/apkit/config.json` holds the selected Workspace and
  the list of installed folders, for `--all`. `APKIT_HOME` overrides the
  location.

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
| Antigravity | `~/.gemini/AGENTS.md` or `GEMINI.md` | Antigravity changelog; not tested live |

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
