// What the pinned QuickJS wrapper itself can enforce, checked against the raw API before the sandbox
// relies on it: heap limit, outer WASM memory cap, stack limit, interrupt deadline, host-call budget,
// and dropping a hanging host callback. The sandbox's own tests (sandbox.test.ts) cover the same
// hostile programs through the worker.
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { Worker } from "node:worker_threads";
import { describe, expect, test } from "vitest";
import { newCappedModule } from "../../src/codemode/quickjs.ts";

const MiB = 1024 * 1024;
const moduleWithCap = newCappedModule;

function evalError(qjs: QuickJSWASMModule, src: string, setup: (rt: ReturnType<QuickJSWASMModule["newRuntime"]>) => void): string {
  const rt = qjs.newRuntime();
  setup(rt);
  const vm = rt.newContext();
  try {
    const r = vm.evalCode(src);
    if (r.error === undefined) {
      r.value.dispose();
      return "no error";
    }
    const e = vm.dump(r.error) as { name?: string; message?: string };
    r.error.dispose();
    return `${e.name}: ${e.message}`;
  } finally {
    vm.dispose();
    rt.dispose();
  }
}

describe("quickjs-emscripten 0.32.0 limits", () => {
  test("heap limit stops growth with an out-of-memory error", async () => {
    const qjs = await moduleWithCap(64 * MiB);
    const err = evalError(qjs, "const a = []; for (;;) a.push(new Array(1e5).fill(1));", (rt) => rt.setMemoryLimit(16 * MiB));
    expect(err).toMatch(/out of memory/i);
  });

  test("the outer WASM memory cap holds when the heap limit is set above it", async () => {
    const qjs = await moduleWithCap(64 * MiB);
    const err = evalError(qjs, "const a = []; for (;;) a.push(new Array(1e5).fill(1));", (rt) => rt.setMemoryLimit(1024 * MiB));
    expect(err).toMatch(/out of memory/i);
    expect(qjs.getWasmMemory().buffer.byteLength).toBeLessThanOrEqual(64 * MiB);
  });

  // QuickJS measures its stack on Emscripten's shadow stack, while the WASM frames themselves use V8's
  // native stack. On a 1 MB native stack (this test file's thread) and on a 4 MB worker stack,
  // JSON.stringify of a deep object and parsing 8,000 nested brackets overflowed V8 first, which throws
  // into the host and leaves the module unusable. With a 16 MB worker stack every probed path stopped at
  // QuickJS's own 512 KiB check and the runtime disposed cleanly, so the sandbox worker uses 16 MB.
  test("stack limit stops deep recursion inside a 16 MB worker", async () => {
    const w = new Worker(
      `const { parentPort } = require("node:worker_threads");
       (async () => {
         const { newQuickJSWASMModuleFromVariant } = await import("quickjs-emscripten-core");
         const v = (await import("@jitl/quickjs-wasmfile-release-sync")).default;
         const out = [];
         for (const src of [
           "function f(n) { return f(n + 1) + 1; } f(0);",
           "let o = {}; for (let i = 0; i < 1e6; i++) o = { o }; JSON.stringify(o);",
           "eval('['.repeat(1e5) + ']'.repeat(1e5));",
         ]) {
           const qjs = await newQuickJSWASMModuleFromVariant(v);
           const rt = qjs.newRuntime();
           rt.setMaxStackSize(512 * 1024);
           rt.setMemoryLimit(16 * 1024 * 1024);
           const vm = rt.newContext();
           try {
             const r = vm.evalCode(src);
             const e = r.error ? vm.dump(r.error) : { name: "none", message: "" };
             (r.error ?? r.value).dispose();
             vm.dispose();
             rt.dispose();
             out.push(e.name + ": " + e.message);
           } catch (e) {
             out.push("host: " + String(e));
           }
         }
         parentPort.postMessage(out);
       })();`,
      { eval: true, resourceLimits: { stackSizeMb: 16 } },
    );
    const out = await new Promise<string[]>((resolve, reject) => {
      w.once("message", resolve);
      w.once("error", reject);
    });
    await w.terminate();
    expect(out).toEqual(["InternalError: stack overflow", expect.stringMatching(/^InternalError: (stack overflow|out of memory)$/), "SyntaxError: stack overflow"]);
  }, 30_000); // three fresh modules and a million-object loop; took over 5 s with the Mac at load 26

  test("interrupt handler stops an infinite loop", async () => {
    const qjs = await moduleWithCap(64 * MiB);
    const t0 = performance.now();
    const err = evalError(qjs, "for (;;) {}", (rt) => {
      const deadline = performance.now() + 100;
      rt.setInterruptHandler(() => performance.now() > deadline);
    });
    expect(err).toMatch(/interrupted/i);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  test("a host function can refuse calls past a budget, and the refusal survives a guest catch", async () => {
    const qjs = await moduleWithCap(64 * MiB);
    const vm = qjs.newContext();
    let calls = 0;
    let violated = false;
    const fn = vm.newFunction("call", () => {
      calls++;
      if (calls > 4) {
        violated = true;
        return { error: vm.newError("budget") };
      }
      return vm.undefined;
    });
    vm.setProp(vm.global, "call", fn);
    fn.dispose();
    const r = vm.evalCode("for (let i = 0; i < 100; i++) { try { call(); } catch {} }");
    if (r.error !== undefined) r.error.dispose();
    else r.value.dispose();
    vm.dispose();
    expect(calls).toBe(100);
    expect(violated).toBe(true);
  });

  test("a hanging host promise can be abandoned and every handle disposed", async () => {
    const qjs = await moduleWithCap(64 * MiB);
    const rt = qjs.newRuntime();
    const vm = rt.newContext();
    const pending = vm.newPromise();
    const fn = vm.newFunction("wait", () => pending.handle.dup());
    vm.setProp(vm.global, "wait", fn);
    fn.dispose();
    const r = vm.evalCode("(async () => { await wait(); return 1; })()");
    const p = vm.unwrapResult(r);
    rt.executePendingJobs();
    expect(vm.getPromiseState(p).type).toBe("pending");
    p.dispose();
    pending.dispose();
    vm.dispose();
    rt.dispose(); // throws on a leaked handle
    expect(rt.alive).toBe(false);
  });

  test("terminating the worker stops a busy guest that has no interrupt handler", async () => {
    const w = new Worker(
      `const { parentPort } = require("node:worker_threads");
       import("quickjs-emscripten-core").then(async ({ newQuickJSWASMModuleFromVariant }) => {
         const v = (await import("@jitl/quickjs-wasmfile-release-sync")).default;
         const qjs = await newQuickJSWASMModuleFromVariant(v);
         const vm = qjs.newContext();
         parentPort.postMessage("spinning");
         vm.evalCode("for (;;) {}");
       });`,
      { eval: true },
    );
    await new Promise<void>((resolve, reject) => {
      w.once("message", () => resolve());
      w.once("error", reject);
    });
    await new Promise((r) => setTimeout(r, 100));
    const t0 = performance.now();
    const code = await w.terminate();
    expect(code).toBe(1);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
