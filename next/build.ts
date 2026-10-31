// Bundles the CLI for Node. Bare built-in imports (such as `process` inside the
// bundled `yaml`) are rewritten to their `node:` form, so the bundle imports
// only `node:` built-ins.
import { builtinModules } from "node:module";

const builtins = new Set(builtinModules);

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  target: "node",
  packages: "bundle",
  outdir: "dist",
  naming: "cli.js",
  plugins: [
    {
      name: "node-prefix",
      setup(build) {
        build.onResolve({ filter: /^[a-z_]/ }, (args) =>
          builtins.has(args.path) ? { path: `node:${args.path}`, external: true } : undefined,
        );
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
