// SCP1: an Ask that names one section of a form writes only fields the window places in that section. Jev decides scope;
// code only vetoes: a field Jev chose in both wordings is taken out when the request named one section and the window
// places the field elsewhere, or can't place it. Sections are occurrences, not text: the named heading text must be one
// occurrence the window shows, and a field is in it when that occurrence contains it. A correct value for a field is no
// authority to write it. A synthetic service form ("Equipment details", "Service contact"); every name is invented.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { PageSnapshot, type Node, type PageControl } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { SELF_IDENTIFICATION } from "../src/engines/page-exclusions.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { intentSnapshot, type IntentSnapshot } from "../src/planner/intent.ts";
import { headsIntentMaker, headsRequest, readHeads, scopeId, scopeRequest, settleFields } from "../src/planner/intent-heads.ts";
import type { IntentMaker } from "../src/planner/intent-makers.ts";
import { AskAsks, AskRefused, planAsk, type AskDraft, type AskGoal } from "../src/planner/ask.ts";
import { askScope, scopeSet, sectionMembership, sectionPlacement, sectionRefusal, windowOutline, withScope } from "../src/fill/ask-scope.ts";
import { sectionName } from "../src/engines/page-exclusions.ts";
import { guardFor } from "../src/fill/contract.ts";
import { validatePlan } from "../src/planner/validate.ts";
import { buildInventory } from "../src/goals/inventory.ts";
import { macClock } from "../src/offers/event-time.ts";
import type { TypedValue } from "../src/protocol.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { forgetWindows, SnippetLedger } from "../src/privacy.ts";
import { secretText } from "../src/memory/sensitive.ts";
import { SAYS } from "../src/planner/says.ts";
import { rng } from "./large-scene.ts";
import { field, node, snap } from "./builders.ts";

const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const NOTES = "Serial number: SN-4471-B\nModel: Kestrel 9\nContact name: Mira Vale\nContact phone: +1 202-555-0146";
const VALUES: Record<string, string> = { "Serial number": "SN-4471-B", Model: "Kestrel 9", "Contact name": "Mira Vale", "Contact phone": "+1 202-555-0146" };
const EQUIPMENT = ["Serial number", "Model"];
const CONTACT = ["Contact name", "Contact phone"];
const ALL = [...EQUIPMENT, ...CONTACT];
const INSTRUCTION = "fill the equipment details section from my notes";
const SECTION_FIELD = (name: string): string => `${name}: Caret couldn't tell which section this field is in.`;

/** The service form as the reader shows it: each section's heading before its fields, in document order. */
function readerForm(o: { headings?: boolean; contactFirst?: boolean } = {}): Node[] {
  const h = (key: string, label: string): Node[] => (o.headings === false ? [] : [node(key, "AXHeading", { label })]);
  const equipment = [...h("h/eq", "Equipment details"), field("f/serial", "", { label: "Serial number", frame: [20, 80, 200, 24] }), field("f/model", "", { label: "Model", frame: [20, 120, 200, 24] })];
  const contact = [...h("h/ct", "Service contact"), field("f/cname", "", { label: "Contact name", frame: [20, 200, 200, 24] }), field("f/cphone", "", { label: "Contact phone", frame: [20, 240, 200, 24] })];
  return [node("h/top", "AXHeading", { label: "Service request" }), ...(o.contactFirst === true ? [...contact, ...equipment] : [...equipment, ...contact])];
}

/** A page walk's outline: the frame's occurrences, and each control's chain of occurrence ids, by control name. */
interface Walked {
  occurrences: { id: string; heading: boolean; text?: string }[];
  chains: Record<string, readonly string[]>;
}

/**
 * The service form as the page engine walks it: the frame's heading list, and, from an SCP1 extension, its section
 * occurrences and each control's chain (`walked`). `extra` adds controls after the four fields.
 */
function pageSnapshot(headings: readonly string[], walked?: Walked, extra: PageControl[] = []): ReturnType<typeof toWindowSnapshot> {
  const control = (id: string, name: string, y: number): PageControl => ({ id, key: `form@0/textbox:${name.toLowerCase()}~0`, strongKey: null, kind: "text", role: "textbox", name, value: "", form: "form@0", rect: [20, y, 200, 24] });
  const controls = [control("e1", "Serial number", 80), control("e2", "Model", 120), control("e3", "Contact name", 200), control("e4", "Contact phone", 240), ...extra].map((c) => {
    const chain = walked?.chains[c.name];
    return chain === undefined || chain.length === 0 ? c : { ...c, sections: [...chain] };
  });
  const s = PageSnapshot.parse({
    type: "pageSnapshot",
    v: 1,
    id: "walk-1",
    at: 2000,
    tabId: 41,
    browserWindowId: 40,
    active: true,
    inFocusedWindow: true,
    title: "Service request",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "doc-1", origin: "https://service.example", path: "/request", navGen: 0, title: "Service request", headings: [...headings], ...(walked === undefined ? {} : { sections: walked.occurrences }), controls, iframes: [], excluded: {}, truncated: false }],
    missing: [],
    focused: null,
  });
  const session = new EngineSession({ engine: "scp1", browser: { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" }, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
  return toWindowSnapshot(s, session, 1);
}

/** The walk of `<h1>Service request</h1><form><h2>Equipment details</h2>…<h2>Service contact</h2>…</form>`. */
const WALKED: Walked = {
  occurrences: [
    { id: "o1", heading: true, text: "Service request" },
    { id: "o2", heading: true, text: "Equipment details" },
    { id: "o3", heading: true, text: "Service contact" },
  ],
  chains: { "Serial number": ["o1", "o2"], Model: ["o1", "o2"], "Contact name": ["o1", "o3"], "Contact phone": ["o1", "o3"] },
};
const HEADINGS = ["Service request", "Equipment details", "Service contact"];

/** A desk: the user's notes, then the form, focused. `page` puts the page engine's walk in place of the reader's window. */
function desk(form: { reader?: Node[]; page?: ReturnType<typeof toWindowSnapshot> }): { model: ScreenModel; windowId: string } {
  forgetWindows();
  const m = new ScreenModel();
  m.apply(snap([{ key: "n", parent: null, role: "AXTextArea", value: NOTES, editable: true }], { at: 1000, windowId: "7001-1", title: "Service notes.txt", app: NOTE_APP, focused: true }));
  if (form.page !== undefined) {
    m.apply({ ...form.page, at: 2000, focused: true });
    m.frontmostPid = form.page.app.pid;
    return { model: m, windowId: form.page.window.windowId };
  }
  m.apply(snap(form.reader ?? readerForm(), { at: 2000, windowId: "F", title: "Service request", focused: true }));
  return { model: m, windowId: "F" };
}
const windowOf = (d: ReturnType<typeof desk>) => {
  const w = d.model.windows.get(d.windowId);
  if (w === undefined) throw new Error("no form window");
  return w;
};
const snapFor = (d: ReturnType<typeof desk>, instruction = INSTRUCTION): IntentSnapshot => intentSnapshot(instruction, d.model, windowOf(d), []);

type A = { choice: string; confidence: number };
type Section = A | ((wording: 0 | 1) => A);
/** The section question's answer for the option naming `heading`, in both wordings. */
const named = (heading: string, confidence = 0.95) => (q: JevRequest["questions"][string]): A => ({ choice: Object.entries(q.criteria).find(([, d]) => d?.includes(`'${heading}'`) === true)?.[0] ?? "unclear", confidence });

/**
 * A stand-in Jev that every gate after scope would let through: the heads fill some fields from any source for the user;
 * the scope ask answers "asks" for `asks` (and "unclear" for `unclear`) in both wordings at 0.99; every contact field is
 * someone else's and every contact value is that person's ("other" in both); each value question picks the notes' value;
 * the verifier says "exact" at 1.0. `section` answers the section question, by the option for a heading, or as given.
 */
function jev(o: { asks?: readonly string[]; unclear?: readonly string[]; section?: string | Section; route?: string; asksOnce?: readonly string[] } = {}) {
  const seen: JevRequest[] = [];
  let scopeWording = 0;
  const ask: AskJev = async (req) => {
    seen.push(req);
    const wording = req.purpose === "ask.scope" ? ((scopeWording++ % 2) as 0 | 1) : 0;
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        const a = (choice: string, confidence = 0.95) => [id, { choice, confidence }] as const;
        if (req.purpose === "ask.heads") return a({ route: o.route ?? "some", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none");
        if (id === "section") {
          const s = o.section ?? "fields";
          if (typeof s === "string") return s in q.criteria ? a(s) : ([id, named(s)(q)] as const);
          return [id, typeof s === "function" ? s(wording) : s] as const;
        }
        if (req.purpose === "ask.scope") {
          const label = /[Tt]he field '([^']+)'/u.exec(ins)?.[1] ?? "";
          if ((o.unclear ?? []).includes(label)) return a("unclear", 0.99);
          const once = (o.asksOnce ?? []).includes(label) && wording === 1;
          return a((o.asks ?? ALL).includes(label) && !once ? "asks" : "not", 0.99);
        }
        if (req.purpose === "fill.verify") return a("exact" in q.criteria ? "exact" : "none", 1);
        if (id.endsWith("_whose")) return a(CONTACT.some((l) => ins.includes(`'${l}'`)) ? "other" : "user" in q.criteria ? "user" : "other");
        if (id.endsWith("_owner")) return a(/Mira|202-555/u.test(ins) ? "other" : "user" in q.criteria ? "user" : "other");
        if ("yes" in q.criteria) return a("yes");
        const want = Object.entries(VALUES).find(([label]) => ins.includes(`'${label}'`))?.[1];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
        return a(hit?.[0] ?? "none");
      }),
    );
    return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 } satisfies JevResult;
  };
  return { ask, seen };
}

