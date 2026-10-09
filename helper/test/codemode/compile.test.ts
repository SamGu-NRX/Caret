import { describe, expect, test } from "vitest";
import { compileProgram } from "../../src/codemode/compile.ts";

const wrap = (body: string) => `async function main(caret: CaretPlanAPI): Promise<PlanRef> {\n${body}\n}`;
const detail = (src: string) => {
  const r = compileProgram(src);
  return r.ok ? "ok" : r.detail;
};

describe("compileProgram", () => {
  test("erases types and keeps the program", () => {
    const r = compileProgram(wrap("const s = new Set<string>(); const m: Map<string, number> = new Map(); return caret.plan({ basedOn: 'x' as SnapshotRef, steps: [] });"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.js).not.toContain("SnapshotRef");
  });

  test.each([
    ["enum", "enum A { B }", "type erasure refused"],
    ["namespace", "namespace N { export const x = 1; }", "type erasure refused"],
    ["class", "class A {}", "ClassDeclaration is not allowed"],
    ["new Function", "new Function('return 1')", "new is allowed only for Map, Set and Error"],
    ["new Proxy", "new Proxy({}, {})", "new is allowed only for Map, Set and Error"],
    ["regex", "const r = /a+/;", "regular expressions"],
    ["getter", "const o = { get x() { return 1; } };", "getters, setters and methods"],
    ["this", "const t = this;", "ThisExpression is not allowed"],
    ["function expression", "const f = function () {};", "FunctionExpression is not allowed"],
    ["nested declaration", "function g() {}", "functions other than main must be arrow functions"],
    ["delete", "const o = { a: 1 }; delete o.a;", "the delete operator is not allowed"],
    ["constructor", "const c = (() => {}).constructor;", ".constructor is not available"],
    ["computed constructor", "const c = (() => {})['constructor'];", ".constructor is not available"],
    ["globalThis", "globalThis.x = 1;", "globalThis is not available"],
    ["with-like sequence", "const a = (1, 2);", "SequenceExpression is not allowed"],
    ["label", "outer: for (const x of []) {}", "LabeledStatement is not allowed"],
  ])("refuses %s", (_name, body, expected) => {
    expect(detail(wrap(body))).toContain(expected);
  });

  test("allows a ReadWindow's .window ref, never the window global or a computed window (B30)", () => {
    expect(detail(wrap("const w = await caret.readWindow(); const r = w.window; return caret.plan({ basedOn: w.snapshot, steps: [] });"))).toBe("ok");
    expect(detail(wrap("const x = window;"))).toContain("window is not available");
    expect(detail(wrap("const w = await caret.readWindow(); const r = w['window'];"))).toContain(".window is not available");
  });

  test("allows switch, which writers use to map a choice", () => {
    expect(detail(wrap("const k = 'a' as string; switch (k) { case 'a': break; default: break; } return caret.plan({ basedOn: 'x' as SnapshotRef, steps: [] });"))).toBe("ok");
  });

  test("refuses programs that are not one async main(caret)", () => {
    expect(detail("const x = 1;")).toContain("exactly one declaration");
    expect(detail(`${wrap("")}\nconst y = 2;`)).toContain("exactly one declaration");
    expect(detail("function main(caret: any) {}")).toContain("must be: async function main(caret)");
    expect(detail("async function run(caret: any) {}")).toContain("must be: async function main(caret)");
    expect(detail("async function main(a: any, b: any) {}")).toContain("must be: async function main(caret)");
    expect(detail("async function* main(caret: any) {}")).toContain("must be: async function main(caret)");
  });

  test("a deeply nested program is refused without overflowing the host", () => {
    const deep = wrap(`const x = ${"[".repeat(7000)}${"]".repeat(7000)};`);
    expect(detail(deep)).not.toBe("ok");
  });

  test("the source limit counts UTF-8 bytes", () => {
    expect(detail(wrap(`const s = "${"é".repeat(9000)}";`))).toContain("bytes; the limit is 16384");
  });
});
