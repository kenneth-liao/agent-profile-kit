# Create a private GitHub Release

Use the manually dispatched `Private Release` workflow to verify one version,
create its Git tag, and attach the installable npm tarball to a GitHub Release.
The repository remains private, so only users with repository read access can
see or download the release.

Repository visibility is the confidentiality boundary for every historical
Release and attached asset. Making the repository public later also makes those
artifacts public. Before any visibility change, audit every Release and remove
or replace assets that are not approved for public distribution.

The release artifact is intentionally not published to npm or GitHub Packages.
`package.json` sets `private: true`, making an accidental `npm publish` fail.
No open-source license or public-registry credentials are required while this
distribution remains private.

## Preconditions

- The release changes are merged to `main`, and CI passed for that commit.
- The workflow is dispatched from `main`, not from a feature branch.
- `package.json` contains the intended Semantic Version.
- `CHANGELOG.md` has a matching dated section below an empty `[Unreleased]`
  section.
- No tag or GitHub Release already exists for that version.

## Create the release

For the initial `0.20.0` release, dispatch the workflow with:

```sh
gh workflow run release.yml --ref main -f version=0.20.0
```

Find the new run and copy its numeric ID, then watch it through completion:

```sh
gh run list --workflow release.yml --event workflow_dispatch --branch main --limit 5
gh run watch <run-id> --exit-status
```

The workflow independently verifies that the repository is still private and
that it is running from the current `main`, checks version and changelog
agreement, creates one package candidate through the shared from-source
creator (one bounded build, one pack, one identity record beside the
archive), runs the complete release gate against that exact candidate,
verifies the retained qualification evidence before publishing, then creates
`v0.20.0` and its GitHub Release. The tag and Release are created only after
every earlier step passes, including the evidence verification that the
published archive is exactly the qualified candidate.

## Verify and install

Inspect the release and its attached tarball:

```sh
gh release view v0.20.0
gh release download v0.20.0 --pattern 'agent-profile-kit-0.20.0.tgz'
```

Install that exact private build locally:

```sh
npm install --global ./agent-profile-kit-0.20.0.tgz
apkit guide --full
```

On another machine, authenticate `gh` with an account that can read this private
repository before downloading the asset.

## Retained evidence

Every run — success or failure — retains a `supervised-suite-qualification-attempt`
Actions artifact containing the supervisor's compact qualification record
(`qualification-record.json`: source identity, candidate archive digest,
observed runtimes, selection, completion status) and the per-run diagnostics.
The qualification record is the evidence the release publication gate consumes:
it must name the candidate's archive digest and source identity, and a run
without a complete record cannot publish. If a run fails or you need to show
what a release was qualified against, download that artifact.

## Recovery

If a run fails before its final step, fix the cause on a new commit, merge it to
`main`, and dispatch the same version again. No tag or Release will exist. The
failed run's qualification artifact states what was qualified and why the run
is not a pass; do not treat a red run's evidence as a baseline.

If GitHub creates a draft or published Release but asset upload or final
reporting fails, inspect its exact state before retrying anything:

```sh
gh release view "v<version>" --json isDraft,targetCommitish,assets,url
git ls-remote --tags origin "refs/tags/v<version>"
```

If the Release targets the expected commit and the tarball is missing, recreate
the candidate from that immutable tag in a disposable repository-local
worktree through the same creator and evidence policy the release workflow
uses — one bounded build and pack, an identity record beside the archive, a
supplied full suite run, and evidence verification — then upload the verified
archive without `--clobber` and publish the draft if necessary:

```sh
version=<version>
recovery_path=".worktrees/release-recovery-$version"

git fetch origin "refs/tags/v$version:refs/tags/v$version"
tag_commit="$(git rev-parse "v$version^{commit}")"
release_commit="$(gh release view "v$version" --json targetCommitish --jq .targetCommitish)"
test "$tag_commit" = "$release_commit"

git worktree add --detach "$recovery_path" "v$version"
(
  cd "$recovery_path"
  bun install --frozen-lockfile
  package_dir="$(mktemp -d)"
  diagnostics_dir="$(mktemp -d)"
  archive_file="$(bun run scripts/create-package-candidate.ts "$package_dir")"
  APKIT_TEST_PACKAGE_ARCHIVE="$archive_file" \
    APKIT_TEST_DIAGNOSTICS_DIR="$diagnostics_dir" \
    bun run test
  bun run scripts/verify-release-candidate.ts \
    "$archive_file" "$tag_commit" \
    "$diagnostics_dir/qualification-record.json"
  gh release upload "v$version" "$archive_file"
)
gh release edit "v$version" --draft=false
git worktree remove "$recovery_path"
git worktree prune
```

Stop if the commit identities differ or an asset already occupies that name;
do not move the tag or overwrite the artifact. If the attached build is
defective, preserve that version for provenance, fix forward with a new patch
version, and mark the defective Release as a prerelease with an explanatory
note.
