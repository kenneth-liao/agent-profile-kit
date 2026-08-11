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
agreement, runs the complete release gate, packs and smoke-tests the CLI, then
creates `v0.20.0` and its GitHub Release. The tag and Release are created only
after every earlier step passes.

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

## Recovery

If a run fails before its final step, fix the cause on a new commit, merge it to
`main`, and dispatch the same version again. No tag or Release will exist.

If GitHub creates a draft or published Release but asset upload or final
reporting fails, inspect its exact state before retrying anything:

```sh
gh release view "v<version>" --json isDraft,targetCommitish,assets,url
git ls-remote --tags origin "refs/tags/v<version>"
```

If the Release targets the expected commit and the tarball is missing, rebuild
from that immutable tag in a disposable repository-local worktree, upload the
missing asset without `--clobber`, and publish the draft if necessary:

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
  bun run typecheck
  bun run build
  bun run test
  mkdir release
  npm pack --ignore-scripts --pack-destination release
)
gh release upload "v$version" \
  "$recovery_path/release/agent-profile-kit-$version.tgz"
gh release edit "v$version" --draft=false
git worktree remove "$recovery_path"
git worktree prune
```

Stop if the commit identities differ or an asset already occupies that name;
do not move the tag or overwrite the artifact. If the attached build is
defective, preserve that version for provenance, fix forward with a new patch
version, and mark the defective Release as a prerelease with an explanatory
note.
