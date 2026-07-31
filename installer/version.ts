import packageManifest from "../package.json" with { type: "json" };

export const COMMAND_NAME = Object.keys(packageManifest.bin)[0]!;
export const ENGINE_VERSION = packageManifest.version;