const plan = (d: ReturnType<typeof desk>, j: ReturnType<typeof jev>, instruction = INSTRUCTION, goals = false, maker?: IntentMaker, resume?: Parameters<typeof planAsk>[4]["resume"]) =>
  planAsk(instruction, d.model, { values: () => [] }, [], { askJev: j.ask, maker: maker ?? headsIntentMaker(j.ask), writer: null, offerKey: "scp1", windowId: d.windowId, now: 3000, ...(goals ? { goals: true } : {}), ...(resume === undefined ? {} : { resume }) });

/** The field names an Ask writes (a fill's writes and controls), or a page goal's scope, by label. Any refusal throws. */
function written(r: AskDraft | AskGoal, d: ReturnType<typeof desk>): string[] {
  const label = (k: string): string => windowOf(d).nodes.get(k)?.label ?? k;
  if (r.route === "goal") return (r.page?.scope.fields ?? []).map(label);
  return [...r.checked.writes.map((v) => label(v.node.key)), ...(r.controls ?? []).map((c) => c.name)];
}

/** The Ask's refusal: an AskRefused (never a question, never another error), which the test then reads. */
async function refusal(p: Promise<unknown>): Promise<AskRefused> {
  let out: unknown;
  try {
    out = await p;
  } catch (e) {
    if (e instanceof AskAsks) throw new Error(`expected a refusal, got a question: ${e.message}`);
    if (!(e instanceof AskRefused)) throw e;
    return e;
  }
  throw new Error(`expected a refusal, got a ${(out as { route?: string }).route ?? "result"}`);
}

/** A refusal that withholds every field because Caret couldn't place them in the section the request named. */
function expectSectionRefusal(e: AskRefused, names: readonly string[]): void {
  expect(e.code).toBe("unsure");
  expect(e.message).toBe(`Caret couldn't tell which section ${names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} or ${names[1]}` : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`} ${names.length === 1 ? "is" : "are"} in, so it filled nothing. Name the fields you want filled.`);
}

describe("a section-only Ask (Part A: the veto)", () => {
  it("leaves out a field seen under another section, though Jev answered asks for it twice", async () => {
    const d = desk({ reader: readerForm() });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(r, d)).toEqual(EQUIPMENT);
    // Not in the Ask's authority either: a later step of the same Ask can't write it.
    const authority = r.checked.writes[0]?.checked.authority;
    expect(authority?.kind).toBe("ask");
    const fields = authority?.kind === "ask" ? [...authority.scope.fields] : [];
    expect(fields.sort()).toEqual(["f/model", "f/serial"]);
  });

  it("would have written both contact values without the veto: values agree, other/other, exact=1 (the b31-07 shape)", async () => {
    const d = desk({ reader: readerForm() });
    const r = (await plan(d, jev({ section: "fields" }))) as AskDraft;
    expect(written(r, d)).toEqual(ALL);
    expect(r.checked.writes.map((x) => x.value)).toEqual(Object.values(VALUES));
  });

  it("writes nothing it can't place in the named section, and says why (a page walk with no section evidence)", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS) });
    expectSectionRefusal(await refusal(plan(d, jev({ section: "Equipment details" }))), ALL);
    // The page goal path, as the helper plans a page Ask.
    expectSectionRefusal(await refusal(plan(d, jev({ section: "Equipment details" }), INSTRUCTION, true)), ALL);
  });

  it("writes nothing when the reader shows no heading before the fields, and says why", async () => {
    const nodes = readerForm({ headings: false });
    const d = desk({ reader: [...nodes, node("h/eq", "AXHeading", { label: "Equipment details" }), node("h/ct", "AXHeading", { label: "Service contact" })].filter((n) => n.key !== "h/top") });
    expectSectionRefusal(await refusal(plan(d, jev({ section: "Equipment details" }))), ALL);
  });

  it("fills the fields it can place and says the rest are the user's, with the section reason", async () => {
    // Model sits before every heading: its section can't be told; Serial number is under Equipment details.
    const d = desk({ reader: [field("f/model", "", { label: "Model", frame: [20, 40, 200, 24] }), node("h/eq", "AXHeading", { label: "Equipment details" }), field("f/serial", "", { label: "Serial number", frame: [20, 80, 200, 24] }), node("h/ct", "AXHeading", { label: "Service contact" }), field("f/cname", "", { label: "Contact name", frame: [20, 200, 200, 24] })] });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(r, d)).toEqual(["Serial number"]);
    expect(r.unsure).toEqual([{ key: "f/model", name: "Model", says: SECTION_FIELD("Model") }]);
  });

  it("holds a later settlement (settleFields) to the named section: it can't widen the Ask", async () => {
    const d = desk({ reader: readerForm() });
    const s = snapFor(d);
    const settled = await settleFields(s, jev({ section: "Equipment details" }).ask);
    expect(settled.asks.map((f) => f.name)).toEqual(EQUIPMENT);
    expect(settled.unclear).toEqual([]);
    expect(settled.section).toBe("Equipment details");
    // Revealed fields only (`only`): the contact fields alone are asked about, and none is settled.
    const only = await settleFields(s, jev({ section: "Equipment details" }).ask, new Set(["f/cname", "f/cphone"]));
    expect(only.asks).toEqual([]);
    // A later settlement of the same Ask (a next page, a reply window) holds the section the Ask named, though Jev now
    // answers that the request names no one section, or another one.
    for (const now of ["fields", "whole", "unclear", "Service contact"]) {
      const later = await settleFields(s, jev({ section: now }).ask, undefined, "Equipment details");
      expect(later.asks.map((f) => f.name), now).toEqual(EQUIPMENT);
      expect(later.section, now).toBe("Equipment details");
    }
    // On a window that shows no such section, nothing is settled: every field Jev chose is the user's.
    const other = desk({ reader: [node("h/x", "AXHeading", { label: "Billing" }), field("f/card", "", { label: "Billing contact" })] });
    const elsewhere = await settleFields(snapFor(other), jev({ asks: ["Billing contact"], section: "fields" }).ask, undefined, "Equipment details");
    expect(elsewhere.asks).toEqual([]);
    expect(elsewhere.sectionless.map((f) => f.name)).toEqual(["Billing contact"]);
    // A presettled request (helper.ts settleRequest) carries what it left to the user into the Ask, said.
    const page = desk({ page: pageSnapshot(HEADINGS) });
    const ps = snapFor(page);
    const pre = await settleFields(ps, jev({ section: "Equipment details" }).ask);
    expect(pre.asks).toEqual([]);
    expect(pre.sectionless.map((f) => f.name)).toEqual(ALL);
    const j = jev({ section: "Equipment details" });
    const made = await headsIntentMaker(j.ask).make(ps, undefined, { asks: [], unclear: [], sectionless: pre.sectionless.map((f) => f.key), section: pre.section });
    expect(made.intent).toMatchObject({ route: "refuse", why: "sectionUnknown", namedSection: "Equipment details" });
    expect(made.intent.settled).toEqual([]);
  });

  it("keeps the named section on the Ask's scope, so every scope its goal settles holds to it", async () => {
    const d = desk({ reader: readerForm() });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    const authority = r.checked.writes[0]?.checked.authority;
    expect(authority?.kind === "ask" ? authority.scope.section : undefined).toBe("Equipment details");
    expect(r.intent.namedSection).toBe("Equipment details");
    const whole = (await plan(d, jev({ section: "fields" }))) as AskDraft;
    const wa = whole.checked.writes[0]?.checked.authority;
    expect(wa?.kind === "ask" ? wa.scope.section : undefined).toBeNull();
    if (authority?.kind !== "ask") throw new Error("no Ask authority");
    expect(() => scopeSet(authority.scope.askId, null, [authority.scope], null)).toThrow(/one section its Ask named/u);
    expect(() => withScope(scopeSet(authority.scope.askId, null, [], null), authority.scope)).toThrow(/held to section/u);
  });
});

