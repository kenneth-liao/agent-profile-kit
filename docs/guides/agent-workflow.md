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
5. Validate before planning. The current tracer accepts Context Modules with
   `id` frontmatter and flat Context-only Profiles with explicit arrays for
   every artifact category. Run `agent-profile-kit validate`, then
   `agent-profile-kit plan --profile <id> --host codex`; inspect the selected
   Context, destination, and capability result before requesting installation.
   The current Workspace schema version is 1.
6. Do not install anything without direction. Explain the plan, ask the user
   whether to apply it, and only then run an installation command they
   explicitly requested. Use `status` to inspect an existing installation and
   `update` only when the user explicitly requests regeneration; launch never
   refreshes source implicitly. `uninstall` removes only a Manifest-verified
   whole installation.

If the user plans to publish the Workspace, remind them to review personal
content. Credentials are invalid in a Workspace regardless of publication
visibility.
