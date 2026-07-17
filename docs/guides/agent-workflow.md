# Agent Profile Kit agent workflow

Use this workflow when helping a person author their Workspace and bind projects.

1. Read this guide first. Then inspect the Workspace: start with `workspace.yaml`
   and its schema version. A valid Workspace needs only that Manifest; missing
   artifact directories are empty categories, and bootstrap files such as
   `README.md`, `AGENTS.md`, and `.gitignore` are optional scaffolding from
   `init`, not format requirements. Inspect any present artifact directories next.
   Treat the Workspace as the canonical source; do not infer reusable material
   from generated Host output.
2. Elicit the user's needs one decision at a time. Establish the kind of work,
   the reusable facts or workflow they want, and whether existing material
   already satisfies the need. Ask instead of inventing personal preferences,
   project facts, Host preferences, credentials, or machine paths.
3. Create the smallest useful artifact set. This release accepts Context Modules
   and portable Skills for Codex and Claude Code. Put standing facts in Context
   Modules and reusable procedures in Skills. A Profile needs at least one
   supported artifact (Context, Skills, or both); Context is not mandatory—a
   Skills-only Profile is valid on CLI 0.17.0+ (convert or uninstall before
   rolling back to older binaries; see the human Workspace guide). For Skills
   that must not fire implicitly, use
   `metadata.agent-profile-kit.model-invocation: disabled` (default is
   `allowed`); do not leave Claude-native `disable-model-invocation` in
   Workspace source. Profiles selecting Agents, Hooks, or Tools are rejected. Do
   not create a new artifact merely because a directory exists, and do not invent
   Agents, Hooks, or Tools for this release.
4. Preserve boundaries.
   - **Workspace** owns reusable cross-project Profiles and artifacts as the
     single canonical source. That includes Profile-selected material and
     unselected universal artifacts (useful across every directory or kind of
     work). Unselected does not mean “belongs in Host config.”
   - **Local Configuration** (`~/.agents/agent-profile-kit/config.yaml`) owns
     machine-local Project Bindings and the explicit Workspace path. Current
     schema version 2 requires one existing absolute or home-relative Workspace
     path and each binding names one existing project root, one Profile, and a
     supported Host set. A version-1 configuration without `workspace` is legacy
     migration input only; run `agent-profile-kit init` before any desired-state
     or binding-recording command.
   - **Project repositories** own project facts and repository-owned instructions.
   - **Hosts** own authentication, trust, approvals, plugins, sessions, and
     Host preferences. User-managed native global Skill delivery (including
     Host-root symlinks into Workspace source) is Host configuration, not
     Agent Profile Kit–owned state: outside Project Bindings and Installation
     Manifests; `apply` / `uninstall` never adopt or remove those paths. v1 does
     not manage global Host delivery. `status` may still report a project
     installation as blocked when a selected Skill collides with global delivery
     (#53).
   - **Generated output** is disposable Installer-owned material inside bound
     projects. Never copy it back into the Workspace as source.
   - Do not select a Skill into a bound Profile while the same Host-visible
     identity is also globally delivered; preview/apply fail closed, and later
     overlap appears as status blocked (#53).
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
   `agent-profile-kit preview`, and ask before applying all configured Project
   Bindings with `agent-profile-kit apply`. The current Workspace schema version
   is 1.
7. After apply, the user launches Codex or Claude natively in the bound project.
   Do not claim that Agent Profile Kit manages Host authentication, trust,
   approvals, plugins, or sessions. For non-Git projects, remind the user that
   Codex must launch from the exact bound root.
8. Use `status` to distinguish current, stale, drifted, missing, and blocked
   installations (including later global Skill identity collisions). `unbind`
   removes desired Project Binding state but leaves generated output for global
   `preview` and `apply`. `uninstall` instead removes only output whose
   Installation Marker and hashes prove Agent Profile Kit ownership; it preserves
   the Workspace, Local Configuration, global Host configuration, and
   repository-owned files. Never use `uninstall` as a substitute for removing a
   binding, or `unbind` as a substitute for output cleanup.

If the user plans to publish the Workspace, remind them to review personal
content. Credentials are invalid in a Workspace regardless of publication
visibility.
