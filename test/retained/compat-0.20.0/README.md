# 0.20.0 optional-scaffolding Workspaces (#50, #787)

Neutral, hand-authored fixtures validated with the released 0.20.0 engine at
`d23221783859658876ffa0efa43faef7df13e673`, the last revision at `package.json`
version `0.20.0` (the next commit, `a9de58c`, bumps to 0.21.0; the release has no
tag). `CHANGELOG.md` lists #50 under `## [0.20.0] - 2026-07-16`. The format change
itself landed earlier, at `f2ec1c1` (package version 0.16.0, unreleased), and
shipped in 0.20.0.

- `minimal/` contains only the supported `workspace.yaml` marker. It proves
  optional scaffolding: all six artifact directories and bootstrap documents
  are absent.
- `partial/` has Context and a Profile, but no Skills, Agents, Hooks, Tools,
  or bootstrap documents. Its six Profile fields are the complete schema then,
  including empty `agents`, `hooks`, and `tools` placeholders. Content is
  synthetic and belongs to this repository.

On 2026-11-05, Bun 1.4.4 installed historical dependencies with lifecycle scripts
disabled and bundled the historical CLI; Node v26.12.1 ran `validate` in fresh
homes. Both fixtures exited 0, reporting respectively 0 and 1 Profiles and
0 Project Bindings. Reproduction: `../verify-historical.py` and the instructions
in `../README.md`. No Host program was needed or run.

Current validation must name the marker rename; the partial Workspace must also
name removal of all four extra Profile keys (`id`, `agents`, `hooks`, `tools`).
The CLI compatibility test applies only the repairs named in that first report
and requires the repaired Workspace to validate, with no validation writes.
