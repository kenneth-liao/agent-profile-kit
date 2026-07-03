---
name: sync-context
description: Regenerate ~/.claude/rules/elle-core.md from your context files. Run after significant context updates to keep your session rules current. Use when context feels stale, after /update-context changes rules/preferences/identity, or after /upgrade.
user-invocable: true
disable-model-invocation: true
model: claude-sonnet-4-6
---

# Sync Context

Regenerate `~/.claude/rules/elle-core.md` from source files in `~/.claude/.context/core/`.

## What It Does

1. Reads identity.md, preferences.md, rules.md, projects.md
2. Generates a compact derived file (~100 lines)
3. Writes to `~/.claude/rules/elle-core.md`
4. Reports diff of what changed

## Run the Script

```bash
uv run python ${CLAUDE_SKILL_DIR}/scripts/sync_context.py
```

## After Running

Read the generated file and report what changed:

```bash
cat ~/.claude/rules/elle-core.md
```

Summarize:
- Number of rules synced
- Number of active projects listed
- Whether identity/preferences sections were populated
- Any warnings (empty sections, missing source files)

## When to Run

- After `/update-context` changes rules, preferences, or identity
- After `/upgrade` completes
- After manual edits to context files
- When elle-core.md feels out of sync with your actual context
