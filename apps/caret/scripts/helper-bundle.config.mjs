// Bundles the helper for Caret.app (scripts/build-app.sh): src/main.ts and the codemode worker as ESM chunks for the
// pinned Node runtime, with the QuickJS wasm beside them. Output: $CARET_HELPER_OUT (Contents/Resources/helper).
//
// Why a bundle (H4 probe, ~/.caret-run/evidence/host/h4/node-probe): against Node running src/ with type stripping it
// cut cold start from 235 to 103 ms median and 13 MiB of node_modules, and unlike a single executable application it
// needs no helper source change. The QuickJS sandbox runs from it (a sandbox program run through runCodePlan).
//
//   cd helper && node node_modules/rolldown/bin/cli.mjs -c ../apps/caret/scripts/helper-bundle.config.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELPER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "helper");
const out = process.env.CARET_HELPER_OUT;
if (out === undefined || out === "") throw new Error("set CARET_HELPER_OUT to the directory the helper bundle goes in");
const wasm = createRequire(join(HELPER, "package.json")).resolve("@jitl/quickjs-wasmfile-release-sync/wasm");

export default {
  input: { main: join(HELPER, "src", "main.ts"), worker: join(HELPER, "src", "codemode", "worker.ts") },
  platform: "node",
  output: { dir: out, format: "esm", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
  plugins: [
    {
      // sandbox.ts starts its worker from new URL("./worker.ts", import.meta.url); in the bundle that URL resolves
      // against the chunk holding the sandbox, beside which the worker entry is worker.mjs.
      name: "caret-worker-url",
      transform(code, id) {
        if (!id.endsWith("/src/codemode/sandbox.ts")) return null;
        const from = 'new URL("./worker.ts", import.meta.url)';
        if (!code.includes(from)) throw new Error(`sandbox.ts no longer contains ${from}; update helper-bundle.config.mjs`);
        return code.replace(from, 'new URL("./worker.mjs", import.meta.url)');
      },
    },
    {
      // Emscripten loads the module from new URL("emscripten-module.wasm", import.meta.url), next to its chunk.
      name: "caret-quickjs-wasm",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "emscripten-module.wasm", source: readFileSync(wasm) });
      },
    },
  ],
};
