# Agent Profile Kit Workspace

This Workspace is the canonical source for your Profiles, Context Modules, and
Skills. Lasting edits belong here; installed project files are generated files.

- A **Context Module** (under `context/`) carries standing instructions, preferences, and background an agent should always know.
- A **Skill** (under `skills/<skill>/SKILL.md`) carries reusable instructions for one task.
- A **Profile** packages chosen Context and Skills to install together, so a project installs one selection with one command.

Scaffold with `apkit new`, select the artifact into a Profile, and install:

```sh
apkit new skill <skill>
apkit configure profile           # pick a Profile and toggle the new Skill
apkit install example --host codex   # from a project directory
```

After editing Workspace source, run `apkit update` to refresh installations.

Run `apkit guide --full` for complete authoring guidance.
