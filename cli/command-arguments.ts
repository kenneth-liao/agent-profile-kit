/**
 * Shared CLI argument sanitation and positional validation helpers.
 */

export function sanitizeCommandToken(token: string): string {
  return token.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replaceAll("'", "\\'");
}

export function positionalArgument(command: string, description: string, value: string): string {
  if (value.startsWith("-")) {
    throw new Error(`${command} does not accept flag '${value}' as ${description}`);
  }
  return value;
}
