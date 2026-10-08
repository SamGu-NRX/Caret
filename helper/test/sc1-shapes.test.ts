// SC1 section 4, T-M1: every wire string's path matches a row of its purpose's shape (privacy/shapes.ts), one way it was
// minted carries only reasons the row allows, and it is no longer than the row's max. Disclosure.verify enforces this
// where every request is sent and when a builder seals it, so T-P1 (test/sc1-provenance.test.ts), which drives every
// builder through the real client, holds each builder to its row. This file checks the rule itself, each part with one
// correct answer, and that a builder adding a slot without a row fails.
import { describe, expect, it } from "vitest";
import { Disclosure, OutOfShape, setShapeLengthLog, UnmintedText, verifySent, type MintReason, type ModelText, type ShapeLengthRefusal, registryOf } from "../src/privacy/disclosure.ts";
import { ANY_PATH, childGlob, SHAPES, UNNAMED } from "../src/privacy/shapes.ts";
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

  it("gives the intent writer one value from a source window, its sender, by an explicit row, and no other", () => {
    expect(Object.entries(SHAPES.intent).filter(([, slot]) => slot.reasons.includes("candidate")).map(([glob]) => glob)).toEqual(["input.windows[*].from"]);
    const { m, view } = desk();
    const d = new Disclosure(m);
    const sender = d.candidate(view, "Elena Vance") as ModelText;
    const window = { ref: d.id("w1"), app: d.app(view), title: d.descriptor(view, "Notes") as ModelText, from: sender };
    expect(() => d.seal({ kind: "intent", input: { windows: [window] } })).not.toThrow();
    // The same value anywhere else in the intent's input is refused.
    expect(() => d.seal({ kind: "intent", input: { fields: [{ ref: d.id("f1"), name: sender }] } })).toThrow(/input\.fields\[0\]\.name carries text minted as candidate/u);
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
