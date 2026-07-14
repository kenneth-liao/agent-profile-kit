export type ProjectOutputEntryType = "directory" | "file";

/** A regular file inside an owned artifact directory. Paths are relative to the directory root. */
export interface ProposedDirectoryFileMember {
  readonly bytes: string;
  readonly mode: number;
  readonly path: string;
  readonly type: "file";
}

/** A subdirectory inside an owned artifact directory. Paths are relative to the directory root. */
export interface ProposedDirectoryDirectoryMember {
  readonly mode: number;
  readonly path: string;
  readonly type: "directory";
}

export type ProposedDirectoryMember =
  | ProposedDirectoryDirectoryMember
  | ProposedDirectoryFileMember;

/** A single owned regular file at a project-relative path. */
export interface ProposedProjectFileOutput {
  readonly bytes: string;
  readonly mode: number;
  readonly path: string;
  readonly requirements: readonly string[];
  readonly type: "file";
}

/**
 * One complete owned artifact directory. The Installer treats the directory as
 * a single ownership boundary whose regular-file members carry exact bytes and modes.
 */
export interface ProposedProjectDirectoryOutput {
  readonly members: readonly ProposedDirectoryMember[];
  readonly mode: number;
  readonly path: string;
  readonly requirements: readonly string[];
  readonly type: "directory";
}

export type ProposedProjectOutput =
  | ProposedProjectDirectoryOutput
  | ProposedProjectFileOutput;

export interface AdapterProjectPlan {
  readonly host: string;
  readonly hostVersion: string;
  readonly outputs: readonly ProposedProjectOutput[];
}
