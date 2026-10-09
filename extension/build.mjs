// `pnpm build` bundles into dist/ for --load-extension. The manifest's `key` fixes that build's id (EXTENSION_ID),
// which the bridge's Native Messaging manifest names in allowed_origins; the private key is not in the repository.
// `pnpm build:store` writes dist-store/caret-for-chrome-<version>.zip without the key, because the Web Store assigns
// its own ID, and verifies the zip (verify-store.mjs).
import { build } from "esbuild";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyStore } from "./verify-store.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const store = process.argv.includes("--store");
const manifest = JSON.parse(readFileSync(`${here}manifest.json`, "utf8"));
const stage = store ? mkdtempSync(join(tmpdir(), "caret-store-build-")) : null;
const dist = stage ?? `${here}dist`;
try {
  if (!store) rmSync(dist, { recursive: true, force: true });
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
  cpSync(`${here}icons`, `${dist}/icons`, { recursive: true });
  if (store) {
    delete manifest.key;
    writeFileSync(`${dist}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
    const output = `${here}dist-store`;
    mkdirSync(output, { recursive: true });
    const archive = `${output}/caret-for-chrome-${manifest.version}.zip`;
    const files = readdirSync(dist, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(dist.length + 1))
      .sort();
    const epoch = new Date("1980-01-01T00:00:00Z");
    for (const file of files) {
      chmodSync(join(dist, file), 0o644);
      utimesSync(join(dist, file), epoch, epoch);
    }
    rmSync(archive, { force: true });
    execFileSync("zip", ["-X", "-q", archive, "-@"], {
      cwd: dist,
      input: `${files.join("\n")}\n`,
      env: { ...process.env, TZ: "UTC" },
    });
    verifyStore(archive);
    const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
    console.log(`built ${archive}\nsha256 ${sha256}`);
  } else {
    copyFileSync(`${here}manifest.json`, `${dist}/manifest.json`);
    const key = JSON.parse(readFileSync(`${here}manifest.json`, "utf8")).key;
    const id = [...createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
    const expected = readFileSync(`${here}EXTENSION_ID`, "utf8").trim();
    if (id !== expected) throw new Error(`manifest key gives extension id ${id}, EXTENSION_ID says ${expected}`);
    console.log(`built ${dist} for extension ${id}`);
  }
} finally {
  if (stage) rmSync(stage, { recursive: true, force: true });
}
