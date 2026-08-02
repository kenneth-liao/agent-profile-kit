export class MissingProfileError extends Error {
  readonly availableProfiles: readonly string[];

  constructor(
    readonly profile: string,
    availableProfiles: Iterable<string>,
    readonly recoverByEditingLocalConfiguration = false,
  ) {
    super(`Profile '${profile}' does not exist in this Workspace`);
    this.name = "MissingProfileError";
    this.availableProfiles = [...availableProfiles].sort();
  }
}

export function requireProfile<T>(
  profiles: ReadonlyMap<string, T>,
  profile: string,
): T {
  const selected = profiles.get(profile);
  if (selected === undefined) {
    throw new MissingProfileError(profile, profiles.keys());
  }
  return selected;
}
