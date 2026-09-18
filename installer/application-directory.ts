import { join } from "node:path";

/**
 * The one canonical home of the machine-local Agent Profile Kit application
 * root: Local Configuration, installation state, the lifecycle lock, and
 * diagnostic operation history are all placed relative to this directory. The
 * Workspace is not: the user chooses its location, which Local Configuration
 * records (ADR-0049). Every placement fact derives from here so no module
 * spells the application root independently.
 */
export function applicationDirectory(home: string): string {
  return join(home, ".agents", "agent-profile-kit");
}
