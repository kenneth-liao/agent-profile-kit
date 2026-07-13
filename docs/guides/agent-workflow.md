# Agent Profile Kit agent workflow

Use this workflow when helping a person author their Workspace.

1. Read this guide first. Then inspect the Workspace: `workspace.yaml`, its
   schema version, and the existing artifact directories. Treat the Workspace
   as the canonical source; do not infer reusable material from generated Host
   output.
2. Elicit the user's needs one decision at a time. Establish the kind of work,
   the reusable facts or workflow they want, and whether existing material
   already satisfies the need. Ask instead of inventing personal preferences.
3. Create the smallest useful artifact set. A Profile selects a flat set of
   artifacts. Put standing facts in Context Modules, reusable procedures in
   Skills, delegated roles in Agents, lifecycle behavior in Hooks, and
   model-callable capabilities in Tools. Do not create a new artifact merely
   because a directory exists.
4. Preserve boundaries. Keep project facts in the project repository; keep
   Host preferences, authentication, credential values, and machine-specific
   bindings outside the Workspace. Never copy generated Host files back into
   canonical source.
5. Validate before applying. Context Modules use `id` frontmatter and flat
   Profiles contain explicit arrays for every artifact category. Dependencies
   use explicit `{ type, id }` references. The Context-only Codex slice rejects
   Profiles selecting Skills, Agents, Hooks, or Tools. Run
   `agent-profile-kit validate`, review `agent-profile-kit preview`, and ask
   before applying all configured Project Bindings with `agent-profile-kit
   apply`. The current Workspace schema version is 1.
6. Use `status` to distinguish current source from stale or drifted generated
   output. `uninstall` removes only output whose Installation Marker and hashes
   prove Agent Profile Kit ownership; it preserves the Workspace, Local
   Configuration, global Host configuration, and repository-owned files.

If the user plans to publish the Workspace, remind them to review personal
content. Credentials are invalid in a Workspace regardless of publication
visibility.
