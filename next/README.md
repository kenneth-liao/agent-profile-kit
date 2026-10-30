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
