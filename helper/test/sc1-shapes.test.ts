// SC1 section 4, T-M1: every wire string's path matches a row of its purpose's shape (privacy/shapes.ts), one way it was
// minted carries only reasons the row allows, and it is no longer than the row's max. Disclosure.verify enforces this
// where every request is sent and when a builder seals it, so T-P1 (test/sc1-provenance.test.ts), which drives every
// builder through the real client, holds each builder to its row. This file checks the rule itself, each part with one
// correct answer, and that a builder adding a slot without a row fails.
import { describe, expect, it } from "vitest";
import { Disclosure, OutOfShape, setShapeLengthLog, UnmintedText, verifySent, type MintReason, type ModelText, type ShapeLengthRefusal, registryOf } from "../src/privacy/disclosure.ts";
import { ANY_PATH, childGlob, ITEMS, SHAPES, UNNAMED } from "../src/privacy/shapes.ts";
import { OPTION_DESCRIPTIONS, wireBody, type JevRequest } from "../src/fill/jev.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { intentSnapshot } from "../src/planner/intent.ts";
import { headsRequest } from "../src/planner/intent-heads.ts";
import { field, node, snap, text } from "./builders.ts";

const REASONS: readonly MintReason[] = ["ownWording", "descriptor", "candidate", "instruction", "memory", "held", "plan", "drafted"];

function desk(): { m: ScreenModel; view: WindowState; form: WindowState } {
  const m = new ScreenModel();
  m.apply(snap([text("n1", "Name: Elena Vance"), text("n2", "Guests: 2")], { at: 900, windowId: "note", title: "Notes" }));
  m.apply(snap([node("pg/h", "AXHeading", { label: "Contact" }), field("pg/name", "", { label: "Full name" }), field("pg/email", "", { label: "Email" })], { at: 1000, windowId: "form", title: "Apply", focused: true }));
  return { m, view: redactWindow(m.windows.get("note") as WindowState), form: m.windows.get("form") as WindowState };
}

describe("T-M1: the shape table", () => {
  it("is well formed: globs, reasons and lengths, and only the unnamed shape matches any path", () => {
    for (const [purpose, rows] of Object.entries(SHAPES)) {
      for (const [glob, slot] of Object.entries(rows)) {
        expect(glob === ANY_PATH ? purpose : "", `${purpose} ${glob}`).toBe(glob === ANY_PATH ? UNNAMED : "");
        if (glob !== ANY_PATH) expect(glob, purpose).toMatch(/^(?:state|questions\.\*|input)(?:\.[A-Za-z0-9_]+|\.\*|\[\*\])*$/u);
        expect(slot.reasons.length, `${purpose} ${glob}`).toBeGreaterThan(0);
        for (const r of slot.reasons) expect(REASONS, `${purpose} ${glob}`).toContain(r);
        expect(slot.max, `${purpose} ${glob}`).toBeGreaterThanOrEqual(100);
      }
    }
    // The unnamed shape carries Caret's own wording only.
    expect(SHAPES[UNNAMED]).toEqual({ [ANY_PATH]: { reasons: ["ownWording"], max: 4000 } });
  });

  it("names a path's glob by its place, whatever its ids hold", () => {
    expect(childGlob("", "state")).toBe("state");
    expect(childGlob("state.fields", 3)).toBe("state.fields[*]");
    expect(childGlob("questions", "f3.x")).toBe("questions.*");
    expect(childGlob("questions.*.criteria", "a.b")).toBe("questions.*.criteria.*");
    // A description the client hoists (fill/jev.ts wireBody) is checked as the option it came from.
    expect(childGlob("state", OPTION_DESCRIPTIONS)).toBe("state.option_descriptions");
    expect(childGlob("state.option_descriptions", "c1")).toBe("questions.*.criteria.*");
  });
});

