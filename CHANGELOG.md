# Changelog

All notable changes to this repository are documented here.

The format follows Keep a Changelog, and this repository uses Semantic Versioning once versioned packages or tools are introduced.

## [Unreleased]

### Fixed

- Author canonical structured inline parts across adapter capability failures, diagnostics, Git exclusions, lifecycle normalization, and reconciliation rather than dropping them or searching composed messages ([#428](https://github.com/kenneth-liao/agent-profile-kit/pull/428)).

### Removed

- Delete the legacy string presentation pipeline: the regex categoriser, English prefix table, copyable-value substring protector, and string wrapping path are removed now that every human view flows through presentation documents and the pure renderer with atomic inline parts ([#391](https://github.com/kenneth-liao/agent-profile-kit/issues/391)).

### Added

- Migrate root help, machine help, per-command help, the guide index, focused guides, and complete guide files onto the presentation document, and render every CLI-boundary diagnostic (including stderr) through the same document and renderer. Diagnostics now present what happened, why, and what to type as one readable sentence — errors that shattered into one line per protected value read as a sentence again — with usage as an atomic command node and wording carried over unchanged. Authoring and teardown receipts (init, bind, unbind) also render as documents with authored categories. The machine JSON surface is byte-identical, exit codes are unchanged, and snapshot diffs are limited to wrapping, eliding, alignment, colour extent, and the corrected sentence structure of previously shattered errors ([#390](https://github.com/kenneth-liao/agent-profile-kit/issues/390)).

- Migrate the inventory index and listings, machine details, validation, uninstall, and temporary installation views onto the presentation document and renderer. JSON, exit codes, and the string pipeline stay unchanged. Snapshot diffs are wrapping, eliding, alignment, and colour extent only ([#389](https://github.com/kenneth-liao/agent-profile-kit/issues/389)).

- Migrate apply receipts, blocked apply reports, and both apply failure views onto the presentation document and renderer. Each view presents exactly its baseline facts; snapshot diffs are wrapping, eliding, alignment, and colour extent only, the machine JSON surface is byte-identical, and exit codes are unchanged. In-process coverage asserts document structure ([#388](https://github.com/kenneth-liao/agent-profile-kit/issues/388)).

- Migrate lifecycle `status` human views onto the presentation document and renderer. JSON, exit codes, and other commands stay on the string pipeline. Snapshot diffs are wrapping, eliding, alignment, and colour extent only ([#387](https://github.com/kenneth-liao/agent-profile-kit/issues/387)).

- Add a typed presentation document and pure renderer beside the existing string pipeline, with atomic path/command layout, wrapped-line styling, row stacking, and verbatim reproduction. No command output changes ([#386](https://github.com/kenneth-liao/agent-profile-kit/issues/386)).

- Give location display an explicit fleet or project scope so application locations, fleet listings, and fleet-wide next actions use stable home-relative identities instead of cwd aliases ([#385](https://github.com/kenneth-liao/agent-profile-kit/issues/385)).

- Move every remaining Installer-authored tool-error sentence into presentation, keyed by typed error facts (DEC-020, #405). Missing Local Configuration, bind conflicts, stale-binding removal, duplicate Project Bindings, unsupported Agent Hosts (configuration, bind, and temporary installation), configured path-shape rejections, Local Configuration and Workspace Manifest parse rejections, portable-artifact (Context Module, Profile, Skill) parse rejections, Workspace ingestion failures, `init` Workspace validation, and the reachable `remove-temp` identity errors now cross as typed records — kind plus non-prose evidence (path, Project, Host, supported-Host list, or a nested typed fact) — and `cli/error-wording.ts` is the single home of every carried sentence, carried over verbatim. Machine tool-error JSON, exit codes, and on-screen wording are unchanged; per the #405 decision the newcomer lens is not applied to tool-error sentences, so human output renders the same carried sentence. Inventory `problem` fields carry typed facts and presentation composes their sentences, so no per-binding prose is composed at ingestion, and `INTERNAL_ONLY_DEFAULT_TERMS` covers the vocabulary these error surfaces carry ([#405](https://github.com/kenneth-liao/agent-profile-kit/issues/405)).

- Move Blocker and error wording out of the Installer into presentation, keyed by the typed `BlockerKind` (DEC-020). Blockers now carry typed facts only — kind, scope, Project identity, affected items, plus per-kind non-prose evidence (occupation type, ownership action, adapter remedy key, discriminated ownership/removal failure facts, foreign diagnostic detail) — and prose fields are rejected at the normalization boundary, so the Installer cannot emit a user-facing sentence. Blocked temporary-installation output renders each Blocker's remedy with its runnable command, Installer-composed tool errors (`ProjectTargetError`) carry typed reasons that presentation renders, and human rendering substitutes the guarded "generated output" term reachable through foreign diagnostics. The new `cli/blocker-wording.ts` lexicon is the single home of every problem, requirement, and remedy sentence: the machine JSON publishes the stored sentences verbatim with an unchanged field shape and schema versions, while human rendering substitutes internal domain terms with the newcomer lexicon (for example "Project Binding" becomes "configured Project", "Installation State" becomes "installation record") and appends a runnable command where the carried remedy names none. Every surviving Blocker kind renders a remedy containing a runnable command, the vocabulary guard now covers Blocker and error surfaces across every command including failure paths, and the helper that stripped a Project path out of a composed message is deleted — Project identity is a typed field on the Blocker ([#382](https://github.com/kenneth-liao/agent-profile-kit/issues/382)).

- Read Ownership State at the previous schema version and ignore recorded legacy ownership-token output entries, republishing the current schema version on the next successful write without re-binding or re-applying. Downgrade note: a successful write republishes `schema_version: 7`, which the prior v6-only release cannot read — back up `~/.agents/agent-profile-kit/state/manifest.json` (and any Project's `~/.agents/agent-profile-kit/` state you moved) before running this version, and restore that backup before downgrading ([#374](https://github.com/kenneth-liao/agent-profile-kit/issues/374)).

- Add Pi parity for Temporary Profile Installations: `install-temp ... --host pi` accepts Pi through the canonical Host registry and the existing receipt-owned temporary lifecycle, preserving the Pi Adapter plan, Capability Contract, Repository Exclusion contribution, `trust-required` Host Setup Step, and idempotent `remove-temp` removal by durable identity ([#369](https://github.com/kenneth-liao/agent-profile-kit/issues/369)).

- Group semantic warnings across Projects in concise and verbose human lifecycle views with exact `(kind, message, consequence, copyableValues)` matching, reporting the affected-Project count in concise output and all affected Project paths in verbose output, while normalizing diagnostic messages at the Adapter ingestion boundary and retaining Project-nested warning records in machine JSON ([#354](https://github.com/kenneth-liao/agent-profile-kit/issues/354)).

- Group concise tracked-path Blocker evidence by deterministic immediate parent-directory prefix with lossless counts, and print the exact user-owned `git -C <project> rm -r --cached --` untracking command (bound to the Blocker's Project root, safely quoted, canonically ordered, never executed) in focused verbose `status` and `apply` views with recovery copy that preserves working files and retains the Project Binding alternative; ordinary concise and verbose views point to the focused diagnostics instead ([#353](https://github.com/kenneth-liao/agent-profile-kit/issues/353)).

- Extend the focused human `--blockers-only` view to `apply`: a partial `apply` renders its committed Apply Receipt and failed or still-pending Project identities as an ordered prefix before focused Blocker evidence, a globally blocked apply reports focused Blocker evidence with no writes and the existing blocked exit code, an apply with no Blockers renders the ordinary receipt view unchanged, and `apply --blockers-only --json` fails before lifecycle inspection with focused usage guidance (ADR-0024) ([#352](https://github.com/kenneth-liao/agent-profile-kit/issues/352)).

- Add a focused human `status --blockers-only` view: every global and Project Blocker in the selected scope with concise deterministic grouping and no unrelated lifecycle inventory; `--blockers-only --verbose` retains every affected item and complete Blocker field without unrelated sections, `--blockers-only --json` fails before lifecycle inspection with focused usage guidance, and a Blocker-free scope reports that outcome without ordinary inventory (ADR-0024) ([#351](https://github.com/kenneth-liao/agent-profile-kit/issues/351)).

- Treat a missing repository-local exclusion section, exclusion file, or safe Git exclusion parent during intentional-deletion retirement as an ordinary Safe Repair: when the active receipts and live target prove the complete post-retirement contribution union, `status` classifies the retirement as non-blocking pending work with no writes, and `apply` publishes the exact post-retirement union (or removes the Agent Profile Kit section when the union is empty) and retires the receipt through the existing atomic retirement transaction, with publication failure keeping retirement retryable; malformed or unsafe exclusion bytes, unprovable unions, and missing authoritative contributions remain Blockers ([#350](https://github.com/kenneth-liao/agent-profile-kit/issues/350)).

- Treat a Repository Exclusion Contribution whose target moved between two proven Git targets as an ordinary Safe Repair: when the active Installation Receipt, Marker, owned roots, otherwise-current desired write set, and both targets independently prove one exact two-target result, `status` classifies the move as non-blocking pending work and `apply` removes the recorded entries at the receipt-derived old target and publishes the re-derived entries at the topology-derived new target through the existing contribution pass, preserving every other contribution and unrelated byte; a missing, malformed, unsafe, or ambiguous old or new target remains a Blocker with no writes (ADR-0022) ([#349](https://github.com/kenneth-liao/agent-profile-kit/issues/349)).

- Treat stale Repository Exclusion Contribution entries at an unchanged, proven Git target as an ordinary Safe Repair: `status` classifies the correction as non-blocking pending work and `apply` atomically replaces only the proven installation's entries through the existing contribution pass when the active Installation Receipt, Marker, owned roots, otherwise-current desired write set, and live target independently derive one exact replacement; unprovable exclusion bytes, identity mismatch, and ambiguous target ownership remain Blockers, with byte-gate failures surfaced as distinct Blocker evidence ([#348](https://github.com/kenneth-liao/agent-profile-kit/issues/348)).

- Treat a provably missing Repository Exclusion Contribution as an ordinary Safe Repair: an existing installation that is now in a Git Project moves through read-only `status` and transactional `apply` without a Blocker when its active Installation Receipt, Marker, owned roots, live Project, untracked destinations, and Git target independently prove the exact contribution, and one exhaustive typed Safe Repair eligibility boundary now distinguishes every supported repair class (ADR-0022) ([#347](https://github.com/kenneth-liao/agent-profile-kit/issues/347)).

- Support updating an existing Project Binding in one command with `apkit bind --replace`, restating its Profile and Host set with an old → new receipt while reconciling generated output through the ordinary status/apply path ([#342](https://github.com/kenneth-liao/agent-profile-kit/issues/342)).

- Qualify complete OpenCode temporary profile installation, ordinary uninstallation, repository exclusion contributions, and documentation across all Host-facing surfaces ([#334](https://github.com/kenneth-liao/agent-profile-kit/issues/334)).

- Report safe Claude and OpenCode duplicate Skill discovery as a non-blocking Adapter diagnostic warning while preserving semantic equality across discovery roots ([#333](https://github.com/kenneth-liao/agent-profile-kit/issues/333)).

- Enforce explicit-only OpenCode Skill invocation through Artifact-ID-keyed global deny rules while preserving native explicit Skill commands, and record distinct Capability Contracts ([#332](https://github.com/kenneth-liao/agent-profile-kit/issues/332)).

- Load composed Profile Context for OpenCode through dedicated whole-file JSONC configuration referencing the owned Context document ([#331](https://github.com/kenneth-liao/agent-profile-kit/issues/331)).

- Add OpenCode as a supported Agent Host that installs allowed-invocation Skills through the qualified shared projection ([#330](https://github.com/kenneth-liao/agent-profile-kit/issues/330)).

- Add weekly grouped Dependabot updates for the npm/Bun dependency graph and SHA-pinned GitHub Actions, with both update streams passing through normal pull-request CI ([#283](https://github.com/kenneth-liao/agent-profile-kit/issues/283)).

- Retain complete supervised suite diagnostics in one explicit CI directory and upload them for 7 days only when the test step fails or is cancelled, while successful CI runs upload nothing and local runs keep private temporary diagnostics ([#281](https://github.com/kenneth-liao/agent-profile-kit/issues/281)).

### Changed

- Make `uninstall` proceed per Project instead of failing globally. Each Project is evaluated and removed independently: a Project whose owned output cannot be fully removed is reported as kept with its reason and skipped, every other Project is still fully removed in the same invocation, and a skipped Project alone never returns a tool error. A staging rollback failure is the one non-skippable per-Project outcome: it is raised as a tool error, every staged transaction is rolled back, Installation State is restored, and the staging tree is retained so no moved bytes are deleted while their receipt still claims them installed. Only removed Projects' receipts are retired from Installation State, so a kept Project stays installed with its exclusion entries intact. The result reports what was removed and what was kept, per Project ([#381](https://github.com/kenneth-liao/agent-profile-kit/issues/381)).

- BREAKING: collapse Safe Repair into the ordinary apply lifecycle. The typed Safe Repair classification, its eligibility gates, and the `installer/safe-repair.ts` boundary are deleted; a wholly absent owned generated file is now ordinary non-blocking pending work that `status` reports as `drifted output` and `apply` restores from the Workspace like any other write. `apply` records every write it performs in the Apply Receipt, including the replacement of a user-edited generated file: drifted and absent outputs are recorded as named `update` writes instead of uncounted attention items, in every invocation mode. The output reconciliation kinds `repair` and `drifted output` are removed from the machine surface, and the lifecycle JSON contract advances to `schemaVersion: 14` with unchanged exit-code meanings ([#380](https://github.com/kenneth-liao/agent-profile-kit/issues/380)).

- BREAKING: make Repository Exclusion Contribution derived, best-effort bookkeeping that can never block or require repair. `apply` rewrites the Agent Profile Kit-owned section of `.git/info/exclude` from the active receipts' recorded output roots on every run, preserving unrelated bytes; an emptied file, a modified or missing owned section, an unwritable target, a missing `info/` parent, or an unprovable Git topology each produce one warning and leave `status` and `apply` at exit 0 with generated material installed. `unbind` followed by `apply` removes the entries, and `uninstall` removes what it can and continues when it cannot; a non-Git Project installs identically apart from exclusion entries. The `repository-exclusion-contribution`, `repository-exclusion-target-unproven`, and `repository-exclusion-invalid` Blocker kinds are removed from the typed Blocker class, exclusion Safe Repair classes and their transactional staging are deleted, and receipts stop recording an exclusion target or entry list: Installation State publishes `schema_version: 9` and drops stored `repository_exclusion` fields on the next write — back up `~/.agents/agent-profile-kit/state/manifest.json` before running this version and restore that backup before downgrading ([#379](https://github.com/kenneth-liao/agent-profile-kit/issues/379)).

- BREAKING: move Temporary Profile Installation behind a machine-facing namespace, out of the newcomer's default command list. `apkit machine install-temp`, `apkit machine remove-temp`, and `apkit machine list temporary` carry the full capability with unchanged arguments, JSON payloads (the `command` field keeps the bare `install-temp`/`remove-temp` labels), exit codes, and receipt behavior; the machine namespace is listed only by `apkit machine --help`. Top-level `install-temp`, `remove-temp`, and `list temporary` fail fast with a pointer to the machine replacement, and default help, focused guides, and examples no longer surface them (DEC-019) ([#378](https://github.com/kenneth-liao/agent-profile-kit/issues/378)).

- Scaffold exactly the delivered Workspace artifact directories (`profiles`, `context`, `skills`) on `init` — no more `agents`, `hooks`, or `tools` placeholders — and leave pre-existing undelivered artifact directories present and untouched, with `validate` still passing (an absent artifact directory remains an empty category). Trim the README description and the `CONTEXT.md` glossary to delivered concepts only, dropping the Agent, Hook, and Tool entries and their supporting terms along with Installation Marker and Safe Repair; the migration note about obsolete Profile fields is retained ([#377](https://github.com/kenneth-liao/agent-profile-kit/issues/377)).

- BREAKING: make Agent Host capability probing advisory. Probe results classify Host capability for warning purposes only; they never gate planning, never gate writing, and never produce a Blocker. `status` performs no Agent Host process execution at all (Git process execution for repository topology is unchanged), reports Projects normally, and exits 0 when a Host CLI is absent from `PATH`. `apply` writes a Host's material even when that Host is missing or outdated — installing the Host later requires no re-apply — and emits one warning per Host per invocation, naming the Host and its required version, regardless of how many Projects select it. `install-temp` treats capability failures the same way. The `host-capability` and `host-capability-unclassified` Blocker kinds are removed from the typed Blocker class, and capability cases surface as `host-attention` warnings on the machine surface; the lifecycle JSON contract advances to `schemaVersion: 13` with unchanged exit-code meanings ([#376](https://github.com/kenneth-liao/agent-profile-kit/issues/376)).

- Make `unbind` retire the Project's active Installation Receipt in the same operation as the Project Binding, so no active receipt can outlive its binding. The retiring record keeps exactly the detail the receipt already held — nothing is added — while `apply` keeps its teardown authority: generated files remain until the next `apply`, which proves and removes them as it does for receipts orphaned by a supported hand edit, cleans the recorded exclusion contribution, and consumes the record. `status` reports the pending removal; `uninstall` ignores retired records, so it is unaffected by previously unbound Projects; re-binding then applying starts a clean lifetime without manual state editing. Installation State gains an optional `retired` receipt flag and publishes `schema_version: 8` on the next write; the prior release cannot read that version — back up `~/.agents/agent-profile-kit/state/manifest.json` before running this version and restore that backup before downgrading. `apply` also re-ingests Local Configuration under the lifecycle lock and fails closed when bindings changed while it was planning, so a concurrent `bind`/`unbind` can never resurrect an active receipt after its binding was removed ([#375](https://github.com/kenneth-liao/agent-profile-kit/issues/375)).

- BREAKING: remove the Installation Marker so the Installation Receipt is the sole ownership home. `apply` writes no Marker into any Project, removes a leftover Marker from an earlier version on the next `apply`, proves ownership from the active receipt's Project Binding scope alone, and adopts byte-identical output at planned destinations so a re-bound Project applies cleanly after a move; the `installation-marker` Blocker class no longer exists. Ownership continuity is anchored in the receipt's recorded hashes: changed extant roots with no recorded root still matching its recorded hash fail closed instead of being refreshed or removed, and Temporary Profile Installations block on any extant destination (including byte-identical ones) because their durable Receipt precedes publication ([#374](https://github.com/kenneth-liao/agent-profile-kit/issues/374)).

- Treat identity-proven generated output roots as disposable: drift reports as non-blocking pending `drifted output` work in `status`, `apply` replaces the whole proven root from current Workspace source, and removal paths remove drifted proven roots; identity, path-safety, and Git-ownership boundaries still block (ADR-0019, ADR-0022) ([#363](https://github.com/kenneth-liao/agent-profile-kit/issues/363)).

- Advance the `status`/`apply` lifecycle payload family to schema version 12: repository exclusion repairs add the `retiring-exclusion-section` class carrying the exact post-retirement union entries, and the `repository-exclusion-section-missing` Blocker kind is retired because a missing section, file, or safe parent during retirement is now a Safe Repair. Pre-1.0: automation consuming lifecycle JSON must accept schema version 12 and the retirement repair class ([#350](https://github.com/kenneth-liao/agent-profile-kit/issues/350)).

- Advance the `status`/`apply` lifecycle payload family to schema version 11: moved-contribution repair records carry the owning Installation ID, the explicit `currentTarget`/`nextTarget` pair, and the exact `current`/`next` contribution entries (ADR-0022). Pre-1.0: automation consuming lifecycle JSON must accept schema version 11 and the moved-contribution repair fields ([#349](https://github.com/kenneth-liao/agent-profile-kit/issues/349)).

- Advance the `status`/`apply` lifecycle payload family to schema version 10: stale-contribution repair records carry the owning Installation ID plus the exact current (`current`) and resulting (`next`) contribution entries, matching the sibling repository-exclusion change records (ADR-0022). Pre-1.0: automation consuming lifecycle JSON must accept schema version 10 and the stale-contribution repair fields ([#348](https://github.com/kenneth-liao/agent-profile-kit/issues/348)).

- Advance the `status`/`apply` lifecycle payload family to schema version 9: repository exclusion repairs carry their Safe Repair class and, for a missing contribution, the owning Installation ID (ADR-0022). Machine `outcome` is now `attention` (instead of `clean`) whenever any repository exclusion repair is pending, including the pre-existing section class; exit codes are unchanged. Pre-1.0: automation consuming lifecycle JSON must accept schema version 9 and the repair-record fields ([#347](https://github.com/kenneth-liao/agent-profile-kit/issues/347)).

- Use `repository-exclusion-contribution` as the only structured Blocker kind for receipt-owned Git exclusion evidence, replace Repository Exclusion Record language in every emitter, renderer, and machine payload, and advance the `status`/`apply` lifecycle payload family and the whole `install-temp`/`remove-temp` payload family (success receipt, blocked, tool error) to schema version 8, each versioning as one per-command family line (ADR-0023). The Blocker normalization boundary rejects the retired kind without a compatibility alias. Pre-1.0: automation consuming lifecycle or temporary-installation JSON must accept schema version 8 and the new kind; the temporary success receipt moves 2 → 8 and its tool-error envelope 1 → 8 ([#346](https://github.com/kenneth-liao/agent-profile-kit/issues/346)).

- Reduce the complete Profile Context envelope to compact Profile metadata plus normalized Context Module bodies with no generated per-module boundary markers, shared identically by Pi, Codex, Claude, and Grok while Antigravity keeps separate per-module always-on rules ([#326](https://github.com/kenneth-liao/agent-profile-kit/issues/326)). Upgrading changes every bound envelope hash, so `status` reports Context drift until `apply` refreshes each Project.

- Preserve authored YAML frontmatter comments and formatting when projecting disabled-invocation Skills, and unify the Claude and qualified shared Skill emitters ([#329](https://github.com/kenneth-liao/agent-profile-kit/issues/329)).

- Qualify the complete quiet, task-first newcomer journey through one packed CLI path and recapture the living first-run excerpts from that run ([#307](https://github.com/kenneth-liao/agent-profile-kit/issues/307)).

- Apply the maintained newcomer presentation lexicon across default views, help, inventory, and lifecycle summaries while preserving canonical domain terms on technical and machine surfaces ([#306](https://github.com/kenneth-liao/agent-profile-kit/issues/306)).

- Emit one invocation-wide next-launch readiness statement on successful changed apply using Profile-loading language and bound-Project-root guidance, naming one Profile when unambiguous and using a count when multiple Profiles changed, without splitting equivalent outcomes by exact Host set ([#305](https://github.com/kenneth-liao/agent-profile-kit/issues/305)).

- Group first-use Host setup guidance under one note with plain reasons in concise apply, deduplicating actions across Projects without path matrices, suppressing standing trust and root-launch guidance during routine updates, and omitting shared-path layout notes from concise output while verbose apply and JSON retain full step evidence ([#304](https://github.com/kenneth-liao/agent-profile-kit/issues/304)).

- Lead successful apply from its committed Apply Receipt impact before setup guidance, summarize affected Project and generated-file counts once in concise output, omit routine Git exclusion bookkeeping from concise success, and reserve "already current" exclusively for true no-op apply ([#303](https://github.com/kenneth-liao/agent-profile-kit/issues/303)).

- Keep concise pending, clean, and blocked status free of transition-triggered and standing Host Setup Steps while verbose status and JSON retain every Adapter-authored step and its typed provenance ([#302](https://github.com/kenneth-liao/agent-profile-kit/issues/302)).

- Make unblocked concise status one compact, scope-correct decision with routine generated paths and successful Git bookkeeping behind one matching verbose route, while preserving exceptional evidence and machine behavior ([#301](https://github.com/kenneth-liao/agent-profile-kit/issues/301)).

- Print the exact `apkit remove-temp <actual-id>` command after a successful temporary install, using the durable identity created by that operation while preserving removal and JSON behavior ([#300](https://github.com/kenneth-liao/agent-profile-kit/issues/300)).

- Derive successful validation guidance from the configured Project count: point to `apkit bind` when none exist and `apkit status` otherwise, while preserving warnings and read-only behavior ([#299](https://github.com/kenneth-liao/agent-profile-kit/issues/299)).

- Align focused initialization help and successful scaffold initialization on `apkit bind example --host codex`, deriving both routes from the existing scaffolded example Profile ([#298](https://github.com/kenneth-liao/agent-profile-kit/issues/298)).

- Replace optional or redundant inventory `Next:` actions with instructional usage guidance, including how to select a listed Host for a configured Project, while keeping inventory read-only and JSON unchanged ([#297](https://github.com/kenneth-liao/agent-profile-kit/issues/297)).

- Make Host inventory lead with the canonical Hosts supported for configured Projects, while keeping temporary-install eligibility in focused temporary help and unchanged JSON ([#296](https://github.com/kenneth-liao/agent-profile-kit/issues/296)).

- Simplify the no-topic inventory menu to show each topic and its description once, while keeping JSON guidance in focused `list` help ([#295](https://github.com/kenneth-liao/agent-profile-kit/issues/295)).

- Lead bare and root help with the four-step first run, then separate common commands from secondary inventory, teardown, machine-detail, and temporary-installation commands while keeping every command discoverable ([#294](https://github.com/kenneth-liao/agent-profile-kit/issues/294)).

- Install CI's frozen dependency graph with lifecycle scripts disabled after proving install, typecheck, build, supervised test, and package paths remain compatible, without adding dependency caching ([#282](https://github.com/kenneth-liao/agent-profile-kit/issues/282)).

- Run CI typechecking, production bundling, and script-disabled package creation once each, then reuse the actual archive across the supervised package and CLI boundary tests while keeping local scripts independently usable ([#280](https://github.com/kenneth-liao/agent-profile-kit/issues/280)).

- Skip the complete macOS CI gate for draft pull requests, run it immediately when a draft becomes ready, and prevent contributor-controlled checkout from retaining repository credentials while preserving the read-only `main` and ready-pull-request qualification contract ([#279](https://github.com/kenneth-liao/agent-profile-kit/issues/279)).

- Close the pre-1.0 Installation State migration window: runtime ownership reads now accept only strict schema-6 JSON, reject leftover YAML with focused 0.95.0 migration guidance, and remove legacy readers and retired receipt projections ([#257](https://github.com/kenneth-liao/agent-profile-kit/issues/257)).

### Removed

- Remove the leftover special-case error path for the removed `apkit preview` command, so `preview` invocations and `help preview` fall through to ordinary unknown-command handling ([#418](https://github.com/kenneth-liao/agent-profile-kit/issues/418)).

### Fixed

- Treat unprovable Git topology as a warning that never blocks installation: a Project whose authored Git common directory resolves through a symlink or non-directory component leaves `status` and `apply` at exit 0 with one warning and generated Profile Installation output written, while Repository Exclusion Contribution is skipped and the exclusion target's bytes stay unchanged. Proven worktree identity — root and Project-relative path — still reaches Adapters and tracked-path classification, so Git-tracked generated paths remain a Blocker for writing and teardown, and a corrupt Git boundary still fails closed ([#404](https://github.com/kenneth-liao/agent-profile-kit/issues/404)).

- Deduplicate Host capability warnings to one per Host per invocation: a missing or outdated Host CLI emits exactly one warning naming the Host and the strictest version it requires, regardless of Project count or distinct requirement messages, while Project-specific surface failures keep their distinct warnings per affected Project ([#403](https://github.com/kenneth-liao/agent-profile-kit/issues/403)).

- Read Ownership State at schema versions 6 and 7 — every version published from the v0.132.0 baseline — so upgrading directly from v0.132.0 keeps existing Installation Receipts working without re-binding or re-applying. Recorded legacy Marker output entries and stored `repository_exclusion` fields are ignored at the single ingestion boundary, and the next successful write publishes `schema_version: 9` ([#402](https://github.com/kenneth-liao/agent-profile-kit/issues/402)).

- Complete the presentation-boundary work from the first review cycle: ownership and temporary-removal failures cross as discriminated typed facts with malformed facts rejected at the normalization boundary; the blocker contract returns to a compile-time kind-discriminated union; blocked `machine install-temp`/`remove-temp` human output renders each Blocker's remedy with its runnable command; and `ProjectTargetError` carries typed reasons that presentation renders ([#382](https://github.com/kenneth-liao/agent-profile-kit/issues/382)).

- Second review cycle: Installer-classified Installation State read failures (retired legacy YAML, oversize state, receipts recording no outputs) cross as typed facts, with `detail` reserved for genuinely foreign diagnostics; runtime blocker normalization rejects cross-kind forbidden fields and invalid Project values; and machine tool-error JSON preserves canonical domain terminology while human rendering of `ProjectTargetError` uses newcomer wording ([#382](https://github.com/kenneth-liao/agent-profile-kit/issues/382)).

- Third review cycle: state-read failure facts ride on every reachable report and error surface — Project `state.reason` in lifecycle JSON and verbose human status is presentation-composed from the typed fact (restoring the pre-conversion machine values), and human `machine list temporary` errors render newcomer wording; runtime normalization rejects cross-kind fields and global Blocker projects by own-property presence, including explicit `undefined`; and a valid final symlink to a directory is accepted as a Project target again, with regression coverage ([#382](https://github.com/kenneth-liao/agent-profile-kit/issues/382)).

- Make residual `installation-ownership` Blocker evidence provenance-neutral, stating only what the evidence proves ([#363](https://github.com/kenneth-liao/agent-profile-kit/issues/363), [#364](https://github.com/kenneth-liao/agent-profile-kit/issues/364)).

- Remove the non-actionable Claude/OpenCode duplicate-Skill discovery warning at the OpenCode Adapter source ([#363](https://github.com/kenneth-liao/agent-profile-kit/issues/363)).

- Sort warning groups deterministically using canonical string comparison across kind, consequence, and JSON-encoded copyable values ([#354](https://github.com/kenneth-liao/agent-profile-kit/issues/354)).

- Bind the focused untracking command to the Blocker's Project root with `git -C` so the caller's working directory cannot target the wrong repository, and add `-r` so directory output roots untrack without a fatal recursion error ([#353](https://github.com/kenneth-liao/agent-profile-kit/issues/353)).

- Do not replay standing first-use trust or root-launch guidance when an established Project/Host pairing later gains additional Host-consumed output ([#324](https://github.com/kenneth-liao/agent-profile-kit/issues/324)).

- Restrict CI diagnostic uploads to exact failed or cancelled test-step outcomes and use attempt-unique artifact names so reruns cannot collide with retained diagnostics ([#281](https://github.com/kenneth-liao/agent-profile-kit/issues/281)).

## [0.95.0] - 2026-08-24

### Changed

- Publish all ordinary and Temporary Profile Installation ownership as strict schema-6 JSON receipts, with exact-byte self-validation, atomic replacement, bounded legacy YAML migration, aggregate directory roots, compact temporary tombstones, and per-receipt Git exclusion contributions. This is a pre-1.0 breaking change ([#254](https://github.com/kenneth-liao/agent-profile-kit/issues/254)).

- Define the final minimal ownership-receipt model, strict deterministic bounded JSON codec, and pure supported-YAML-to-final normalization boundary without changing runtime state publication ([#253](https://github.com/kenneth-liao/agent-profile-kit/issues/253)).

- Make `status` the complete apply-equivalent read-only plan with predictable Host capability blockers for pending work and Host attention for already-current output, and remove the separate `preview` command and lifecycle JSON variant with focused migration guidance. Lifecycle JSON advances to schema version 7. This is a pre-1.0 breaking change ([#252](https://github.com/kenneth-liao/agent-profile-kit/issues/252)).

- Let `apply --all` commit and freshly verify healthy Projects sequentially while leaving Project-scoped capability, ownership, destination, and Git blockers untouched; global blockers still stop every write, partial blockers exit `2`, and tool or verification failures retain committed-work evidence. Lifecycle JSON advances to schema version 6 for partial and failed execution results. This is a pre-1.0 breaking change ([#251](https://github.com/kenneth-liao/agent-profile-kit/issues/251)).

- Make `status` and `apply` target the bound Project containing the current directory by default, accept one explicit absolute or home-relative bound root, and require `--all` for fleet scope. Scoped commands isolate planning, Host probes, Git and ownership inspection, reconciliation, reporting, writes, and shared Git exclusion contributions from unrelated Projects. This is a pre-1.0 breaking change ([#250](https://github.com/kenneth-liao/agent-profile-kit/issues/250)).

- Render lifecycle text directly from nested global and Project records, with structured blocker evidence, typed warning values, and task-authored wording replacing the temporary flat report and regex vocabulary translation ([#249](https://github.com/kenneth-liao/agent-profile-kit/issues/249)).

### Added

- Add Antigravity Skill delivery through the qualified shared `.agents/skills/<Artifact ID>` projector, with distinct Skills-only/combined Capability Contracts, disabled-invocation preservation, ownership-safe lifecycle coverage, and consuming-Host evidence ([#231](https://github.com/kenneth-liao/agent-profile-kit/issues/231)).

- Add Antigravity as the `antigravity` Agent Host through `agy` 1.1.13+, delivering deterministic always-on Context rules under `.agents/rules` with module-boundary size blockers, Host-owned trust guidance, and the ordinary preview/apply/status/repair/deselection/uninstall lifecycle ([#230](https://github.com/kenneth-liao/agent-profile-kit/issues/230)).

- Add a qualified shared `.agents/skills/<Artifact ID>` projector for Codex that preserves package content and metadata, composes deterministic disabled-invocation policy for both Host fields, and emits structured project blockers for malformed or contradictory Codex policy before writes ([#228](https://github.com/kenneth-liao/agent-profile-kit/issues/228)).

- Qualify fleet-wide synchronization as one complete journey: an isolated packed 12-Project fixture (one shared Profile with a Context Module and a Skill, mixed Host sets, alternating Git and plain roots) proves a shared Skill update plus a Host addition renders the concise impact-first preview once per Host scope with one next action, applies with preview-consistent grouped receipts, and reports current with one standing reminder while verbose and JSON retain the complete evidence; deterministic operation instrumentation (`installer/qualification-instrumentation.ts`) enforces invocation-scoped budgets through the command layer for unique Profiles, Hosts, Projects, Git roots, and generated outputs (including apply's fresh post-commit verification passes and sequential writes); and `installer/benchmark.ts` records representative warm `validate`, `status`, `preview`, and changed-fleet `apply` samples as release evidence rather than CI timing gates. ADR-0017 records the invocation-scoped cache trust, bounded read concurrency, typed lifecycle impact taxonomy, and progressive-disclosure presentation boundaries, and `docs/USER-JOURNEY.md` records the final compact fleet lifecycle with the qualified warm samples and the shipped fleet-repetition gap UJ-31 ([#205](https://github.com/kenneth-liao/agent-profile-kit/issues/205)).

- Simplify successful `bind` and `unbind` receipts to compact task language: created and unchanged `bind` receipts keep the short Project identity with the visible Profile and Hosts and `apkit preview` next, routine `unbind` removal names the short Project identity, Profile, and Hosts, states that generated files remain until `apply` when an Installation Manifest still requires reconciliation and points to `apkit preview` (which presents the eventual global apply), and omits the Local Configuration location and redundant canonical-path repetition; exceptional authored-path recovery retains the recovery and configuration detail needed to act safely, while stored configuration, exit codes, and machine-readable state stay unchanged ([#204](https://github.com/kenneth-liao/agent-profile-kit/issues/204)).

- Collapse lifecycle summaries, next actions, and readiness so preview and apply finish with one compact actionable frame: successful summaries omit zero-value blocker and pending clauses, identical next actions collapse once while differing remedies stay scoped, successful apply reports the receipt without reprinting a verified-current Project matrix, no-op preview and apply state that everything is current once, and next-launch readiness groups Projects that share the same Profile, Hosts, and setup condition. `--verbose`, JSON, and lifecycle exit codes stay unchanged ([#203](https://github.com/kenneth-liao/agent-profile-kit/issues/203)).

- Separate change-relevant Host setup from standing constraints with typed provenance classified once at the Adapter boundary ([#202](https://github.com/kenneth-liao/agent-profile-kit/issues/202)): every Host Setup Step carries `transition` or `standing` provenance, and a transition step names the exact generated output whose addition, update, or repair makes it newly relevant (the Codex SessionStart hook approval names `.codex/hooks.json`). Preview presents transition-triggered steps only when the plan changes their output, apply presents change-relevant transition steps from the applied receipt plus a separate compact standing reminder, and status retains the standing reminder without replaying transition setup; no-op applies show no setup and blocked runs still suppress post-apply steps. Identical steps collapse across Projects with a deterministic affected-Project scope while distinct consequences and typed bound-project roots stay visible, `--verbose` retains every step as complete evidence, and lifecycle and temporary-installation JSON add the typed `provenance` and `output` fields to existing setup records without dropping flat evidence.

- Render shared fleet changes once with progressive Project scope: multi-Project preview, apply, and status concise views derive one impact-first presentation from the typed lifecycle impacts instead of repeating each shared Workspace change per Project — Workspace Skill/Context changes appear once with generated-file counts and a deterministic affected-Project scope (a complete short list, a count when every Project of the Profile/Host scope is affected, or a capped representative list with an explicit `--verbose` pointer to every Project), Project Binding and Host-specific changes stay in a distinct Project section, and member-level attention that impacts do not carry remains visible as Project exceptions; single-Project runs keep the recognizable Project-first detail and do not pay for fleet grouping, blocked runs keep blockers first ahead of any impact detail, the multi-Project apply receipt groups the same facts with preview-consistent symbols and counts, and `--verbose` and versioned JSON retain the complete per-Project and per-path evidence ([#201](https://github.com/kenneth-liao/agent-profile-kit/issues/201)).

- Inspect independent Projects with fixed bounded concurrency through one invocation-scoped scheduler shared by desired-state planning, reconciliation, and apply preflight/post-commit verification (`installer/project-scheduler.ts`): each independent per-Project read runs with a fixed product-policy limit of four concurrent tasks, concurrent results fold and sort by canonical Project so human and JSON ordering cannot drift with completion order, a read failure propagates and stops queued reads while global blockers still prevent any write, and apply writes, Installation State publication, Repository Exclusion publication, commit sequencing, stale removals, rollback, and recovery stay strictly sequential because the scheduler is a pure executor that holds no Project, Git, or filesystem evidence and only schedules independent reads ([#200](https://github.com/kenneth-liao/agent-profile-kit/issues/200)).

- Emit typed lifecycle impacts from reconciliation and publish the normalized facts in versioned lifecycle JSON: every Profile Installation is compared against its prior receipt provenance to produce deterministic impact records distinguishing Workspace Skill/Context additions, updates, and removals (complete proven multi-source sets only), Project Binding/Host selection changes, Adapter/capability changes, repairs and installation removals, receipt metadata-only changes, and unclassified exact generated-path changes; Artifact identity and cause are proven by normalized fingerprints and typed output origins, never inferred from generated paths, legacy receipts lacking provenance fall back to exact paths, and preview, the apply receipt, and the verified resulting state all share one canonical comparison ([#199](https://github.com/kenneth-liao/agent-profile-kit/issues/199)).

- Reuse one normalized ownership inspection per owned generated output within each reconciliation pass: ownership proof, member-level diagnostics, conflict detection, and output reconciliation items all consume the same invocation-scoped result (`installer/lifecycle-ownership-inspection.ts`), so each owned file is read and each owned directory walked at most once per pass while the Installation Marker is read once and shared by identity resolution and ownership proof; the cache key includes the complete expected output identity so a path proven against a different expected hash, mode, or member tree always re-inspects instead of reusing evidence classified for another manifest; only proven root absence is repairable while unreadable or otherwise unprovable directory inspection failures fail closed; missing files and members, content and mode drift, unexpected members, unsafe parents, and malformed Markers retain their exact fail-closed classifications; and apply keeps separate preflight, stale-removal, and post-commit ownership inspection passes so pre-write filesystem evidence can neither prove post-write state nor authorize removal ([#198](https://github.com/kenneth-liao/agent-profile-kit/issues/198)).

- Probe each unique machine-level Agent Host capability requirement once per lifecycle invocation: Claude, Codex, Grok, and Pi CLI executable/version evidence is resolved and floor-asserted at most once per distinct requirement set regardless of Project count, while Project-specific Host surface checks (CLI paths, Grok inspection topology, destination hostability) still run for every affected Project; missing, outdated, malformed, and supported results keep identical Project/global blocker semantics, probe evidence is discarded at command exit so a later invocation probes again, and reuse is available only through the invocation-scoped planning context ([#197](https://github.com/kenneth-liao/agent-profile-kit/issues/197)).

- Batch Git and Repository Exclusion inspection per lifecycle pass: each Project resolves Git topology at most once, each Git worktree root streams its index once without a fixed whole-output buffer and classifies planned destinations with binary search over that sorted listing (so neither Profile argv size nor repository index size depends on `execFile`/`maxBuffer` ceilings), and each shared Repository Exclusion target is read and parsed once while contribution identity, union semantics, tracked-output blocker scope/remedies/ordering, and fail-closed non-Git/linked-worktree/moved/missing/Git-failure behavior stay unchanged; apply keeps separate preflight and post-commit inspection passes so pre-write snapshots cannot prove post-write state; reuse is available only through the invocation-scoped Git inspection context and is discarded when the command exits ([#196](https://github.com/kenneth-liao/agent-profile-kit/issues/196)).

- Reuse Profile resolution, artifact fingerprints, Skill package source, composed Context, and Host projections within one lifecycle invocation when their complete normalized inputs match, so multi-Project fleets stop repeating identical Workspace work while desired outputs, blockers, ordering, and machine contracts stay unchanged; reuse is available only through the invocation-scoped planning context and is discarded when the command exits ([#195](https://github.com/kenneth-liao/agent-profile-kit/issues/195)).

- Record normalized artifact fingerprints and typed output origins in ordinary Installation Manifest receipt evidence: one schema transition advances the Manifest to v3, each resolved artifact carries a deterministic content fingerprint normalized at the planning boundary, every owned output declares zero, one, or multiple canonical Artifact origins without deriving identity from generated paths, exact-field validation rejects malformed, duplicate, or inconsistent provenance evidence, existing supported Installation State ingests and migrates provenance-absent manifests through the canonical state boundary while preserving Installation IDs, ownership hashes, Hosts, and Repository Exclusion contributions, and a legacy receipt remains usable and gains canonical provenance on its next successful ordinary apply without rewriting unchanged generated output ([#194](https://github.com/kenneth-liao/agent-profile-kit/issues/194)). **Rollback:** 0.67.x and earlier cannot read Installation State containing a manifest schema v3 (written by 0.68.0+). Before the first 0.68.0+ write that publishes state, retain a copy of `~/.agents/agent-profile-kit/state/manifest.yaml`; to downgrade, stop the newer CLI, restore that backup, and only then run the older binary.

- Qualify the complete CLI as one presentation system: every human surface (help, guides, inventory, info, lifecycle, errors, teardown, and temporary installation) receives one trusted terminal-presentation context read once at the CLI boundary, prose wraps to the interactive measure while copyable paths, commands, and identities stay whole on dedicated lines, redirected output remains deterministic and ANSI-free, and machine JSON and exit codes are unchanged. Record the responsive-terminal-presentation, read-only-inventory, and typed-blocker boundaries in ADR-0016, add a packed discovery-to-lifecycle acceptance journey covering root help → list Profiles/Hosts → bind → list Projects → preview/apply → current status → install-temp → list temporary → remove-temp, and extend the living user journey with the discovery and Temporary Profile Installation stages plus the shipped presentation gaps ([#173](https://github.com/kenneth-liao/agent-profile-kit/issues/173)).

### Changed

- Publish reconciliation as global Blockers plus one complete deterministic record per Project, with output consumers, structured warnings and copyable values, setup guidance, and Git exclusion work kept beside that Project; lifecycle JSON advances to schema version 5 with the same nested model and keeps applied work separate from freshly verified resulting state. Blocker messages are now derived projections of canonical structured evidence, while the existing human lifecycle presentation remains stable through a temporary typed projection ([#248](https://github.com/kenneth-liao/agent-profile-kit/issues/248)).

- Route Temporary Profile Installation capability checks, Project-surface checks, warnings, Capability Contracts, setup steps, and outputs through each eligible Host's canonical registered Adapter while preserving the temporary install/remove contract ([#247](https://github.com/kenneth-liao/agent-profile-kit/issues/247)).

- Route Grok capability probing, dynamic inspection, Project-surface validation, warnings, topology, setup, and output planning through its registered complete Adapter; ordinary Installer planning now iterates every selected Adapter without Host-specific fallback ([#246](https://github.com/kenneth-liao/agent-profile-kit/issues/246)).

- Route Pi and Antigravity capability probing, Project-surface inspection, warnings, output planning, Capability Contract selection, and setup steps through their registered complete Adapters without changing qualified native delivery; Installer legacy dispatch now remains only for Grok ([#245](https://github.com/kenneth-liao/agent-profile-kit/issues/245)).

- Introduce one canonical Host registry and complete ordinary-planning Adapter contract, migrate Claude and Codex capability probing, Project-surface inspection, warnings, output planning, Capability Contract selection, and setup steps behind that boundary, and retain explicit legacy dispatch only for Grok, Pi, and Antigravity ([#244](https://github.com/kenneth-liao/agent-profile-kit/issues/244)).

- Coalesce compatible multi-Host Adapter output solely by normalized physical identity—path, entry type, mode, and exact file bytes or complete directory tree—while retaining all consuming Hosts and descriptive provenance; physical disagreements remain deterministic pre-write conflicts ([#243](https://github.com/kenneth-liao/agent-profile-kit/issues/243)).

- Keep `uninstall` independent of Workspace and Project Binding input while removing all ownership-proven ordinary output and Git exclusion contributions, preserving bindings and Temporary Profile Installations, and reporting still-bound Projects as not installed and ready for `apply`. Intended-teardown records are no longer written or consulted; the inert persisted field remains until the final ownership-state contraction. This is a pre-1.0 breaking change ([#242](https://github.com/kenneth-liao/agent-profile-kit/issues/242)).

- Prove generated-directory ownership through one deterministic aggregate-root hash and report drift only at that generated root, while preserving fail-closed detection and complete-root repair rules. Member-level directory change items are removed from lifecycle reports and presentation, and lifecycle JSON advances to schema version 4 for the changed output-kind contract. This is a pre-1.0 breaking change ([#241](https://github.com/kenneth-liao/agent-profile-kit/issues/241)).

- Replace typed lifecycle impacts and artifact-causal fleet presentation with summaries derived directly from observable additions, updates, repairs, removals, blockers, and affected Projects. Lifecycle JSON advances to schema version 3 and removes the `impacts` collection while keeping applied work distinct from freshly verified resulting state. This is a pre-1.0 breaking change ([#240](https://github.com/kenneth-liao/agent-profile-kit/issues/240)).

- Remove the unsupported `agents`, `hooks`, and `tools` Profile fields. Profiles now contain exactly `id`, `context`, and `skills`; validation tells existing Workspace authors to remove obsolete empty placeholders. This is a pre-1.0 breaking change ([#239](https://github.com/kenneth-liao/agent-profile-kit/issues/239)).

- Migrate Pi Skills from `.pi/skills/<Artifact ID>/` to the qualified shared `.agents/skills/<Artifact ID>/` projection, coalescing Codex and Pi packages with complete consuming-Host evidence and ownership-safe migration. This is a pre-1.0 breaking change; retain a state backup before the first apply, then use the documented 0.81.0 uninstall → state restore → 0.80.x apply rollback procedure if needed ([#229](https://github.com/kenneth-liao/agent-profile-kit/issues/229)).

- Make the Blocker contract exhaustively structured: every Adapter and Installer emitter carries typed `kind`, `scope`, `problem`, `requirement`, `remedy`, and affected-item evidence from one closed typed vocabulary, message-only blockers can no longer be represented or emitted, and malformed internal blockers fail fast instead of degrading to a message. Lifecycle JSON and blocked `install-temp`/`remove-temp` JSON advance to `schemaVersion: 2` with each blocker serialized directly from its structured record, so no human-rendered prose must be parsed to construct machine output. Human default grouping and verbose completeness continue to derive from the same records, and exit codes, blocker ordering, ownership refusal, and Host behavior remain unchanged ([#172](https://github.com/kenneth-liao/agent-profile-kit/issues/172)).

### Fixed

- Recover supported high-alias YAML Installation State within explicit 8 MiB file and 100,000-alias expansion limits, keep hostile or oversized state fail-closed, and make every transitional YAML publication alias-free and exact-byte validated by the production reader before atomic replacement ([#238](https://github.com/kenneth-liao/agent-profile-kit/issues/238)).

- Make Antigravity Skill rejection mandatory at the desired-state boundary, preserve stable rule ordering limits, and document Host rollback requirements ([#230](https://github.com/kenneth-liao/agent-profile-kit/issues/230)).

- Use the process executor's canonical group-empty result for TERM-resistant descendant cleanup verification instead of treating a terminated orphan awaiting macOS process-table reaping as a live leak ([#211](https://github.com/kenneth-liao/agent-profile-kit/issues/211)).

- Keep Adapter capability evidence Adapter-owned at its host/path subset and translate it into the shared blocker affected-item vocabulary at the Installer boundary, so Adapters never import Installer-owned blocker types and out-of-vocabulary Adapter evidence is rejected loudly ([#172](https://github.com/kenneth-liao/agent-profile-kit/issues/172)).

- Use one shortest-unambiguous Project path presenter across every human command, including `unbind` teardown, temporary-installation receipts and Host Setup Steps, blocked `install-temp`/`remove-temp` output, and `uninstall` Git-exclusion targets, so bind, inventory, lifecycle, teardown, and temporary installation identify the same Project consistently without exposing canonical paths; blocked temporary-installation diagnostics fall back to a home-relative or full identity when the caller's working directory is inside the Project, preventing a bare `.` from losing the blocked message's subject; Local Configuration, Installation State, receipts, and JSON retain their existing canonical or authored paths ([#171](https://github.com/kenneth-liao/agent-profile-kit/issues/171)).

- Give every packed-CLI and PTY test child one bounded, diagnostic process-execution boundary: a shared async executor runs each launch as a process-group leader with a finite deadline, terminates the complete group within a short cleanup grace (escalating to SIGKILL) on timeout or cancellation, and returns one typed result distinguishing exit, signal termination, spawn failure, timeout, and cancellation with exit code, signal, error, captured output, and elapsed duration. Packed-CLI, PTY, restricted-PATH, environment, and Claude-parity helpers all delegate to it, and assertions report the available evidence instead of a bare `status: null` ([#191](https://github.com/kenneth-liao/agent-profile-kit/issues/191)).

- Turn the bounded process executor into the repository's canonical test command surface: `bun run test` performs exactly one full-suite run under a five-minute outer deadline, `bun run test:focused -- <arguments>` forwards explicit test paths and filters to one supervised run without shell interpolation, and `bun run test:stress` runs up to ten sequential full suites with a five-minute per-run deadline and a 25-minute aggregate deadline, stopping at the first failure, timeout, or interruption. Every command supervises Bun through the shared bounded executor, cleans up the complete process group on timeout or interrupt, emits one concise summary with the run number, duration, outcome, and retained diagnostic log location, and records structured exit, signal, spawn-error, timeout, and cancellation evidence per run. CI, the release workflow, the release runbook, and agent operating guidance now invoke only the canonical package scripts without restating timeout values or handwritten repetition loops ([#192](https://github.com/kenneth-liao/agent-profile-kit/issues/192)).

### Added

- Show delayed ephemeral progress for interactive long-running `status` and `preview` inspections after a short anti-flicker threshold, cleared before the final report so completed output stays clean; redirected human output, JSON, and non-interactive errors never contain progress bytes ([#170](https://github.com/kenneth-liao/agent-profile-kit/issues/170)).

- Make lifecycle and temporary-installation human reports width-aware for interactive terminals and wrap redirected human output at the deterministic 80-column default, while preserving copyable values and separating Host Setup Step actions from consequences ([#166](https://github.com/kenneth-liao/agent-profile-kit/issues/166)).

- Add TTY-safe semantic color and compact interactive branding while keeping redirected human output and JSON plain ([#164](https://github.com/kenneth-liao/agent-profile-kit/issues/164)).

- Add conventional focused-help aliases, canonical Host guidance, and bounded command suggestions for unknown commands ([#158](https://github.com/kenneth-liao/agent-profile-kit/issues/158)).

- Add read-only inventory topic discovery and `list projects` Project Binding views in human and versioned JSON forms ([#160](https://github.com/kenneth-liao/agent-profile-kit/issues/160)).

- Add read-only `list profiles` views with deterministic Profile IDs and selected Context Module/Skill counts in human and versioned JSON forms ([#161](https://github.com/kenneth-liao/agent-profile-kit/issues/161)).

- Add read-only `list temporary` views for active Temporary Profile Installation identity recovery in human and versioned JSON forms ([#162](https://github.com/kenneth-liao/agent-profile-kit/issues/162)).

- Add read-only `list hosts` views with canonical Host order and Temporary Profile Installation eligibility in human and versioned JSON forms ([#163](https://github.com/kenneth-liao/agent-profile-kit/issues/163)).

- Add read-only `info` human and versioned JSON views for the engine version and Workspace, Local Configuration, and Installation State locations ([#157](https://github.com/kenneth-liao/agent-profile-kit/issues/157)).

- Make root help responsive with workflow groups, width-aware two-line command entries, and terminal-aware wrapping ([#156](https://github.com/kenneth-liao/agent-profile-kit/issues/156)).

### Fixed

- Harden Temporary Profile Installation blocked errors to derive their legacy message projection and structured evidence from one canonical normalized collection, restore canonical Git exclusion blocker ordering, and separate unprovable Git target evidence from Repository Exclusion Record mismatches ([#169](https://github.com/kenneth-liao/agent-profile-kit/issues/169)).

- Correct command summaries and empty lifecycle output so uninstall describes removing proven Agent Profile Kit-owned output and no-Project status points to inventory/binding without repetition ([#165](https://github.com/kenneth-liao/agent-profile-kit/issues/165)).

- Harden interactive color gating for terminal capability, document `NO_COLOR`, and keep agent guides and machine output plain ([#164](https://github.com/kenneth-liao/agent-profile-kit/issues/164)).

- Avoid self-suggestions for known commands with non-help trailing arguments ([#158](https://github.com/kenneth-liao/agent-profile-kit/issues/158)).

- Accept trailing focused-help aliases after `help <command>` ([#158](https://github.com/kenneth-liao/agent-profile-kit/issues/158)).

- Handle nested root-help aliases, sanitize unknown-command diagnostics, and normalize focused-help parsing ([#158](https://github.com/kenneth-liao/agent-profile-kit/issues/158)).

- Keep Project inventory available when individual configured roots are invalid, centralize inventory topic metadata, and include engine provenance in JSON ([#160](https://github.com/kenneth-liao/agent-profile-kit/issues/160)).

- Report legacy Local Configuration explicitly in `info`, keep error JSON Workspace-unknown, and document the versioned configuration state ([#157](https://github.com/kenneth-liao/agent-profile-kit/issues/157)).

- Harden root-help width guarantees and keep command/group metadata canonical across rendering and tests ([#156](https://github.com/kenneth-liao/agent-profile-kit/issues/156)).

### Changed

- Migrate remaining Installation State, Git exclusion, reconciliation, and Temporary Profile Installation blockers to complete structured evidence with typed classes, problems, requirements, remedies, scopes, and affected items, while preserving legacy lifecycle and temporary-installation projections, scope attribution, ordering, deduplication, exit codes, and fail-closed Git/output ownership guarantees ([#169](https://github.com/kenneth-liao/agent-profile-kit/issues/169)).

- Group tracked-output ownership conflicts into one typed Project-scoped blocker with complete per-path evidence, a single problem/requirement/safe-remedy explanation, and a deterministic capped affected-path list with an overflow pointer to `--verbose`; legacy lifecycle and temporary-installation projections keep their schema v1 shape, with the grouped conflict count preserved in the `message` projection ([#168](https://github.com/kenneth-liao/agent-profile-kit/issues/168)).

- Keep unexpected Adapter preflight failures distinct while centralizing capability evidence construction and preserving temporary-installation blocker projections ([#167](https://github.com/kenneth-liao/agent-profile-kit/issues/167)).

- Migrate Adapter Host capability and preflight blockers to structured evidence while preserving legacy lifecycle and temporary-installation projections ([#167](https://github.com/kenneth-liao/agent-profile-kit/issues/167)).

- Bare `apkit guide` now prints a concise topic index; the complete human guide is available at `apkit guide --full`. Scripts or agents that consumed the former full output should switch to `--full` ([#159](https://github.com/kenneth-liao/agent-profile-kit/issues/159)).
- Expand the shared blocker contract with normalized structured evidence while preserving legacy lifecycle and temporary-installation output ([#155](https://github.com/kenneth-liao/agent-profile-kit/issues/155)).
- Harden structured blocker fallback, validation diagnostics, migration deduplication, and blocked-report projection ([#155](https://github.com/kenneth-liao/agent-profile-kit/issues/155)).

### Added

- Add Claude Code Host parity for `install-temp` / `remove-temp`: temporary Profile preparation reuses the Claude Adapter plan, shares the versioned receipt protocol with Codex, and qualifies both Hosts through the packed CLI without launching either agent ([#136](https://github.com/kenneth-liao/agent-profile-kit/issues/136)).

- Make Temporary Profile Installations recoverable and contributor-safe: durable recovery identity before owned mutations, structured install failures that report `removalRequired` + `temporaryInstallationId`, disposable removal of modified owned roots, linked-worktree independence, and an Installation State lifecycle lock shared with `apply`/`uninstall` ([#137](https://github.com/kenneth-liao/agent-profile-kit/issues/137)).

- Add `install-temp` and `remove-temp` for temporary Codex Profile installation into one explicit Project, with a versioned JSON receipt (including Host Setup Steps and warnings) and idempotent removal ([#135](https://github.com/kenneth-liao/agent-profile-kit/issues/135)). Installation State advances to schema **v5** (`temporary_installations`). **Rollback:** 0.49.x and earlier cannot read a v5 state file. Before the first 0.50.0+ write that upgrades state, retain a copy of `~/.agents/agent-profile-kit/state/manifest.yaml`. To downgrade, stop the newer CLI, restore that backup, and only then run the older binary. Without a backup, restore is unsupported—do not hand-edit the state file; remove only known Installer-owned project outputs and temporary receipt-owned paths after verifying no other tool depends on them.

- Add `--json` machine output for `preview`, `apply`, and `status`, covering outcome, per-installation state, planned or committed paths, blockers, warnings, and Host Setup Steps ([#126](https://github.com/kenneth-liao/agent-profile-kit/issues/126)).

### Changed

- Make lifecycle exit codes uniform across `preview`, `apply`, and `status`: `0` no tool error and no blockers (JSON `outcome` may still be `attention`), `1` tool error, `2` blockers present. `status` no longer exits `0` while reporting blockers ([#126](https://github.com/kenneth-liao/agent-profile-kit/issues/126)).

- Require Codex CLI `0.145.0+` for Context-bearing Profile Installations and emit SessionStart hooks with `additionalContextLimit: 0` so complete Context is delivered directly ([#138](https://github.com/kenneth-liao/agent-profile-kit/issues/138)). Previously-working installs on older Codex (or without `codex` on `PATH`) fail preflight before writes; Skills-only Codex bindings are unchanged. `apply` remains all-project: one blocked Codex binding blocks writes for every other binding in the fleet. Recovery: upgrade Codex to `0.145.0+` and re-apply, or temporarily remove `codex` from the Project Binding, apply other Hosts, then restore the binding after upgrade.

### Fixed

- Shorten project-scoped concise blocker text through the shared project-path presenter, including stale-installation blockers ([#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)).

- Render bound project references through one shortest-unambiguous path presenter across `bind`, lifecycle blockers, warnings, Git exclusions, and verbose diagnostics, without changing stored project paths ([#152](https://github.com/kenneth-liao/agent-profile-kit/issues/152)).

- Use Darwin `O_EXLOCK` for the Installation State lifecycle lock so exclusive publication is kernel-identity-bound (no pathname stale-reclaim TOCTOU), require a matching Installation Marker before deleting extant temporary-owned roots, and delete disposable temporary roots in place without orphan stages ([#137](https://github.com/kenneth-liao/agent-profile-kit/issues/137)).

- Exclude `resume` from the Codex SessionStart Context Hook matcher so resumed conversations no longer duplicate Profile Context already present in rollout history; injection remains on `startup`, `clear`, and `compact` ([#139](https://github.com/kenneth-liao/agent-profile-kit/issues/139)). A resumed session keeps the Context it started with — start a new session or `/clear` (or wait for compact) to pick up an updated Profile. Existing installs keep the old matcher until the next `apply`, which rewrites `hooks.json`.

- Treat informational Host Setup Steps as requiring no user action and lock Grok's compatibility-disabled path at the Adapter seam ([#145](https://github.com/kenneth-liao/agent-profile-kit/pull/145)).

- Clarify mixed-fleet intended teardown status, canonicalize teardown Hosts, and keep uninstall Git-exclusion receipts concise ([#144](https://github.com/kenneth-liao/agent-profile-kit/pull/144)).

- Deduplicate combined content-and-mode member drift at reconciliation and make verbose Context fences collision-safe ([#143](https://github.com/kenneth-liao/agent-profile-kit/pull/143)).

- Make mixed-project guidance reflect the all-project apply gate, normalize global blocker scope, deduplicate verbose state explanations, and retain the current Project count ([#142](https://github.com/kenneth-liao/agent-profile-kit/pull/142)).

- Keep `init` next steps valid when adopting an existing Workspace, make example binding guidance project-scoped, and diagnose partial example removal ([#141](https://github.com/kenneth-liao/agent-profile-kit/pull/141)).

### Added

- Add conditional Grok shared-rule and Pi project-trust Host Setup Steps, and explicitly confirm when a changed installation requires no further Host setup ([#125](https://github.com/kenneth-liao/agent-profile-kit/issues/125)).

- Make deliberate teardown explicit: `uninstall` lists affected projects, removed generated paths, cleaned Git exclusions, and preserved Project Bindings; subsequent `status` reports intended teardown; and `unbind` recommends reconciliation only while installed output remains ([#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124)).

- Scaffold a bindable example Profile and Context Module on first `init`, add short `guide profile`, `guide context`, and `guide skill` topics, and prove the example through packed-CLI apply ([#121](https://github.com/kenneth-liao/agent-profile-kit/issues/121)).

- List reconciliation-plan paths with action markers in concise lifecycle reports, cap long lists with a `--verbose` overflow pointer, summarize Git exclusions in one clause, and make output-kind summaries exhaustive ([#120](https://github.com/kenneth-liao/agent-profile-kit/issues/120)).

- Name available Profiles in missing-Profile errors, turn empty Workspaces into an authoring next step, and make `validate` list Profiles and bound Hosts with grammatical counts ([#119](https://github.com/kenneth-liao/agent-profile-kit/issues/119)).

- Carry typed Host Setup Steps from Adapters through lifecycle reports, replacing the prior `validate` warning with conditional Codex hook review and approval, project trust, non-Git launch guidance, and next-launch activation messaging ([#118](https://github.com/kenneth-liao/agent-profile-kit/issues/118)).

- Lead blocked lifecycle reports with one actionable blocker, preserve command-specific retry guidance, and document the safe generated-file drift recovery loop ([#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117)).

- Identify project lifecycle blocks with short, unambiguous paths and the Hosts recorded by each Project Binding ([#116](https://github.com/kenneth-liao/agent-profile-kit/issues/116)).

- Add `--version`, conventional root-help aliases, complete per-command help, fail-fast leading-dash argument handling, and one canonical reusable example set ([#115](https://github.com/kenneth-liao/agent-profile-kit/issues/115)).

- Document the CLI user journey in `docs/USER-JOURNEY.md` with a stable-ID gap register covering 23 observed gaps, and record the placement decision in ADR-0013.
- Accept user-facing CLI presentation decisions — vocabulary layering, information design, Host Setup Steps, the `apkit` command name, `--json` and uniform exit codes, the teaching surface, and pre-1.0 versioning — in ADR-0014.
- Add one UI lexicon for task-focused default lifecycle wording, with exhaustive enforcement that keeps internal domain vocabulary in `--verbose` output ([#114](https://github.com/kenneth-liao/agent-profile-kit/issues/114)).

- Project Pi Skill projections now preserve disabled model-invocation policy with Pi-native frontmatter, explicit Artifact ID activation, invocation-specific Capability Contracts, and packed-CLI rejection coverage ([#104](https://github.com/kenneth-liao/agent-profile-kit/issues/104)).

- Make Pi Skill capability preflight settings-aware: benign global and project settings preserve static collision proof, while configured Skill paths, dynamic extensions, contributing packages, and unprovable relevant configuration fail closed without modifying Host state ([#103](https://github.com/kenneth-liao/agent-profile-kit/issues/103)).

- Install resolved allowed-model-invocation portable Skills for Pi under `.pi/skills/<Artifact ID>/`, preserving package bytes and modes, retaining dependency reasons, and failing closed on static discovery collisions, unsafe state, configured Pi settings, or disabled model invocation until #104 added Pi-native projection ([#102](https://github.com/kenneth-liao/agent-profile-kit/issues/102)).
- Add Pi as a project-bound Agent Host for Context-only Profile Installations through `.pi/APPEND_SYSTEM.md`, with Pi 0.82.1+ capability preflight and shared lifecycle reconciliation ([#101](https://github.com/kenneth-liao/agent-profile-kit/issues/101)).
- Guide users to the next lifecycle action on concise `status` and `preview` results: actionable status recommends read-only `preview` before `apply`, ready preview recommends `apply`, blockers direct resolve-and-retry of the same read-only command, and current or completed results omit redundant steps; multi-project outcomes emit one conservative aggregate instruction ([#90](https://github.com/kenneth-liao/agent-profile-kit/issues/90)).
- Explain concise lifecycle summary terminology: generated-output change units, short non-current Profile Installation state glosses (deduplicated across installations), and Git-local Repository Exclusion purpose while preserving exact path deltas; `--verbose` still exposes complete diagnostics from the same reconciliation report ([#89](https://github.com/kenneth-liao/agent-profile-kit/issues/89)).
- Install resolved portable Skills for Grok projects under `.grok/skills/<Artifact ID>/`, preserving package bytes/modes, projecting `disable-model-invocation` for disabled model-invocation policy, and fail-closed Skill discovery preflight across native, personal, compatibility, plugin, and configured sources ([#87](https://github.com/kenneth-liao/agent-profile-kit/issues/87)).
- Add Grok as a project-bound Agent Host for Profile Context via always-scanned `.grok/rules/` and Claude rules compatibility coalescing ([#86](https://github.com/kenneth-liao/agent-profile-kit/issues/86)).
- Explain every command in root `apkit` and `apkit --help` output, including a minimal `init` → `bind` → `preview` → `apply` Profile Installation quick start and a pointer to `guide` for deeper authoring; unknown commands and invalid arguments now name the error and show the relevant usage ([#88](https://github.com/kenneth-liao/agent-profile-kit/issues/88)).
- Repair wholly absent owned files and complete artifact directories from current Workspace source when the Installation Marker and every surviving output prove ownership ([#79](https://github.com/kenneth-liao/agent-profile-kit/issues/79)).
- Make Repository Exclusion Records the canonical machine-local ownership source for shared Git exclusion files, including deterministic unions, fail-closed validation, and transactional reconciliation ([#77](https://github.com/kenneth-liao/agent-profile-kit/issues/77)).
- Add concise, outcome-led `bind`, `preview`, `apply`, and `status` output with
  Profile Installation grouping, actionable ownership blockers, and explicit
  `--verbose` lifecycle diagnostics ([#70](https://github.com/kenneth-liao/agent-profile-kit/issues/70)).
- Accept an optional explicit Workspace path in `apkit init`, provisioning missing or empty destinations, adopting valid existing Workspaces, and failing closed on canonical selection conflicts ([#69](https://github.com/kenneth-liao/agent-profile-kit/issues/69)).
- Require an explicit Workspace selection in Local Configuration schema version 2; `init` records the conventional default or migrates supported version-1 configuration without implicit read-time migration ([#68](https://github.com/kenneth-liao/agent-profile-kit/issues/68)).

### Changed

- Add intended-teardown provenance to Installation State schema 4, retaining schemas 2 and 3 as non-mutating migration inputs until the next successful `apply` or `uninstall` ([#124](https://github.com/kenneth-liao/agent-profile-kit/issues/124)).

- Make member-level attention statuses authoritative in verbose output, deduplicate combined content-and-mode member drift at reconciliation, and delimit composed Context with collision-avoiding fences ([#123](https://github.com/kenneth-liao/agent-profile-kit/issues/123)).

- Map apply output from `Changes:` and `Resulting state:` to `Pending:`, map `Apply receipt:` to `Applied:`, remove the duplicate `No Projects need attention.` current-status line, keep state definitions behind `--verbose`, and name per-project next actions ([#122](https://github.com/kenneth-liao/agent-profile-kit/issues/122)).

- Derive default and verbose Git exclusion repair receipts from one canonical line shape ([#128](https://github.com/kenneth-liao/agent-profile-kit/pull/128)).

- Rename the published CLI command to `apkit`; the former `agent-profile-kit` executable is no longer installed. Existing Workspace bootstrap docs are not rewritten and may retain the obsolete command ([#113](https://github.com/kenneth-liao/agent-profile-kit/issues/113)).
- Treat Installation Manifest `engine_version` as provenance rather than desired state, so an engine version bump alone does not re-apply an otherwise-current Profile Installation ([#113](https://github.com/kenneth-liao/agent-profile-kit/issues/113)).

- Require Agent Profile Kit 0.34.0+ to read Pi invocation-capable `host_versions`; unbind Pi or re-apply/uninstall with 0.34.0+ before rolling back an invocation-capable installation ([#104](https://github.com/kenneth-liao/agent-profile-kit/issues/104)).

- Normalize repeated Host entries at Local Configuration and `bind` ingestion; authored Host order and duplicates now converge to the canonical supported-Host order ([#101](https://github.com/kenneth-liao/agent-profile-kit/issues/101)).
- Require Agent Profile Kit 0.32.0+ to read Pi Skill-capable `host_versions` in Installation State; unbind Pi and re-apply or uninstall with 0.32.0+ before rolling back ([#102](https://github.com/kenneth-liao/agent-profile-kit/issues/102)).
- Require Agent Profile Kit 0.31.0+ to read Installation State containing the `pi` Host; unbind Pi and re-apply or uninstall with 0.31.0+ before rolling back to 0.30.3 or older ([#101](https://github.com/kenneth-liao/agent-profile-kit/issues/101)).
- Keep schema-v2 Installation State readable through a one-time Repository Exclusion Record migration, publish schema v3 on the next successful lifecycle operation, and document downgrade/recovery guidance ([#77](https://github.com/kenneth-liao/agent-profile-kit/issues/77)).
- Document the required pre-migration Local Configuration backup and restore procedure for schema-v2 downgrade ([#68](https://github.com/kenneth-liao/agent-profile-kit/issues/68)).
- Document the 0.24.2 Installation State backup and pre-delete apply required for rollback and safe retirement of pre-0.24.2 non-Git installations ([#78](https://github.com/kenneth-liao/agent-profile-kit/issues/78)).

### Fixed

- Render Host Setup Step paths through the canonical path presenter, preserve Codex hook review, and suppress activation claims after no-op applies ([#132](https://github.com/kenneth-liao/agent-profile-kit/pull/132)).

- Preserve edited generated output after a Marker-proven project move and keep every blocked apply on the single actionable-report path ([#117](https://github.com/kenneth-liao/agent-profile-kit/issues/117)).

- Delegate Skill discovery, precedence, deduplication, and collision handling to Codex, Claude, Grok, and Pi Host Resolution; retain exact output and capability blockers while reporting detectable disabling or malformed Host configuration as warnings. Warning-only lifecycle results remain exit status 0, so automation that requires Host loading guarantees must inspect reported warnings ([#109](https://github.com/kenneth-liao/agent-profile-kit/issues/109)).
- Complete Pi static collision proof beneath managed Skill trees, cover Installer status preflight, and clarify Pi rollback floors for Context-only versus Skill-capable state ([#102](https://github.com/kenneth-liao/agent-profile-kit/issues/102)).
- Harden apply receipt/result reporting for verbose repairs, per-project output, and post-commit verification failures ([#97](https://github.com/kenneth-liao/agent-profile-kit/issues/97)).
- Report the verified post-apply Profile Installation state separately from the completed reconciliation receipt, including generated-output and Repository Exclusion work ([#97](https://github.com/kenneth-liao/agent-profile-kit/issues/97)).
- Treat omitted Codex lifecycle hook settings as default-enabled, honor `CODEX_HOME`, and fail closed on malformed or invalid hook settings while preserving explicit disablement, configuration precedence, and deprecated alias compatibility ([#84](https://github.com/kenneth-liao/agent-profile-kit/issues/84)).
- Report safely repairable output distinctly in compact lifecycle summaries and document its status vocabulary ([#83](https://github.com/kenneth-liao/agent-profile-kit/pull/83)).
- Retire intentionally deleted projects after exact-path `unbind` without requiring a vanished Installation Marker, while preserving shared Git exclusion ownership and failing closed on missing or drifted exclusion sections ([#78](https://github.com/kenneth-liao/agent-profile-kit/issues/78)).
- Surface Installation State restore failures during transactional apply and uninstall instead of silently discarding recovery errors ([#77](https://github.com/kenneth-liao/agent-profile-kit/issues/77)).
- Reconcile each Project Binding only at its exact canonical project root without enrolling sibling Git worktrees ([#76](https://github.com/kenneth-liao/agent-profile-kit/issues/76)).
- Reject Workspace selections that overlap Local Configuration or disposable installation state, including configured and symlinked paths ([#73](https://github.com/kenneth-liao/agent-profile-kit/pull/73)).

## [0.20.0] - 2026-07-16

### Added

- Recording-only `agent-profile-kit bind <profile> [project] --host <host>…` appends one validated Project Binding to Local Configuration (cwd or explicit path, required Hosts, idempotent identical records, fail-closed conflicts, atomic concurrent-safe publish) without reconciling project or Host state; ADR-0010 amended, architecture and guides distinguish authoring from global reconciliation ([#54](https://github.com/kenneth-liao/agent-profile-kit/issues/54)).
- Recording-only `agent-profile-kit unbind [project]` removes one Project Binding by canonical existing-path identity or exact authored spelling for a missing path, preserving Local Configuration safety and leaving generated output for global `preview`/`apply`; ADR-0010, architecture, README, and guides distinguish `unbind` from `uninstall` ([#56](https://github.com/kenneth-liao/agent-profile-kit/issues/56)).

- Optional Local Configuration `workspace` path selects one existing absolute or home-relative Workspace (symlinks resolved once at ingestion); omission retains `~/.agents/agent-profile-kit/workspace/`; `init` never creates or migrates a configured custom target; ADR-0007, glossary, architecture, and guides updated ([#51](https://github.com/kenneth-liao/agent-profile-kit/issues/51)).

- Verified the project-bound initial release candidate: permanent packed-CLI gates on real Node.js (version provenance, multi-Host lifecycle, install-inert package install, distribution boundary, fail-closed unsupported surfaces) plus neutral fixtures for model-invocation policy, Skills-only Profiles, global Skill identity collisions, and optional Workspace scaffolding. Blockers [#49](https://github.com/kenneth-liao/agent-profile-kit/issues/49), [#50](https://github.com/kenneth-liao/agent-profile-kit/issues/50), [#52](https://github.com/kenneth-liao/agent-profile-kit/issues/52), [#53](https://github.com/kenneth-liao/agent-profile-kit/issues/53), and [#55](https://github.com/kenneth-liao/agent-profile-kit/issues/55) are complete; Host qualification remains Codex [#33](https://github.com/kenneth-liao/agent-profile-kit/issues/33) and Claude [#43](https://github.com/kenneth-liao/agent-profile-kit/issues/43). Parent PRD [#27](https://github.com/kenneth-liao/agent-profile-kit/issues/27) ([#35](https://github.com/kenneth-liao/agent-profile-kit/issues/35)).

- Support Skills-only Profiles without Context machinery: a Profile must select at least one supported artifact overall (Context and/or Skills), but no category is mandatory; Skills-only bindings install only selected Skill packages and skip Context outputs and Context-related Host capability requirements; document CLI 0.17.0+ vs older Context-required ingestion for safe downgrade ([#55](https://github.com/kenneth-liao/agent-profile-kit/issues/55)).

### Changed

- Document that universal artifacts may remain canonical Workspace source while Profile selection drives only project-bound delivery; v1 does not own or mutate global Host paths, `status` may still report selected↔global Skill collisions as blocked (#53), and dual delivery fails closed ([#52](https://github.com/kenneth-liao/agent-profile-kit/issues/52)).

- Treat Workspace scaffolding as optional after initialization: only a supported `workspace.yaml` is required; missing artifact directories ingest as empty categories; bootstrap docs are never format requirements; document CLI 0.16.1+ vs older full-scaffold expectations for rollback ([#50](https://github.com/kenneth-liao/agent-profile-kit/issues/50)).

- Published the final project-bound public overview, Workspace guide, and agent workflow for init through native Host use, with packed CLI coverage of both bundled guides ([#34](https://github.com/kenneth-liao/agent-profile-kit/issues/34)).

### Fixed

- Fail closed when a selected project-bound Skill collides with a selected Host's personal/global Skill identity (Codex `~/.agents/skills` and `~/.codex/skills`, Claude `~/.claude/skills`), including identical bytes and Workspace symlinks; `status` reports later overlaps as blocked without mutating global material ([#53](https://github.com/kenneth-liao/agent-profile-kit/issues/53)).

- Reject dangling Workspace category symlinks as structural errors instead of treating them as empty categories ([#50](https://github.com/kenneth-liao/agent-profile-kit/issues/50)).

- Kept personal Workspace and generated migration content outside the public package and added packed-artifact boundary checks ([#16](https://github.com/kenneth-liao/agent-profile-kit/issues/16)).

- Record Claude Capability Contract `native-project-unscoped-rules-skills-v1` for installations that prove unscoped project rules and native Skill discovery ([#42](https://github.com/kenneth-liao/agent-profile-kit/issues/42)).

### Added

- Optional portable Skill model-invocation policy via `metadata.agent-profile-kit.model-invocation`, with Adapter-owned Host projection and capability preflight that rejects Host versions unable to enforce disabled implicit invocation ([#49](https://github.com/kenneth-liao/agent-profile-kit/issues/49)).

- Installed resolved portable Claude Skills at project scope under native `.claude/skills/<Artifact ID>/` discovery, with transitive dependency selection, inclusion reasons in preview and the Installation Manifest, sidecar omission, combined Codex/Claude Host ownership, and shared Context lifecycle ([#42](https://github.com/kenneth-liao/agent-profile-kit/issues/42)).

- Installed Profile Context for Claude Code as an unscoped owned `.claude/rules/agent-profile-kit.md` rule, with Claude-only and combined Codex/Claude bindings through the shared preview/apply/status/uninstall lifecycle and fail-closed Skills until Claude Skill delivery ([#32](https://github.com/kenneth-liao/agent-profile-kit/issues/32)).

- Installed resolved portable Codex Skills at project scope under native `.agents/skills/<Artifact ID>/` discovery, with transitive dependency selection, inclusion reasons in preview and the Installation Manifest, sidecar omission, and shared Context lifecycle ownership ([#31](https://github.com/kenneth-liao/agent-profile-kit/issues/31)).

- Extended Adapter plans and Installer reconciliation to own complete artifact directories as one ownership boundary, with member-level preflight, preview, transactional apply, and proven removal ([#39](https://github.com/kenneth-liao/agent-profile-kit/issues/39)).

- Added Git worktree expansion and repository-local generated-path exclusions while preserving safe project move, copy, and uninstall ownership ([#30](https://github.com/kenneth-liao/agent-profile-kit/issues/30)).

- Added deterministic global reconciliation with normalized multi-Adapter output plans, complete preflight reporting, independently transactional project updates, and ownership-proven removals ([#29](https://github.com/kenneth-liao/agent-profile-kit/issues/29)).

- Added project-bound Context-only Codex lifecycle with Local Configuration ingestion, preview/apply reconciliation, ownership-aware status, and safe uninstall ([#28](https://github.com/kenneth-liao/agent-profile-kit/issues/28)).

- Added typed, transitive cross-artifact Dependency resolution with deterministic plans and auditable Manifest inclusion reasons ([#7](https://github.com/kenneth-liao/agent-profile-kit/issues/7)).
- Initialized the Agent Profile Kit monorepo structure.
- Added the schema-versioned `agent-profile-kit init` CLI and npm executable contract ([#2](https://github.com/kenneth-liao/agent-profile-kit/issues/2)).
- Added bundled human and agent Workspace authoring guides ([#3](https://github.com/kenneth-liao/agent-profile-kit/issues/3)).
- Added Context-only Codex Profile validation, planning, installation, and launch ([#4](https://github.com/kenneth-liao/agent-profile-kit/issues/4)).
- Added transactional Profile Installation status, update, and verified uninstall lifecycle management ([#5](https://github.com/kenneth-liao/agent-profile-kit/issues/5)).
- Added standard Skill package ingestion and validation groundwork, including separate Agent Profile Kit sidecars ([#6](https://github.com/kenneth-liao/agent-profile-kit/issues/6)).
- Added the owned Codex Skill Library, transactional complete-Workspace projection, process-only Profile filtering, conflict protection, and shared lifecycle reporting ([#6](https://github.com/kenneth-liao/agent-profile-kit/issues/6)).

### Changed

- Replaced the unreleased per-session launcher and global Skill projection with native project SessionStart output ([#28](https://github.com/kenneth-liao/agent-profile-kit/issues/28)).

- Profiles now define observable artifact selection while Adapters may use different native delivery mechanisms per artifact category; Codex Skills use a shared owned projection without modifying existing Host state ([#6](https://github.com/kenneth-liao/agent-profile-kit/issues/6)).
- Marked the PR review follow-up skills for explicit invocation only.
- Simplified Workspace staging to clean only output owned by the running initialization process ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Simplified initialization warnings to their single concurrent-cleanup producer ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).

### Fixed

- Report missing repository-local exclusion ownership before repair and publish exclusion changes only after Manifest durability ([#38](https://github.com/kenneth-liao/agent-profile-kit/pull/38)).

- Made repairable-marker status and malformed-state apply errors precise, and decoupled reconciliation from report ordering ([#37](https://github.com/kenneth-liao/agent-profile-kit/pull/37)).

- Recover from interrupted Profile Installation replacement without blocking later updates ([#21](https://github.com/kenneth-liao/agent-profile-kit/pull/21)).
- Report an existing Profile Installation without modifying it ([#20](https://github.com/kenneth-liao/agent-profile-kit/pull/20)).
- Report incomplete Workspace structure with an actionable error without modifying user-owned source ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Preserve initialization failures when staging cleanup also fails ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Keep staging cleanup non-blocking, expose nested cleanup failures, and recognize valid symlinked Workspaces ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Make concurrent initialization converge and report empty Workspace symlink targets clearly ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Atomically replace empty Workspace directories and preserve concurrent-state validation failures ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Enforce initial macOS support at package installation and keep benign concurrent convergence non-blocking ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Quote optional shell commands safely and report unsupported Workspace schema versions with migration guidance ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Report malformed Workspace YAML with an actionable manifest error ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Distinguish malformed schema versions from supported-version migration failures ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Validate the Workspace Manifest path kind before reading it ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Add safe remediation guidance for dangling Workspace symlinks ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).
- Make empty Workspace symlink remediation actionable from the fixed path ([#18](https://github.com/kenneth-liao/agent-profile-kit/pull/18)).

### Removed

- Removed the unreleased `plan`, `install`, `update`, and `run` interfaces, launcher, leases, and global Codex Skill projection ([#28](https://github.com/kenneth-liao/agent-profile-kit/issues/28)).