describe("sections are occurrences (review of fc233af and 3e8a129)", () => {
  // Review P1 3: two headings that read alike are two sections, on the reader's window and the page walk.
  it("withholds every field when the named heading text is two occurrences", async () => {
    const reader = desk({ reader: [node("h/eq", "AXHeading", { label: "Equipment details" }), field("f/serial", "", { label: "Serial number" }), node("h/eq2", "AXHeading", { label: "Equipment details" }), field("f/model", "", { label: "Model" })] });
    expectSectionRefusal(await refusal(plan(reader, jev({ asks: EQUIPMENT, section: "Equipment details" }))), EQUIPMENT);
    // On a page, two h3 "Address" under one h2: every field is withheld, whichever "Address" it is under.
    const twice: Walked = {
      occurrences: [{ id: "o1", heading: true, text: "Delivery" }, { id: "o2", heading: true, text: "Address" }, { id: "o3", heading: true, text: "Notes" }, { id: "o4", heading: true, text: "Address" }],
      chains: { "Serial number": ["o1", "o2"], Model: ["o1", "o3"], "Contact name": ["o1", "o4"], "Contact phone": ["o1"] },
    };
    const page = desk({ page: pageSnapshot(["Delivery"], twice) });
    expectSectionRefusal(await refusal(plan(page, jev({ section: "Address" }))), ALL);
  });

  // Review P1 1: a container's own heading suppresses the inherited one (the walk's chain says so; the helper follows it).
  it("places a field in the section its chain names, not every heading its text path went through", async () => {
    // `<h2>Equipment details</h2>…<section><h2>Service contact</h2>…</section>`: the contact fields are not equipment.
    const d = desk({ page: pageSnapshot(["Equipment details", "Service contact"], { occurrences: [{ id: "o1", heading: true, text: "Equipment details" }, { id: "o2", heading: true, text: "Service contact" }], chains: { "Serial number": ["o1"], Model: ["o1"], "Contact name": ["o2"], "Contact phone": ["o2"] } }) });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(r, d)).toEqual(EQUIPMENT);
  });

  // Review P1 2: an excluded heading keeps its occurrence and still ends the section before it.
  it("ends a section at an excluded heading, whose text is never offered", async () => {
    const excluded: Walked = {
      occurrences: [{ id: "o1", heading: true, text: "Equipment details" }, { id: "o2", heading: true }],
      chains: { "Serial number": ["o1"], Model: ["o1"], "Contact name": ["o2"], "Contact phone": ["o2"] },
    };
    const d = desk({ page: pageSnapshot(["Equipment details"], excluded) });
    expect(snapFor(d).headings.map((h) => h.name)).toEqual(["Equipment details"]);
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(r, d)).toEqual(EQUIPMENT);
    expect(r.unsure ?? []).toEqual([]);
  });

  // Review P1 5: on the Accessibility path a heading inside a group that closed tells nothing of the fields after it.
  it("can't place a reader field after a group that closed on the heading before it", async () => {
    const nodes: Node[] = [
      node("h/eq", "AXHeading", { label: "Equipment details" }),
      field("f/serial", "", { label: "Serial number" }),
      field("f/model", "", { label: "Model" }),
      node("g/ct", "AXGroup"),
      node("h/ct", "AXHeading", { label: "Service contact", parent: "g/ct" }),
      field("f/cname", "", { label: "Contact name", parent: "g/ct" }),
      field("f/cphone", "", { label: "Contact phone" }),
    ];
    const d = desk({ reader: nodes });
    const contact = (await plan(d, jev({ section: "Service contact" }))) as AskDraft;
    expect(written(contact, d)).toEqual(["Contact name"]);
    expect(contact.unsure).toEqual([{ key: "f/cphone", name: "Contact phone", says: SECTION_FIELD("Contact phone") }]);
    const equipment = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(equipment, d)).toEqual(EQUIPMENT);
    expect(equipment.unsure).toEqual([{ key: "f/cphone", name: "Contact phone", says: SECTION_FIELD("Contact phone") }]);
  });

  // Review P1 6: every heading is offered, placed or not; a page title holds every field.
  it("offers every heading the window shows, whether or not it places a field", () => {
    const d = desk({ page: pageSnapshot(HEADINGS, { occurrences: [...WALKED.occurrences, { id: "o4", heading: true, text: "Need help?" }], chains: { "Serial number": ["o2"], Model: ["o2"], "Contact name": ["o3"], "Contact phone": ["o3"] } }) });
    // Those holding a field first (re-review item 3), then the rest, none dropped.
    expect(snapFor(d).headings.map((h) => h.name)).toEqual(["Equipment details", "Service contact", "Service request", "Need help?"]);
    // A section Ask naming a heading no field sits in withholds rather than reading as particular fields.
  });

  it("keeps every field of a whole-form Ask Jev labels with the page title", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS, WALKED) });
    const r = (await plan(d, jev({ section: "Service request", route: "all" }), "fill out this form from my notes")) as AskDraft;
    expect(written(r, d)).toEqual(ALL);
    const g = (await plan(d, jev({ section: "Service request", route: "all" }), "fill out this form from my notes", true)) as AskGoal;
    expect(written(g, d)).toEqual(ALL);
  });

  // Review P1 7: heading and section text are lines of the window, charged like its labels.
  it("indexes a page's heading and section text in the window's lines, so plan text quoting one is charged", () => {
    const long = "Equipment details and warranty coverage";
    const withText = desk({ page: pageSnapshot([long], { occurrences: [{ id: "o1", heading: true, text: long }], chains: { "Serial number": ["o1"] } }) });
    const ledger = new SnippetLedger(withText.model.windows.values());
    expect(ledger.plan([`please fill the ${long} part`])).toBe(true);
    expect(ledger.charges()[withText.windowId] ?? 0).toBeGreaterThanOrEqual(long.length);
    // And a change to it alone is a change to the window's lines: the next snapshot's charge follows the new text.
    const changed = "Service history and maintenance notes";
    withText.model.apply({ ...pageSnapshot([changed], { occurrences: [{ id: "o1", heading: true, text: changed }], chains: {} }), at: 2500, focused: true });
    const again = new SnippetLedger(withText.model.windows.values());
    expect(again.plan([`please fill the ${long} part`])).toBe(true);
    expect(again.charges()[withText.windowId] ?? 0).toBe(0);
    expect(again.plan([`please fill the ${changed} part`])).toBe(true);
    expect(again.charges()[withText.windowId] ?? 0).toBeGreaterThanOrEqual(changed.length);
  });

  // Review P1 8: a self-identification heading never reaches a request, from the heading list or the outline.
  it("drops a self-identification heading's text where the walk is projected, and never offers it", () => {
    const page = pageSnapshot(["Equipment details", "Voluntary Self-Identification"], { occurrences: [{ id: "o1", heading: true, text: "Equipment details" }, { id: "o2", heading: true, text: "Voluntary Self-Identification" }], chains: { "Serial number": ["o1"], Model: ["o1"], "Contact name": ["o2"] } });
    const area = page.nodes.find((n) => n.role === "AXWebArea");
    expect(area?.headings).toEqual(["Equipment details"]);
    expect(area?.outline).toEqual([{ key: `${area?.key}#o1`, heading: true, text: "Equipment details" }, { key: `${area?.key}#o2`, heading: true }]);
    const d = desk({ page });
    const s = snapFor(d, "fill the voluntary self-identification section");
    expect(s.headings.map((h) => h.name)).toEqual(["Equipment details"]);
    expect(JSON.stringify(headsRequest(s))).not.toMatch(/Self-Identification/u);
  });

  it("holds the same self-identification cases as the extension's walker", () => {
    const golden = JSON.parse(readFileSync(new URL("../fixtures/golden/self-identification.json", import.meta.url), "utf8")) as { excluded: string[]; kept: string[] };
    for (const t of golden.excluded) expect(SELF_IDENTIFICATION.test(t), t).toBe(true);
    for (const t of golden.kept) expect(SELF_IDENTIFICATION.test(t), t).toBe(false);
  });

  it("keeps a section text that names a secret out of the redacted view, its occurrence still in place", () => {
    const secret = "Password and security";
    expect(secretText(secret)).toBe(true);
    const d = desk({ page: pageSnapshot(["Equipment details"], { occurrences: [{ id: "o1", heading: true, text: "Equipment details" }, { id: "o2", heading: true, text: secret }], chains: { "Serial number": ["o1"], Model: ["o2"] } }) });
    const o = windowOutline(redactWindow(windowOf(d)));
    expect(o.occurrences.map((x) => x.text)).toEqual(["Equipment details", null]);
    expect(snapFor(d).headings.map((h) => h.name)).toEqual(["Equipment details"]);
  });

  // Review P2 9: what the veto left to the user is in the saved intent before any question goes out.
  it("saves the fields the veto left to the user in the question's resume, and says them after the pick", async () => {
    const nodes: Node[] = [field("f/early", "", { label: "Reference number" }), ...readerForm()];
    const d = desk({ reader: nodes });
    const s = snapFor(d);
    const listed: IntentMaker = {
      name: "writer",
      make: async (x) => ({ intent: { route: "fill", why: "none", scope: "list", section: "none", fields: x.fields.map((f) => f.ref), sources: ["any"], whose: "user", literals: [] }, use: { maker: "writer", model: "t", calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } }),
    };
    const j = jev({ asks: ["Reference number", "Serial number"], unclear: ["Model"], section: "Equipment details" });
    const asked = await plan(d, j, INSTRUCTION, false, listed).catch((e: unknown) => e);
    if (!(asked instanceof AskAsks)) throw asked;
    const early = s.fields.find((f) => f.key === "f/early")?.ref;
    expect(asked.question.resume.intent.sectionless).toEqual([early]);
    expect(asked.question.resume.intent.namedSection).toBe("Equipment details");
    const model = asked.question.options.find((c) => c.option.kind === "field" && c.option.label === "Model");
    if (model === undefined) throw new Error("Model is not offered");
    const after = (await plan(d, j, INSTRUCTION, false, listed, { ...asked.question.resume, fixed: { ...asked.question.resume.fixed, ...model.fixes } })) as AskDraft;
    expect(written(after, d)).toEqual(["Serial number", "Model"]);
    expect(after.unsure).toEqual([{ key: "f/early", name: "Reference number", says: SECTION_FIELD("Reference number") }]);
  });

  // Review P2 10: an upload field the veto left to the user is carried and said as a field is.
  it("carries an upload field it can't place through the intent and the page goal's left-to-user list", async () => {
    const photo: PageControl = { id: "e5", key: "form@0/button:service photo~0", strongKey: null, kind: "file", role: "button", name: "Service photo", form: "form@0", rect: [20, 300, 200, 24] };
    const d = desk({ page: pageSnapshot(HEADINGS, WALKED, [photo]) });
    const s = snapFor(d);
    const upload = s.uploads.find((u) => u.name === "Service photo");
    if (upload === undefined) throw new Error("no upload field");
    const j = jev({ asks: [...ALL, "Service photo"], section: "Equipment details" });
    const g = (await plan(d, j, INSTRUCTION, true)) as AskGoal;
    expect(g.route).toBe("goal");
    expect(g.intent.sectionless).toEqual([upload.ref]);
    expect(g.page?.sectionless).toEqual([upload.key]);
    expect(g.page?.scope.fields).not.toContain(upload.key);
    const r = (await plan(d, j)) as AskDraft;
    expect(r.unsure).toEqual([{ key: upload.key, name: "Service photo", says: SECTION_FIELD("Service photo") }]);
  });
});

