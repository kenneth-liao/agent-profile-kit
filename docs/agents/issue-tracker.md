# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Prefer the current agent harness's native GitHub connector or application when available; use the `gh` CLI as the portable fallback.

## Conventions

- Infer the repository from `git remote -v`; when run inside this clone, `gh` does this automatically.
- Fetch an issue's complete body, comments, and labels before acting on it.
- Use quoted heredocs or a temporary body file for Markdown or multiline issue content so the shell cannot expand it.
- Treat a request to publish to the issue tracker as a request to create a GitHub issue.
- Treat a request to fetch a ticket as a request to fetch the complete GitHub issue, including comments and labels.
- Treat an assignee, an open linked PR, or the ticket's deterministic branch/worktree as the ticket's active-work signals.
- The implementation frontier is defined in `docs/agents/triage-labels.md`.

## Pull requests

`docs/agents/triage-labels.md` says which tickets ship in a spec PR, which in their own PR, and which issues a PR closes. GitHub mechanics:

- **Open:** a PR into the default branch that is ready for review, with `Closes #<number>` in its body for each issue it closes.
- **Integration-merge record:** an issue comment.
- **Closing:** GitHub applies closing keywords only on merge into the default branch; when the base branch is not the default, whoever merges records the evidence on each of those issues and closes them by hand.
