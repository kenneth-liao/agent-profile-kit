import { parse as parseToml } from "smol-toml";

function tomlPosition(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const line = (error as { readonly line?: unknown }).line;
  const column = (error as { readonly column?: unknown }).column;
  if (
    typeof line !== "number" ||
    typeof column !== "number" ||
    !Number.isInteger(line) ||
    !Number.isInteger(column) ||
    line < 1 ||
    column < 1
  ) {
    return "";
  }
  return ` at line ${line}, column ${column}`;
}

export function parseTomlTable(source: string, description: string): Record<string, unknown> {
  let document: unknown;
  try {
    document = parseToml(source);
  } catch (error) {
    throw new Error(
      `${description} is invalid TOML${tomlPosition(error)}; fix the file before retrying`,
    );
  }
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(`${description} must be a TOML table`);
  }
  return document as Record<string, unknown>;
}