describe("what the veto leaves as it was (preservation)", () => {
  const heads = (s: IntentSnapshot, route = "some"): JevResult => ({ model: "t", inputTokens: 0, latencyMs: 0, costUsd: 0, answers: Object.fromEntries(Object.keys(headsRequest(s).questions).map((id) => [id, { choice: ({ route, why: "nothingToFill", source: "any", whose: "user" } as Record<string, string>)[id] ?? "none", confidence: 0.9 }])) });
  const pair = (s: IntentSnapshot, f: (name: string, wording: 0 | 1) => A, section: (wording: 0 | 1) => A | undefined): [JevResult, JevResult] =>
    ([0, 1] as const).map((wd) => {
      const sec = section(wd);
      return { model: "t", inputTokens: 0, latencyMs: 0, costUsd: 0, answers: { ...Object.fromEntries(s.fields.map((x) => [scopeId(x.ref), f(x.name, wd)])), ...(sec === undefined ? {} : { section: sec }) } };
    }) as [JevResult, JevResult];
  const refOf = (s: IntentSnapshot, heading: string): string => s.headings.find((h) => h.name === heading)?.ref ?? "none";
  const chosenNames = (s: IntentSnapshot, refs: readonly string[]): string[] => refs.map((r) => s.fields.find((f) => f.ref === r)?.name ?? r);

  it("still needs both wordings' asks for a field in the named section", async () => {
    const d = desk({ reader: readerForm() });
    const r = (await plan(d, jev({ section: "Equipment details", asksOnce: ["Model"] }))) as AskDraft;
    expect(written(r, d)).toEqual(["Serial number"]);
  });

  it("never lets not, unclear, a disagreement or a low answer to the section question take anything out", () => {
    const s = snapFor(desk({ reader: readerForm() }));
    const eq = refOf(s, "Equipment details");
    const asks = (): A => ({ choice: "asks", confidence: 0.99 });
    const baseline = readHeads(s, heads(s), pair(s, asks, () => ({ choice: "fields", confidence: 0.99 })), null);
    const cases: ((w: 0 | 1) => A)[] = [
      () => ({ choice: "unclear", confidence: 0.99 }),
      () => ({ choice: "whole", confidence: 0.99 }),
      () => ({ choice: "fields", confidence: 0.99 }),
      (w) => ({ choice: w === 0 ? eq : "fields", confidence: 0.99 }),
      (w) => ({ choice: w === 0 ? eq : refOf(s, "Service contact"), confidence: 0.99 }),
      (w) => ({ choice: eq, confidence: w === 0 ? 0.99 : 0.49 }),
    ];
    for (const [i, c] of cases.entries()) expect(readHeads(s, heads(s), pair(s, asks, c)), `case ${i}`).toEqual(baseline);
    const vetoed = readHeads(s, heads(s), pair(s, asks, () => ({ choice: eq, confidence: 0.99 })));
    expect(chosenNames(s, vetoed.fields)).toEqual(EQUIPMENT);
  });

  it("fails loudly when Jev leaves the section question unanswered or answers outside its options", () => {
    const s = snapFor(desk({ reader: readerForm() }));
    const asks = (): A => ({ choice: "asks", confidence: 0.99 });
    expect(() => readHeads(s, heads(s), pair(s, asks, () => undefined))).toThrow(/no answer to the section question/u);
    expect(() => readHeads(s, heads(s), pair(s, asks, () => ({ choice: "sec99", confidence: 0.99 })))).toThrow(/not one of its options/u);
  });

  it("authorises a subset of what it authorised before the veto, for random answers", () => {
    const r = rng(31);
    const options = ["asks", "not", "unclear"];
    for (let n = 0; n < 300; n++) {
      const order = r() < 0.5 ? readerForm() : readerForm({ contactFirst: true });
      const s = snapFor(desk({ reader: r() < 0.2 ? order.filter((x) => x.key !== "h/eq") : order }));
      const sections = ["whole", "fields", "unclear", ...s.headings.map((h) => h.ref)];
      const picks = new Map(s.fields.map((f) => [f.name, [0, 1].map(() => ({ choice: options[Math.floor(r() * 3)] as string, confidence: r() }))]));
      const sec = [0, 1].map(() => ({ choice: sections[Math.floor(r() * sections.length)] as string, confidence: r() }));
      const p = pair(s, (name, wd) => picks.get(name)?.[wd] as A, (wd) => sec[wd]);
      const before = readHeads(s, heads(s, r() < 0.3 ? "all" : "some"), p, null);
      const after = readHeads(s, heads(s, before.route === "fill" && before.wholeForm === true ? "all" : "some"), p);
      const fills = (i: typeof before): Set<string> => new Set([...i.fields, ...(i.options ?? []), ...(i.sure ?? []), ...(i.settled ?? [])]);
      for (const ref of fills(after)) expect(fills(before).has(ref), `seed ${n}: ${ref}`).toBe(true);
    }
  });

  // Coordinator: an Ask that names no section leaves the veto inactive, even where no field has a section Caret can see.
  it("leaves a whole-form or named-field Ask on a page with no section evidence exactly as it was", async () => {
    for (const [instruction, section, route] of [["fill out this form from my notes", "whole", "all"], ["fill out the application", "whole", "all"], ["my serial number and contact phone please", "fields", "some"]] as const) {
      const shown = desk({ page: pageSnapshot(HEADINGS) });
      const bare = desk({ page: pageSnapshot([]) });
      const asks = section === "whole" ? ALL : ["Serial number", "Contact phone"];
      const a = (await plan(shown, jev({ asks, section, route }), instruction, true)) as AskGoal;
      const b = (await plan(bare, jev({ asks, route }), instruction, true)) as AskGoal;
      expect(written(a, shown), instruction).toEqual(written(b, bare));
      expect([...(a.askScope?.fields ?? [])], instruction).toEqual([...(b.askScope?.fields ?? [])]);
      expect(written(a, shown), instruction).toEqual(asks);
      const fa = (await plan(shown, jev({ asks, section, route }), instruction)) as AskDraft;
      const fb = (await plan(bare, jev({ asks, route }), instruction)) as AskDraft;
      expect(written(fa, shown), instruction).toEqual(written(fb, bare));
      expect(fa.checked.writes.map((x) => x.node.key), instruction).toEqual(fb.checked.writes.map((x) => x.node.key));
    }
  });

  it("leaves an Ask whose section answer is unclear, split or low exactly as it was, on a page with no section evidence", async () => {
    const answers: Section[] = [{ choice: "unclear", confidence: 0.99 }, (w) => (w === 0 ? { choice: "sec2", confidence: 0.99 } : { choice: "fields", confidence: 0.99 }), { choice: "sec2", confidence: 0.3 }];
    for (const section of answers) {
      const shown = desk({ page: pageSnapshot(HEADINGS) });
      const bare = desk({ page: pageSnapshot([]) });
      const a = (await plan(shown, jev({ section }), INSTRUCTION, true)) as AskGoal;
      const b = (await plan(bare, jev({}), INSTRUCTION, true)) as AskGoal;
      expect(written(a, shown)).toEqual(written(b, bare));
      expect(written(a, shown)).toEqual(ALL);
    }
  });
});

