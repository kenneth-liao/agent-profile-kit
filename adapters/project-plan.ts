export type ProjectOutputEntryType = "directory" | "file";

export interface ProposedProjectOutput {
  readonly bytes: string;
  readonly mode: number;
  readonly path: string;
  readonly requirements: readonly string[];
  readonly type: ProjectOutputEntryType;
}

export interface AdapterProjectPlan {
  readonly host: string;
  readonly hostVersion: string;
  readonly outputs: readonly ProposedProjectOutput[];
}
