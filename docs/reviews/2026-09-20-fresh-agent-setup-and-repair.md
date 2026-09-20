# Fresh agent qualification: setup and repair — 2026-09-20

This observational review records fresh agent sessions executing setup from
scattered material (ISC-21) and repairing an invalid Workspace from validation
output alone (ISC-45), fulfilling the agent qualification requirements under
spec [#593](https://github.com/kenneth-liao/agent-profile-kit/issues/593) and
ticket [#609](https://github.com/kenneth-liao/agent-profile-kit/issues/609)
(TEST-012).

Observations only. See
[ADR-0029](../adr/0029-keep-dated-observational-reviews-in-docs-reviews.md):
findings here are one reviewer's observations of one build on one day, not
maintained backlog. Any actionable findings graduate to the issue tracker.

---

## 1. Limitations

The following limitations apply across the qualification sessions:

1. **Reasoning effort was `none`.** Both runs and all attempts were executed with
   OpenAI Codex CLI default reasoning effort (`none`, as confirmed by session
   headers). Higher reasoning effort was not tested.
2. **Run 1 prompt included a command name.** The Run 1 goal prompt ended with the
   clause `"so that \`apkit validate\` passes"`, naming an explicit CLI command
   rather than describing the goal purely functionally.
3. **Installation occurred outside the session.** Packaging and installation of
   `apkit` was performed outside the fresh agent runs because the release
   candidate bundle is unpublished. Agents received an environment note that the
   candidate was pre-installed on `PATH`.
4. **Run 2 Attempt 1 shared a home directory with Run 1.** Attempt 1 ran with the
   same `HOME` directory as Run 1, which already held a valid connected Workspace
   in Local Configuration. This revealed a UX finding (Finding 609-F1) but did
   not test repair in a fresh home. Attempt 2 addressed this defect in a
   completely isolated home directory.

---

## 2. Method, environment, and limits

| Item | Value |
| --- | --- |
| Engine under test | `agent-profile-kit` 0.217.0 (release candidate bundle built from `origin/main` commit `25f1b8c`) |
| Runtime | Node.js v22.23.2 (matching declared line `engines.node: >=22 <23`) |
| Date | 2026-09-20 |
| Platform | macOS (Darwin 25.6.0, arm64), zsh |
| Harness | OpenAI Codex CLI (`codex-cli 0.155.1`) |
| Model | `gpt-6-astra` (provider: `openai`) |
| Reasoning effort | `none` (observed from session headers) |
| Isolation | OS-enforced seatbelt sandbox (`-s workspace-write`), sandbox `HOME` in `/private/tmp` |
| Approvals | Automatic non-interactive execution (`-c approval_policy="never"`) |

### Packaging and installation
The release candidate was packed directly from `origin/main` (commit `25f1b8c`)
using the repository's canonical release-candidate pack sequence
(`test/support/package-archive.ts`):
1. `bun run build` (`tsc -p tsconfig.json --noEmit` followed by bundling `cli/index.ts` to `dist/cli.js` with `--target=node --packages=bundle`).
2. `npm pack --silent --ignore-scripts --json --pack-destination <dest>`.
3. The resulting archive `agent-profile-kit-0.217.0.tgz` was extracted into the sandbox, and an `apkit` wrapper script invoking Node v22.23.2 was placed first on `PATH`.

### Sandbox layout and confinement
All work was conducted strictly inside `/private/tmp/apkit-sandbox-609` (outside
this repository and outside `~/projects`), with:
- Run 1 and Run 2 Attempt 1: `HOME=/private/tmp/apkit-sandbox-609/home`
- Run 2 Attempt 2: `HOME=/private/tmp/apkit-sandbox-609/home-run2`
- Session `PATH` containing only the sandbox `bin` and system directories (host user bin directories were excluded).
- Credentials: `auth.json` copied to `$HOME/.codex/auth.json` with permissions mode 600; no `config.toml`, user rules, custom skills, plugins, memories, or MCP servers were provided. Credentials were deleted immediately following the final session.

### Confinement proof
Before any test run, confinement was proved with a throwaway probe session
(logged as a probe in the attempt log, not counted as a run). Its task was to
attempt to create `<HOST_HOME>/.apkit-609-probe` and `$HOME/inside-probe`.
- Write to host path `<HOST_HOME>/.apkit-609-probe` failed with `Operation not permitted` (OS seatbelt sandbox denial).
- Write to `$HOME/inside-probe` succeeded.
- Host check confirmed `<HOST_HOME>/.apkit-609-probe` was never created.

---

## 3. Pre-execution pass criteria

Written into the external attempt log (`attempt-log.txt`) before executing any
run:

### Run 1: Setup from README and Scattered Material (ISC-21)
A single fresh session given only the README link on `main`, a copy of the
scattered-sample material, an environment note that the release candidate is
pre-installed on `PATH`, and a one-sentence goal.
Pass criteria (all required without human intervention after prompt):
1. Sandbox Local Configuration (`$HOME/.agents/agent-profile-kit/config.yaml`) selects a Workspace.
2. `apkit validate` exits 0.
3. Every material file from `test/support/fixtures/scattered-sample/material` is present in that Workspace with its content intact:
   - `material/AGENTS.md`
   - `material/CLAUDE.md`
   - `material/docs/AGENTS.md`
   - `material/.claude/skills/code-review/SKILL.md` (with Host-specific frontmatter preserved)
   - `material/.agents/skills/build-helper/SKILL.md`
   - `material/.agents/skills/build-helper/references/reference.md`
   - `material/.agents/skills/build-helper/scripts/build.sh`

### Run 2: Repair of Invalid Workspace from Validation Output Alone (ISC-45)
A single fresh session given only an invalid Workspace path and the sentence to
make `apkit validate` pass; no README, no docs, network disabled.
Pass criteria (all required without human intervention after prompt):
1. `apkit validate` exits 0 for the workspace.
2. Valid material survived and was not deleted to silence errors (before-and-after tree check).

---

## 4. Verbatim attempt log

Retained verbatim from the external append-only log maintained outside the
repository at `/private/tmp/apkit-sandbox-609/attempt-log.txt`:

```text
# Agent Profile Kit — Issue #609 Fresh Agent Sessions Attempt Log
Date: 2026-09-20
Spec: #593 (TEST-012, ISC-21, ISC-45)
Harness: OpenAI Codex CLI (codex-cli 0.155.1)
Model: gpt-6-astra (provider: openai)
Release Candidate: Built from origin/main commit 25f1b8c, package version 0.217.0, Node v22.23.2

## Established Pass Criteria (Pre-execution)

### Run 1: Setup from README and Scattered Material (ISC-21)
A single fresh session given only the README link on main, a copy of the scattered-sample material, an environment note that the release candidate is pre-installed on PATH, and a one-sentence goal.
Pass Criteria (all required without human intervention after prompt):
1. Sandbox Local Configuration ($HOME/.agents/agent-profile-kit) selects a Workspace.
2. `apkit validate` exits 0.
3. Every material file from scattered-sample/material is present in that Workspace with its content intact:
   - material/AGENTS.md
   - material/CLAUDE.md
   - material/docs/AGENTS.md
   - material/.claude/skills/code-review/SKILL.md (with Host-specific frontmatter preserved)
   - material/.agents/skills/build-helper/SKILL.md
   - material/.agents/skills/build-helper/references/reference.md
   - material/.agents/skills/build-helper/scripts/build.sh

### Run 2: Repair of Invalid Workspace from Validation Output Alone (ISC-45)
A single fresh session given only an invalid Workspace path and the sentence to make `apkit validate` pass; no README, no docs, network disabled.
Pass Criteria (all required without human intervention after prompt):
1. `apkit validate` exits 0 for the workspace.
2. Valid material survived and was not deleted to silence errors (before-and-after tree check).

---
## Attempts

### Probe: Sandbox Confinement Verification
Timestamp: 2026-09-20T14:14:40-07:00
Purpose: Verify OS-enforced seatbelt confinement (writes outside sandbox fail, writes inside sandbox HOME succeed) with network access enabled.
Prompt: "Try to create <HOST_HOME>/.apkit-609-probe and $HOME/inside-probe and report both results."
Result: PASS
- Write to /Users/kennethliao/.apkit-609-probe failed with "Operation not permitted" (seatbelt sandbox confinement enforced).
- Write to $HOME/inside-probe succeeded.
- Verified on host: /Users/kennethliao/.apkit-609-probe was never created.

### Run 1: Setup from README and Scattered Material (Attempt 1)
Timestamp: 2026-09-20T14:15:10-07:00
Harness: codex-cli 0.155.1
Model: gpt-6-astra (provider: openai)
Network Access: Enabled (for fetching README)
Working Directory: /private/tmp/apkit-sandbox-609/run1/work
Prompt:
"""
Before running any other command, run:
echo "SANDBOX_PROOF: HOME=$HOME, CWD=$(pwd), APKIT=$(which apkit), APKIT_VERSION=$(apkit --version)"

The apkit release candidate is already installed on PATH as apkit, do not install or upgrade it.
README: https://github.com/kenneth-liao/agent-profile-kit/blob/main/README.md
Material: /private/tmp/apkit-sandbox-609/run1/material

Set up and connect a valid Agent Profile Kit workspace containing all of the material at /private/tmp/apkit-sandbox-609/run1/material so that `apkit validate` passes.
"""
Outcome: PASS
- Sandbox Proof: HOME=/private/tmp/apkit-sandbox-609/home, CWD=/private/tmp/apkit-sandbox-609/run1/work, APKIT=/private/tmp/apkit-sandbox-609/bin/apkit, APKIT_VERSION=0.217.0
- Reasoning effort: none
- Tokens used: 22,264
- Information sources used:
  * apkit --help
  * Web search for https://github.com/kenneth-liao/agent-profile-kit/blob/main/README.md
  * apkit guide --full, apkit init --help, apkit validate --help
  * curl https://raw.githubusercontent.com/kenneth-liao/agent-profile-kit/main/README.md
- Paths outside <SANDBOX> touched: none (all filesystem reads and writes confined to /private/tmp/apkit-sandbox-609)
- Pass criteria evaluation:
  1. Sandbox Local Configuration ($HOME/.agents/agent-profile-kit/config.yaml) selects /private/tmp/apkit-sandbox-609/run1/work: PASS
  2. apkit validate exits 0: PASS ("Workspace and settings valid (1 Profile, 0 configured Projects)")
  3. Every material file present with content intact: PASS (all 7 files verified byte-for-byte clean)
- Human intervention: none

### Run 2: Repair of Invalid Workspace from Validation Output Alone (Attempt 1)
Timestamp: 2026-09-20T14:16:30-07:00
Harness: codex-cli 0.155.1
Model: gpt-6-astra (provider: openai)
Network Access: Disabled (validation output alone)
Working Directory: /private/tmp/apkit-sandbox-609/run2/work
Target Workspace: /private/tmp/apkit-sandbox-609/run2/workspace
Prompt:
"""
Before running any other command, run:
echo "SANDBOX_PROOF: HOME=$HOME, CWD=$(pwd), APKIT=$(which apkit), APKIT_VERSION=$(apkit --version)"

Workspace: /private/tmp/apkit-sandbox-609/run2/workspace

Make `apkit validate` pass for the workspace at /private/tmp/apkit-sandbox-609/run2/workspace.
"""
Outcome: FAIL
- Sandbox Proof: HOME=/private/tmp/apkit-sandbox-609/home, CWD=/private/tmp/apkit-sandbox-609/run2/work, APKIT=/private/tmp/apkit-sandbox-609/bin/apkit, APKIT_VERSION=0.217.0
- Reasoning effort: none
- Tokens used: 5,468
- Information sources used:
  * Local filesystem (rg --files)
  * apkit validate (bare invocation without path)
- Paths outside <SANDBOX> touched: none (all operations strictly confined)
- Pass criteria evaluation:
  1. `apkit validate` exits 0 for the workspace: FAIL.
     The agent changed directory to /private/tmp/apkit-sandbox-609/run2/workspace and ran bare `apkit validate`.
     Bare `apkit validate` checks the connected Workspace in Local Configuration (/private/tmp/apkit-sandbox-609/run1/work),
     not `pwd`. Because Run 1 had successfully connected a valid workspace, bare `apkit validate` reported "Workspace and
     settings valid (1 Profile, 0 configured Projects)". The agent mistook this output as validating the current directory,
     concluded no changes were needed, and stopped.
     Actual validation of /private/tmp/apkit-sandbox-609/run2/workspace exits 1 with 8 violations unresolved.
  2. Valid material survived: YES (no files were modified or deleted).
- Root Cause: Product design / UX pitfall: bare `apkit validate` ignores `pwd` and validates the connected Workspace
  without indicating which directory was checked in the summary line ("Workspace and settings valid..."), giving false confidence
  when invoked from an invalid workspace folder.

### Pre-registration: Run 2 Attempt 2
Timestamp: 2026-09-20T14:21:00-07:00
Reason for second attempt:
Run 2 Attempt 1 executed with the same HOME as Run 1 (/private/tmp/apkit-sandbox-609/home), where Local Configuration already had Run 1's valid Workspace selected. Because #609 requires a fresh agent session in an isolated home, Attempt 1 did not meet the ticket's precondition, and ISC-45 has not yet been qualified in an isolated fresh home.

Hypothesis:
In a completely fresh home with no pre-existing Local Configuration, bare `apkit validate` will not find a connected workspace, forcing the agent to validate the target folder directly (via `apkit validate <path>` or `apkit validate .`) and repair the 8 seeded violations from validation output alone.

Controlled parameters:
- Prompt: Byte-identical to Attempt 1.
- Working directory: /private/tmp/apkit-sandbox-609/run2/work (byte-identical).
- Target Workspace: /private/tmp/apkit-sandbox-609/run2/workspace (rebuilt identically from recipe).
- Harness: codex-cli 0.155.1.
- Model: gpt-6-astra (provider: openai).
- Reasoning effort: none.
- Network Access: Disabled (validation output alone).
- Flags: `-s workspace-write -c approval_policy="never" --add-dir /private/tmp/apkit-sandbox-609 --skip-git-repo-check --ephemeral`.
- Isolation: New HOME /private/tmp/apkit-sandbox-609/home-run2 holding only .codex/auth.json (mode 600, deleted immediately after run). Previous workspace material (run1/), old home (home/), pack-stage/, and attempt-log.txt moved to /private/tmp/apkit-sandbox-609-hold/ outside the sandbox writable root so no completed workspace or notes are discoverable.
- Finality: The result of Attempt 2 is final either way, with no further attempts.


### Run 2 Attempt 2 Outcome: PASS
- Session ID: 01a0c0b1-90c2-7213-ae58-a769c4480871
- Duration: ~43s (started 14:21:08-07:00, completed 14:21:51-07:00)
- Sandbox Proof: HOME=/private/tmp/apkit-sandbox-609/home-run2, CWD=/private/tmp/apkit-sandbox-609/run2/work, APKIT=/private/tmp/apkit-sandbox-609/bin/apkit, APKIT_VERSION=0.217.0
- Reasoning effort: none
- Tokens used: 20,420
- Network access: OFF (seatbelt blocked by default)
- Information sources used:
  * Local CLI: `apkit --help`, `apkit validate --help`, `apkit guide --full`, `apkit guide --contract`, `apkit validate /private/tmp/apkit-sandbox-609/run2/workspace`
  * Local workspace inspection (`find`, `cat`, `rg`)
  * No external network access
- Changes made by agent:
  1. `workspace.yaml`: created with `schema_version: 1`
  2. `profiles/default.yaml`: removed redundant `id: default` and dangling `missing-context` reference
  3. `skills/broken-skill/SKILL.md`: added non-empty `description`
  4. `skills/build-helper/agent-profile-kit.yaml`: deleted retired sidecar file
  5. `context/invalid file name.md`: renamed to `context/invalid-file-name.md` (valid kebab-case ID)
  6. `context/notes.txt`: renamed to `context/notes.md` (valid markdown extension)
  7. `skills/stray-script.sh`: moved to `scripts/stray-script.sh` (valid non-skill directory, preserving script)
  8. `apkit init /private/tmp/apkit-sandbox-609/run2/workspace`: connected the workspace so bare `apkit validate` also succeeds
- Pass criteria evaluation:
  1. `apkit validate /private/tmp/apkit-sandbox-609/run2/workspace` exits 0: PASS.
  2. Bare `apkit validate` exits 0: PASS (`Workspace and settings valid (1 Profile, 0 configured Projects)`).
  3. Valid material survived: YES (all original content in `context/agents.md`, `context/claude.md`, `context/docs/architecture.md`, `skills/build-helper/`, `skills/code-review/`, and `profiles/default.yaml` preserved; renamed invalid context files and moved stray script preserved their contents).
```

---

## 5. Run 1: Setup from README and scattered material (ISC-21)

Supporting transcript: [`evidence/2026-09-20-fresh-agent-setup.txt`](evidence/2026-09-20-fresh-agent-setup.txt).

### Stated inputs and prompt
- README URL: `https://github.com/kenneth-liao/agent-profile-kit/blob/main/README.md`
- Material path: `<SANDBOX>/run1/material`
- Environment note: `The apkit release candidate is already installed on PATH as apkit, do not install or upgrade it.`
- Goal: `Set up and connect a valid Agent Profile Kit workspace containing all of the material at <SANDBOX>/run1/material so that apkit validate passes.`

Verbatim prompt:
```text
Before running any other command, run:
echo "SANDBOX_PROOF: HOME=$HOME, CWD=$(pwd), APKIT=$(which apkit), APKIT_VERSION=$(apkit --version)"

The apkit release candidate is already installed on PATH as apkit, do not install or upgrade it.
README: https://github.com/kenneth-liao/agent-profile-kit/blob/main/README.md
Material: <SANDBOX>/run1/material

Set up and connect a valid Agent Profile Kit workspace containing all of the material at <SANDBOX>/run1/material so that `apkit validate` passes.
```

### Transcript summary
1. **Environment verification**: The session proved its sandbox environment:
   `SANDBOX_PROOF: HOME=<SANDBOX>/home, CWD=<SANDBOX>/run1/work, APKIT=<SANDBOX>/bin/apkit, APKIT_VERSION=0.217.0`
2. **Discovery**: The agent ran `apkit --help`, checked files under `<SANDBOX>/run1/material`, fetched the README via web search and `curl`, and ran `apkit guide --full` to read Workspace authoring specifications.
3. **Initialization**: The agent ran `apkit init <SANDBOX>/run1/work`, creating Workspace scaffolding and recording `<SANDBOX>/run1/work` in Local Configuration (`<SANDBOX>/home/.agents/agent-profile-kit/config.yaml`).
4. **Preservation and structuring**:
   - Mapped `AGENTS.md` to `context/project-guidelines.md`.
   - Mapped `CLAUDE.md` to `context/claude-instructions.md`.
   - Mapped `docs/AGENTS.md` to `context/docs/architecture-guidelines.md`.
   - Copied both Skill packages (`.agents/skills/build-helper` and `.claude/skills/code-review`) to `skills/build-helper` and `skills/code-review`.
   - Created `profiles/engineering.yaml` referencing all Context Modules and Skills.
5. **Validation**: Ran `apkit validate` and confirmed:
   `Workspace and settings valid (1 Profile, 0 configured Projects)`.
6. **Integrity check**: The agent verified byte-for-byte identity and file permissions across all 7 source files. Host-side diffs confirmed all 7 files were clean.

### Information sources used and paths touched
- Sources other than apkit CLI output:
  - Web search for `https://github.com/kenneth-liao/agent-profile-kit/blob/main/README.md`
  - `curl` fetch of raw `README.md` from `raw.githubusercontent.com`
  - `apkit guide --full` (bundled documentation in packed CLI)
- Paths outside `<SANDBOX>` touched: none.

### Result
**PASS.** With zero human intervention, the fresh session initialized and connected the Workspace, cleanly organized the scattered material, and satisfied all validation rules while keeping every file intact.

---

## 6. Run 2: Repair of invalid Workspace from validation output alone (ISC-45)

### Seeded violations
The invalid Workspace in `<SANDBOX>/run2/workspace` was prepared with 8 violations across 7 categories:
1. Missing `workspace.yaml` manifest (`workspace-missing-manifest`).
2. Context Module with spaces in filename: `context/invalid file name.md` (invalid ID format).
3. Non-markdown file in `context/`: `context/notes.txt` (stray context file).
4. Profile with forbidden `id` field: `profiles/default.yaml` (`id: default`).
5. Stray script in `skills/`: `skills/stray-script.sh` (file outside skill package).
6. Missing skill description: `skills/broken-skill/SKILL.md` (missing description in frontmatter).
7. Legacy sidecar metadata: `skills/build-helper/agent-profile-kit.yaml` (retired sidecar).
8. Missing Context Module reference: `profiles/default.yaml` referencing `missing-context`.

When validated directly with `apkit validate <path>`, `apkit` emits actionable diagnostics describing every violation and its resolution.

---

### Attempt 1: Shared home execution (FAIL with Finding 609-F1)

Supporting transcript: [`evidence/2026-09-20-fresh-agent-repair.txt`](evidence/2026-09-20-fresh-agent-repair.txt).

#### Stated inputs and prompt
- Workspace path: `<SANDBOX>/run2/workspace`
- Goal: `Make apkit validate pass for the workspace at <SANDBOX>/run2/workspace.`
- Network: Disabled via OS-enforced seatbelt sandbox (no external web search, no package installation).
- Guides/Docs: None provided.

Verbatim prompt:
```text
Before running any other command, run:
echo "SANDBOX_PROOF: HOME=$HOME, CWD=$(pwd), APKIT=$(which apkit), APKIT_VERSION=$(apkit --version)"

Workspace: <SANDBOX>/run2/workspace

Make `apkit validate` pass for the workspace at <SANDBOX>/run2/workspace.
```

#### Transcript summary and failure mechanism
1. **Environment verification**: The session proved its sandbox environment:
   `SANDBOX_PROOF: HOME=<SANDBOX>/home, CWD=<SANDBOX>/run2/work, APKIT=<SANDBOX>/bin/apkit, APKIT_VERSION=0.217.0`
2. **Execution**: The agent changed directory into `<SANDBOX>/run2/workspace` and ran bare `apkit validate`:
   ```sh
   pwd; rg --files -g AGENTS.md ... /private/tmp/apkit-sandbox-609; apkit validate
   ```
3. **The failure**:
   - Bare `apkit validate` (without an explicit path argument) does **not** validate the current working directory (`.`). Instead, it validates the connected Workspace recorded in Local Configuration (`<SANDBOX>/home/.agents/agent-profile-kit/config.yaml`).
   - Because Run 1 had successfully initialized and connected `<SANDBOX>/run1/work`, Local Configuration pointed to that valid Workspace.
   - Bare `apkit validate` executed in `<SANDBOX>/run2/workspace` validated `<SANDBOX>/run1/work`, printing:
     ```text
     Workspace and settings valid (1 Profile, 0 configured Projects)
     Profiles found: engineering
     Hosts bound: none
     Next: apkit install <profile> --host <host>
     ```
   - The summary line `Workspace and settings valid` omitted the path of the Workspace it checked.
   - The agent saw the success message from `apkit validate` and concluded:
     "`apkit validate passes in <SANDBOX>/run2/workspace. Found 1 profile (engineering) and 0 configured projects. No changes were needed.`"
   - The session halted immediately, leaving all 8 violations in `<SANDBOX>/run2/workspace` untouched.

#### Before and after tree comparison
- Before tree: 13 files (including seeded violations).
- After tree: 13 files (identical).
- Valid material survival: All valid material survived (no files were deleted).
- Violations resolved: 0 of 8 resolved. Direct validation of `<SANDBOX>/run2/workspace` exits 1.

#### Result
**FAIL.** The session failed because bare `apkit validate` validated the connected Workspace rather than `pwd`, and the output suppressed the checked path, giving false confidence to the agent that the directory in `pwd` was valid (see Finding 609-F1).

---

### Attempt 2: Isolated home execution (PASS)

Supporting transcript: [`evidence/2026-09-20-fresh-agent-repair-attempt-2.txt`](evidence/2026-09-20-fresh-agent-repair-attempt-2.txt).

#### Pre-registration and environment isolation
As pre-registered in `attempt-log.txt`, Attempt 1 revealed a plan defect: it shared a `HOME` directory with Run 1, so Local Configuration already held a connected Workspace. Ticket #609 specifies a fresh agent session in an isolated home. Attempt 2 tested ISC-45 under strictly controlled conditions:
- **Clean HOME**: `/private/tmp/apkit-sandbox-609/home-run2` with permissions mode 700, holding only temporary Codex credentials (`auth.json`, mode 600, deleted immediately after the session).
- **Prior artifacts isolated**: All prior run directories (`run1/`, `home/`, `pack-stage/`) were moved outside the sandbox tree so no prior notes or completed workspaces were visible.
- **Identical parameters**: Identical prompt, harness (`codex-cli 0.155.1`), model (`gpt-6-astra`), reasoning effort (`none`), sandbox seatbelt flags, and network disabled.
- **Finality**: Pre-registered as final with no further attempts.

Verbatim prompt:
```text
Before running any other command, run:
echo "SANDBOX_PROOF: HOME=$HOME, CWD=$(pwd), APKIT=$(which apkit), APKIT_VERSION=$(apkit --version)"

Workspace: /private/tmp/apkit-sandbox-609/run2/workspace

Make `apkit validate` pass for the workspace at /private/tmp/apkit-sandbox-609/run2/workspace.
```

#### Transcript summary
1. **Sandbox proof**:
   `SANDBOX_PROOF: HOME=<SANDBOX>/home-run2, CWD=<SANDBOX>/run2/work, APKIT=<SANDBOX>/bin/apkit, APKIT_VERSION=0.217.0`
2. **Autonomous diagnosis**:
   - The agent ran `apkit --help`, `apkit validate --help`, `apkit guide --full`, and `apkit guide --contract`.
   - It executed positional validation: `apkit validate <SANDBOX>/run2/workspace`, receiving the 8 diagnostics emitted by `apkit`.
   - It inspected the workspace source files with `find` and `cat`.
3. **Execution of repairs**:
   - Stated reasoning: *"Validation found eight issues: a missing manifest, invalid file locations or names, outdated metadata, a missing skill description, and a profile reference to nonexistent context. I’ll fix those, preserve the script in a workspace-level `scripts/` folder, and connect this workspace so plain `apkit validate` works."*
   - Created `workspace.yaml` with `schema_version: 1`.
   - Edited `profiles/default.yaml` to remove the redundant `id: default` field and dangling `missing-context` reference.
   - Added `description: Placeholder skill with no workflow defined yet.` to `skills/broken-skill/SKILL.md`.
   - Deleted the retired sidecar `skills/build-helper/agent-profile-kit.yaml`.
   - Renamed `context/invalid file name.md` to `context/invalid-file-name.md` (producing a valid lowercase kebab-case ID).
   - Renamed `context/notes.txt` to `context/notes.md`.
   - Moved `skills/stray-script.sh` to a workspace-level `scripts/` folder (`scripts/stray-script.sh`), preserving the script without violating the skill package rule.
   - Initialized and connected the workspace via `apkit init <SANDBOX>/run2/workspace`.
4. **Validation**:
   - Positional validation `apkit validate <SANDBOX>/run2/workspace` exited 0:
     `Workspace valid (1 Profile, 5 Context Modules, 3 Skills)`
   - Bare `apkit validate` exited 0:
     `Workspace and settings valid (1 Profile, 0 configured Projects)`

#### Before and after tree comparison

Before repair (13 files):
```text
.
./context
./context/agents.md
./context/claude.md
./context/docs
./context/docs/architecture.md
./context/invalid file name.md
./context/notes.txt
./profiles
./profiles/default.yaml
./skills
./skills/broken-skill
./skills/broken-skill/SKILL.md
./skills/build-helper
./skills/build-helper/agent-profile-kit.yaml
./skills/build-helper/references
./skills/build-helper/references/reference.md
./skills/build-helper/scripts
./skills/build-helper/scripts/build.sh
./skills/build-helper/SKILL.md
./skills/code-review
./skills/code-review/SKILL.md
./skills/stray-script.sh
```

After repair (13 files):
```text
.
./context
./context/agents.md
./context/claude.md
./context/docs
./context/docs/architecture.md
./context/invalid-file-name.md
./context/notes.md
./profiles
./profiles/default.yaml
./scripts
./scripts/stray-script.sh
./skills
./skills/broken-skill
./skills/broken-skill/SKILL.md
./skills/build-helper
./skills/build-helper/references
./skills/build-helper/references/reference.md
./skills/build-helper/scripts
./skills/build-helper/scripts/build.sh
./skills/build-helper/SKILL.md
./skills/code-review
./skills/code-review/SKILL.md
./workspace.yaml
```

#### Valid material survival
Every piece of valid material was preserved:
- `context/agents.md`: content preserved.
- `context/claude.md`: content preserved.
- `context/docs/architecture.md`: content preserved.
- `context/invalid file name.md` & `context/notes.txt`: contents preserved under corrected names.
- `skills/broken-skill/`: preserved, with missing description added.
- `skills/build-helper/`: `SKILL.md`, `references/reference.md`, and `scripts/build.sh` preserved; only retired `agent-profile-kit.yaml` removed.
- `skills/code-review/`: `SKILL.md` preserved.
- `skills/stray-script.sh`: script preserved by relocation to `scripts/stray-script.sh`.
- `profiles/default.yaml`: preserved context selections (`agents`, `claude`, `docs/architecture`) and skill selections (`build-helper`, `code-review`).

#### Result
**PASS.** With network access completely disabled and relying solely on `apkit validate` diagnostic output and bundled guide contracts, the fresh agent cleanly diagnosed all 8 seeded violations, repaired them without loss of valid material, and left both positional and bare validation passing.

---

## 7. Findings and observations

### Finding 609-F1: Bare `apkit validate` suppresses the checked Workspace path and ignores `pwd`

- **Observed Behavior**: Running `apkit validate` without arguments inside an arbitrary folder validates the Workspace registered in Local Configuration, not the current working directory. Furthermore, the success output:
  ```text
  Workspace and settings valid (1 Profile, 0 configured Projects)
  ```
  does not name the Workspace directory that was evaluated.
- **Impact**: When an agent (or human operator) navigates into a folder containing a Workspace and executes `apkit validate`, any output reporting validity is ambiguous. In Run 2 Attempt 1, the agent navigated to the target Workspace folder, ran `apkit validate`, received a green exit code from the *other* (connected) Workspace, and falsely concluded that the local folder was already valid.
- **Recommendation**:
  1. In `apkit validate`, explicitly state the resolved Workspace path in both human and machine-readable output:
     `Workspace and settings valid at <path> (...)`
  2. Consider warning or prompting if `pwd` is an unconnected Workspace folder when bare `apkit validate` is invoked.

### Finding 609-F2: Workspace authoring contract is fully agent-navigable

- **Observed Behavior**: In Run 1, a fresh agent with no pre-existing knowledge or prompts was able to locate the Workspace contract via the README link and `apkit guide --full`, correctly construct the folder layout (`context/`, `skills/`, `profiles/`), map scattered files into valid IDs, and produce a clean Profile on its first attempt.
- **Impact**: Validates that ISC-21 and US-004 documentation enables autonomous agent migration from raw scattered materials to an Agent Profile Kit Workspace.

### Finding 609-F3: Autonomous repair from validation diagnostics alone (ISC-45)

- **Observed Behavior**: In Run 2 Attempt 2, a fresh agent in an isolated environment with network access disabled completely repaired an invalid Workspace from `apkit validate <path>` error messages and the bundled contract documentation (`apkit guide --contract`). All 8 seeded violations across 7 categories were resolved in a single iteration without destroying valid content.
- **Impact**: Validates that ISC-45 is satisfied: `apkit validate` diagnostics are self-contained, actionable, and sufficient for autonomous agent repair without external web access or human intervention.

---

## 8. Sanitization statement

In compliance with open-source publication rules:
- All paths referencing the sandbox root `/private/tmp/apkit-sandbox-609` have been replaced with `<SANDBOX>`.
- Raw evidence files under `docs/reviews/evidence/` were scanned for sensitive patterns (tokens, keys, account IDs, email addresses, host user paths). All matched patterns were verified absent.
