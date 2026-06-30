# Context

## Terms

- **Agent Kit** - the monorepo that owns agent commands, shared context, tools, skills, and operating guidance for this system.
- **Command** - a reusable instruction or entrypoint an agent can invoke to perform a specific workflow.
- **Skill** - a packaged set of instructions, references, or helpers that extends an agent's capabilities.
- **Tool** - executable code or integration support used by agents or skills.
- **Shared context** - cross-project knowledge that is maintained here because more than one agent workflow depends on it.

## Invariants

- Each maintained fact has one canonical home.
- Local runtime state, generated output, and disposable worktrees are not source material.
