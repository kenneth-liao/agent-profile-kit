---
name: resolve-issue
description: Resolve an issue from the user's project issue tracker using TDD. Use when the user wants to resolve an individual issue, continue progress on a PRD implementation, or review outstanding issues.
---

# Resolve Issue

Implement/resolve an issue from the user's project issue tracker using TDD.

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-project-skills` if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments. Identify and read any related issues, PRDs, dependencies, etc.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Read and use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

### 3. Draft the implementation plan

Summarize your understanding of the issue and propose a task list to the user for how you plan to implement/resolve the issue, accounting for all dependencies. Also highlight how the changes will address all Acceptance criteria for this issue. 

If anything unexpected surfaces such as new issues, architecture/design decisions, gotchas, etc., these should be surfaced to the user. Get alignment with the user before proceeding.

Ask the user:

- Are the dependency relationships correct?
- Flag any new/unexpected issues, requirements, decisions, gotchas, etc.

### 4. Implement the changes

Always use a new git worktree to isolate the changes and prevent impacting other agents or the user working in the same project. Create it **inside the repo** at `.worktrees/<branch>` (`git worktree add -b <branch> .worktrees/<branch>`), never as a sibling dir; ensure `.worktrees/` is in `.gitignore` (add it if missing) so the worktree stays uncommitted. Use the tdd skill to implement all changes using TDD.

### 5. Communicate the changes

Provide a concise summary of the work and anything that should be flagged, as well as next steps. Ask the user if they want you to open PR.

If yes, commit, push, and open the PR.

When the PR should close the issue on merge, use a GitHub closing keyword in the PR body, such as `Closes #123`, `Fixes #123`, or `Resolves #123`.

### 6. Document

Document any important context in the project memory to pick up later in a fresh session, such as what was accomplished, next steps, and gotchas. If any new/unexpected issues, requirements, decisions, gotchas, etc. came up, document these in a comment on the issue. This is important context for posterity.

### 7. Clean up

Suggest a clean up plan to the user that you can perform once the user confirms the PR merged. As an example, clean up might include:

- Deleting stale branches, worktrees, and other files
- Cleaning up any test data in databases
- Pulling the latest from remote to local
