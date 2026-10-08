// SCP1: an Ask that names one section of a form writes only fields seen in that section. Jev decides scope; code only
// vetoes: a field Jev chose in both wordings is taken out when the request named one section and the field is seen under
// another, or when Caret can't tell which section it is in. A correct value for a field is no authority to write it.
// A synthetic service form ("Equipment details", "Service contact"); every name and number is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { PageSnapshot, type Node, type PageControl } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { intentSnapshot, type IntentSnapshot } from "../src/planner/intent.ts";
import { headsIntentMaker, headsRequest, readHeads, scopeId, settleFields } from "../src/planner/intent-heads.ts";
import { AskRefused, planAsk, type AskDraft, type AskGoal } from "../src/planner/ask.ts";
import { scopeSet, withScope } from "../src/fill/ask-scope.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { secretText } from "../src/memory/sensitive.ts";
import { rng } from "./large-scene.ts";
import { field, node, snap } from "./builders.ts";

const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const NOTES = "Serial number: SN-4471-B\nModel: Kestrel 9\nContact name: Mira Vale\nContact phone: +1 202-555-0146";
const VALUES: Record<string, string> = { "Serial number": "SN-4471-B", Model: "Kestrel 9", "Contact name": "Mira Vale", "Contact phone": "+1 202-555-0146" };
const EQUIPMENT = ["Serial number", "Model"];
const CONTACT = ["Contact name", "Contact phone"];
const ALL = [...EQUIPMENT, ...CONTACT];
const INSTRUCTION = "fill the equipment details section from my notes";

/** The service form as the reader shows it: each section's heading before its fields, in document order. */
function readerForm(o: { headings?: boolean; contactFirst?: boolean } = {}): Node[] {
  const h = (key: string, label: string): Node[] => (o.headings === false ? [] : [node(key, "AXHeading", { label })]);
  const equipment = [...h("h/eq", "Equipment details"), field("f/serial", "", { label: "Serial number", frame: [20, 80, 200, 24] }), field("f/model", "", { label: "Model", frame: [20, 120, 200, 24] })];
  const contact = [...h("h/ct", "Service contact"), field("f/cname", "", { label: "Contact name", frame: [20, 200, 200, 24] }), field("f/cphone", "", { label: "Contact phone", frame: [20, 240, 200, 24] })];
  return [node("h/top", "AXHeading", { label: "Service request" }), ...(o.contactFirst === true ? [...contact, ...equipment] : [...equipment, ...contact])];
}

