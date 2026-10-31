---
status: accepted
---

# Serialize writing runs with one lock per apkit home

Takes effect at cutover to the engine in `next/`.

## Context

Agents start several runs at once: installs into sibling worktrees, or an
`update --all` while an install runs. Each run reads shared state, changes it,
and writes it back. The shared state is the registry (`config.json`), the
global manifest, the user-level notes and Context sections, each folder's
manifest, and a repository's `.git/info/exclude`, which linked worktrees
share. Two runs that overlap lose a registry entry or an exclusion block, or
leave a manifest that does not match the files on disk (ISC-58, #744). The
engine must start no child processes (ISC-61) and must have no code path that
depends on the operating system (ISC-62). The released installer's lock uses
Darwin `O_EXLOCK`, so the engine cannot use it.

## Decision

1. **One lock per apkit home.** `init`, `workspace`, `install`, `update`,
   `remove`, and `setup` hold `<APKIT_HOME>/lock` from their first read to
   their last write. `status`, `check`, `guide`, and `help` do not take it.
   Runs that write take turns. A run always plans against the disk as the run
   before it left it.
2. **Taken in one atomic step.** A run writes its owner record (pid and a
   random token) to a temp file, then uses `link` to create the lock. `link`
   fails if the lock exists, so the lock never exists without its owner. On
   release, a run deletes the lock only if the lock still holds its token.
3. **A stopped run's lock is taken over.** If the owner's pid is not running
   (`process.kill(pid, 0)` sends no signal), a waiting run renames the lock
   aside. It then checks that the renamed lock still holds the stopped owner's
   token, and puts the lock back if it does not.
4. **Bounded wait.** A run waits up to 120 seconds. Then it fails and names
   the lock file to delete if no run is active.

## Considered Options

- **A lock for each shared file.** Rejected: every new shared file needs its
  own lock, and several locks need a fixed order to avoid deadlock. A
  per-file lock also leaves the plan-then-write gap open between files.
- **Merge-on-write records (one file per registry entry).** Rejected: it does
  not cover `.git/info/exclude` or a folder's manifest, which stay
  read-modify-write.
- **A heartbeat (mtime) to detect a stale lock.** Rejected: on a loaded
  machine a live run can miss its heartbeat, and another run then takes its
  lock.
- **OS file locks (`O_EXLOCK`, `flock`, `LockFileEx`).** Rejected: Node has no
  cross-platform API for them without native code (ISC-60, ISC-62).

## Consequences

- Runs that write at the same time finish one after another, not in
  parallel. Each run is short.
- If a stopped run's pid is reused by another process, the next run waits
  for the full timeout, and then the error names the lock file to delete.
- Two runs with different `APKIT_HOME` values are not serialized against each
  other, even when they write to one shared `.git/info/exclude`.
- *Amended 2026-10-30:* §3 no longer moves the lock aside. Moving it let a
  late run that had read the stopped owner move a live owner's lock, so a third
  run could take the lock while that owner still wrote. Now a run that finds a
  stopped owner first creates that owner's reclaim mark with `link`, which only
  one run can do. The run that holds the mark deletes the lock only if the lock
  still holds the stopped owner's token, then deletes the mark. No run moves or
  deletes a live owner's lock. If a run stops while it holds the mark, the lock
  stays until the wait ends, and the error names the lock file to delete.
