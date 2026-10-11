// Bundles the worker and the content script into dist/ with the manifest, for --load-extension=extension/dist.
// The manifest's `key` fixes the extension id (EXTENSION_ID) so unpacked and store builds share one id, which the
// bridge's Native Messaging manifest names in allowed_origins. The private key is not in the repository.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dist = `${here}dist`;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
await build({
  entryPoints: { worker: `${here}src/worker.ts`, content: `${here}src/content.ts` },
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome116",
  minify: false,
  legalComments: "none",
  logLevel: "warning",
});
copyFileSync(`${here}manifest.json`, `${dist}/manifest.json`);
const key = JSON.parse(readFileSync(`${here}manifest.json`, "utf8")).key;
const id = [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
const expected = readFileSync(`${here}EXTENSION_ID`, "utf8").trim();
if (id !== expected) throw new Error(`manifest key gives extension id ${id}, EXTENSION_ID says ${expected}`);
console.log(`built ${dist} for extension ${id}`);
