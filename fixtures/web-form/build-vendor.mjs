// Rebuilds public/app.bundle.js: the fixture's React app with React 18.3.1, ReactDOM and react-select 5.10.2
// bundled in, minified, license comments kept at the end. The bundle is committed so the acceptance run serves
// static files and needs no build; run this only after changing src/app.jsx or the pins in package.json.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const here = fileURLToPath(new URL(".", import.meta.url));
const result = await build({
  metafile: true,
  entryPoints: [`${here}src/app.jsx`],
  outfile: `${here}public/app.bundle.js`,
  bundle: true,
  minify: true,
  format: "iife",
  target: "chrome116",
  jsx: "transform",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
  logLevel: "warning",
});
// Every package that went into the bundle, with its license text, next to it.
const pkgs = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m === null) continue;
  const dir = input.slice(0, m.index + m[0].length - 1);
  pkgs.set(m[1], dir);
}
const parts = [...pkgs].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
  const pkg = JSON.parse(readFileSync(`${here}${dir}/package.json`, "utf8"));
  const file = ["LICENSE", "LICENSE.md", "license", "LICENSE.txt"].map((f) => `${here}${dir}/${f}`).find((f) => existsSync(f));
  return `${name}@${pkg.version} (${pkg.license})\n\n${file === undefined ? "(no license file in the package)" : readFileSync(file, "utf8").trim()}\n`;
});
writeFileSync(`${here}public/app.bundle.LICENSES.txt`, `Packages bundled into app.bundle.js by build-vendor.mjs.\n\n${parts.join("\n----\n\n")}`);
console.log(`built public/app.bundle.js from ${pkgs.size} packages`);
