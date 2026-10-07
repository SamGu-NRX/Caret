// G2: who a value belongs to, decided from evidence; and the Greenhouse task page's Location stops. Every name, number
// and address is synthetic (F1's task fixtures, fixtures/web-form/tasks/expect).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { sourceHolds, writtenFields } from "../src/offers/fill-popup.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";

const TASKS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "fixtures", "web-form", "tasks", "expect");
const expectation = (page: string): { sources: { note: string } } => JSON.parse(readFileSync(join(TASKS, `${page}.json`), "utf8"));

const ORIGIN = "http://127.0.0.1:4310";
const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const WIN = "page:eng1:7";
const NOTE_KEY = "com.apple.TextEdit/standard/textarea:~0";

const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({
  id,
  key: `form[apply]/${kind}:${name.toLowerCase()}~0`,
  strongKey: null,
  kind,
  role: kind,
  name,
  form: "form#apply",
  rect: [0, 0, 100, 20],
  ...extra,
});

/** A page form through the page engine, and the note the user just left as page-loop-eval.ts replays it (noteWindow). */
function pageModel(controls: PageControl[], note: string): ScreenModel {
  const page: PageSnapshot = {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/apply", navGen: 1, title: "Apply", headings: ["Apply"], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [],
    focused: { frameId: 0, id: controls[0]?.id ?? "e1", selection: [0, 0] },
  };
  const m = new ScreenModel();
  m.apply(snap([field(NOTE_KEY, note, { role: "AXTextArea" })], { at: 900, windowId: "w4-note", title: "Application details.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
  m.apply(toWindowSnapshot(page, session, 1));
  return m;
}
const keyOf = (c: PageControl): string => `f0/${c.key}`;

describe("Greenhouse task page: the Location step's source check (G1 fix 1, frozen from LV1 pass 1)", () => {
  // LV1 pass 1 (evidence/screen/lv1/r1-jev/sets/tasks-blind/pass-1/jev.ndjson lines 65-66, 71-92): both asks picked the
  // derived city "Portland" of the span "Portland, Maine", which the note's sentence bounds, for 'Location (City)' at
  // 0.88 to 0.97, and every segment then stopped with "The window Caret copies 'Location (City)' from no longer shows it",
  // before School and the education end date (correct at 0.87 to 0.98) were written.
  const note = expectation("greenhouse").sources.note;
  const location = control("e1", "combobox", "Location (City)", { value: "" });

  it("reads Location's value as LV1's asks did: the city of 'Portland, Maine', from an unlabelled sentence", async () => {
    const m = pageModel([location], note);
    const p = await proposeFill(m, jevPickingText((_, ins) => (ins.includes("Location (City)") ? "Portland" : null), 0.93), WIN, keyOf(location), 2000);
    const f = p.fields.find((x) => x.key === keyOf(location));
    expect(f).toMatchObject({ control: "combobox", handoff: { value: "Portland", writes: true, source: { windowId: "w4-note", nodeKey: NOTE_KEY } } });
    expect(f?.handoff?.context).toBeUndefined();
    const g = writtenFields(p).fields.find((x) => x.key === keyOf(location));
    expect(g).toMatchObject({ span: "Portland", context: null, control: "combobox" });
  });

  it("finds the note, unchanged, still gives that city: fill derived it from the line's span, and so does the check", () => {
    const sw = pageModel([location], note).windows.get("w4-note")!;
    // Failed before G2: the check derived a city only from the whole line, which is a sentence, not a place.
    expect(sourceHolds(sw, NOTE_KEY, "Portland", null, "combobox")).toBe(true);
  });

  it("still refuses a line that no longer gives the city, a line that gained a label, and a sentence with no place", () => {
    const sw = (text: string) => pageModel([location], text).windows.get("w4-note")!;
    expect(sourceHolds(sw("I live in Bangor now. Recruiters keep mixing that up."), NOTE_KEY, "Portland", null, "combobox")).toBe(false);
    expect(sourceHolds(sw("Not this one: Portland, Maine"), NOTE_KEY, "Portland", null, "combobox")).toBe(false);
    expect(sourceHolds(sw("I flew through Portland once."), NOTE_KEY, "Portland", null, "combobox")).toBe(false);
  });
});
