---
name: update-context
description: Update the context system based on our conversation so far.
user-invocable: true
disable-model-invocation: true
---

# Context Update

Scan the current conversation and update Elle's context system.

## Prerequisites

Check that the context system has been initialized:

```bash
ls ~/.claude/.context/
```

If not, run `/personal-assistant:setup` first.

## Update Flow

### 1. Read update instructions

Read `~/.claude/.context/context-update.md` for the full update philosophy.

### 2. Scan conversation

Review the current conversation for:
- New facts about the user (identity, relationships)
- New preferences or workflow patterns
- Corrections to Claude's behavior (rules)
- Project status changes
- Important dates or deadlines (triggers)
- Session context updates

### 3. Classify and route

For each finding, determine the destination file:

| Type | Destination |
|------|-------------|
| Identity info | `~/.claude/.context/core/identity.md` |
| Preferences | `~/.claude/.context/core/preferences.md` |
| Corrections | `~/.claude/.context/core/rules.md` |
| Workflows | `~/.claude/.context/core/workflows.md` |
| Relationships | `~/.claude/.context/core/relationships.md` |
| Dates/deadlines | `~/.claude/.context/core/triggers.md` |
| Project changes | `~/.claude/.context/core/projects.md` |
| Session state | `~/.claude/.context/core/session.md` |

### 4. Write confirmed updates

Write updates to the appropriate files. Follow each file's update policy (see context-update.md).

### 5. Auto-sync

If any of these files were updated:
- `rules.md`
- `preferences.md`
- `identity.md`
- `projects.md`

Automatically run the sync-context script to regenerate elle-core.md:

```bash
uv run python ${CLAUDE_PLUGIN_ROOT}/skills/sync-context/scripts/sync_context.py
```

Report what changed in the sync.

### 6. Summary

Briefly summarize what was updated and which files were modified.
