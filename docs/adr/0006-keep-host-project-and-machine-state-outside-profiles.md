# Keep Host, project, and machine state outside Profiles

The user-owned Workspace contains personal cross-project material only: project facts stay in project repositories, general Host settings stay in native configuration or arguments, machine-specific non-secret bindings stay in untracked Local Configuration, and credential values stay in Host authentication, environment references, or operating-system secret storage. Context is composed deterministically without a custom semantic precedence system, keeping each fact in one authority and leaving contradictions to the Host or user.
