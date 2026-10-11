// Resource limits for one code-mode planning run, from the action-engine-v2 plan, section 5. They bound a
// small plan-building program; none of them comes from a benchmark.
//
// QuickJS comes from quickjs-emscripten-core 0.32.0 with @jitl/quickjs-wasmfile-release-sync 0.32.0, both
// pinned exactly. 0.32.0 is the latest release (2026-02-16) and vendors bellard/quickjs 2025-09-13. It is
// the version test/codemode/quickjs-wrapper.test.ts checked for a heap limit, an outer WASM memory cap, a
// stack limit, an interrupt deadline and disposal after an abandoned host promise. The sync variant is used
// because async host calls are QuickJS promises the worker resolves itself; the asyncify variant would
// suspend the whole WASM module inside a host call, where the interrupt handler cannot reach it.

const KiB = 1024;
const MiB = 1024 * KiB;

export interface SandboxLimits {
  /** UTF-8 bytes of the TypeScript source, checked before parsing. */
  sourceBytes: number;
  /** QuickJS heap (JS_SetMemoryLimit). */
  heapBytes: number;
  /** QuickJS stack (JS_SetMaxStackSize), measured on Emscripten's shadow stack. */
  stackBytes: number;
  /** Maximum size of the WASM linear memory the module is instantiated with. */
  wasmMemoryBytes: number;
  /** V8 heap of the worker thread itself, which holds the QuickJS glue and the frozen snapshots. */
  workerHeapMb: number;
  /**
   * Native stack of the worker thread. QuickJS checks its stack on Emscripten's shadow stack, but the WASM
   * frames use this one. At 1 MB and 4 MB, JSON.stringify of a deep object and parsing 8,000 nested brackets
   * overflowed it before QuickJS's own 512 KiB check fired; at 16 MB every probed path stopped at QuickJS's
   * check (quickjs-wrapper.test.ts). The thread reserves this address space; it does not commit it.
   */
  workerStackMb: number;
  /** Guest compute: time spent inside QuickJS, summed over slices, excluding waits on host callbacks. */
  guestCpuMs: number;
  /**
   * Worker watchdog: time the worker may own (not waiting on a host callback), startup included, before
   * the parent terminates it. The interrupt hook only runs between bytecodes, so a native builtin is not
   * stopped by guestCpuMs: JSON.stringify of a 20,000-deep object ran 1,030 ms of guest time against a
   * 250 ms budget, and a 50,000-deep one 2,670 ms. A run with no callbacks took about 80 ms end to end
   * (sandbox.test.ts), so 1,000 ms leaves room for startup and the full compute budget.
   */
  watchdogMs: number;
  /** Wall clock for the whole run, host callbacks included. */
  wallMs: number;
  /** One host callback (a Jev choice); also bounded by what is left of wallMs. */
  callbackMs: number;
  readWindowCalls: number;
  chooseCalls: number;
  steps: number;
  asks: number;
  optionsPerChoice: number;
  /** Longest ref string accepted from the guest; anything longer is refused before it is copied out. */
  refChars: number;
  /** Serialized size of one value handed into the guest (a readWindow result). */
  callbackResultBytes: number;
  /** Longest waitFor timeout a step may ask for. */
  waitForMs: number;
  /** Drafts one goal program may write (B30). */
  drafts: number;
  /**
   * Longest draft text copied out of the guest. Past it the call is a violation; under it, lowering holds a draft to
   * goals/drafts.ts DRAFT_MAX_CHARS and says so in the user's words.
   */
  draftCopyChars: number;
  /** Refs one draft may name as its basis. */
  draftBasis: number;
}

export const DEFAULT_LIMITS: SandboxLimits = Object.freeze({
  sourceBytes: 16 * KiB,
  heapBytes: 16 * MiB,
  stackBytes: 512 * KiB,
  wasmMemoryBytes: 64 * MiB,
  workerHeapMb: 32,
  workerStackMb: 16,
  guestCpuMs: 250,
  watchdogMs: 1_000,
  wallMs: 15_000,
  callbackMs: 10_000,
  readWindowCalls: 4,
  chooseCalls: 4,
  steps: 24,
  asks: 1,
  optionsPerChoice: 64,
  refChars: 128,
  callbackResultBytes: 64 * KiB,
  // Not in the plan's table. The executor's own predicate waits are a few seconds; 10 s matches the
  // writer timeout and is an assumption.
  waitForMs: 10_000,
  // Assumed, not measured: a goal writes one reply or description, two at most.
  drafts: 2,
  draftCopyChars: 2_000,
  draftBasis: 8,
});
