// Bundles the CLI for Node. Bare built-in imports (such as `process` inside the
// bundled `yaml`) are rewritten to their `node:` form in the output, so the
// bundle imports only `node:` built-ins. The rewrite runs on the output text, not
// in a resolve plugin: Bun 1.4.0 drops a plugin's `node:` path for `require` calls.
import { readFile, writeFile } from "node:fs/promises";
import { builtinModules } from "node:module";

const builtins = new Set(builtinModules);

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "node",
  packages: "bundle",
  outdir: "dist",
  naming: "cli.js",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const out = "dist/cli.js";
const bundle = await readFile(out, "utf8");
const prefixed = bundle.replace(
  /(\b(?:__require|require)\s*\(\s*|\bimport\s*\(\s*|\bfrom\s*|^import\s*)(["'])([^"']+)\2/gm,
  (whole, lead: string, quote: string, specifier: string) =>
    builtins.has(specifier) ? `${lead}${quote}node:${specifier}${quote}` : whole,
);
await writeFile(out, prefixed);
