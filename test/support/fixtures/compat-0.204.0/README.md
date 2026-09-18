# 0.204.0 compatibility fixtures (issue #596, TEST-010)

Installation State and installed project output written by release 0.204.0 for
a Profile that used Dependencies, plus the 0.204.0-format Workspace source
that drove the journey. No release tag exists for 0.204.0, so the fixtures are
produced from the commit that carried version `0.204.0` in `package.json`:
**531f12f** ("Render authoring guides cleanly in the terminal (#510) (#590)").

## How they were produced

1. `git worktree add /tmp/apk-0204-checkout 531f12f` in this repository, then
   `bun install && bun run build:bundle` inside that checkout to produce
   `dist/cli.js` (the packed CLI).
2. Run the committed journey script against that binary:

       produce.sh <path-to>/dist/cli.js <this-directory>

   The script (`produce.sh`, committed beside this README) runs the packed CLI
   in one isolated stage home with a `codex` stub on `PATH`:

   - `apkit init` (0.204.0 fixed-default Workspace and settings),
   - author a dependency-using Workspace (Context Module frontmatter
     `dependencies` and a Skill `agent-profile-kit.yaml` sidecar),
   - `apkit install coding <project> --host codex --auto-confirm`,
   - `apkit update`,
   - copy the Workspace source, Local Configuration, Installation State
     (`state/manifest.json`), and the installed project tree into this
     directory.

3. The stage's canonical (realpath) absolute prefixes are replaced with the
   mechanical placeholders `__FIXTURE_HOME__` (the machine home holding the
   application directory) and `__FIXTURE_PROJECT__` (the installed project) in
   the two text records that carry them (`config.yaml`,
   `state/manifest.json`). The consuming test loader substitutes its own
   isolated home's canonical paths for the placeholders at copy time; no other
   byte of either record is altered. The `desired_input_digest` in
   `state/manifest.json` is exactly the digest the 0.204.0 code computed
   (including dependency and inclusion-reason semantics).

The committed script is the single reproduction path; regenerate this
directory only by re-running it against the recorded commit. Regeneration is
byte-identical except for the receipts' random `installation_id` UUID, which
the journey's install run generates fresh each time; the desired-input
digest, output hashes, and every other record are deterministic.