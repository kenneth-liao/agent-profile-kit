# Migration fixture: apkit 0.238.0, six agents, unchanged outputs

The old engine is deleted from this repository, so `apkit migrate` is tested
against receipts the published 0.238.0 package wrote (#753, SRC-25a). The
content is neutral.

- `workspace/`: the content of `test/retained/compat-0.237.0/` with an extra
  `apkit-workspace.yaml`. It has both marker files, so 0.238.0 and the current
  engine both accept it. The `workspace.yaml`-only journeys (#756) delete
  `apkit-workspace.yaml` from their copy.
- `pristine/`: the Project before the old install. It holds the user's own
  `README.md`, `docs/notes.md`, and `.claude/settings.json`; that last file
  keeps `.claude/` from being removed.
- `project/`: the same Project after the old install, without `.git`.
- `git-info-exclude`: the Project's `.git/info/exclude` after the old install.
- `home/.agents/agent-profile-kit/`: `config.yaml` and `state/manifest.json`
  as 0.238.0 wrote them. The one change is that the generation root is replaced
  with `{{ROOT}}`. The output hashes do not depend on it. The lock and the
  operation history are left out.

`test/migration.ts` copies all of this into a fresh temporary folder,
initializes both Projects as Git repositories, and restores the exclude file
and the modes 0.238.0 had (folders 0755, files 0644). On Windows only, it
re-records each output's mode and hash from the copied tree, because a mode
recorded on macOS can never match there. The engine always compares exactly,
as 0.238.0 did. Hash compatibility with 0.238.0 is therefore proven on macOS
and Linux. `.gitattributes` keeps these bytes the same on every checkout.

## How it was made (2026-11-03, macOS, Node 22.23.4)

The package is `npm pack agent-profile-kit@0.238.0`. Its integrity is
`sha512-KdP2dYTzKe/uhzqPMHcZ2wE1Ng69qTEJBceuSdZ7JMH58nRLGB9v6elhV0+ifiy0UsULbpL0/lJIMD3AHZFRCA==`
and the tarball's SHA-256 is
`7073f77fbe9331848ac2e41fcdba16a57e12e198bab21dd64fdc3f6ae3fe46bc`.

The commands ran in a fresh `mktemp -d` root `$R`, with the Project holding
the `pristine/` files and `git init`. Do not pass `~` under `env -i`: the outer
shell expands it to the real home folder.

```sh
OLD="env -i HOME=$R/home PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin TERM=dumb node package/dist/cli.js"
(cd "$R/home" && $OLD init "$R/workspace")
(cd "$R/project" && $OLD install engineering --agent antigravity --agent claude \
  --agent codex --agent grok --agent opencode --agent pi --auto-confirm)
```
