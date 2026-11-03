// Files apkit keeps between runs carry a schema number. An older apkit must not
// read, rewrite, or delete what a newer one wrote, so it stops and names the update.

/** A file was written by a newer apkit. Nothing was changed. */
export class NewerSchemaError extends Error {}

/** Throws NewerSchemaError when `schema` is newer than `supported`. */
export function refuseNewer(schema: unknown, supported: number, file: string): void {
  if (typeof schema === "number" && schema > supported) {
    throw new NewerSchemaError(
      `${file} was written by a newer apkit (schema ${schema}; this apkit reads schema ${supported}). ` +
        "Nothing was changed. Update apkit, then run the command again.",
    );
  }
}