/** The service form as the page engine walks it: the frame's heading list, and each control's sections, by name (none before Part B). */
function pageSnapshot(headings: readonly string[], sections: Readonly<Record<string, readonly string[]>> = {}): ReturnType<typeof toWindowSnapshot> {
  const control = (id: string, name: string, y: number): PageControl => ({ id, key: `form@0/textbox:${name.toLowerCase()}~0`, strongKey: null, kind: "text", role: "textbox", name, value: "", form: "form@0", rect: [20, y, 200, 24], ...(sections[name] === undefined ? {} : { sections: [...sections[name]] }) });
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
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "doc-1", origin: "https://service.example", path: "/request", navGen: 0, title: "Service request", headings: [...headings], controls: [control("e1", "Serial number", 80), control("e2", "Model", 120), control("e3", "Contact name", 200), control("e4", "Contact phone", 240)], iframes: [], excluded: {}, truncated: false }],
    missing: [],
    focused: null,
  });
  const session = new EngineSession({ engine: "scp1", browser: { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" }, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
  return toWindowSnapshot(s, session, 1);
}

/** A desk: the user's notes, then the form, focused. `page` puts the page engine's walk in place of the reader's window. */
function desk(form: { reader?: Node[]; page?: ReturnType<typeof toWindowSnapshot> }): { model: ScreenModel; windowId: string } {
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

type Section = { choice: string; confidence: number } | ((wording: 0 | 1) => { choice: string; confidence: number });
/** The section question's answer for the option naming `heading`, in both wordings. */
const named = (heading: string, confidence = 0.95) => (q: JevRequest["questions"][string]) => ({ choice: Object.entries(q.criteria).find(([, d]) => d?.includes(`'${heading}'`) === true)?.[0] ?? "unclear", confidence });

/**
 * A stand-in Jev that every gate after scope would let through: the heads fill some fields from any source for the user;
 * the scope ask answers "asks" for `asks` in both wordings at 0.99; every contact field is someone else's and every
 * contact value is that person's ("other" in both); each value question picks the notes' value; the verifier says
 * "exact" at 1.0. `section` answers the section question, by the option for a heading, or as given.
 */
function jev(o: { asks?: readonly string[]; section?: string | Section; route?: string; asksOnce?: readonly string[] } = {}) {
  const seen: JevRequest[] = [];
  let scopeWording = 0;
  const ask: AskJev = async (req) => {
    seen.push(req);
    const wording = req.purpose === "ask.scope" ? (scopeWording++ % 2 as 0 | 1) : 0;
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        const a = (choice: string, confidence = 0.95) => [id, { choice, confidence }] as const;
        if (req.purpose === "ask.heads") return a({ route: o.route ?? "some", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none");
        if (id === "section") {
          const s = o.section ?? "fields";
          if (typeof s === "string") return s in q.criteria ? a(s) : [id, named(s)(q)] as const;
          return [id, typeof s === "function" ? s(wording) : s] as const;
        }
        if (req.purpose === "ask.scope") {
          const label = /[Tt]he field '([^']+)'/u.exec(ins)?.[1] ?? "";
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

const plan = (d: ReturnType<typeof desk>, j: ReturnType<typeof jev>, instruction = INSTRUCTION, goals = false) =>
  planAsk(instruction, d.model, { values: () => [] }, [], { askJev: j.ask, maker: headsIntentMaker(j.ask), writer: null, offerKey: "scp1", windowId: d.windowId, now: 3000, ...(goals ? { goals: true } : {}) });

/** The field names an Ask writes (a fill's writes and controls), or a page goal's scope, by label. */
function written(r: AskDraft | AskGoal | unknown, d: ReturnType<typeof desk>): string[] {
  const w = d.model.windows.get(d.windowId);
  const label = (k: string): string => w?.nodes.get(k)?.label ?? k;
  if (r instanceof Error) return [];
  const x = r as AskDraft | AskGoal;
  if (x.route === "goal") return (x.page?.scope.fields ?? []).map(label);
  return [...x.checked.writes.map((v) => label(v.node.key)), ...(x.controls ?? []).map((c) => c.name)];
}
const scopeOf = (r: unknown): string[] => [...((r as AskDraft).checked?.writes ?? [])].map((x) => x.node.key);

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

  it("writes nothing it can't place in the named section, and says why (no membership evidence: the page walk)", async () => {
    const d = desk({ page: pageSnapshot(["Service request", "Equipment details", "Service contact"]) });
    const r = await plan(d, jev({ section: "Equipment details" })).catch((e: unknown) => e);
    expect(r).toBeInstanceOf(AskRefused);
    expect((r as AskRefused).message).toMatch(/^Caret couldn't tell which section .* (is|are) in, so it filled nothing/u);
    // The page goal path, as the helper plans a page Ask.
    const g = await plan(d, jev({ section: "Equipment details" }), INSTRUCTION, true).catch((e: unknown) => e);
    expect(written(g, d)).toEqual([]);
  });

  it("writes nothing when the reader shows no heading before the fields, and leaves them to the user", async () => {
    // The headings come after the fields they would name: no field has a section Caret can see.
    const nodes = readerForm({ headings: false });
    const d = desk({ reader: [...nodes, node("h/eq", "AXHeading", { label: "Equipment details" }), node("h/ct", "AXHeading", { label: "Service contact" })].filter((n) => n.key !== "h/top") });
    const r = await plan(d, jev({ section: "Equipment details" })).catch((e: unknown) => e);
    expect(written(r, d)).toEqual([]);
    expect((r as AskRefused).message).toContain("couldn't tell which section");
  });

  it("fills the fields it can place and says the rest are the user's, with the section reason", async () => {
    // Model sits before every heading: its section can't be told; Serial number is under Equipment details.
    const d = desk({ reader: [field("f/model", "", { label: "Model", frame: [20, 40, 200, 24] }), node("h/eq", "AXHeading", { label: "Equipment details" }), field("f/serial", "", { label: "Serial number", frame: [20, 80, 200, 24] }), node("h/ct", "AXHeading", { label: "Service contact" }), field("f/cname", "", { label: "Contact name", frame: [20, 200, 200, 24] })] });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(r, d)).toEqual(["Serial number"]);
    expect(r.unsure).toEqual([{ key: "f/model", name: "Model", says: "Model: Caret couldn't tell which section this field is in." }]);
  });

  it("keeps a heading shown twice from naming either: its fields are the user's", async () => {
    const d = desk({ reader: [node("h/eq", "AXHeading", { label: "Equipment details" }), field("f/serial", "", { label: "Serial number" }), node("h/eq2", "AXHeading", { label: "Equipment details" }), field("f/model", "", { label: "Model" })] });
    const r = await plan(d, jev({ section: "Equipment details" })).catch((e: unknown) => e);
    expect(written(r, d)).toEqual([]);
  });

  it("holds a later settlement (settleFields) to the named section: it can't widen the Ask", async () => {
    const d = desk({ reader: readerForm() });
    const w = d.model.windows.get("F");
    if (w === undefined) throw new Error("no form");
    const s = intentSnapshot(INSTRUCTION, d.model, w, []);
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
    const ow = other.model.windows.get("F");
    if (ow === undefined) throw new Error("no form");
    const elsewhere = await settleFields(intentSnapshot(INSTRUCTION, other.model, ow, []), jev({ asks: ["Billing contact"], section: "fields" }).ask, undefined, "Equipment details");
    expect(elsewhere.asks).toEqual([]);
    // A presettled request (helper.ts settleRequest) carries what it left to the user into the Ask, said.
    const page = desk({ page: pageSnapshot(["Equipment details", "Service contact"]) });
    const pw = page.model.windows.get(page.windowId);
    if (pw === undefined) throw new Error("no page");
    const ps = intentSnapshot(INSTRUCTION, page.model, pw, []);
    const pre = await settleFields(ps, jev({ section: "Equipment details" }).ask);
    expect(pre.asks).toEqual([]);
    expect(pre.sectionless.map((f) => f.name)).toEqual(ALL);
    const j = jev({ section: "Equipment details" });
    const made = await headsIntentMaker(j.ask).make(ps, undefined, { asks: pre.asks.map((f) => f.key), unclear: [], sectionless: pre.sectionless.map((f) => f.key) });
    expect(made.intent).toMatchObject({ route: "refuse", why: "sectionUnknown" });
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
    // A goal's set refuses a scope held to another section (helper.ts settleScopeFor passes the set's).
    if (authority?.kind !== "ask") throw new Error("no Ask authority");
    expect(() => scopeSet(authority.scope.askId, null, [authority.scope], null)).toThrow(/one section its Ask named/u);
    expect(() => withScope(scopeSet(authority.scope.askId, null, [], null), authority.scope)).toThrow(/held to section/u);
  });
});

describe("what the veto leaves as it was (preservation)", () => {
  const snapFor = (d: ReturnType<typeof desk>, instruction = INSTRUCTION): IntentSnapshot => {
    const w = d.model.windows.get(d.windowId);
    if (w === undefined) throw new Error("no form");
    return intentSnapshot(instruction, d.model, w, []);
  };
  const heads = (s: IntentSnapshot, route = "some"): JevResult => ({ model: "t", inputTokens: 0, latencyMs: 0, costUsd: 0, answers: Object.fromEntries(Object.keys(headsRequest(s).questions).map((id) => [id, { choice: ({ route, why: "nothingToFill", source: "any", whose: "user" } as Record<string, string>)[id] ?? "none", confidence: 0.9 }])) });
  type A = { choice: string; confidence: number };
  const pair = (s: IntentSnapshot, field: (name: string, wording: 0 | 1) => A, section: (wording: 0 | 1) => A | undefined): [JevResult, JevResult] =>
    ([0, 1] as const).map((wd) => {
      const sec = section(wd);
      return { model: "t", inputTokens: 0, latencyMs: 0, costUsd: 0, answers: { ...Object.fromEntries(s.fields.map((f) => [scopeId(f.ref), field(f.name, wd)])), ...(sec === undefined ? {} : { section: sec }) } };
    }) as [JevResult, JevResult];
  const refOf = (s: IntentSnapshot, heading: string): string => s.headings.find((h) => h.name === heading)?.ref ?? "none";
  const chosenNames = (s: IntentSnapshot, refs: readonly string[]): string[] => refs.map((r) => s.fields.find((f) => f.ref === r)?.name ?? r);

  it("still needs both wordings' asks for a field in the named section", async () => {
    const d = desk({ reader: readerForm() });
    const r = (await plan(d, jev({ section: "Equipment details", asksOnce: ["Model"] }))) as AskDraft;
    expect(written(r, d)).toEqual(["Serial number"]);
  });

  it("never lets not, unclear, a disagreement or a low answer to the section question take anything out", () => {
    const d = desk({ reader: readerForm() });
    const s = snapFor(d);
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
    for (const [i, c] of cases.entries()) {
      const r = readHeads(s, heads(s), pair(s, asks, c));
      expect(r, `case ${i}`).toEqual(baseline);
    }
    // And when the section question settles, it only removes.
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
      const d = desk({ reader: r() < 0.2 ? order.filter((x) => x.key !== "h/eq") : order });
      const s = snapFor(d);
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
      const shown = desk({ page: pageSnapshot(["Service request", "Equipment details", "Service contact"]) });
      const bare = desk({ page: pageSnapshot([]) });
      const asks = section === "whole" ? ALL : ["Serial number", "Contact phone"];
      const a = await plan(shown, jev({ asks, section, route }), instruction, true);
      const b = await plan(bare, jev({ asks, route }), instruction, true);
      // The section question was asked on one desk and not the other; the authority and the writes are the same.
      expect(written(a, shown), instruction).toEqual(written(b, bare));
      expect([...((a as AskGoal).askScope?.fields ?? [])], instruction).toEqual([...((b as AskGoal).askScope?.fields ?? [])]);
      expect(written(a, shown), instruction).toEqual(asks);
      // The plain fill path too.
      const fa = await plan(shown, jev({ asks, section, route }), instruction);
      const fb = await plan(bare, jev({ asks, route }), instruction);
      expect(written(fa, shown), instruction).toEqual(written(fb, bare));
      expect(scopeOf(fa), instruction).toEqual(scopeOf(fb));
    }
  });

  it("leaves an Ask whose section answer is unclear, split or low exactly as it was, on a page with no section evidence", async () => {
    const answers: Section[] = [{ choice: "unclear", confidence: 0.99 }, (w) => (w === 0 ? { choice: "sec2", confidence: 0.99 } : { choice: "fields", confidence: 0.99 }), { choice: "sec2", confidence: 0.3 }];
    for (const section of answers) {
      const shown = desk({ page: pageSnapshot(["Service request", "Equipment details", "Service contact"]) });
      const bare = desk({ page: pageSnapshot([]) });
      const a = await plan(shown, jev({ section }), INSTRUCTION, true);
      const b = await plan(bare, jev({}), INSTRUCTION, true);
      expect(written(a, shown)).toEqual(written(b, bare));
      expect(written(a, shown)).toEqual(ALL);
    }
  });
});

/** Part B: the page walk says which sections each control sits in (extension content/sections.ts). */
const PAGE_SECTIONS: Record<string, readonly string[]> = {
  "Serial number": ["Service request", "Equipment details"],
  Model: ["Service request", "Equipment details"],
  "Contact name": ["Service request", "Service contact"],
  "Contact phone": ["Service request", "Service contact"],
};
const HEADINGS = ["Service request", "Equipment details", "Service contact"];

describe("a section-only Ask on the page walk (Part B: page fields carry their sections)", () => {
  it("projects each control's sections onto its node, and leaves out a section name that names a secret", () => {
    const secret = "Password and security";
    expect(secretText(secret)).toBe(true);
    const page = pageSnapshot(HEADINGS, { ...PAGE_SECTIONS, Model: ["Service request", secret] });
    const node = (name: string): Node | undefined => page.nodes.find((n) => n.label === name);
    expect(node("Serial number")?.sections).toEqual(["Service request", "Equipment details"]);
    expect(node("Model")?.sections).toEqual(["Service request", secret]);
    const d = desk({ page });
    const w = d.model.windows.get(d.windowId);
    if (w === undefined) throw new Error("no page");
    const model = [...redactWindow(w).nodes.values()].find((n) => n.label === "Model");
    expect(model?.sections).toEqual(["Service request"]);
    // Nor is it ever offered as a section.
    expect(intentSnapshot(INSTRUCTION, d.model, w, []).headings.map((h) => h.name)).toEqual(HEADINGS);
  });

  it("fills the named section's fields and leaves out the adjacent section's, though Jev answered asks and exact for both", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS, PAGE_SECTIONS) });
    const r = (await plan(d, jev({ section: "Equipment details" }))) as AskDraft;
    expect(written(r, d)).toEqual(EQUIPMENT);
    expect(r.unsure ?? []).toEqual([]);
    const g = await plan(d, jev({ section: "Equipment details" }), INSTRUCTION, true);
    expect(written(g, d)).toEqual(EQUIPMENT);
    expect([...((g as AskGoal).askScope?.fields ?? [])].length).toBe(2);
  });

  it("reads the page title over the form as a section holding every field, not as no field's", async () => {
    const d = desk({ page: pageSnapshot(HEADINGS, PAGE_SECTIONS) });
    const r = (await plan(d, jev({ section: "Service request" }))) as AskDraft;
    expect(written(r, d)).toEqual(ALL);
  });

  it("offers only the sections the walk places a field in, once it places any", () => {
    const d = desk({ page: pageSnapshot(["Service request", "Equipment details", "Service contact", "Need help?"], { "Serial number": ["Equipment details"], Model: ["Equipment details"], "Contact name": ["Service contact"], "Contact phone": ["Service contact"] }) });
    const w = d.model.windows.get(d.windowId);
    if (w === undefined) throw new Error("no page");
    expect(intentSnapshot(INSTRUCTION, d.model, w, []).headings.map((h) => h.name)).toEqual(["Equipment details", "Service contact"]);
  });

  it("can't tell a section whose name the walk reaches by two outlines: its fields are the user's", async () => {
    const d = desk({ page: pageSnapshot(["Service request"], { "Serial number": ["Equipment details", "Address"], Model: ["Equipment details"], "Contact name": ["Service contact", "Address"], "Contact phone": ["Service contact"] }) });
    const r = await plan(d, jev({ asks: ["Serial number", "Contact name"], section: "Address" })).catch((e: unknown) => e);
    expect(written(r, d)).toEqual([]);
    expect((r as AskRefused).message).toContain("couldn't tell which section");
  });

  it("leaves a whole-form Ask on a sectioned page exactly as on a page without sections", async () => {
    const sectioned = desk({ page: pageSnapshot(HEADINGS, PAGE_SECTIONS) });
    const bare = desk({ page: pageSnapshot([]) });
    const a = await plan(sectioned, jev({ section: "whole", route: "all" }), "fill out this form from my notes", true);
    const b = await plan(bare, jev({ route: "all" }), "fill out this form from my notes", true);
    expect(written(a, sectioned)).toEqual(written(b, bare));
    expect(written(a, sectioned)).toEqual(ALL);
  });
});
