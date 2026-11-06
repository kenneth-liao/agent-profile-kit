# 0.84.0 reduced-Profile Workspace (#239, #787)

Neutral, hand-authored fixture validated with the engine at
`ca468af769016c16148cb925b39b39fb567868af` (`package.json` version `0.84.0`),
"Remove unsupported Profile fields (#259)", which delivered #239. #787
originally named 0.95.0, but the changing commit and #239's delivery record
identify 0.84.0; use the actual format-changing release.

The Profile contains exactly the three implemented fields of that release:
`id`, `context`, and `skills`. The obsolete `agents`, `hooks`, and `tools`
placeholders are absent. Context frontmatter supplies its ID, independently of
its filename, as permitted then. Content is synthetic and belongs to this repo.

On 2026-11-06, Bun 1.4.4 installed historical dependencies with lifecycle scripts
disabled and bundled the historical CLI; Node v26.12.1 ran `validate` in a fresh
home. It exited 0 with 1 Profile (`writing`) and 0 Project Bindings.
Reproduction: `../verify-historical.py` and the instructions in `../README.md`.
No Host program was needed or run.

Current validation must name three changes in one report: rename the marker,
remove the Profile `id` key, and rename the Context file to keep the selected
frontmatter ID. The CLI compatibility test applies only the named repairs and
requires the repaired Workspace to validate, with no validation writes.
