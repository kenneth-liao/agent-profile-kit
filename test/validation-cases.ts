import { readdir, rm } from "node:fs/promises";
import { SKILL, tempDir, writeTree } from "./fixtures.js";

// Detect the filesystem capability, not the OS: this collision cannot exist on a case-insensitive volume.
const probe = await tempDir("case-probe");
await writeTree(probe, { "Style.md": "Upper", "style.md": "Lower" });
export const CASE_SENSITIVE_CONTEXT = (await readdir(probe)).length === 2;
await rm(probe, { recursive: true });

// Each error kind blocks installs, so each names the wrong or ambiguous install it prevents (ADR-0057 §4, ISC-82).
/** `links`: link path → the path it points to, both under the Workspace root. */
export const ERROR_KINDS: Record<string, {
  readonly prevents: string;
  readonly paths: readonly string[];
  readonly fix: string;
  readonly files: Record<string, string>;
  readonly links?: Record<string, string>;
}> = {
  "workspace-missing-manifest": {
    paths: ["apkit-workspace.yaml"],
    fix: "needs an apkit-workspace.yaml file; it may be empty",
    prevents: "installing from a folder that is not a Workspace, such as a mistyped path",
    files: { "context/a.md": "x\n" },
  },
  "workspace-old-manifest": {
    paths: ["workspace.yaml"],
    fix: "Rename workspace.yaml to apkit-workspace.yaml",
    prevents: "installing from a folder that is not marked as a Workspace; the fix names the rename",
    files: { "workspace.yaml": "schema_version: 1\n" },
  },
  "workspace-manifest": {
    paths: ["apkit-workspace.yaml"],
    fix: "`schema_version` must be a whole number such as 1",
    prevents: "reading a Workspace whose format version apkit cannot tell",
    files: { "apkit-workspace.yaml": "schema_version: abc\n" },
  },
  "workspace-unsupported-version": {
    paths: ["apkit-workspace.yaml"],
    fix: "Update apkit",
    prevents: "reading a newer Workspace format with older rules",
    files: { "apkit-workspace.yaml": "schema_version: 2\n" },
  },
  "context-id-case-collision": {
    paths: ["context/Style.md", "context/style.md"],
    fix: "rename one so each Context ID is unique",
    prevents: "an ambiguous Context ID whose file depends on the file system",
    files: { "apkit-workspace.yaml": "", "context/Style.md": "U\n", "context/style.md": "L\n" },
  },
  "invalid-frontmatter": {
    paths: ["skills/a/SKILL.md"],
    fix: "must open and close YAML frontmatter with a name and description",
    prevents: "installing a Skill that agents cannot load, or silently dropping one a Profile selects",
    files: { "apkit-workspace.yaml": "", "skills/a/SKILL.md": "no frontmatter\n" },
  },
  "invalid-field": {
    paths: ["skills/a/SKILL.md"],
    fix: "needs a non-empty `description` of at most 1024 characters",
    prevents: "installing a Skill that agents reject for its name or description, or silently dropping it",
    files: { "apkit-workspace.yaml": "", "skills/a/SKILL.md": "---\nname: a\n---\n" },
  },
  "invalid-model-invocation": {
    paths: ["skills/a/SKILL.md"],
    fix: "`disable-model-invocation` must be true or false",
    prevents: "an ambiguous choice of whether agents may invoke the Skill on their own",
    files: { "apkit-workspace.yaml": "", "skills/a/SKILL.md": SKILL("a", "disable-model-invocation: maybe\n") },
  },
  "duplicate-artifact-name": {
    paths: ["skills/b/SKILL.md"],
    fix: "rename one so each Skill name is unique",
    prevents: "an ambiguous Skill name that two packages declare",
    files: { "apkit-workspace.yaml": "", "skills/a/SKILL.md": SKILL("same"), "skills/b/SKILL.md": SKILL("same") },
  },
  "unreadable-skill-file": {
    paths: ["skills/a/gone"],
    fix: "replace it with the real file or folder, or remove it",
    prevents: "installing a Skill package with a file that does not exist or a folder without end",
    files: { "apkit-workspace.yaml": "", "skills/a/SKILL.md": SKILL("a") },
    links: { "skills/a/gone": "missing" },
  },
  "profile-file-name": {
    paths: ["profiles/My Profile.yaml"],
    fix: "must have a lowercase kebab-case file name",
    prevents: "a Profile ID that would break the marked section it is written into",
    files: { "apkit-workspace.yaml": "", "profiles/My Profile.yaml": "context: []\n" },
  },
  "duplicate-profile": {
    paths: ["profiles/x.yml"],
    fix: "keep one of x.yaml and x.yml",
    prevents: "an ambiguous Profile that two files define",
    files: { "apkit-workspace.yaml": "", "profiles/x.yaml": "context: []\n", "profiles/x.yml": "context: []\n" },
  },
  "invalid-yaml": {
    paths: ["profiles/p.yaml"],
    fix: "correct its YAML syntax",
    prevents: "installing a Profile whose selection cannot be read; skipping it would make update remove what it installed",
    files: { "apkit-workspace.yaml": "", "profiles/p.yaml": "skills: [\n" },
  },
  "invalid-profile": {
    paths: ["profiles/p.yaml"],
    fix: "remove `id`",
    prevents: "installing a Profile whose selection cannot be read; skipping it would make update remove what it installed",
    files: { "apkit-workspace.yaml": "", "profiles/p.yaml": "id: p\n" },
  },
  "duplicate-selection": {
    paths: ["profiles/p.yaml"],
    fix: "remove the repeated selection",
    prevents: "Context joined twice, or in an order the user did not choose",
    files: { "apkit-workspace.yaml": "", "context/a.md": "A\n", "profiles/p.yaml": "context: [a, a]\n" },
  },
  "missing-context-reference": {
    paths: ["profiles/p.yaml"],
    fix: "add the missing Context or remove its selection",
    prevents: "an install that lacks Context the Profile names",
    files: { "apkit-workspace.yaml": "", "profiles/p.yaml": "context: [nope]\n" },
  },
  "missing-skill-reference": {
    paths: ["profiles/p.yaml"],
    fix: "add the missing Skill or remove its selection",
    prevents: "an install that lacks a Skill the Profile names",
    files: { "apkit-workspace.yaml": "", "profiles/p.yaml": "skills: [gone]\n" },
  },
};
