// Bundles the API and the workspace packages it uses (shipped as TypeScript source) into dist/server.js.
// Third-party dependencies stay external and load from node_modules.
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith("@infuture/"));

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  logLevel: "info",
});