describe("a section-only Ask on the page walk (Part B: page fields carry their sections)", () => {
  it("projects each control's chain onto its node as occurrence keys, and the frame's occurrences onto its web area", () => {
    const page = pageSnapshot(HEADINGS, WALKED);
    const area = page.nodes.find((n) => n.role === "AXWebArea");
    const key = (id: string): string => `${area?.key}#${id}`;
    expect(page.nodes.find((n) => n.label === "Serial number")?.sections).toEqual([key("o1"), key("o2")]);
    expect(area?.outline?.map((o) => o.text)).toEqual(HEADINGS);
  });

  it("fills the named section's fields and leaves out the adjacent section's, though Jev answered asks and exact for both", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS, WALKED) });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(r, d)).toEqual(EQUIPMENT);
    expect(r.unsure ?? []).toEqual([]);
    const g = (await plan(d, jev({ section: "Equipment details" }), INSTRUCTION, true)) as AskGoal;
    expect(written(g, d)).toEqual(EQUIPMENT);
    expect([...(g.askScope?.fields ?? [])]).toHaveLength(2);
  });

  it("shows Jev each page field's heading in the scope question, not 'Heading: none'", () => {
    const s = snapFor(desk({ page: pageSnapshot(HEADINGS, WALKED) }));
    expect(s.fields.map((f) => [f.name, f.heading])).toEqual([["Serial number", "Equipment details"], ["Model", "Equipment details"], ["Contact name", "Service contact"], ["Contact phone", "Service contact"]]);
  });

  it("withholds a section Ask naming a heading no field sits in", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS, { occurrences: [...WALKED.occurrences, { id: "o4", heading: true, text: "Need help?" }], chains: WALKED.chains }) });
    const r = await plan(d, jev({ section: "Need help?" })).catch((e: unknown) => e);
    // Every field the window places sits in other sections only: nothing is written, and nothing is said of them.
    expect(r).toBeInstanceOf(AskRefused);
    expect((r as AskRefused).message).toBe(SAYS.noSuchField);
  });

  it("leaves a whole-form Ask on a sectioned page exactly as on a page without sections", async () => {
    const sectioned = desk({ page: pageSnapshot(HEADINGS, WALKED) });
    const bare = desk({ page: pageSnapshot([]) });
    const a = (await plan(sectioned, jev({ section: "whole", route: "all" }), "fill out this form from my notes", true)) as AskGoal;
    const b = (await plan(bare, jev({ route: "all" }), "fill out this form from my notes", true)) as AskGoal;
    expect(written(a, sectioned)).toEqual(written(b, bare));
    expect(written(a, sectioned)).toEqual(ALL);
  });
});

