# Agent Profile Kit agent workflow

Use this workflow when helping a person author their Workspace and bind projects.

1. Read this guide first. Then inspect the Workspace: `workspace.yaml`, its
   schema version, and the existing artifact directories. Treat the Workspace
   as the canonical source; do not infer reusable material from generated Host
   output.
2. Elicit the user's needs one decision at a time. Establish the kind of work,
   the reusable facts or workflow they want, and whether existing material
   already satisfies the need. Ask instead of inventing personal preferences,
   project facts, Host preferences, credentials, or machine paths.
3. Create the smallest useful artifact set. This release accepts Context Modules
   and portable Skills for Codex and Claude Code. Put standing facts in Context
   Modules and reusable procedures in Skills. Profiles selecting Agents, Hooks,
   or Tools are rejected. Do not create a new artifact merely because a directory
   exists, and do not invent Agents, Hooks, or Tools for this release.
4. Preserve boundaries.
   - **Workspace** owns reusable cross-project Profiles and artifacts.
   - **Local Configuration** (`~/.agents/agent-profile-kit/config.yaml`) owns
     machine-local Project Bindings: one existing absolute or home-relative
     project root, one Profile, and a supported Host set per binding.
   - **Project repositories** own project facts and repository-owned instructions.
   - **Hosts** own authentication, trust, approvals, plugins, sessions, and
     Host preferences.
   - **Generated output** is disposable Installer-owned material inside bound
     projects. Never copy it back into the Workspace as source.
5. Author bindings directly in Local Configuration. Do not invent project roots
   or Host lists. Use only explicit paths the user confirms. Reject wildcards,
   recursive scans, hidden defaults, per-session selection, and Profile version
   pins.
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
8. Use `status` to distinguish current source from stale or drifted generated
   output. `uninstall` removes only output whose Installation Marker and hashes
   prove Agent Profile Kit ownership; it preserves the Workspace, Local
   Configuration, global Host configuration, and repository-owned files.

If the user plans to publish the Workspace, remind them to review personal
content. Credentials are invalid in a Workspace regardless of publication
visibility.
