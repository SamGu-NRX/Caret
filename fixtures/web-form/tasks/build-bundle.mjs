// Rebuilds public/tasks/tasks.bundle.js from src/tasks.jsx: React 18.3.1, ReactDOM and react-select 5.10.2 (the pins in
// package.json, as build-vendor.mjs uses), minified, licenses beside it. The bundle is committed so the task pages are
// static files; run this only after changing src/tasks.jsx or the pins.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const here = fileURLToPath(new URL("..", import.meta.url));
const result = await build({
  metafile: true,
  entryPoints: [`${here}src/tasks.jsx`],
  outfile: `${here}public/tasks/tasks.bundle.js`,
  bundle: true,
  minify: true,
  format: "iife",
  target: "chrome116",
  jsx: "transform",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "eof",
  logLevel: "warning",
});
const pkgs = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/\.pnpm\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (m === null) continue;
  pkgs.set(m[1], input.slice(0, m.index + m[0].length - 1));
}
const parts = [...pkgs].sort(([a], [b]) => a.localeCompare(b)).map(([name, dir]) => {
  const pkg = JSON.parse(readFileSync(`${here}${dir}/package.json`, "utf8"));
  const file = ["LICENSE", "LICENSE.md", "license", "LICENSE.txt"].map((f) => `${here}${dir}/${f}`).find((f) => existsSync(f));
  return `${name}@${pkg.version} (${pkg.license})\n\n${file === undefined ? "(no license file in the package)" : readFileSync(file, "utf8").trim()}\n`;
});
writeFileSync(`${here}public/tasks/tasks.bundle.LICENSES.txt`, `Packages bundled into tasks.bundle.js by tasks/build-bundle.mjs.\n\n${parts.join("\n----\n\n")}`);
console.log(`built public/tasks/tasks.bundle.js from ${pkgs.size} packages`);