describe("re-review of 9939ac2: a named section the list can't offer, and a page that changes after the mint", () => {
  const occ = (id: string, text: string, heading = true) => ({ id, heading, text });

  // Re-review 1: "the request names a section that isn't in this list" withholds every field.
  it("withholds every field, said, when both wordings say the named section isn't in the list", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS, WALKED) });
    const e = await refusal(plan(d, jev({ section: "unlisted" })));
    expect(e.code).toBe("unsure");
    expect(e.message).toBe(SAYS.sectionNotFound);
    expect(e.intent).toMatchObject({ route: "refuse", why: "sectionNotFound" });
    // The writer's path, which settles the fields itself.
    const listed: IntentMaker = { name: "writer", make: async (x) => ({ intent: { route: "fill", why: "none", scope: "list", section: "none", fields: x.fields.map((f) => f.ref), sources: ["any"], whose: "user", literals: [] }, use: { maker: "writer", model: "t", calls: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 } }) };
    const w = await refusal(plan(d, jev({ section: "unlisted" }), INSTRUCTION, false, listed));
    expect(w.message).toBe(SAYS.sectionNotFound);
    // One wording only, or below the cutoff: nothing is taken out.
    const split = (await plan(d, jev({ section: (wd) => ({ choice: wd === 0 ? "unlisted" : "unclear", confidence: 0.99 }) }))) as AskDraft;
    expect(written(split, d)).toEqual(ALL);
  });

  it("keeps a whole-form Ask unchanged when the section answer is unclear, with the new option offered", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS, WALKED) });
    const bare = desk({ page: pageSnapshot([]) });
    const q = (await jev({}).ask(scopeRequestOf(d))).answers;
    expect(Object.keys(q).includes("section")).toBe(true);
    const a = (await plan(d, jev({ section: "unclear", route: "all" }), "fill out this form from my notes", true)) as AskGoal;
    const b = (await plan(bare, jev({ route: "all" }), "fill out this form from my notes", true)) as AskGoal;
    expect(written(a, d)).toEqual(written(b, bare));
    expect(written(a, d)).toEqual(ALL);
  });

  // Re-review 2 (item 3): legends are sections too, and two that read alike withhold.
  it("offers fieldset legends, and withholds every field when two legends read 'Address'", async () => {
    const twoAddresses: Walked = {
      occurrences: [occ("o1", "Service request"), occ("o2", "Address", false), occ("o3", "Address", false)],
      chains: { "Serial number": ["o1", "o2"], Model: ["o1", "o2"], "Contact name": ["o1", "o3"], "Contact phone": ["o1", "o3"] },
    };
    const d = desk({ page: pageSnapshot(["Service request"], twoAddresses) });
    expect(snapFor(d).headings.map((h) => h.name)).toEqual(["Service request", "Address"]);
    expectSectionRefusal(await refusal(plan(d, jev({ section: "Address" }), "fill the address section")), ALL);
    // One "Address" legend places its fields.
    const one = desk({ page: pageSnapshot(["Service request"], { occurrences: [occ("o1", "Service request"), occ("o2", "Address", false)], chains: { "Serial number": ["o1", "o2"], Model: ["o1", "o2"], "Contact name": ["o1"], "Contact phone": ["o1"] } }) });
    expect(written((await plan(one, jev({ section: "Address" }), "fill the address section")) as AskDraft, one)).toEqual(EQUIPMENT);
  });

  // Re-review 3: forty empty h2s before the form's own sections.
  it("offers the sections holding fields first, past forty empty headings, and says when the list is cut", async () => {
    const empties = Array.from({ length: 40 }, (_, i) => occ(`e${i + 1}`, `Notice ${i + 1}`));
    const walked: Walked = { occurrences: [...empties, occ("o2", "Equipment details"), occ("o3", "Service contact")], chains: { "Serial number": ["o2"], Model: ["o2"], "Contact name": ["o3"], "Contact phone": ["o3"] } };
    const d = desk({ page: pageSnapshot([], walked) });
    const s = snapFor(d);
    expect(s.headings.slice(0, 2).map((h) => h.name)).toEqual(["Equipment details", "Service contact"]);
    expect(s.sectionsCut).toBe(true);
    const question = scopeRequestOf(d).questions.section;
    expect(String(question?.instructions)).toContain("The list may be incomplete");
    expect(Object.keys(question?.criteria ?? {})).toContain("unlisted");
    expect(written((await plan(d, jev({ section: "Equipment details" }))) as AskDraft, d)).toEqual(EQUIPMENT);
    // A section the cut list lacks is "not in this list": every field is withheld.
    expect((await refusal(plan(d, jev({ section: "unlisted" }), "fill the notice 40 section"))).message).toBe(SAYS.sectionNotFound);
  });

  // Re-review 4: a control past the walk's occurrence cap has no chain (extension test/sections.test.ts), so it is withheld.
  it("withholds a field the walk could place in no section past its cap, never inheriting the one before", async () => {
    const h3s = Array.from({ length: 199 }, (_, i) => occ(`o${i + 2}`, `Part ${i + 1}`));
    const walked: Walked = { occurrences: [occ("o1", "Equipment details"), ...h3s], chains: { "Serial number": ["o1"], Model: ["o1"], "Contact name": [], "Contact phone": [] } };
    const d = desk({ page: pageSnapshot([], walked) });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(r, d)).toEqual(EQUIPMENT);
    expect(r.unsure).toEqual(CONTACT.map((n) => ({ key: expect.any(String), name: n, says: SECTION_FIELD(n) })));
  });

  // Re-review 5: the fingerprint keeps section text, so the guard and the acceptance recheck place the field again.
  it("refuses at dispatch and at acceptance when the named section appears twice after the mint, or no longer holds the field", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS, WALKED) });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    const mints = new Map(r.checked.writes.map((x, i) => [i, x.checked]));
    const serial = r.checked.writes[0];
    if (serial === undefined) throw new Error("no write");
    const guard = guardFor(() => d.model, mints, r.checked.origin, null, null);
    const now = () => {
      const w = windowOf(d);
      return { windowId: w.window.windowId, node: w.nodes.get(serial.node.key) as Node, window: w };
    };
    expect(guard(0, serial.value, now())).toBeNull();
    const accept = () => validatePlan(r.plan, r.slots, { model: d.model, memory: [], instruction: INSTRUCTION, origin: r.checked.origin, documentOf: null }, r.checked.mints);
    expect(() => accept()).not.toThrow();
    // The page now shows a second "Equipment details" section; Serial number's chain still reads the same text.
    const twice: Walked = { occurrences: [...WALKED.occurrences, occ("o4", "Equipment details")], chains: { ...WALKED.chains } };
    d.model.apply({ ...pageSnapshot(HEADINGS, twice), at: 2500, focused: true });
    expect(guard(0, serial.value, now())).toMatch(/more than once/u);
    expect(() => accept()).toThrow(PlannerError);
    // Or it no longer shows the section at all, the field's chain text unchanged by a relabelled heading elsewhere.
    const gone: Walked = { occurrences: [occ("o1", "Service request"), occ("o2", "Equipment details"), occ("o3", "Service contact")], chains: { "Serial number": ["o1", "o3"], Model: ["o1", "o2"], "Contact name": ["o1", "o3"], "Contact phone": ["o1", "o3"] } };
    d.model.apply({ ...pageSnapshot(HEADINGS, gone), at: 2600, focused: true });
    expect(guard(0, serial.value, now())).not.toBeNull();
  });

  // Re-review 6: a redacted Accessibility heading keeps its boundary.
  it("does not place a reader field after a redacted 'Password and security' heading in the section before it", async () => {
    const nodes: Node[] = [
      node("h/ct", "AXHeading", { label: "Service contact" }),
      field("f/cname", "", { label: "Contact name" }),
      field("f/cphone", "", { label: "Contact phone" }),
      node("h/pw", "AXHeading", { label: "Password and security" }),
      field("f/serial", "", { label: "Serial number" }),
      field("f/model", "", { label: "Model" }),
    ];
    const d = desk({ reader: nodes });
    const view = redactWindow(windowOf(d));
    expect(view.nodes.get("h/pw")).toEqual({ key: "h/pw", parent: null, role: "AXHeading" });
    // The Ask's authority: only the named section's two fields, though Jev chose all four. (Fill withholds the fields
    // after a password heading for its own reasons, so the writes alone would not show it.)
    const settled = await settleFields(snapFor(d, "fill the service contact section from my notes"), jev({ section: "Service contact" }).ask);
    expect(settled.asks.map((f) => f.name)).toEqual(CONTACT);
    expect(settled.sectionless).toEqual([]);
    expect(JSON.stringify(scopeRequestOf(d))).not.toMatch(/Password and security/u);
  });
});

