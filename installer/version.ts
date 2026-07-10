import packageManifest from "../package.json" with { type: "json" };

export const ENGINE_VERSION = packageManifest.version;
