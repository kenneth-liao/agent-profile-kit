# Agent Profile Kit

Agent Profile Kit is the shared language for an agent-independent system of reusable agent material and context.

## Language

**Agent Profile Kit**:
The open-source tool and format that composes reusable agent material into Profiles and adapts them for different Agent Hosts while each maintained fact retains one canonical home.
_Avoid_: Monorepo, universal agent runtime

**Agent Profile Kit Workspace**:
The user's single canonical source of Profiles, Context, and Skills consumed by Agent Profile Kit. It may own both Profile-selected artifacts and unselected universal artifacts; selection controls managed project delivery, not whether material is valid Workspace source. The fixed default path is `~/.agents/agent-profile-kit/workspace/`; current Local Configuration explicitly selects either that path or one existing absolute or home-relative Workspace path on this machine. `init <workspace>` may provision a missing or empty non-symlink destination before recording it, or adopt an existing valid Workspace. It may be a Git repository version-controlled independently of the tool.
_Avoid_: Open-source tool repository, Profile Installation, Host-global second source

**Workspace Manifest**:
The `workspace.yaml` file that marks a Workspace root and declares the Workspace schema version without listing or duplicating artifact content.
_Avoid_: Installation Receipt, Profile

**Agent Host**:
An agent product or environment that consumes Agent Profile Kit material, such as Antigravity, Codex, Claude Code, Grok, OpenCode, or Pi.
_Avoid_: Agent Profile Kit implementation

**Adapter**:
The single boundary that owns all host-specific knowledge for one Agent Host and translates Agent Profile Kit material without a portable native form into concepts that Host supports.
_Avoid_: Installer, canonical source, duplicate implementation

**Host Setup Step**:
A typed, Adapter-authored action a user must take in an Agent Host after generated output is applied, including the consequence of skipping it when one exists. Every step is classified once at the Adapter boundary as transition-triggered (caused by the current lifecycle transition and tied to the generated output that makes it relevant) or standing (a persistent constraint); presentation may order, filter, and render these steps but does not derive Host-specific requirements from installed files.
_Avoid_: Activation, generated output, Installer-derived Host guidance

**Capability Contract**:
The machine-readable set of behaviors an Adapter can preserve for a detected Agent Host version and surface. The Installer compares artifact requirements against this contract before installation.
_Avoid_: Best-effort compatibility, version number alone

**Host Resolution**:
An Agent Host's native discovery, precedence, deduplication, and collision behavior across Agent Profile Kit output and other Host-visible material. Agent Profile Kit relies on this behavior rather than reproducing it.
_Avoid_: Adapter-owned resolver, emulated Host inventory

**Installer**:
The mechanism that reads the Workspace and Project Bindings, combines Adapter output plans, and reconciles Profile Installations. Portable Skills are copied without changing their canonical content.
_Avoid_: Adapter, runtime router

**Profile Installation**:
A generated, host-native snapshot of one Workspace Profile installed into one bound project for all Agent Hosts selected by its Project Binding. The Installer exclusively owns its normalized output set; the Profile Installation is disposable output with no authority independent of its Workspace source. Matching durable installation identity — an active Installation Receipt — grants the Installer authority over each recorded generated output root; content differences from the recorded output are refreshable drift, not ownership changes, while identity or path-safety failures remain Blockers.
_Avoid_: Canonical source, live link, Temporary Profile Installation

**Temporary Profile Installation**:
Generated Host-native output for one Profile, one Host, and one explicit Project whose desired lifetime is owned by a temporary Installation Receipt rather than a Project Binding. It uses the same receipt shape, Adapter planning, output ownership, and Repository Exclusion Contribution machinery as an ordinary installation, creates no Local Configuration change, and is removed only through `remove-temp` by durable temporary installation identity.
_Avoid_: Project Binding, ordinary Profile Installation, global apply

**Output Ownership Conflict**:
A condition where reconciling a planned Profile Installation output would overwrite, adopt, or conflict with project material not proven to be owned by that installation. Same-identity material at a different Host-visible location is Host Resolution, not an Output Ownership Conflict.
_Avoid_: Host Skill collision, precedence conflict

**Blocker**:
A condition that prevents a lifecycle operation from proceeding. A Blocker is one exhaustively typed structured record (`kind`, `problem`, `requirement`, `remedy`, `scope`, and `affectedItems`) normalized at the Installer boundary, with a derived `message` projection retained for machine JSON. `scope: global` applies independently of one project; `scope: project` carries one canonical project identity that `problem` does not duplicate. Machine JSON publishes the structured evidence and derived message directly; human views render the structured fields and derive grouping and verbose completeness from the same record.
_Avoid_: Warning, reconciliation item, Output Ownership Conflict

