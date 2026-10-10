---
status: accepted
---

# Publish qualified releases publicly to npm

## Context

The release workflow and `docs/runbooks/github-release.md` were built for
private distribution: the repository was the confidentiality boundary, and the
workflow refused to run unless the repository was private. The repository is
now public, so that check blocks every release (#712).

npm distribution already started outside the workflow. #612 removed
`"private": true` from `package.json`, and `agent-profile-kit@0.204.1` was
published by hand. That package never passed release qualification, which
breaks ISC-13 (every published package is byte-identical to the package that
passed its required release qualification). The repository also has no license,
although `CONTEXT.md` describes an open-source tool.

## Decision

1. **Public distribution.** The repository, its GitHub Releases, and the npm
   package are public. Repository visibility is no longer a release gate.
2. **npm is the install channel.** The release workflow publishes the verified
   candidate tarball to npm. It also attaches that same tarball to a GitHub
   Release with the changelog notes. Both carry one artifact, identified by the
   candidate digest that the verification job recorded.
3. **Trusted publishing.** The workflow publishes through an npm trusted
   publisher bound to this repository and `release.yml`, with provenance. No
   npm token is stored. A manual `npm publish` is not a release path.
4. **MIT license.** The project is licensed under MIT.
5. **Existing releases stay.** `v0.95.0` was audited: its tarball is built from
   code that is already public in Git history, so it stays published.

## Considered Options

- **npm only, no GitHub Release.** Rejected: the Release page carries the
  changelog notes and a second copy of the same artifact at no extra build cost.
- **An `NPM_TOKEN` secret.** Rejected: a long-lived secret can publish any
  bytes, so it cannot guarantee that only the qualified tarball is published.
- **Keep manual publishing.** Rejected: it leaves ISC-13 unmet.
- **Apache-2.0.** Rejected in favour of the shorter, more common MIT for an npm
  CLI. The project needs no explicit patent grant.

## Consequences

- The private-release model in `docs/runbooks/github-release.md` and the
  "Private Release" names in `release.yml` are retired.
- Enabling the trusted publisher on npmjs.com is a human step by the package
  owner, done once before the first public release.
- `agent-profile-kit@0.204.1` stays on npm as an unqualified build until a
  qualified version replaces it as `latest`.