/** The scope ask's first wording for a desk's form, as the Ask sends it. */
function scopeRequestOf(d: ReturnType<typeof desk>): JevRequest {
  return scopeRequest(snapFor(d), 0);
}

describe("check of 479f875: a heading stub is structure only", () => {
  const SECRET_EMAIL = "violet.orchard@example.test";
  /** A note whose heading redaction removes (its label, or its placeholder, names a secret), holding an email the reader typed. */
  function leaky(on: "label" | "placeholder") {
    forgetWindows();
    const m = new ScreenModel();
    const heading = node("src/h", "AXHeading", { ...(on === "label" ? { label: "Password" } : { label: "Account", placeholder: "Password" }), value: SECRET_EMAIL });
    const typed: TypedValue = { kind: "email", text: SECRET_EMAIL, nodeKey: "src/h" };
    m.apply(snap([heading, { key: "src/t", parent: null, role: "AXTextArea", value: "Grocery list: oat milk, lemons", editable: true }], { at: 1000, windowId: "7001-1", title: "Account notes.txt", app: NOTE_APP, focused: true, values: [typed] }));
    m.apply(snap([field("f/email", "", { label: "Email", frame: [20, 80, 200, 24] })], { at: 2000, windowId: "F", title: "Sign up", focused: true }));
    return { model: m, windowId: "F" };
  }

  // P1: the removed node's typed value stays out, whether or not a stub of it stays for the outline.
  it.each(["label", "placeholder"] as const)("never sends the typed value of a heading redaction removed (secret %s)", async (on) => {
    const d = leaky(on);
    const view = redactWindow(d.model.windows.get("7001-1") as never);
    expect(view.values).toEqual([]);
    expect(JSON.stringify([...view.nodes.values()])).not.toContain(SECRET_EMAIL);
    const j = jev({ asks: ["Email"] });
    await plan(d, j, "fill my email").catch((e: unknown) => {
      if (!(e instanceof AskRefused)) throw e;
    });
    const fill = j.seen.filter((r) => r.purpose === "fill.whose" || r.purpose === "fill.values");
    expect(fill.length).toBeGreaterThan(0);
    for (const r of j.seen) expect(JSON.stringify(r), r.purpose).not.toContain(SECRET_EMAIL);
    // The goal writer's snapshots, from the same redacted views.
    const inv = buildInventory(d.model, { instruction: "fill my email", windows: ["F", "7001-1"], memory: [], calendar: null, clock: macClock(new Date(3000)), now: 3000, readerSession: 1 });
    expect(JSON.stringify(inv.snapshots)).not.toContain(SECRET_EMAIL);
  });

  // P2: a removed group keeps its boundary, so the outline after redaction places fields as the raw one does.
  it("keeps the boundary of a group redaction removed, so a field after it is not placed in the section before it", async () => {
    const nodes: Node[] = [
      node("h/eq", "AXHeading", { label: "Equipment details" }),
      field("f/serial", "", { label: "Serial number" }),
      node("g/pw", "AXGroup", { label: "Password and security" }),
      node("h/ct", "AXHeading", { label: "Service contact", parent: "g/pw" }),
      field("f/cphone", "", { label: "Contact phone" }),
    ];
    const d = desk({ reader: nodes });
    const raw = windowOutline(windowOf(d));
    const red = windowOutline(redactWindow(windowOf(d)));
    expect(red.chainOf("f/serial")).toEqual(raw.chainOf("f/serial"));
    expect(red.chainOf("f/cphone")).toEqual(raw.chainOf("f/cphone"));
    expect(raw.chainOf("f/cphone")).toBe("unknown");
    const j = jev({ asks: ["Serial number", "Contact phone"], section: "Equipment details" });
    const settled = await settleFields(snapFor(d), j.ask);
    expect(settled.asks.map((f) => f.name)).toEqual(["Serial number"]);
    expect(settled.sectionless.map((f) => f.name)).toEqual(["Contact phone"]);
    for (const r of j.seen) expect(JSON.stringify(r)).not.toMatch(/Password and security|Service contact/u);
  });
});

describe("confirmation of 516ac15: veto decisions read the raw outline", () => {
  const REMOVED = /Password and security/u;
  /** The reader's form: an "Equipment details" heading over Serial number, a group redaction removes, then Model. */
  const unique = (): Node[] => [node("h/eq", "AXHeading", { label: "Equipment details" }), field("f/serial", "", { label: "Serial number" }), node("g/pw", "AXGroup", { label: "Password and security" }), field("f/model", "", { label: "Model" })];
  /** The same form with a second "Equipment details" heading inside the group redaction removes. */
  const duplicated = (): Node[] => [node("h/eq", "AXHeading", { label: "Equipment details" }), field("f/serial", "", { label: "Serial number" }), node("g/pw", "AXGroup", { label: "Password and security" }), node("h/eq2", "AXHeading", { label: "Equipment details", parent: "g/pw" }), field("f/model", "", { label: "Model" })];
  /** A plan minted on the unique form, and a guard and an acceptance recheck over the form as it reads now. */
  async function minted(d: ReturnType<typeof desk>, j: ReturnType<typeof jev>) {
    const r = (await plan(d, j)) as AskDraft;
    // On the unique form a group with no heading ends no section: Model is under "Equipment details" too.
    expect(written(r, d)).toEqual(EQUIPMENT);
    const serial = r.checked.writes[0];
    if (serial === undefined) throw new Error("no write");
    const guard = guardFor(() => d.model, new Map([[0, serial.checked]]), r.checked.origin, null, null);
    const now = () => ({ windowId: "F", node: windowOf(d).nodes.get("f/serial") as Node, window: windowOf(d) });
    const accept = () => validatePlan(r.plan, r.slots, { model: d.model, memory: [], instruction: INSTRUCTION, origin: r.checked.origin, documentOf: null }, r.checked.mints);
    return { guard: () => guard(0, serial.value, now()), accept };
  }

  it("withholds at settlement when the named section is also a heading inside a removed group", async () => {
    const d = desk({ reader: duplicated() });
    const j = jev({ asks: EQUIPMENT, section: "Equipment details" });
    expectSectionRefusal(await refusal(plan(d, j)), EQUIPMENT);
    const settled = await settleFields(snapFor(d), j.ask);
    expect(settled.asks).toEqual([]);
    // The plan a unique form would mint is refused here, at acceptance and at dispatch.
    const u = desk({ reader: unique() });
    const m = await minted(u, jev({ asks: EQUIPMENT, section: "Equipment details" }));
    u.model.apply(snap(duplicated(), { at: 2500, windowId: "F", title: "Service request", focused: true }));
    expect(() => m.accept()).toThrow(PlannerError);
    expect(m.guard()).toMatch(/more than once/u);
    // Nothing redaction removed reaches a request; the second heading is offered once, by the text the view shows.
    for (const r of j.seen) expect(JSON.stringify(r)).not.toMatch(REMOVED);
    const options = Object.values(scopeRequestOf(d).questions.section?.criteria ?? {}).filter((c) => c?.includes("Equipment details"));
    expect(options).toHaveLength(1);
  });

  it("refuses at acceptance and at dispatch when the duplicate appears inside a removed group after the mint", async () => {
    const d = desk({ reader: unique() });
    const j = jev({ asks: EQUIPMENT, section: "Equipment details" });
    const m = await minted(d, j);
    expect(m.guard()).toBeNull();
    expect(() => m.accept()).not.toThrow();
    d.model.apply(snap(duplicated(), { at: 2500, windowId: "F", title: "Service request", focused: true }));
    // Serial number reads as it did: the fingerprint alone would let it through.
    expect(() => m.accept()).toThrow(/more than once/u);
    expect(m.guard()).toMatch(/more than once/u);
    for (const r of j.seen) expect(JSON.stringify(r)).not.toMatch(REMOVED);
  });
});