**Apply Receipt**:
The pre-apply ReconciliationReport retained after a successful apply. It represents `Applied` generated-output and Repository Exclusion work; a separate post-commit reconciliation snapshot is authoritative for the resulting Profile Installation state and represents `Pending` work.
_Avoid_: Resulting state, pending report

**Host Bundle**:
A plugin, extension, or similar Agent Host-native package generated by an Adapter from canonical Agent Profile Kit artifacts.
_Avoid_: Canonical artifact, independent source

**Installation State**:
The durable machine-local JSON ownership evidence used to prove, move, repair, remove, and recover Profile Installations. It contains active Installation Receipts and compact removed-temporary identities, but is not canonical Workspace source or desired state independent of Workspace and Project Bindings.
_Avoid_: Disposable Profile Installation output, Workspace source, reconstructed Host inventory

**Installation Receipt**:
The single active ownership record for one ordinary or Temporary Profile Installation. It owns installation identity, lifetime, canonical Project, Profile ID, desired-input digest, one Host receipt map, generated output roots, and an optional Repository Exclusion Contribution. Directory roots retain one aggregate ownership hash and no member tree.
_Avoid_: Installation Manifest, presentation history, selected Context, generated output

**Repository Exclusion Contribution**:
One active Installation Receipt's exact repository-local exclusion target and entries, owned by that receipt rather than by any separately persisted record. The Installer derives the deterministic shared-target union at planning time, represented in code by the `RepositoryExclusionRecord` planning type (`repositoryExclusionRecords()`); that type names the derived union only and persists nothing. Structured Blockers use the `repository-exclusion-contribution` kind for this evidence.
_Avoid_: Repository Exclusion Record (as a separately persisted record), shared `.gitignore`, persisted target union, one exclusion owner per Profile Installation

**Artifact ID**:
The stable identity of a canonical Agent Profile Kit artifact, unique within its artifact type and independent of its organizational path or display name. A Skill's Agent Skills `name` is its Artifact ID.
_Avoid_: File path, display name

**Dependency**:
A required relationship from one canonical artifact to another. The Installer resolves Dependencies transitively, installs each Artifact ID once, and records every direct and transitive reason for its presence.
_Avoid_: Duplicate installation, Profile inheritance

**Credential Requirement**:
A semantic declaration that an artifact needs authenticated access, independent of how an Agent Host or system supplies it. Credential values never belong to Agent Profile Kit source or Installation State.
_Avoid_: Token, API key, host credential binding

**Local Configuration**:
The untracked source of machine-specific, non-secret values, including Project Bindings and the required explicit Workspace path, that bind canonical definitions to the current system. `init` records the fixed default Workspace path for zero-argument initialization or the authored path supplied explicitly; an existing selection cannot be silently switched to a different canonical Workspace. Older files without `workspace` are migration input only and are rejected by desired-state and binding-recording commands until `init` upgrades them.
_Avoid_: Canonical default, credential value, Profile

**Skill**:
The canonical package for a reusable agent workflow, conforming to the portable subset of the Agent Skills open standard. A Skill contains `SKILL.md` and may include supporting scripts, references, and assets.
_Avoid_: Capability, command, hook

**Context**:
Always-loaded declarative facts, preferences, and standing rules selected by a Profile to shape behavior across workflows without prescribing a workflow themselves. Profile Context explicitly defers to repository-owned project instructions when they conflict.
_Avoid_: Skill, procedure

**Context Module**:
An independently reusable unit of Context organized around one reason to change. Profiles select Context Modules, and Adapters compose them for an Agent Host.
_Avoid_: Profile, generated host instructions

**Skill Resource**:
A script, reference, or asset owned and used exclusively by one Skill.
_Avoid_: Tool

**External Capability**:
Functionality supplied by an Agent Host or the surrounding system that Agent Profile Kit material may require but does not own.
_Avoid_: Tool, Skill Resource

**Profile**:
An explicit named selection containing exactly an Artifact ID, Context, and Skills suited to a kind of work and reusable across projects. A Project Binding selects one Profile for a project, and Adapters add its material without replacing user-managed Host or project configuration. Agents, Hooks, and Tools are not implemented Profile selection categories.
_Avoid_: Agent, Agent Host, Profile Installation

**Project Binding**:
The machine-local association that selects one Profile and a set of Agent Hosts for exactly one explicit project root. Each project has exactly one Project Binding, separate from both the reusable Profile and the project's own configuration.
_Avoid_: Profile, project configuration, per-session selection

**Activation**:
The event or entrypoint that starts a Skill during use. A user request, command, model selection, or hook can provide an Activation.
_Avoid_: Skill, installation, source update

**Command**:
An Agent Host-specific, user-facing entrypoint that explicitly activates a Skill. A Command does not own workflow instructions independently of the Skill it activates.
_Avoid_: Skill, canonical workflow
