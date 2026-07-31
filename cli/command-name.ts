import packageManifest from "../package.json" with { type: "json" };

const publishedCommands = Object.keys(packageManifest.bin);

if (publishedCommands.length !== 1) {
  throw new Error("package.json must publish exactly one CLI command");
}

export const COMMAND_NAME = publishedCommands[0]!;