describe("T-M1: verify holds each text to its slot", () => {
  it("fails when a builder adds a slot without a row, naming the path, at build and at the client", () => {
    const { m, form } = desk();
    const s = intentSnapshot("put my name in", m, form, []);
    const req = headsRequest(s);
    const d = req.disclosure;
    // The builder's request as built is in shape.
    expect(() => verifySent(req, wireBody(req, "jev-test"))).not.toThrow();
    const grown: JevRequest = { ...req, state: { ...(req.state as Record<string, ModelText>), page_text: d.own("More of the page.") } };
    expect(() => verifySent(grown, wireBody(grown, "jev-test"))).toThrow(OutOfShape);
    expect(() => verifySent(grown, wireBody(grown, "jev-test"))).toThrow(/state\.page_text has no row/u);
    expect(() => d.seal({ purpose: "ask.heads", state: { page_text: d.own("More of the page.") }, questions: {} })).toThrow(/state\.page_text has no row/u);
    // A new question slot too.
    expect(() => d.seal({ purpose: "ask.heads", state: {}, questions: { q: { type: "choice", instructions: d.own("Which?"), criteria: {}, hint: d.own("A hint.") } } })).toThrow(/questions\.q\.hint has no row/u);
  });

  it("refuses a text minted for a reason its slot does not allow, naming the reasons, never the text", () => {
    const { m, view } = desk();
    const d = new Disclosure(m);
    const name = d.candidate(view, "Elena Vance") as ModelText;
    // route.judge's task is Caret's wording only.
    expect(() => d.seal({ purpose: "route.judge", state: { task: name }, questions: {} })).toThrow(/state\.task carries text minted as candidate, which its shape allows only as ownWording/u);
    try {
      d.seal({ purpose: "route.judge", state: { task: name }, questions: {} });
    } catch (e) {
      expect(String(e)).not.toContain("Elena");
    }
    // Composing keeps the candidate in it.
    expect(() => d.seal({ purpose: "route.judge", state: { task: d.t`The user is ${name}.` }, questions: {} })).toThrow(OutOfShape);
    // Where the row allows candidates, it goes.
    expect(() => d.seal({ purpose: "route.judge", state: {}, questions: { q: { type: "choice", instructions: d.own("Which?"), criteria: { a: d.t`"${name}"` } } } })).not.toThrow();
  });

  it("accepts a text one way of minting fits: a count Caret wrote that a window also shows", () => {
    const { m, view } = desk();
    const d = new Disclosure(m);
    expect(d.candidate(view, "2")).toBe("2");
    const two = d.count(2);
    expect([...(d.reasonsOf(two) ?? [])].sort()).toEqual(["candidate", "ownWording"]);
    expect(() => d.seal({ purpose: "route.judge", state: { task: two }, questions: {} })).not.toThrow();
    expect(() => d.seal({ purpose: "route.judge", state: { task: d.t`Pick ${two} of them.` }, questions: {} })).not.toThrow();
  });

  it("refuses a text longer than its slot, naming the lengths, never the text, and logs the purpose, slot and length", () => {
    const d = new Disclosure(registryOf([]));
    const long = d.own(`${"x".repeat(296)}-pw7Q` as "x");
    const logged: ShapeLengthRefusal[] = [];
    const was = setShapeLengthLog((r) => logged.push(r));
    try {
      expect(() => d.seal({ purpose: "route.judge", state: { task: long }, questions: {} })).toThrow(/state\.task holds 301 characters, more than its shape's 300/u);
    } finally {
      setShapeLengthLog(was);
    }
    // The limits are unmeasured (privacy/shapes.ts): the log is what a live run measures them by, and holds no text.
    expect(logged).toEqual([{ purpose: "route.judge", slot: "state.task", length: 301, max: 300 }]);
    expect(JSON.stringify(logged)).not.toContain("pw7Q");
  });

  it("checks a hoisted option description as the option it came from, and a JSON state as the value it writes", () => {
    const { m, view } = desk();
    const d = new Disclosure(m);
    const name = d.candidate(view, "Elena Vance") as ModelText;
    const q = { type: "choice" as const, instructions: d.own("Which?"), criteria: { a: d.t`"${name}"`, none: d.own("None.") } };
    const ok = d.seal({ purpose: "fill.values", state: { task: d.own("Fill.") }, questions: { f1: q, f2: q }, snippets: [], charged: {} });
    const hoisted = wireBody(ok as JevRequest, "jev-test", true);
    expect(OPTION_DESCRIPTIONS in (hoisted.state as object)).toBe(true);
    expect(() => verifySent(ok, hoisted)).not.toThrow();
    // A description hoisted into the state of a purpose whose options are Caret's only (fill.verify).
    const own = { purpose: "fill.verify" as const, disclosure: d };
    expect(() => verifySent(own, { state: { [OPTION_DESCRIPTIONS]: { a: q.criteria.a } }, questions: {} })).toThrow(/state\.option_descriptions\.a carries text minted as/u);
    // A state written as one JSON text (engines/decide/harness.ts layaState) is checked as the value it writes.
    expect(() => verifySent({ purpose: "route.judge", disclosure: d }, { state: d.jsonText({ task: d.own("Route.") }), questions: {} })).not.toThrow();
    expect(() => verifySent({ purpose: "route.judge", disclosure: d }, { state: d.jsonText({ task: name }), questions: {} })).toThrow(/state\.task carries text minted as candidate/u);
  });

  it("holds a request with no purpose to Caret's own wording, and refuses a purpose with no shape", () => {
    const { m, view } = desk();
    const d = new Disclosure(m);
    expect(() => d.seal({ state: { anything: d.own("Fixture wording.") }, questions: {} })).not.toThrow();
    expect(() => d.seal({ state: { anything: d.candidate(view, "Elena Vance") } , questions: {} })).toThrow(/unnamed: state\.anything carries text minted as candidate/u);
    expect(() => d.verify("no.such.purpose", { state: {} })).toThrow(/no\.such\.purpose has no request shape/u);
    // OutOfShape is an UnmintedText: every caller that handles one handles both.
    expect(new OutOfShape("x")).toBeInstanceOf(UnmintedText);
  });
});

describe("every list in a request has an item count (privacy/shapes.ts ITEMS)", () => {
  it("names one for every list a shape's rows reach", () => {
    const missing: string[] = [];
    for (const [purpose, rows] of Object.entries(SHAPES)) {
      for (const glob of Object.keys(rows)) {
        for (const m of glob.matchAll(/\[\*\]|\.\*/gu)) {
          const items = glob.slice(0, m.index + m[0].length);
          if ((ITEMS as Record<string, Record<string, number>>)[purpose]?.[items] === undefined) missing.push(`${purpose} ${items}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("refuses a list over its count, naming the counts, never the text, and logs the purpose, list and count", () => {
    const d = new Disclosure(registryOf([]));
    const ask = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, { type: "choice" as const, instructions: d.own(`Question ${i}?` as "x"), criteria: {} }]));
    const logged: ShapeLengthRefusal[] = [];
    const was = setShapeLengthLog((r) => logged.push(r));
    try {
      expect(() => d.seal({ purpose: "route.task", state: {}, questions: ask(3) })).toThrow(/questions holds 3 items, more than its shape's 2/u);
      expect(() => d.seal({ purpose: "route.task", state: {}, questions: ask(2) })).not.toThrow();
    } finally {
      setShapeLengthLog(was);
    }
    expect(logged).toEqual([{ purpose: "route.task", slot: "questions.*", items: 3, max: 2 }]);
  });
});

// A shape holds a request's keys and scalar types, not only its strings and lists.
describe("a request's keys and scalar types are its shape's too", () => {
  it("refuses a number where its shape has an object, and an object where it has none", () => {
    const d = new Disclosure(registryOf([]));
    expect(() => d.seal({ purpose: "fill.whose", state: { source_notes: 12 as never }, questions: {} })).toThrow(OutOfShape);
    expect(() => d.seal({ purpose: "fill.whose", state: {}, questions: 4 as never })).toThrow(OutOfShape);
  });

  it("refuses ten thousand numeric fields no row names", () => {
    const d = new Disclosure(registryOf([]));
    const state = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`f${i}`, i]));
    expect(() => d.seal({ purpose: "route.judge", state, questions: {} })).toThrow(OutOfShape);
  });

  it("accepts the scalars a shape names, at their type only", () => {
    const d = new Disclosure(registryOf([]));
    expect(() => d.seal({ purpose: "pattern.naming", state: { timesSeen: 3 }, questions: {} })).not.toThrow();
    expect(() => d.seal({ purpose: "pattern.naming", state: { timesSeen: true as never }, questions: {} })).toThrow(OutOfShape);
  });
});
