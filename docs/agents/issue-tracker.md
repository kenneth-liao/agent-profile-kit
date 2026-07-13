# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues. Prefer the current agent harness's native GitHub connector or application when available; use the `gh` CLI as the portable fallback.

## Conventions

- Infer the repository from `git remote -v`; when run inside this clone, `gh` does this automatically.
- Fetch an issue's complete body, comments, and labels before acting on it.
- Use quoted heredocs or a temporary body file for Markdown or multiline issue content so the shell cannot expand it.
- Treat a request to publish to the issue tracker as a request to create a GitHub issue.
- Treat a request to fetch a ticket as a request to fetch the complete GitHub issue, including comments and labels.
