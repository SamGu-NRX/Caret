// A value in quotes, brackets or with sentence punctuation after it, for a field of an email, URL, phone or ID kind
// (kinds.ts unwrapValue, wrappedValue; contract.ts shapeRefusal). The four texts the verifier answered "exact" twice at
// 0.75 to 0.92 in slice 2's labelled set (~/.caret-run/evidence/act/slice3/sweep.txt) are refused by code; the value
// inside is what fill types. All values are synthetic.
import { describe, expect, it } from "vitest";
import { fieldKinds, unwrapValue, wrappedValue } from "../src/fill/kinds.ts";
import { makeFieldContract, shapeRefusal, type Proposed } from "../src/fill/contract.ts";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { writtenFields } from "../src/offers/fill-popup.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { optionIs } from "./builders.ts";

const kinds = (label: string) => fieldKinds([label]);
const proposed = (label: string, text: string, span = text): Proposed => ({
  field: makeFieldContract({ windowId: "form", node: { key: `form/${label}`, parent: null, role: "AXTextField", label }, descriptor: `Text field. Label: '${label}'.`, name: label, labelWords: [label, null, null], control: "text", kinds: kinds(label), part: null }),
  text,
  display: text,
  provenance: { kind: "window", windowId: "note", nodeKey: "note/body", app: "TextEdit", title: "Details.txt", span, label: null, line: null, partOf: null, context: null, lines: [], sentences: [] },
  owner: null,
});

// The slice 2 set's four false exacts at 0.75 and above that the shape check let through.
const FALSE_EXACTS: [string, string, string][] = [
  ["Mileage Plan number (optional)", '"123456796"', "123456796"],
  ["Portfolio or website", "https://harperq.example.amara-petrovic.", "https://harperq.example.amara-petrovic"],
  ["Portfolio or website", "https://harperq.example.rafael-quispe.", "https://harperq.example.rafael-quispe"],
  ["LinkedIn Profile", "<https://www.linkedin.com/in/priya-no-example>", "https://www.linkedin.com/in/priya-no-example"],
];

describe("wrapped values", () => {
  it("refuses each of the four false exacts, and reads the value inside each", () => {
    for (const [label, text, core] of FALSE_EXACTS) {
      expect(shapeRefusal(proposed(label, text, core)), text).toContain("marks around the value");
      expect(unwrapValue(text, kinds(label)), text).toBe(core);
    }
  });

  it("reads the value inside other marks and punctuation", () => {
    expect(unwrapValue("(dana.w@example.com)", kinds("Email"))).toBe("dana.w@example.com");
    expect(unwrapValue("dana.w@example.com;", kinds("Email"))).toBe("dana.w@example.com");
    expect(unwrapValue("“555-0147”.", kinds("Phone"))).toBe("555-0147");
    expect(unwrapValue("[LC-204417]", kinds("Student ID"))).toBe("LC-204417");
    expect(unwrapValue("<https://example.com/search?q=hello!>.", kinds("Website"))).toBe("https://example.com/search?q=hello!");
  });

  it("leaves whole values, and values of other kinds, alone", () => {
    for (const [label, text] of [
      ["Phone", "(303) 555-0148"],
      ["Phone", "+1 415 555 0142"],
      ["Email", "jo.abernathycole@example.com"],
      ["Website", "https://en.example.org/wiki/Fern_(plant)"],
      ["Student ID", "LC-204417"],
      ["Delivery instructions", "\"side door\", ring twice."],
      ["Full name", "(Dr.) Simone Achebe."],
      // Greptile review on #22: a link's query may end in "!" or "?".
      ["Website", "https://example.com/search?q=hello!"],
      ["Website", "https://example.com/faq?"],
    ] as const) {
      expect(wrappedValue(text, kinds(label)), text).toBe(false);
      expect(shapeRefusal(proposed(label, text)), text).toBeNull();
    }
  });

  it("refuses rather than guesses when what is inside is no whole value", () => {
    expect(unwrapValue("(call me)", kinds("Phone"))).toBeNull();
    expect(wrappedValue("(call me)", kinds("Phone"))).toBe(true);
    expect(unwrapValue("4.", kinds("Number of guests"))).toBeNull();
  });
});

// The generator keeps the marks: lineSpans cuts '"123456789"' from 'Mileage Plan: "123456789"', and
// "<https://harperq.example.com>." from a portfolio line (probed Oct 9). Fill types the value inside.
describe("fill types the value inside the marks", () => {
  const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
  const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
  const control = (id: string, name: string): PageControl => ({ id, key: `form[apply]/text:${name.toLowerCase()}~0`, strongKey: null, kind: "text", role: "text", name, form: "form#apply", rect: [0, Number(id.slice(1)) * 30, 100, 20], value: "" });
  const fields = [control("e1", "Mileage Plan number"), control("e2", "Portfolio or website")];
  const note = ["Trip notes", 'Mileage Plan: "123456789"', "Portfolio: <https://harperq.example.com>.", "Seat: aisle if possible", "Bring the passport"].join("\n");
  const desk = (): ScreenModel => {
    const m = new ScreenModel();
    m.apply({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 900, reason: "initial", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, window: { windowId: "note", kind: "standard", title: "Trip.txt", frame: [0, 0, 700, 500] }, focused: true, root: null, nodes: [{ key: "com.apple.TextEdit/standard/textarea:~0", parent: null, role: "AXTextArea", value: note, editable: true }], values: [], focusedKey: null, stats: { walkMs: 0, visited: 1, truncated: false } });
    const page: PageSnapshot = { type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply", frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/apply", navGen: 1, title: "Apply", headings: ["Apply"], iframes: [], excluded: {}, truncated: false, controls: fields }], missing: [], focused: { frameId: 0, id: "e1", selection: [0, 0] } };
    m.apply(toWindowSnapshot(page, session, 1));
    return m;
  };
  // Jev picks the spans as cut, marks and all.
  const want: Record<string, string> = { "Mileage Plan number": '"123456789"', "Portfolio or website": "<https://harperq.example.com>." };
  const ask: AskJev = async (req) => ({
    model: "scripted",
    inputTokens: 0,
    latencyMs: 0,
    costUsd: 0,
    answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
      const ins = String(q.instructions);
      if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.95 }];
      const label = /Label: '(.+?)'\./u.exec(ins)?.[1] ?? "";
      const hit = Object.entries(q.criteria).find(([, d]) => want[label] !== undefined && optionIs(String(d), want[label] as string))?.[0];
      return [id, { choice: hit ?? "none", confidence: 0.95 }];
    })),
  });

  it("writes 123456789 and the link, without the quotes, brackets or period", async () => {
    const p = await proposeFill(desk(), ask, "page:eng1:7", `f0/${(fields[0] as PageControl).key}`, 2000, { about: [] });
    const out = Object.fromEntries(writtenFields(p).fields.map((f) => [f.key, f.value]));
    expect(out[`f0/${(fields[0] as PageControl).key}`]).toBe("123456789");
    expect(out[`f0/${(fields[1] as PageControl).key}`]).toBe("https://harperq.example.com");
  });
});
