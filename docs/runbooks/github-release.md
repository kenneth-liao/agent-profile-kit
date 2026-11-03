# Publish a release to npm and GitHub

The manually dispatched `Release` workflow builds and packs once, qualifies the
installed tarball with plain `bun test`, and publishes the same bytes to npm
and a GitHub Release (ADR-0053, ADR-0059). Verification is read-only. The separate
publishing job has the sole `contents: write` and `id-token: write` grants;
`dry-run=true` skips that entire job, including tag and Release creation.

## One-time setup: npm trusted publisher

The package owner configures a GitHub Actions trusted publisher at
<https://www.npmjs.com/package/agent-profile-kit/access>:

- Organization or user: `kenneth-liao`
- Repository: `agent-profile-kit`
- Workflow filename: `release.yml`
- Environment name: leave blank

No `NPM_TOKEN` is stored. npm publication uses OIDC and `--provenance`.

## Qualification without publication

Start with a clean checkout and installed dependencies. Local qualification
uses the installed Node on `PATH` and the Bun running the command. CI uses the
Bun pin in `package.json`, Node 22, macOS 15, and a finite 15-minute verification
job. The ordinary CI matrix separately qualifies the same revision on macOS,
Linux, Windows, and every supported Node line; require those results before
publication. A local result is evidence only for its recorded environment.

```sh
candidate_dir="$(mktemp -d)"
bun scripts/release.ts candidate "$candidate_dir" rc.1
bun scripts/release.ts qualify "$candidate_dir"
bun scripts/release.ts verify "$candidate_dir" "$(git rev-parse HEAD)" 0.239.0-rc.1
```

Omit `rc.1` and use the base version when qualifying a stable candidate. Candidate
creation runs `bun run build`, then `npm pack --ignore-scripts` once. For a
prerelease it temporarily sets the manifest version before building and packing,
then restores the original manifest even on an ordinary build/pack failure.
An abrupt termination during creation can leave that working-copy edit; restore
it before starting a new candidate. No version commit is needed on the
integration branch. Never reuse a candidate whose creation failed.

Qualification installs that archive with lifecycle scripts disabled into
`<candidate>/install`, sets `APKIT_CLI` to its absolute
`node_modules/agent-profile-kit/dist/cli.js`, and runs
`bun test --reporter=junit --reporter-outfile=<candidate>/tests.xml` from the
source root. This runs every engine test and exercises the packed CLI on Node.
The bundle-only test runs too, so no skipped test is accepted for release.
Tracked `test/**/*.test.ts` files define the required selection. A missing or
empty suite, skipped test, failure, interruption, dirty source, or changed
commit prevents successful qualification. Extra filters are not accepted by
the qualification command. CI job timeouts bound execution; there is no suite
supervisor. Failed and interrupted jobs are never qualification passes.

For a workflow dry run, select any source ref and leave the default
`dry-run=true`:

```sh
gh workflow run release.yml --ref spec/728-agent-first-cutover \
  -f version=0.239.0 -f prerelease=rc.1 -f dry-run=true
```

This retains the verified handoff without publishing it. If the workflow is not
yet dispatchable on GitHub, use the local commands above. They contain no
publication operations.

## Publish a prerelease to next

Prereleases can come from the integration branch before it merges. Require
passing CI on the selected commit. The base version must match `package.json`;
the suffix must be valid SemVer prerelease identifiers. The dated changelog
check is skipped. `latest` is left alone: npm receives `--tag next`, and GitHub
receives `--prerelease --latest=false`.

```sh
gh workflow run release.yml --ref spec/728-agent-first-cutover \
  -f version=0.239.0 -f prerelease=rc.1 -f dry-run=false
```

This publishes `0.239.0-rc.1`, with both the source commit and packed version in
the qualification record. Each candidate suffix must be unused.

## Publish a stable release

Stable publication requires the current `main` head, passing CI on that commit,
the matching base version in `package.json`, and a dated changelog section
`## [<version>] - YYYY-MM-DD`. No tag, GitHub Release, or npm version may already
exist. Leave `prerelease` empty. Stable publication explicitly uses `--tag latest`.

```sh
gh workflow run release.yml --ref main -f version=0.239.0 -f dry-run=false
```

Watch the run:

```sh
gh run list --workflow release.yml --event workflow_dispatch --limit 5
gh run watch <run-id> --exit-status
```

Both jobs use the same verifier. Before handoff, after download, and immediately
before each publication, it checks the actual archive digest, tested and release
commit, packed manifest/version, complete selection, command, runtime, and
successful result. The publishing job neither rebuilds nor repacks. The stable
path rechecks the current `main` before publishing.

## Retained evidence

Each qualification attempt first writes `qualification-record.json` with an
`incomplete` result, then records `failed` or `passed`. A killed process may leave
an incomplete or unreadable record; both are rejected. The compact record holds
commit, packed version and digest, selected test files, command (with
`<candidate>` as a portable output-directory placeholder), observed Bun/Node and
platform/architecture, result, and completed test count. `tests.xml` records the
individual test outcomes. The CLI environment is the installed path described
above. Reproduce using that commit, the same runtime, and these commands.

Workflow artifacts retained for seven days:

- `qualification-attempt-<attempt>`: available identity, qualification, and JUnit
  records on success or failure. A failure before record creation is evidenced
  by the failed step's log.
- `release-candidate-handoff`: only after verification succeeds, the exact
  `.tgz`, `candidate.json` (commit, version, archive name, SHA-256 digest),
  qualification record, and JUnit report. The installation prefix is excluded.

## Verify the published release (ISC-13 probe)

The human release owner performs this after actual publication (#763). Download
both published copies and compare their SHA-256 with `digest` in the retained
qualification record:

```sh
version=0.239.0
verify_dir="$(mktemp -d)"
gh release download "v$version" --pattern "agent-profile-kit-$version.tgz" --dir "$verify_dir"
curl -fsSL "$(npm view "agent-profile-kit@$version" dist.tarball)" -o "$verify_dir/npm-$version.tgz"
shasum -a 256 "$verify_dir/agent-profile-kit-$version.tgz" "$verify_dir/npm-$version.tgz"
npm view "agent-profile-kit@$version" dist.attestations
```

All three digests must match. For prereleases also confirm `npm view
agent-profile-kit dist-tags --json` shows the intended `next` and unchanged
`latest`.

## Recovery and partial failure

npm publishes before GitHub. If verification or npm publication fails, inspect
the actual registry state before retrying; a failed network response can follow
a successful publication. Preserve failed evidence, fix the cause, and use a
new version when the old one exists. Never turn an incomplete attempt into a pass.

If npm succeeded and GitHub failed, do not rebuild or repack. From a clean
checkout at the original release commit, recover the handoff and verify it:

```sh
run_id=<workflow-run-id>
recovery_dir="$(mktemp -d)"
gh run download "$run_id" --name release-candidate-handoff --dir "$recovery_dir"
target_sha="$(node -p 'require(process.argv[1]).commit' "$recovery_dir/candidate.json")"
version="$(node -p 'require(process.argv[1]).version' "$recovery_dir/candidate.json")"
archive="$(node -p 'require(process.argv[1]).archive' "$recovery_dir/candidate.json")"
bun scripts/release.ts verify "$recovery_dir" "$target_sha" "$version"
```

The release owner then prepares notes for that version and creates the missing
GitHub Release using `$recovery_dir/$archive`, targeting `$target_sha`. Include
`--prerelease --latest=false` for a prerelease. Do not rerun npm publication or
move a dist-tag as part of recovery. Preserve defective published versions and
fix forward.
