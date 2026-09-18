# Use portable artifacts as canonical source

Agent Profile Kit Workspaces author workflows as standard Agent Skills and use minimal host-neutral definitions for Context, Agents, Hooks, and Tools, with stable typed identities and optional `agent-profile-kit.yaml` dependency metadata. Commands, plugins, extensions, and other Host-native forms are derived outputs rather than canonical categories, favoring one maintained source and existing interoperability over a more expressive custom capability format.

Amendment: since spec #593 (DEC-006, ticket #596), the optional dependency
metadata this decision introduced — Context Module frontmatter `dependencies`
and the Skill `agent-profile-kit.yaml` sidecar — is removed, and ADR-0045
supersedes it. Typed artifact identities and portable artifacts as canonical
source stand unchanged.

Amendment: since spec #593 (DEC-014, ticket #598), a Profile's identity is its
file name under `profiles/` without `.yaml`, and the authored `id` field this
decision carried inside the Profile file is removed; ADR-0046 supersedes that
part. Typed artifact identities and portable artifacts as canonical source
stand unchanged.

Amendment: since spec #593 (DEC-004/005, ticket #600), a Context Module's
identity is its path under `context/` without `.md`, and the frontmatter `id`
field this decision carried inside Context files is removed; apkit reads no
Context frontmatter and delivers each file's bytes as written. ADR-0048
supersedes that part. Typed artifact identities and portable artifacts as
canonical source stand unchanged.
