---
status: superseded by ADR-0010
---

# Deliver Profiles as process overlays

Every managed session explicitly selects one flat Profile, which adds its Workspace Context, Skills, Agents, Hooks, and Tools to the Host's ordinary global and project configuration through per-process native integration. Profiles may run concurrently, contain no inheritance or general Host settings, and never switch shared configuration, allowing Hosts to retain authentication and session management without Agent Profile Kit building a parallel runtime.
