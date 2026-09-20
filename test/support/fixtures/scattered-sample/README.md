# Scattered sample material fixture (TEST-013)

Reusable neutral fixture providing sample scattered material for qualification of Workspace setup starting points (spec #593 TEST-013; qualified by #608, #609, and #610).

## Layout

- `README.md`: This provenance and specification note. Kept outside `material/` so qualification harnesses in #609 and #610 can pass `material/` directly to fresh agent sessions and newcomers without coaching them or introducing stray files into the target Workspace.
- `material/`: The scattered project material representing existing agent configuration before Agent Profile Kit setup.

## Material contents

1. **Instruction files in project folders**:
   - `material/AGENTS.md`: Root instruction file with neutral coding guidelines and conventions.
   - `material/CLAUDE.md`: Root instruction file with neutral instructions for Claude Code.
   - `material/docs/AGENTS.md`: Nested instruction file with neutral architectural standards.

2. **Standard Skills in more than one Host folder**:
   - `material/.claude/skills/code-review/SKILL.md`: Standard Skill package with Host-specific frontmatter (`user-invocable: true`, documented by Claude Code for skill slash-command visibility control; DEC-015).
   - `material/.agents/skills/build-helper/`: Standard Skill package with Skill Resources:
     - `SKILL.md`: Package entry point with name and description.
     - `references/reference.md`: Skill reference resource.
     - `scripts/build.sh`: Skill script resource.
