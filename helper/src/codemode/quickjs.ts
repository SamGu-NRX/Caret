// Loads the pinned QuickJS variant (see limits.ts for the version and why) into a WASM memory with a hard
// maximum. QuickJS's own heap limit does not cover the whole module; the Memory maximum does, because
// the module imports its memory and cannot grow past it (quickjs-wrapper.test.ts).
import variantImport from "@jitl/quickjs-wasmfile-release-sync";
import { newQuickJSWASMModuleFromVariant, newVariant, type QuickJSSyncVariant, type QuickJSWASMModule } from "quickjs-emscripten-core";

const PAGE = 64 * 1024;
/** The variant's own initial memory (Emscripten INITIAL_MEMORY, 16 MiB). */
export const INITIAL_BYTES = 16 * 1024 * 1024;

// The package's `types` condition points at its CommonJS declaration while Node's `import` condition
// loads the ESM build, whose default export is the variant itself. Check the shape instead of casting.
function syncVariant(v: unknown): QuickJSSyncVariant {
  if (typeof v === "object" && v !== null && (v as { type?: unknown }).type === "sync") return v as QuickJSSyncVariant;
  throw new Error("@jitl/quickjs-wasmfile-release-sync did not load as a sync QuickJS variant");
}

export function newCappedModule(maxBytes: number): Promise<QuickJSWASMModule> {
  if (maxBytes < INITIAL_BYTES || maxBytes % PAGE !== 0) throw new Error(`WASM memory cap must be a multiple of 64 KiB and at least ${INITIAL_BYTES} bytes`);
  const wasmMemory = new WebAssembly.Memory({ initial: INITIAL_BYTES / PAGE, maximum: maxBytes / PAGE });
  return newQuickJSWASMModuleFromVariant(newVariant(syncVariant(variantImport), { wasmMemory }));
}
