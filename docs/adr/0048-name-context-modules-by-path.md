---
status: accepted
---

# Name Context Modules by their path and deliver them as written

## Context

ADR-0001 gave every portable artifact a stable typed identity carried inside
the artifact: a Context Module's Markdown frontmatter held an `id` field that
named the module, plus optional dependency metadata (already removed by
ADR-0045). The field added apkit-only authoring work on top of material users
already have (#519 O1–O4, spec #593): every existing Markdown instruction file
needed an apkit-only frontmatter edit before it could serve as Context, the
frontmatter `id` was a second identity home that could drift from the file's
location, and moving a file silently changed nothing while editing the field
changed the identity that Profiles reference.

## Decision

1. **A Context Module's identity is its path under `context/` without
   `.md`, with `/` between folders.** Every `.md` file under `context/`, at
   any depth, is a Context Module; duplicate Context IDs are structurally
   impossible because one path has one file (spec #593 DEC-004, ticket
   #600). Moving or renaming a file changes its ID by design; guides and
   validation name this so Profiles can be updated deliberately.
2. **The ID grammar extends to `/`-separated segments for Context Modules
   only.** Every path segment must satisfy the Artifact ID naming rule; a
   path segment that cannot form a valid Artifact ID is one violation
   suggesting the rename. Skills, Profiles, and Installation Receipts keep
   the flat Artifact ID grammar.
3. **apkit reads no Context Module frontmatter and requires none (spec #593
   DEC-005).** Each file's complete bytes are the Context and are delivered
   as written. Every complete-envelope Host's generated header precedes all
   module content, so user frontmatter never becomes Host frontmatter.
   Antigravity composes each module into one always-on rule whose own
   generated `trigger: always_on` frontmatter and generated-source notice
   precede the module bytes; user frontmatter travels inside the module's
   boundary markers. A zero-byte file is reported as a violation (`must
   contain Context`); any written bytes — whitespace-only or frontmatter-only
   files included — are delivered as written.
4. **Nested Context IDs are safe in projected output.** The only Adapter that
   places a Context ID in a file name is Antigravity; it flattens each `/`
   into `.` in the rule file name, keeping every rule a flat file under
   `.agents/rules/`. The encoding is injective because `.` never occurs in an
   Artifact ID, so distinct IDs always produce distinct rule file names and
   no ID spelling can traverse out of the rules root. The true ID is
   preserved in the rule's boundary markers and capability requirements.
5. **A Profile naming a Context ID that does not exist is a violation
   suggesting the closest existing ID, including a moved file's new path:**
   the shared nearest-name suggestion first, then a unique final-path-segment
   match, since a folder move exceeds any small edit-distance threshold.
6. **This supersedes the rest of ADR-0001's Context identity.** ADR-0001's
   frontmatter `id` field for Context Modules is superseded (its dependency
   metadata was already superseded by ADR-0045); its typed
   artifact-identity principle and portable-artifacts-as-canonical-source
   stand. ADR-0045's clause tolerating Context frontmatter `dependencies` as
   an unread key is completed: all Context frontmatter is now inert
   delivered-as-written bytes, read by nothing and never a violation.

## Consequences

- A 0.204.0 Workspace whose Context frontmatter `id`s matched the file names
  keeps every Context ID, Project Binding, and receipt after the frontmatter
  is deleted; the files simply gain their frontmatter bytes as delivered
  content, refreshing the desired-input digest through the existing
  receipt-proven source-change path (TEST-010).
- A file whose frontmatter `id` differed from its file name changes identity
  to the path-derived ID; a Profile naming the old frontmatter ID is a
  violation whose fix renames the file (keeping the ID) or updates the
  Profile list. Nothing is silently rebound (DEC-013).
- `apkit new context` accepts nested IDs and creates the intermediate
  folders; its scaffold is plain Markdown with no frontmatter.
- An older binary still requires frontmatter `id`; the Workspace guide names
  this rollback caveat, mirroring the 0.208.0 Profile caveat.
