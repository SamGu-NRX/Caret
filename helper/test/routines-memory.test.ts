// B20: what the routine recognizer remembers about a window that comes apart before it closes, and which
// clicked labels may be kept as a routine's finish.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { MemoryStore } from "../src/patterns/memory.ts";
import { finishLabel, RoutineRecognizer } from "../src/patterns/routines.ts";
import { templateOf } from "../src/patterns/shape.ts";
import type { Node } from "../src/protocol.ts";
import { snap } from "./builders.ts";

describe("where a window's elements were last seen", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const field = (k: string): Node => ({ key: k, parent: null, role: "AXTextField", label: "City", editable: true });

  it("keeps the place an element was first seen at when the elements before it go", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-routines-memory-"));
    dirs.push(dir);
    const model = new ScreenModel();
    const memory = new MemoryStore(dir);
    const r = new RoutineRecognizer(model, memory, (t) => t);
    const [first, second] = ["app/standard/textfield:city~0", "app/standard/textfield:city~1"];
    model.apply(snap([field(first), field(second)], { at: 1, windowId: "w" }));
    r.observe("w", true);
    expect(r.seenSlot("w", second)).toEqual({ template: templateOf(second, "AXTextField"), pos: 1 });
    // The page comes apart: the first field goes, and the second is now the only one of its template.
    model.apply(snap([field(second)], { at: 2, windowId: "w" }));
    r.observe("w", true);
    expect(r.seenSlot("w", second)?.pos).toBe(1);
    // A window nobody is editing in and with nothing under way is not remembered.
    r.observe("w", false);
    expect(r.seenSlot("w", second)).toBeUndefined();
    memory.close();
  });
});

describe("labels a clicked finish may be kept under", () => {
  it("keeps a short name for an action and refuses one carrying an address, a number or a link", () => {
    for (const ok of ["Send", "Send later", "Delete draft", "Pay invoice"]) expect(finishLabel(ok), ok).toBe(true);
    for (const no of ["", "Send to dana@example.com", "Pay $40", "Open https://example.com", "Send this message to everyone now", "x".repeat(41)]) expect(finishLabel(no), no).toBe(false);
  });
});
