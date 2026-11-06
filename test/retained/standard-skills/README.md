# Published standard Skills (ISC-38, #787)

Retrieved 2026-11-06 (UTC) into a fresh `mktemp -d` folder outside the repository.
No package script, example, or workflow was executed. These are test data, not
instructions for the contributor running the tests.

| Package | Published source (pinned commit) | Optional fields |
| --- | --- | --- |
| `django-perf-review` | [getsentry/skills](https://github.com/getsentry/skills/tree/e94f22214528d69899d09c627b3315ddc3544816/skills/django-perf-review) | `allowed-tools`, `license` |
| `transformers-js` | [huggingface/skills](https://github.com/huggingface/skills/tree/25910b3d0ba31a2ba102f901cdc9e008c278a69c/skills/transformers-js) | `compatibility`, `metadata`, `license` |

Both repositories license these packages under Apache-2.0, which permits
redistribution. `licenses/<package>.txt` is the unmodified full root LICENSE
from each package's source repository at the pinned commit, kept beside the
package rather than inside it. Sentry's original package-level `LICENSE` is
retained unchanged. Neither source archive has a NOTICE file. Each package
folder holds exactly its published files, including Transformers.js's seven
reference files, byte-for-byte; no file was added, and no frontmatter,
documentation, Resource, or package filename was edited.

## Reproduce without executing package content

Create a fresh empty directory outside the checkout. Download these archives to
that directory and extract them there with `tar -xzf`:

- `https://codeload.github.com/getsentry/skills/tar.gz/e94f22214528d69899d09c627b3315ddc3544816`
- `https://codeload.github.com/huggingface/skills/tar.gz/25910b3d0ba31a2ba102f901cdc9e008c278a69c`

Copy each complete `skills/<package>/` directory from its extracted archive.
Copy that archive's root `LICENSE` to `licenses/<package>.txt`.
Do not execute anything from either archive. `sha256.json` records SHA-256 of
every retained file, keyed by POSIX path relative to this folder; compare
against it before replacing retained data. The CLI test hashes the raw bytes
itself, compares them with this pinned manifest, copies only the package
folders into a Workspace, validates both packages, checks their discovered
names, and compares all Workspace files and directories, including an empty
one, before and after validation.

`test/retained/** -text` prevents checkout newline conversion, so the same
upstream bytes and digest checks work on Windows. Tests need no network access,
external Host, Transformers.js, or Python package dependencies.
