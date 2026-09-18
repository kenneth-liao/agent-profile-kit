# Use portable artifacts as canonical source

Agent Profile Kit Workspaces author workflows as standard Agent Skills and use minimal host-neutral definitions for Context, Agents, Hooks, and Tools, with stable typed identities and optional `agent-profile-kit.yaml` dependency metadata. Commands, plugins, extensions, and other Host-native forms are derived outputs rather than canonical categories, favoring one maintained source and existing interoperability over a more expressive custom capability format.

Amendment: since spec #593 (DEC-006, ticket #596), the optional dependency
metadata this decision introduced — Context Module frontmatter `dependencies`
and the Skill `agent-profile-kit.yaml` sidecar — is removed, and ADR-0045
supersedes it. Typed artifact identities and portable artifacts as canonical
source stand unchanged.