const occ = (id: string, text: string, heading = true) => ({ id, heading, text });

describe("final check of 4f644e3: one reading of a section name, and the raw window only takes away", () => {
  const FULLWIDTH = "Ｖｏｌｕｎｔａｒｙ ｓｅｌｆ－ｉｄｅｎｔｉｆｉｃａｔｉｏｎ";
  /** A Jev that names a listed section by its text, and answers "not in this list" when the list lacks it. */
  const faithful = (heading: string, o: { asks?: readonly string[] } = {}) => {
    const inner = jev(o);
    const ask: AskJev = async (req) => {
      const r = await inner.ask(req);
      const q = req.questions.section;
      if (q !== undefined) {
        const hit = Object.entries(q.criteria).find(([k, d]) => k.startsWith("sec") && d !== null && sectionName(d).includes(`'${sectionName(heading)}'`))?.[0];
        r.answers.section = { choice: hit ?? "unlisted", confidence: 0.95 };
      }
      return r;
    };
    return { ask, seen: inner.seen };
  };

  it("reads section names as the extension does", () => {
    const golden = JSON.parse(readFileSync(new URL("../fixtures/golden/section-names.json", import.meta.url), "utf8")) as { names: [string, string][]; excluded: string[]; kept: string[] };
    for (const [raw, name] of golden.names) expect(sectionName(raw), raw).toBe(name);
    for (const t of golden.excluded) expect(SELF_IDENTIFICATION.test(sectionName(t)), t).toBe(true);
    for (const t of golden.kept) expect(SELF_IDENTIFICATION.test(sectionName(t)), t).toBe(false);
  });

  // P1 (a): the fullwidth spelling is excluded as the ASCII one is, so it is never offered or placed.
  it("excludes a fullwidth self-identification section as the ASCII one, from a walk that sent both", async () => {
    const walked: Walked = { occurrences: [occ("o1", "Voluntary self-identification"), occ("o2", FULLWIDTH)], chains: { "Serial number": ["o2"], Model: ["o2"], "Contact name": ["o1"], "Contact phone": ["o1"] } };
    const d = desk({ page: pageSnapshot(["Voluntary self-identification", FULLWIDTH], walked) });
    expect(snapFor(d).headings).toEqual([]);
    const j = faithful("Voluntary self-identification", { asks: EQUIPMENT });
    // The user's words name the section without its text, so any "identification" in a request came from the page.
    const e = await refusal(plan(d, j, "fill the survey section near the bottom"));
    expect(e.message).toBe(SAYS.sectionNotFound);
    // A scope that named it is refused where acceptance and dispatch recheck it.
    const serial = [...windowOf(d).nodes.values()].find((x) => x.label === "Serial number")?.key ?? "";
    const scope = askScope(d.windowId, null, [serial], { [serial]: "seen" }, null, "a", [], "Voluntary self-identification");
    expect(sectionRefusal({ key: serial, name: "Serial number" }, scope, windowOf(d))).toMatch(/no longer on the form/u);
    for (const r of j.seen) expect(JSON.stringify(r)).not.toMatch(/identification|ｉｄｅｎｔ/iu);
  });

  // P1 (b): a name kept in one place and excluded by context in another is two sections.
  it("withholds a section whose name the walk flags as an excluded section's too", async () => {
    const walked: Walked = {
      occurrences: [{ id: "o1", heading: false }, { id: "o2", heading: true }, occ("o3", "Service contact"), { id: "o4", heading: true, text: "Address", sharesExcludedName: true } as Walked["occurrences"][number]],
      chains: { "Serial number": ["o3", "o4"], Model: ["o3", "o4"], "Contact name": ["o3"], "Contact phone": ["o3"] },
    };
    const d = desk({ page: pageSnapshot(["Service contact"], walked) });
    expect(windowOutline(windowOf(d)).occurrences.find((x) => x.text === "Address")?.sharesExcludedName).toBe(true);
    const j = jev({ asks: EQUIPMENT, section: "Address" });
    expectSectionRefusal(await refusal(plan(d, j, "fill the address section")), EQUIPMENT);
    expect(sectionPlacement(windowOf(d), "Address").withhold).toBe("duplicate");
  });

  // P2: the redacted view's occurrence is the section; the raw window naming another one withholds.
  it("withholds when the raw window names another occurrence than the redacted view (reviewer's input)", async () => {
    const nodes: Node[] = [
      node("h/one", "AXHeading", { label: "Equipment details\nPassword: violet-orchard-seven" }),
      field("f/serial", "", { label: "Serial number" }),
      node("h/two", "AXHeading", { label: "Equipment details", placeholder: "Password" }),
      field("f/cphone", "", { label: "Contact phone" }),
    ];
    const d = desk({ reader: nodes });
    const red = windowOutline(redactWindow(windowOf(d)));
    expect(red.occurrences.map((x) => [x.key, x.text])).toEqual([["h/one", "Equipment details"], ["h/two", null]]);
    const j = jev({ asks: ["Serial number", "Contact phone"], section: "Equipment details" });
    const settled = await settleFields(snapFor(d), j.ask);
    expect(settled.asks).toEqual([]);
    expect(settled.sectionless.map((f) => f.name)).toEqual(["Serial number", "Contact phone"]);
    expect(sectionPlacement(windowOf(d), "Equipment details").withhold).toBe("duplicate");
    for (const r of j.seen) expect(JSON.stringify(r)).not.toMatch(/violet-orchard|Password/u);
  });

  it("admits only fields both outlines place in the section, for random redactions", () => {
    const r = rng(4644);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    for (let n = 0; n < 400; n++) {
      const nodes: Node[] = [];
      let group: string | null = null;
      for (let i = 0; i < 10; i++) {
        const roll = r();
        const parent = group === null ? {} : { parent: group };
        if (roll < 0.3) {
          const text = pick(["Equipment details", "Service contact", "Notes"]);
          const secret = r();
          nodes.push(node(`h${i}`, "AXHeading", { ...parent, label: secret < 0.2 ? `${text}\nPassword: violet-orchard-seven` : text, ...(secret > 0.85 ? { placeholder: "Password" } : {}) }));
        } else if (roll < 0.4) {
          group = group === null ? `g${i}` : null;
          if (group !== null) nodes.push(node(group, "AXGroup", { label: r() < 0.5 ? "Password and security" : "Details" }));
        } else nodes.push(field(`f${i}`, "", { ...parent, label: `Field ${i}` }));
      }
      forgetWindows();
      const m = new ScreenModel();
      m.apply(snap(nodes, { at: 2000, windowId: "R", title: "Random form", focused: true }));
      const w = m.windows.get("R");
      if (w === undefined) throw new Error("no window");
      const now = sectionPlacement(w, "Equipment details");
      const byRedacted = sectionMembership(windowOutline(redactWindow(w)), "Equipment details");
      const byRaw = sectionMembership(windowOutline(w), "Equipment details");
      for (const f of nodes.filter((x) => x.editable === true)) {
        if (now.member(f.key) !== "in") continue;
        expect(byRedacted(f.key), `seed ${n} ${f.key}`).toBe("in");
        expect(byRaw(f.key), `seed ${n} ${f.key}`).toBe("in");
      }
    }
  });
});
