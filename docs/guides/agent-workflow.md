# Agent Profile Kit agent workflow

Use this workflow when helping a person author their Workspace and bind projects.

1. Read this guide first. Then inspect the Workspace: start with `workspace.yaml`
   and its schema version. A valid Workspace needs only that Manifest; missing
   artifact directories are empty categories, and bootstrap files such as
   `README.md`, `AGENTS.md`, and `.gitignore` are optional scaffolding from
   `init`, not format requirements. Use `agent-profile-kit init` for the fixed
   default or `agent-profile-kit init <workspace>` for one explicit absolute or
   home-relative destination; missing and empty non-symlink destinations are
   scaffolded, while valid existing Workspaces are adopted without source
   changes. Inspect any present artifact directories next. Treat the Workspace
   as the canonical source; do not infer reusable material from generated Host
   output.
2. Elicit the user's needs one decision at a time. Establish the kind of work,
   the reusable facts or workflow they want, and whether existing material
   already satisfies the need. Ask instead of inventing personal preferences,
   project facts, Host preferences, credentials, or machine paths.
3. Create the smallest useful artifact set. This release accepts Context Modules
   and portable Skills for Codex, Claude Code, Grok, and Pi. Put standing facts in Context Modules and reusable procedures in
   Skills. A Profile needs at least one supported artifact (Context, Skills, or
   both); Context is not mandatory—a
   Skills-only Profile is valid on CLI 0.17.0+ (convert or uninstall before
   rolling back to older binaries; see the human Workspace guide). For Skills
   that must not fire implicitly, use
   `metadata.agent-profile-kit.model-invocation: disabled` (default is
   `allowed`); do not leave Host-native `disable-model-invocation` in
   Workspace source (Adapters project that field for Claude, Grok, and Pi). Profiles
   selecting Agents, Hooks, or Tools are rejected. Do not create a new artifact
   merely because a directory exists, and do not invent Agents, Hooks, or Tools
   for this release.
4. Preserve boundaries.
   - **Workspace** owns reusable cross-project Profiles and artifacts as the
     single canonical source. That includes Profile-selected material and
     unselected universal artifacts (useful across every directory or kind of
     work). Unselected does not mean “belongs in Host config.”
   - **Local Configuration** (`~/.agents/agent-profile-kit/config.yaml`) owns
     machine-local Project Bindings and the explicit Workspace path. Current
     schema version 2 requires one existing absolute or home-relative Workspace
     path and each binding names one existing project root, one Profile, and a
     supported Host set (`codex`, `claude`, `grok`, or `pi`); Host order and
     duplicate entries normalize at ingestion. A version-1 configuration without
     `workspace` is legacy migration input only; run `agent-profile-kit init` before any desired-state
     or binding-recording command.
   - **Project repositories** own project facts and repository-owned instructions.
   - **Hosts** own authentication, trust, approvals, plugins, sessions, and
     Host preferences. User-managed native global Skill delivery (including
   Host-root symlinks into Workspace source) is Host configuration, not
   Agent Profile Kit–owned state: outside Project Bindings and Installation
   Manifests; `apply` / `uninstall` never adopt or remove those paths. v1 does
     not manage global Host delivery. Hosts own Skill discovery, precedence,
     deduplication, collision diagnostics, and resolution across project,
     personal, package, plugin, extension, and compatibility sources.
   - **Generated output** is disposable Installer-owned material inside bound
     projects. Never copy it back into the Workspace as source.
   - Same-identity Skill material outside an exact planned output destination is
     Host Resolution, not an Agent Profile Kit blocker. Concrete Host settings
     that disable planned output may warn; exact Output Ownership Conflicts and
     unsupported capability remain blockers.
5. Author bindings in Local Configuration—either hand-edit `config.yaml` or run
   recording-only `agent-profile-kit bind <profile> [project] --host <host>…`
   (cwd when project is omitted; at least one explicit `--host` required). Do not
   invent project roots or Host lists. Use only explicit paths the user confirms.
   Reject wildcards, recursive scans, Host auto-detection, all-Hosts defaults,
   per-session selection, and Profile version pins. `bind` never applies output;
   after recording, continue with validate/preview/apply. To remove desired
   state, use `agent-profile-kit unbind [project]`; it defaults to cwd, matches
   existing paths canonically, and permits missing-path recovery only by exact
   authored spelling. `unbind` never removes generated output.
6. Validate before applying. Context Modules use `id` frontmatter and flat
   Profiles contain explicit arrays for every artifact category. Dependencies use
   explicit `{ type, id }` references. Run `agent-profile-kit validate`, review
   the concise outcome from `agent-profile-kit preview`, and ask before applying
   all configured Project Bindings with `agent-profile-kit apply`. Use
   `preview --verbose`, `apply --verbose`, or `status --verbose` when complete
   per-output diagnostics, resolved artifact reasons, or composed Context are
   needed. The current Workspace schema version is 1.
7. After apply, the user launches Codex, Claude, Grok, or Pi natively in the
   bound project. Do not claim that Agent Profile Kit manages Host
   authentication, trust, approvals, plugins, or sessions. Pi bindings load the
   generated `.pi/APPEND_SYSTEM.md` and `.pi/skills/<Artifact ID>` packages after
   Pi's native trust boundary; packages, extensions, and other Skill sources
   coexist through Pi Host Resolution. For non-Git projects, remind the
   user that Codex must launch from the exact bound root.
8. Use `status` to focus on Profile Installations needing attention; its concise
   result reports all-current state when nothing needs action, labels change
   counts as generated-output units, explains non-current states when they
   appear, preserves warnings and blockers, and ends with one next-action line
   when useful (preview before apply; resolve blocker and retry the same command
   when blocked; omit when already current). Repository Exclusion lines are
   Git-local exclusions for Installer-owned generated paths. A ready `preview`
   likewise recommends `apply`; blocked `preview` or `apply` retries that same
   command after the blocker. Add `--verbose` to distinguish current, stale, drifted,
   missing, and blocked installations in the complete per-output report.
   `unbind` removes desired
   Project Binding state but leaves generated output for global `preview` and
   `apply`. `uninstall` instead removes only output whose Installation Marker
   and hashes prove Agent Profile Kit ownership; it preserves the Workspace,
   Local Configuration, global Host configuration, and repository-owned files.
   Never use `uninstall` as a substitute for removing a binding, or `unbind` as
   a substitute for output cleanup.

If the user plans to publish the Workspace, remind them to review personal
content. Credentials are invalid in a Workspace regardless of publication
visibility.
