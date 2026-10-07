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
import { identitiesOf, identityOf } from "../src/fill/whose.ts";
import { partAround } from "../src/fill/line-values.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { SnippetLedger } from "../src/privacy.ts";

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
    // G2 review: the sentence Jev read the span with (it warns, "not Oregon", so it went whole) rides with the value.
    expect(g?.basis?.clause).toBe(SENTENCE);
  });

  const SENTENCE = "I live in Portland, Maine, not Oregon. Recruiters keep mixing that up.";
  it("finds the note, unchanged, still gives that city: fill derived it from the line's span, and so does the check", () => {
    const sw = pageModel([location], note).windows.get("w4-note")!;
    // Failed before G2: the check derived a city only from the whole line, which is a sentence, not a place.
    expect(sourceHolds(sw, NOTE_KEY, "Portland", null, "combobox", SENTENCE)).toBe(true);
  });

  it("still refuses a line that no longer gives the city, a line that gained a label, and a sentence with no place", () => {
    const sw = (text: string) => pageModel([location], text).windows.get("w4-note")!;
    expect(sourceHolds(sw("I live in Bangor now. Recruiters keep mixing that up."), NOTE_KEY, "Portland", null, "combobox")).toBe(false);
    expect(sourceHolds(sw("Not this one: Portland, Maine"), NOTE_KEY, "Portland", null, "combobox")).toBe(false);
    expect(sourceHolds(sw("I flew through Portland once."), NOTE_KEY, "Portland", null, "combobox")).toBe(false);
  });
});

describe("identity: exact token equality only (whose.ts)", () => {
  const about = [
    { id: "m1", label: "primary email", value: "jo.abernathycole@example.com", kind: "email" as const },
    { id: "m2", label: "cell", value: "(512) 555-0147", kind: "phone" as const },
    { id: "m3", label: "full name", value: "Priya Castellanos", kind: "name" as const },
    { id: "m4", label: "nickname", value: "Jo", kind: "name" as const },
  ];
  const ids = identitiesOf(about);

  it("matches the same email in any case, the same phone digit groups, the same full name word for word", () => {
    expect(identityOf("JO.AbernathyCole@example.com", ids)).toEqual({ memoryId: "m1", kind: "email", label: "primary email", key: "jo.abernathycole@example.com" });
    expect(identityOf("512-555-0147", ids)?.memoryId).toBe("m2");
    expect(identityOf("(512) 555-0147", ids)?.memoryId).toBe("m2");
    expect(identityOf("Priya  Castellanos", ids)?.memoryId).toBe("m3");
  });

  it("matches no near miss, part, header or one-word name", () => {
    for (const t of ["jo.abernathycole@example.net", "jo.abernathycole@example.com.", "Jo Abernathy-Cole <jo.abernathycole@example.com>", "5125550147", "555-0147", "(512) 555-0148", "Priya", "priya castellanos", "Priya Castellanos-Diaz", "Jo"]) {
      expect(identityOf(t, ids), t).toBeNull();
    }
    // A one-word name is no identity at all.
    expect(ids.map((x) => x.a.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("partAround: the part of a date's or a contact's clause that says what it is", () => {
  const at = (line: string, text: string): string | null => partAround(line, line.indexOf(text), text);
  it("takes the comma part holding the value, and its neighbours when that part has no word of its own", () => {
    const school = "School: Lakeshore Polytechnic Institute, B.S. Electrical Engineering, September 2016 to May 2020.";
    expect(at(school, "September 2016")).toBe("September 2016 to May 2020");
    expect(at(school, "May 2020")).toBe("September 2016 to May 2020");
    expect(at("Of course. Put me down as Elena Varga; the best way to reach me is my cell, 555-0139, or this email.", "555-0139")).toBe("the best way to reach me is my cell, 555-0139, or this email");
    // A date's own commas split nothing.
    expect(at("Also, orientation is Sunday, October 18, 2026, so that's the earliest you could start.", "October 18, 2026")).toBe("orientation is Sunday, October 18, 2026, so that's the earliest you could start");
    expect(at("Started at Tallgrass Mechatronics in August 2022. Before that: Copperline.", "August 2022")).toBe("Started at Tallgrass Mechatronics in August 2022");
  });
  it("is null when the part is the value alone", () => {
    expect(at("555-0164", "555-0164")).toBeNull();
    expect(at("May 2021.", "May 2021")).toBeNull();
  });
});

describe("G2 review: optional context never takes a span's place", () => {
  it("6: with deferClauses the generator sets no optional clause; every one waits for fill, after every span", () => {
    for (const page of ["greenhouse", "wizard-2", "forty"]) {
      const m = pageModel([control("e1", "text", "Start date")], expectation(page).sources.note);
      const ledger = new SnippetLedger(m.windows.values());
      const c = collectCandidates(m, WIN, { deferClauses: true, ledger, fields: [new Set(["kind:date", "start"])] });
      const optional = c.candidates.filter((x) => c.clauses.has(x));
      expect(optional.length, page).toBeGreaterThan(0);
      for (const x of optional) expect(x.line ?? null, `${page}: ${x.text}`).toBeNull();
    }
  });
});

describe("G2 review: a full name's identity is its words as memory holds them", () => {
  it("8: matches a lower-case or non-Latin full name exactly, and nothing else", () => {
    const ids = identitiesOf([
      { id: "a", label: "name", value: "sam rivera", kind: "name" },
      { id: "b", label: "legal name", value: "张 伟", kind: "name" },
    ]);
    expect(identityOf("sam rivera", ids)?.memoryId).toBe("a");
    expect(identityOf("张 伟", ids)?.memoryId).toBe("b");
    for (const t of ["Sam Rivera", "sam  rivera jr", "张伟", "sam rivera <sam@example.com>"]) expect(identityOf(t, ids), t).toBeNull();
  });
});
