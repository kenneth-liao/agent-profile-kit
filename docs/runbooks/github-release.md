# Publish a release to npm and GitHub

Use the manually dispatched `Release` workflow to verify one version on `main`,
publish its qualified npm tarball through an npm trusted publisher with
provenance, create its Git tag, and attach that exact tarball to a public
GitHub Release (ADR-0053, #712).

One candidate creation owns the build and pack once (#550). Both npm and the
GitHub Release consume the exact archive bytes that passed the release
qualification suite — neither target rebuilds or repacks.

## One-time setup: npm trusted publisher

Before dispatching the first release workflow run, configure the npm trusted
publisher on npmjs.com (package owner step):

1. Open `https://www.npmjs.com/package/agent-profile-kit/access`.
2. Under **Trusted Publishers**, add a **GitHub Actions** publisher with:
   - **Organization or user:** `kenneth-liao`
   - **Repository:** `agent-profile-kit`
   - **Workflow filename:** `release.yml`
   - **Environment name:** *(leave blank)*

No `NPM_TOKEN` secret is stored in GitHub. The `publish-release` job authenticates
via GitHub OIDC (`id-token: write`) and publishes with `--provenance`.

## Preconditions

- The release changes are merged to `main`, and CI passed for that commit.
- The workflow is dispatched from `main`, not from a feature branch.
- `package.json` contains the intended Semantic Version.
- `CHANGELOG.md` has a matching dated section (`## [<version>] - YYYY-MM-DD`)
  below an empty `[Unreleased]` section.
- No tag or GitHub Release already exists for that version, and the version has
  not been published to npm.

## Publish the release

For version `0.237.0`, dispatch the workflow with:

```sh
gh workflow run release.yml --ref main -f version=0.237.0
```

Find the new run and copy its numeric ID, then watch it through completion:

```sh
gh run list --workflow release.yml --event workflow_dispatch --branch main --limit 5
gh run watch <run-id> --exit-status
```

The workflow runs in two permission-separated jobs:

1. **`verify-release-candidate` (`contents: read`):** Verifies that the workflow
   is running from the current `main`, checks version and changelog agreement,
   creates one package candidate through the shared from-source creator (one
   bounded build, one pack, one identity record beside the archive), runs the
   complete release gate (`bun run test` and `bun run test:fleet`) plus a smoke
   install against that exact candidate, and verifies the retained qualification
   evidence. It has no write or OIDC permissions, so it cannot publish.
2. **`publish-release` (`contents: write`, `id-token: write`):** Receives only
   the verified candidate handoff artifact (`release-candidate-handoff`),
   re-enforces the same identity and evidence contract on the downloaded bytes,
   publishes that exact tarball to npm (`npm publish <archive> --provenance --access public`),
   and then creates tag `v<version>` and the public GitHub Release attaching the
   same tarball.

## Verify the published release (ISC-13 probe)

Confirm that both the npm registry tarball and the GitHub Release asset match
the qualified candidate digest recorded in `qualification-record.json`:

```sh
version=0.237.0
verify_dir="$(mktemp -d)"

# 1. Download the GitHub Release asset and the npm registry tarball
gh release download "v$version" --pattern "agent-profile-kit-$version.tgz" --dir "$verify_dir"
curl -fsSL "$(npm view "agent-profile-kit@$version" dist.tarball)" -o "$verify_dir/npm-$version.tgz"

# 2. Compare SHA-256 digests
shasum -a 256 "$verify_dir/agent-profile-kit-$version.tgz" "$verify_dir/npm-$version.tgz"
```

Both digests must be identical and match `artifact.archiveDigest` in the run's
retained `qualification-record.json`. You can also verify provenance and execute
the published CLI directly:

```sh
npm view "agent-profile-kit@$version" dist.attestations
npx --yes --package "agent-profile-kit@$version" apkit --version
```

## Retained evidence

Every run — success or failure — retains a `supervised-suite-qualification-attempt`
Actions artifact containing the supervisor's compact qualification record
(`qualification-record.json`: source identity, candidate archive digest,
observed runtimes, selection, completion status) and the per-run diagnostics.
When verification succeeds, the run also retains `release-candidate-handoff` —
the exact candidate bytes, identity record, and accepted qualification record
that the publishing job received and re-verified.

## Recovery and partial failure

The publishing job runs `npm publish` first and `gh release create` second:

- **If verification or `npm publish` fails:** Neither npm nor GitHub has the
  release. Fix the cause on a new commit, merge to `main`, and dispatch again.
- **If `npm publish` succeeds but `gh release create` fails:** Because npm
  versions are immutable, **do not** rerun the workflow or rebuild from source
  (a fresh `npm pack` or build could produce different bytes, violating ISC-13).
  Instead, download the `release-candidate-handoff` artifact from the failed
  workflow run, verify its digest against `qualification-record.json`, and
  create the GitHub Release with that exact archive:

```sh
version=<version>
run_id=<workflow-run-id>
recovery_dir="$(mktemp -d)"

gh run download "$run_id" --name release-candidate-handoff --dir "$recovery_dir"
archive_file="$recovery_dir/agent-profile-kit-$version.tgz"
target_sha="$(jq -r .repositoryHead "$archive_file.provenance.json")"

bun run scripts/verify-release-candidate.ts \
  "$archive_file" \
  "$target_sha" \
  "$recovery_dir/qualification-record.json"

awk -v version="$version" '
  $0 ~ "^## \\[" version "\\] - " { capture = 1; next }
  capture && /^## \[/ { exit }
  capture { print }
' CHANGELOG.md > "$recovery_dir/release-notes.md"

gh release create "v$version" \
  "$archive_file" \
  --target "$target_sha" \
  --title "Agent Profile Kit $version" \
  --notes-file "$recovery_dir/release-notes.md"
```

If a published build is later found to be defective, preserve that version for
provenance, fix forward with a new patch version, and mark the defective GitHub
Release as a prerelease with an explanatory note.
