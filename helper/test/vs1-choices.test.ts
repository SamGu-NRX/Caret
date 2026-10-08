// Source-supported choices (design/ask/MISSING-CANDIDATES.md, "Choice options with source evidence"): a select's or radio
// group's listed option, or a service box's tick, that no source names literally is proposed for judgment against one
// whole basis (a source window, a memory entry, the user's whole request). Both value questions and the verifier must
// admit it; every ownership, scope, consent, privacy and stale-target check still applies. Each test asserts the
// candidate's body before any scripted answer, so a blank is never mistaken for a correct refusal.
//
// The desks are B31's prose in a note the Ask names. B31's own sources are mails, which the output ledger holds as
// conversations to half their text, so no choice can be judged against one whole there (the scoreboard reports those).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkValues, guardFor, isChecked, makeFieldContract, mintExempt, provenanceStale, setTestVerifier, ContractError, type CheckedValue, type Provenance } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { mintOf, proposeFill, valueSettlementOf, VALUE_TASK, type FillScope } from "../src/fill/fill.ts";
import { formControls, pickableOptions, serviceBox } from "../src/fill/controls.ts";
import { ScreenModel } from "../src/model.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import type { FillField, FillProposal, Node } from "../src/protocol.ts";
import { jevPickingText, snap } from "./builders.ts";
import { windowUnit } from "../src/fill/note-unit.ts";
import { groupOptions, type OptionMember } from "../src/fill/value-options.ts";
import { writtenFields } from "../src/offers/fill-popup.ts";
import { askScope, fieldFingerprint } from "../src/fill/ask-scope.ts";
import { proposedOf, runB31, valueQuestions } from "./vs1-kit.ts";

// The verifier's requests go to each test's Jev, not the suite's stand-in.
beforeEach(() => setTestVerifier(null));
afterEach(() => setTestVerifier(STAND_IN));

/** fill.ts's derivation for a source-supported choice, as its criterion and the verifier state it. */
const SUPPORTED = /Derivation: not copied from the source; Caret proposes /u;
type Answer = { choice: string; confidence: number };
interface Option { id: string; criterion: string; output: string | null }
const outputOf = (c: string): string | null => /^Proposed value: "([\s\S]*?)"\. Source: /u.exec(c)?.[1] ?? null;
const isSupported = (o: Option): boolean => SUPPORTED.test(o.criterion);
const fromUnit = (o: Option): boolean => isSupported(o) && /; the whole text is note_\d+ in source_notes\. Observed label: unavailable\. Supporting text: the whole text, note_\d+ in source_notes\./u.test(o.criterion);
const fromRequest = (o: Option): boolean => isSupported(o) && o.criterion.includes("Source: the user's request.");
const labelIn = (ins: string): string => /Label: '(.+?)'(?=[.,;:?)]|\s|$)/u.exec(ins)?.[1] ?? "";

// ---- desks ---------------------------------------------------------------------------------------------------------
const WEB: Node = { key: "web", parent: null, role: "AXWebArea", label: "Form" };
const NAME: Node = { key: "name", parent: "web", role: "AXTextField", label: "Your full name", editable: true, frame: [100, 20, 200, 24] };
const radios = (key: string, label: string, options: readonly string[], y: number): Node[] => [
  { key, parent: "web", role: "AXGroup", subrole: "AXFieldset", label },
  ...options.map((o, i): Node => ({ key: `${key}/${i}`, parent: key, role: "AXRadioButton", label: o, frame: [100, y + 20 * i, 200, 20] })),
];
const menu = (key: string, label: string, options: readonly string[], y: number): Node[] => [
  { key, parent: "web", role: "AXPopUpButton", label, editable: true, frame: [100, y, 200, 24] },
  ...options.map((o, i): Node => ({ key: `${key}/item${i}`, parent: key, role: "AXMenuItem", label: o })),
];
const boxes = (key: string, label: string, items: readonly string[], y: number): Node[] => [
  { key, parent: "web", role: "AXGroup", label },
  ...items.map((l, i): Node => ({ key: `${key}/${i}`, parent: key, role: "AXCheckBox", label: l, frame: [100, y + 20 * i, 200, 20] })),
];
const MEALS = ["Select a meal", "Braised short rib", "Herb-roasted salmon", "Wild mushroom risotto (vegetarian)"];
const RSVP = [WEB, NAME, ...radios("join", "Will you be joining us?", ["Joyfully accepts", "Regretfully declines"], 60), ...menu("party", "How many in your party?", ["Select", "1", "2"], 120), ...menu("mine", "Your meal choice", MEALS, 160), ...menu("guest", "Guest's meal choice", MEALS, 200)];
const BEA = "Avery!\nYes, I'd love to be your plus-one on the 24th, thank you for asking. Can you RSVP for both of us? Put me down as Beatrice Sutherland, that's how Priscilla knows me.\nFood: I'll have the vegetarian one. You said you wanted the short rib, so get that for yourself.\nMy shift ends at 7, so we'd get there around 7:45 pm.\nSee you soon,\nBea";
const SERVICES = ["Oil and filter change", "Tire rotation", "Brake inspection", "Cabin air filter replacement"];
const CAR = [WEB, NAME, ...menu("year", "Year", ["Select year", "2026", "2025", "2019", "2018"], 60), ...boxes("svc", "Services requested", SERVICES, 100)];
const CHRIS = "Hi Jamie,\nFor the 60,000-mile service on your 2019 Outback we'd do the oil change, tire rotation and brake inspection. The cabin air filter is optional, your call.\nChris Delgado, Summit Subaru";
const CLINIC = [WEB, NAME, ...radios("contact", "How should we contact you?", ["Phone call", "Text message", "Email"], 60), ...menu("state", "State", ["Select...", "MA", "NY"], 140), ...boxes("legal", "Before you finish", ["I have read the Notice of Privacy Practices.", "Sign me up for the Harbor Health newsletter."], 180)];
const INES_PICK = "And you said you'd rather they text you than call, so pick text.";
const INES = `Hi love,\nThe clinic texted again about your form.\nAddress: 27 Linden Terrace, Unit 3, Somerville, MA 02143\n${INES_PICK}\nxx\nInes`;
const SECTIONS = ["Mon/Wed 6:00-8:30 PM", "Tue/Thu 9:00-11:30 AM", "Sat 9:00 AM-12:30 PM"];
const COURSE = [WEB, NAME, ...radios("sec", "Section", SECTIONS, 60)];
const ENROLL = "Class: Intro to Web Development (CIS 140)\nSaturday mornings - weeknights I'm at work";
const TUE_THU = "Tue/Thu 9:00-11:30 AM";
const REQUEST_22 = "sign me up for the web dev class in spring but the tue/thu morning one, not sat";

const TEXTEDIT = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const CHROME = { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" };
function desk(note: string, form: readonly Node[], noteTitle = "Notes.txt"): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([{ key: "note", parent: null, role: "AXTextArea", value: note }], { at: 1000, windowId: "src", title: noteTitle, app: TEXTEDIT, focused: true }));
  m.apply(snap([...form], { at: 2000, windowId: "form", title: "The form", app: CHROME, focused: true }));
  return m;
}
const putNote = (m: ScreenModel, note: string, noteTitle = "Notes.txt", at = 4000): void => void m.apply(snap([{ key: "note", parent: null, role: "AXTextArea", value: note }], { at, windowId: "src", title: noteTitle, app: TEXTEDIT, focused: false }));

// ---- the scripted judges -------------------------------------------------------------------------------------------
/**
 * How a run's Jev answers. Whose and owner questions say the user's; the base's value question answers none, so a field
 * with a choice goes on to settlement. A settlement question takes `value`'s answer, else the option stating `want`'s output
 * for the field from its note (by criterion text, the same in both wordings), else none. The verifier takes `verify`'s
 * answer, else exact. `fail` makes the provider fail a request.
 */
interface Script {
  want?: Readonly<Record<string, string>>;
  value?: (label: string, wording: 0 | 1, options: readonly Option[], req: JevRequest) => Answer | undefined;
  verify?: (label: string, output: string, ins: string) => Answer | undefined;
  fail?: (req: JevRequest) => boolean;
}
const isSettlement = (req: JevRequest): boolean => (req.state as { task?: string }).task === VALUE_TASK;
function jevOf(s: Script, reqs: JevRequest[]): AskJev {
  return async (req) => {
    reqs.push(req);
    if (s.fail?.(req) === true) throw new Error("Jev HTTP 503: the provider failed this request");
    const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]): [string, Answer] => {
      const ins = String(q.instructions);
      if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 0.99 }];
      if (req.purpose === "fill.verify") return [id, s.verify?.(labelIn(ins), /Exact output: "([\s\S]*?)"\. /u.exec(ins)?.[1] ?? "", ins) ?? { choice: "exact", confidence: 0.99 }];
      if (!isSettlement(req)) return [id, { choice: "none", confidence: 0.99 }];
      const options = Object.entries(q.criteria).flatMap(([k, c]): Option[] => (typeof c === "string" && k !== "none" ? [{ id: k, criterion: c, output: outputOf(c) }] : []));
      const wording = options.some((o) => /^e\d+$/u.test(o.id)) ? 1 : 0;
      const given = s.value?.(labelIn(ins), wording, options, req);
      if (given !== undefined) return [id, given];
      const want = s.want?.[labelIn(ins)];
      const hit = options.filter((o) => o.output === want && fromUnit(o)).sort((a, b) => (a.criterion < b.criterion ? -1 : 1))[0];
      return [id, { choice: hit?.id ?? "none", confidence: 0.99 }];
    }));
    return { model: "scripted", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
}
/** Both wordings answer the source-supported option for `output` from the basis `basis` picks. */
const forced = (label: string, output: string, basis: (o: Option) => boolean = fromUnit): Script["value"] => (l, _w, options) =>
  l !== label ? undefined : { choice: options.find((x) => x.output === output && basis(x))?.id ?? "none", confidence: 0.99 };
const verdict = (label: string, choice: string): Script["verify"] => (l) => (l === label ? { choice, confidence: 0.99 } : undefined);

interface Run {
  p: FillProposal;
  model: ScreenModel;
  reqs: JevRequest[];
  field: (label: string) => FillField | undefined;
  /** Value settlement's question for `label` in each wording, with its options. */
  questions: (label: string) => { req: JevRequest; options: Option[] }[];
}
/**
 * An Ask on `model`'s form for the fields labelled `labels`, reading only the note, which it names; with `named` false
 * it names no source, so the request is a choice's basis too.
 */
async function run(model: ScreenModel, labels: readonly string[], instruction: string, s: Script, named = true): Promise<Run> {
  const form = model.windows.get("form");
  if (form === undefined) throw new Error("no form");
  const labelOf = (key: string): string => form.nodes.get(key)?.label ?? "";
  const keys = [...form.nodes.values()].filter((n) => labels.includes(n.label ?? "") && n.role !== "AXMenuItem" && n.role !== "AXRadioButton").map((n) => n.key);
  if (keys.length !== labels.length) throw new Error(`fields not found: ${labels.join(", ")}`);
  const scope: FillScope = named ? { fields: keys, windows: new Set(["src"]), memory: false, instruction, person: null, literals: new Map(), consented: new Set(["src"]) } : { fields: keys, windows: null, memory: false, instruction, person: null, literals: new Map() };
  const reqs: JevRequest[] = [];
  // The Ask's own authority, so the write contract holds each value to the fields as they read when it was asked.
  const authority = { kind: "ask" as const, scope: askScope("form", null, keys, Object.fromEntries(keys.map((k) => [k, fieldFingerprint(form, k)])), null, "choices-test") };
  const p = await proposeFill(model, jevOf(s, reqs), "form", "name", 3000, { scope, authority });
  return {
    p, model, reqs,
    field: (label) => p.fields.find((f) => labelOf(f.key) === label),
    questions: (label) => reqs.flatMap((req) => (!isSettlement(req) ? [] : Object.values(req.questions).filter((q) => labelIn(String(q.instructions)) === label).map((q) => ({ req, options: Object.entries(q.criteria).flatMap(([k, c]): Option[] => (typeof c === "string" && k !== "none" ? [{ id: k, criterion: c, output: outputOf(c) }] : [])) })))),
  };
}
const valueOf = (f: FillField | undefined): string | null => f?.handoff?.value ?? f?.value ?? null;
const noteIn = (req: JevRequest, o: Option): string | undefined => {
  const id = /the whole text is (note_\d+) in source_notes/u.exec(o.criterion)?.[1];
  return id === undefined ? undefined : (req.state as { source_notes?: Record<string, string> }).source_notes?.[id];
};
const verifyQuestions = (r: Run, label: string): string[] => r.reqs.filter((q) => q.purpose === "fill.verify").flatMap((q) => Object.values(q.questions).map((x) => String(x.instructions))).filter((x) => labelIn(x) === label);

// ---- Item 1: each missing exact output is a candidate of both value questions, then proposed -------------------------
const MISSING: readonly { note: string; form: readonly Node[]; label: string; output: string; instruction: string; basis?: (o: Option) => boolean; named?: boolean }[] = [
  { note: INES, form: CLINIC, label: "How should we contact you?", output: "Text message", instruction: "do the contact details part w the stuff ines sent" },
  { note: BEA, form: RSVP, label: "Will you be joining us?", output: "Joyfully accepts", instruction: "fill out the rsvp from bea's note" },
  { note: BEA, form: RSVP, label: "How many in your party?", output: "2", instruction: "fill out the rsvp from bea's note" },
  { note: BEA, form: RSVP, label: "Your meal choice", output: "Braised short rib", instruction: "fill out the rsvp from bea's note" },
  { note: BEA, form: RSVP, label: "Guest's meal choice", output: "Wild mushroom risotto (vegetarian)", instruction: "fill out the rsvp from bea's note" },
  { note: CHRIS, form: CAR, label: "Year", output: "2019", instruction: "get this booking form done from chris's note" },
  ...["Oil and filter change", "Tire rotation", "Brake inspection"].map((label) => ({ note: CHRIS, form: CAR, label, output: "checked", instruction: "get this booking form done from chris's note" })),
  { note: ENROLL, form: COURSE, label: "Section", output: TUE_THU, instruction: REQUEST_22, basis: fromRequest, named: false },
];

describe("the missing exact outputs are candidates", () => {
  it.each(MISSING.map((m) => [m.label, m] as const))("%s", async (_, m) => {
    const basis = m.basis ?? fromUnit;
    const r = await run(desk(m.note, m.form), [m.label], m.instruction, { value: forced(m.label, m.output, basis) }, m.named);
    const qs = r.questions(m.label);
    expect(qs, "both settlement wordings ask about the field").toHaveLength(2);
    for (const q of qs) expect(q.options.some((o) => o.output === m.output && basis(o))).toBe(true);
    expect(verifyQuestions(r, m.label), "the verifier is asked").toHaveLength(2);
    expect(valueOf(r.field(m.label))).toBe(m.output);
  });
});

describe("a choice carries its whole evidence and is verified", () => {
  it("both of us: the party count rests on the whole note, in both requests and the verifier's", async () => {
    const r = await run(desk(BEA, RSVP), ["How many in your party?"], "fill out the rsvp from bea's note", { want: { "How many in your party?": "2" } });
    const unit = windowUnit(r.model, "src");
    expect(unit?.complete).toBe(true);
    expect(unit?.text).toMatch(/^Notes\.txt\n/u);
    for (const q of r.questions("How many in your party?")) {
      const two = q.options.find((o) => o.output === "2" && fromUnit(o)) as Option;
      expect(two.criterion).toContain("Caret proposes the listed option '2' for judgment against its whole source text; code did not check that it names it.");
      expect(noteIn(q.req, two)).toBe(unit?.text);
    }
    const verify = r.reqs.filter((q) => q.purpose === "fill.verify");
    expect(verify.every((q) => Object.values((q.state as { source_notes?: Record<string, string> }).source_notes ?? {}).includes(unit?.text ?? ""))).toBe(true);
  });

  it("the two meals are two fields' questions over the same evidence; neither question says whose meal is whose", async () => {
    const labels = ["Your meal choice", "Guest's meal choice"];
    const r = await run(desk(BEA, RSVP), labels, "fill out the rsvp from bea's note", { want: { "Your meal choice": "Braised short rib", "Guest's meal choice": "Wild mushroom risotto (vegetarian)" } });
    for (const label of labels) {
      expect(r.questions(label).map((q) => q.options.filter(isSupported).map((o) => `${o.output} (${fromUnit(o) ? "unit" : "request"})`).sort())).toEqual(Array(2).fill(["Braised short rib (unit)", "Herb-roasted salmon (unit)", "Wild mushroom risotto (vegetarian) (unit)"]));
    }
    expect(labels.map((l) => valueOf(r.field(l)))).toEqual(["Braised short rib", "Wild mushroom risotto (vegetarian)"]);
  });

  it("each requested service names its box, and its tick is minted only by the verifier, against the whole note", async () => {
    const labels = ["Oil and filter change", "Tire rotation", "Brake inspection"];
    const r = await run(desk(CHRIS, CAR), labels, "get this booking form done from chris's note", { want: Object.fromEntries(labels.map((l) => [l, "checked"])) });
    for (const label of labels) {
      for (const q of r.questions(label)) expect(q.options.find(fromUnit)?.criterion).toContain(`Caret proposes ticking the box '${label}' for judgment against its whole source text`);
      for (const x of verifyQuestions(r, label)) expect(x).toMatch(/Operation: tick this checkbox|Proposed operation: tick this checkbox/u);
      const mint = mintOf(r.field(label) as FillField) as CheckedValue;
      expect(mint.verdict.by).toBe("verifier");
      expect(mint.provenance).toMatchObject({ kind: "derived", how: "sourceSupported", base: { kind: "unit", windowId: "src" } });
    }
  });

  it("2019 Outback: the year is a listed option judged against the note, not a date part", async () => {
    const r = await run(desk(CHRIS, CAR), ["Year"], "get this booking form done from chris's note", { want: { Year: "2019" } });
    for (const q of r.questions("Year")) expect(noteIn(q.req, q.options.find((o) => o.output === "2019" && fromUnit(o)) as Option)).toContain("on your 2019 Outback");
    expect(mintOf(r.field("Year") as FillField)?.provenance).toMatchObject({ how: "sourceSupported" });
  });

  it("Tue/Thu: the section option quotes the whole request, its 'not sat' included", async () => {
    const r = await run(desk(ENROLL, COURSE), ["Section"], REQUEST_22, { value: forced("Section", TUE_THU, fromRequest) }, false);
    for (const q of r.questions("Section")) expect(q.options.find((o) => o.output === TUE_THU && fromRequest(o))?.criterion).toContain(`Supporting text: the whole request, "${REQUEST_22}".`);
    for (const x of verifyQuestions(r, "Section")) expect(x).toContain(`User request: "${REQUEST_22}"`);
  });
});

describe("the request as a basis", () => {
  const SECTION = "Section";
  it("is one when the Ask names no source, and the instruction's choice is judged on it", async () => {
    const r = await run(desk(ENROLL, COURSE), [SECTION], REQUEST_22, { value: forced(SECTION, TUE_THU, fromRequest) }, false);
    expect(r.questions(SECTION).map((q) => q.options.filter(fromRequest).map((o) => o.output).sort())).toEqual(Array(2).fill([...SECTIONS].sort()));
    expect(valueOf(r.field(SECTION))).toBe(TUE_THU);
  });

  it("is none when the Ask names a source: that window is the evidence, and a field it cannot show stays blank", async () => {
    const r = await run(desk(ENROLL, COURSE), [SECTION], `${REQUEST_22}, from my note`, { value: forced(SECTION, TUE_THU, fromRequest) });
    expect(r.questions(SECTION).flatMap((q) => q.options).filter(fromRequest)).toEqual([]);
    expect(r.questions(SECTION).flatMap((q) => q.options).filter(fromUnit).length, "the note's own choices").toBe(6);
    const stated = r.reqs.filter(isSettlement).map((q) => String(Object.values(q.questions)[0]?.instructions));
    for (const x of stated) expect(x, "the request still reaches the value question").toContain(REQUEST_22);
    expect(valueOf(r.field(SECTION))).toBeNull();
    const cut = await run(desk(`${ENROLL}\nThe portal password is violet-orchard-seven.`, COURSE), [SECTION], `${REQUEST_22}, from my note`, { value: forced(SECTION, TUE_THU, fromRequest) });
    expect(cut.questions(SECTION).flatMap((q) => q.options).filter(isSupported)).toEqual([]);
    expect(valueOf(cut.field(SECTION))).toBeNull();
  });
});

describe("B31 under the output ledger", () => {
  // b31-13 names Chris's email, a conversation the ledger shows only half of, so its services have no evidence: no
  // choice on the request stands in for it.
  it("b31-13's services get no choice on the request, and stay blank", async () => {
    const r = await runB31("b31-13", { values: true, firstPass: "oracle" });
    const services = ["Oil and filter change", "Tire rotation", "Brake inspection"];
    for (const label of services) expect(valueQuestions(r, label).flatMap((q) => q.options).filter((o) => SUPPORTED.test(o.criterion) && o.criterion.includes("Source: the user's request."))).toEqual([]);
    for (const label of services) expect(proposedOf(r, r.outcome)[label]).toBeUndefined();
  });
});

describe("a page's evidence, whatever order its walk lists nodes in", () => {
  // The disclaimer comes before the footer group that holds it, which a snapshot may do (model.ts admitNodes).
  const page = (disclaimer: string): Node[] => [
    { key: "web", parent: "win", role: "AXWebArea", label: "Service" },
    { key: "body", parent: "web", role: "AXStaticText", value: "We'd do the oil change and the tire rotation." },
    { key: "warn", parent: "foot", role: "AXStaticText", value: disclaimer },
    { key: "foot", parent: "web", role: "AXGroup", label: "Footer" },
    { key: "back", parent: "win", role: "AXButton", label: "Back" },
  ];
  const put = (m: ScreenModel, disclaimer: string, at: number): void => void m.apply(snap(page(disclaimer), { at, windowId: "src", title: "Service quote", app: CHROME, focused: at === 1000 }));
  it("holds a node listed before its parent, in document order, and a change to it refuses the tick", async () => {
    const m = new ScreenModel();
    put(m, "Optional services, not requested. Do not book them.", 1000);
    m.apply(snap([...CAR], { at: 2000, windowId: "form", title: "The form", app: CHROME, focused: true }));
    const unit = windowUnit(m, "src");
    expect(unit?.text).toBe("Service quote\nService\nWe'd do the oil change and the tire rotation.\nFooter\nOptional services, not requested. Do not book them.");
    const r = await run(m, ["Oil and filter change"], "book the service from the quote", { want: { "Oil and filter change": "checked" } });
    for (const q of r.questions("Oil and filter change")) expect(noteIn(q.req, q.options.find(fromUnit) as Option)).toContain("Optional services, not requested. Do not book them.");
    const mint = mintOf(r.field("Oil and filter change") as FillField) as CheckedValue;
    expect(provenanceStale(m, mint.provenance)).toBeNull();
    put(m, "Book them all.", 4000);
    expect(provenanceStale(m, mint.provenance)).toBe("the text it was judged against changed");
  });
});

// ---- Item 5: wrong role, a past preference, an optional service, an unrelated year and a lookalike section ----------
const WRONG: readonly { name: string; note: string; form: readonly Node[]; label: string; output: string; instruction: string; basis?: (o: Option) => boolean; named?: boolean }[] = [
  { name: "Bea's vegetarian meal in Avery's own field", note: BEA, form: RSVP, label: "Your meal choice", output: "Wild mushroom risotto (vegetarian)", instruction: "fill out the rsvp from bea's note" },
  { name: "a preference Ines says Theo no longer has", note: INES.replace(INES_PICK, "You used to prefer texts, but you said you'd rather they call now."), form: CLINIC, label: "How should we contact you?", output: "Text message", instruction: "do the contact details part w the stuff ines sent" },
  { name: "the optional cabin filter", note: CHRIS, form: CAR, label: "Cabin air filter replacement", output: "checked", instruction: "get this booking form done from chris's note" },
  { name: "2026, a year the note never gives the car", note: `${CHRIS}\nSent Oct 15, 2026`, form: CAR, label: "Year", output: "2026", instruction: "get this booking form done from chris's note" },
  { name: "the Saturday section the request rules out", note: ENROLL, form: COURSE, label: "Section", output: "Sat 9:00 AM-12:30 PM", instruction: REQUEST_22, basis: fromRequest, named: false },
];

describe("a wrong choice is never written", () => {
  for (const c of WRONG) {
    const basis = c.basis ?? fromUnit;
    it(`${c.name}: a candidate, and refused after a forced agreement`, async () => {
      const r = await run(desk(c.note, c.form), [c.label], c.instruction, { value: forced(c.label, c.output, basis), verify: verdict(c.label, "other") }, c.named);
      for (const q of r.questions(c.label)) expect(q.options.some((o) => o.output === c.output && basis(o)), "the wrong option is offered").toBe(true);
      expect(verifyQuestions(r, c.label).filter((x) => x.includes(`"${c.output}"`)), "the verifier is asked").toHaveLength(2);
      expect(valueOf(r.field(c.label))).toBeNull();
    });
    it(`${c.name}: a split, none, or an unavailable verifier write nothing`, async () => {
      const split: Script["value"] = (l, w, options, req) => (l !== c.label ? undefined : w === 0 ? forced(c.label, c.output, basis)?.(l, w, options, req) : { choice: "none", confidence: 0.99 });
      const none: Script["value"] = (l) => (l === c.label ? { choice: "none", confidence: 0.99 } : undefined);
      for (const s of [{ value: split }, { value: none }, { value: forced(c.label, c.output, basis), verify: verdict(c.label, "unsure") }] as const) {
        const r = await run(desk(c.note, c.form), [c.label], c.instruction, s, c.named);
        expect(r.questions(c.label).flatMap((q) => q.options).some((x) => x.output === c.output && basis(x))).toBe(true);
        expect(valueOf(r.field(c.label))).toBeNull();
      }
    });
  }
});

describe("a month or day menu", () => {
  // A birthday written "04/12/1990" is April or December by its order, which no judgment may guess.
  it("gets no source-supported choice, even asked with both judgments forced to April", async () => {
    const months = ["Month", "January", "February", "March", "April", "December"];
    const r = await run(desk("Date of birth: 04/12/1990", [WEB, NAME, ...menu("dobm", "Month", months, 60), ...menu("doby", "Year", ["Year", "1990", "1991"], 100)]), ["Month", "Year"], "fill in my birthday from the note", { value: forced("Month", "April"), want: { Year: "1990" } });
    expect(r.questions("Month").flatMap((q) => q.options).filter(isSupported)).toEqual([]);
    expect(r.questions("Year").flatMap((q) => q.options).some((o) => o.output === "1990" && fromUnit(o)), "the year menu is offered").toBe(true);
    expect(valueOf(r.field("Month"))).toBeNull();
  });
});

describe("a settlement provider that fails", () => {
  it("leaves the choices blank and keeps the base's own values", async () => {
    const r = await run(desk(`Name: Jamie Torres\n${CHRIS}`, CAR), ["Your full name", "Year", "Oil and filter change"], "get this booking form done from chris's note", {
      fail: isSettlement,
      value: () => undefined,
    });
    expect(r.reqs.some((q) => isSettlement(q))).toBe(true);
    expect([valueOf(r.field("Year")), valueOf(r.field("Oil and filter change"))]).toEqual([null, null]);
  });
});

// ---- Item 6: the judgments forced to approve, where a deterministic veto applies -------------------------------------
describe("a deterministic veto holds whatever the judgments say", () => {
  const ADDRESS = [WEB, NAME, { key: "addr", parent: "web", role: "AXGroup", subrole: "AXFieldset", label: "Your address" } as Node, ...menu("state", "State", ["Select...", "MA", "NY"], 60).map((n) => (n.key === "state" ? { ...n, parent: "addr" } : n))];

  it("ownership: State takes a person's details, and a choice has no owner judgement, so none is offered", async () => {
    const r = await run(desk(INES, ADDRESS), ["State"], "do my address from ines's note", { value: forced("State", "MA"), verify: verdict("State", "exact") });
    expect(r.questions("State").flatMap((q) => q.options).filter(isSupported)).toEqual([]);
    expect(valueOf(r.field("State"))).toBeNull();
  });

  it("scope: a choice field the Ask did not scope is never asked about", async () => {
    const r = await run(desk(INES, CLINIC), ["How should we contact you?"], "do the contact details part w the stuff ines sent", { value: forced("State", "MA") });
    expect(r.questions("How should we contact you?").flatMap((q) => q.options).filter(isSupported).length, "the scoped choice field is enumerated").toBeGreaterThan(0);
    expect(r.questions("State")).toEqual([]);
    expect(r.field("State")).toBeUndefined();
  });

  it("consent: a privacy notice or sign-up box is no field to tick", async () => {
    const m = desk(INES, CLINIC);
    const w = m.windows.get("form");
    expect(formControls(w as NonNullable<typeof w>).filter((c) => c.control === "checkbox")).toEqual([]);
  });

  it("privacy: a note with a line redaction removes is no basis, and the Ask that names it gets no choice", async () => {
    const r = await run(desk(`${INES}\nThe portal password is violet-orchard-seven.`, CLINIC), ["How should we contact you?"], "do the contact details part w the stuff ines sent", { value: forced("How should we contact you?", "Text message"), verify: verdict("How should we contact you?", "exact") });
    expect(windowUnit(r.model, "src")?.complete).toBe(false);
    expect(r.questions("How should we contact you?").flatMap((q) => q.options).filter(isSupported)).toEqual([]);
    expect(valueOf(r.field("How should we contact you?"))).toBeNull();
  });
});

// ---- Item 7: a window that does not fit, and a change between judgment and dispatch ---------------------------------
describe("missing or changed evidence", () => {
  it("a note too long to send whole gives no note-based choice", async () => {
    const long = `${"We can also talk about parking and the lobby hours another time. ".repeat(24)}${INES_PICK}`;
    const r = await run(desk(INES.replace(INES_PICK, long), CLINIC), ["How should we contact you?"], "do the contact details part w the stuff ines sent", { value: forced("How should we contact you?", "Text message"), verify: verdict("How should we contact you?", "exact") });
    expect(r.questions("How should we contact you?").flatMap((q) => q.options).filter(isSupported)).toEqual([]);
    expect(valueOf(r.field("How should we contact you?"))).toBeNull();
  });

  it("after the judgment, a changed line, title, option label or field refuses the write at dispatch", async () => {
    const r = await run(desk(CHRIS, CAR), ["Year"], "get this booking form done from chris's note", { want: { Year: "2019" } });
    const mint = mintOf(r.field("Year") as FillField) as CheckedValue;
    expect(isChecked(mint) && mint.text).toBe("2019");
    const guard = (): string | null => {
      const form = r.model.windows.get("form");
      const node = form?.nodes.get(mint.field.key);
      return node === undefined || form === undefined ? "gone" : guardFor(() => r.model, new Map([[0, mint]]), mint.authority, null, null)(0, "2019", { windowId: "form", node, window: form });
    };
    expect(guard()).toBeNull();
    putNote(r.model, `${CHRIS}\n(this booking is for my brother's car)`);
    expect(provenanceStale(r.model, mint.provenance)).toBe("the text it was judged against changed");
    expect(guard()).toMatch(/the text it was judged against changed/u);
    putNote(r.model, CHRIS, "Notes.txt", 5000);
    expect(guard()).toBeNull();
    putNote(r.model, CHRIS, "Old notes, do not use", 6000);
    expect(guard(), "a changed title").toMatch(/the text it was judged against changed/u);
    putNote(r.model, CHRIS, "Notes.txt", 7000);
    expect(guard()).toBeNull();
    const relabel = (from: string, to: string, at: number): void => void r.model.apply(snap(CAR.map((n) => (n.label === from ? { ...n, label: to } : n)), { at, windowId: "form", title: "The form", app: CHROME, focused: true }));
    relabel("2019", "2019 (sold out)", 8000);
    expect(guard()).toMatch(/changed since Caret asked about it/u);
    relabel("Year", "Model year of the loaner", 9000);
    expect(guard()).not.toBeNull();
  });
});

// ---- Item 8: ids, grouping, the fresh pair after a pick, and consumers that cannot carry a choice --------------------
describe("identity and obligations through remapping, grouping and picks", () => {
  it("the second wording lists the same options, bases and units under its own ids", async () => {
    const r = await run(desk(CHRIS, CAR), ["Year"], "get this booking form done from chris's note", { want: { Year: "2019" } });
    const [a, b] = r.questions("Year").map((q) => q.options.filter(isSupported));
    expect(a?.map((o) => o.criterion).sort()).toEqual(b?.map((o) => o.criterion).sort());
    expect(a?.every((o) => /^d\d+$/u.test(o.id)) && b?.every((o) => /^e\d+$/u.test(o.id))).toBe(true);
    expect(a?.length).toBe(4);
  });

  it("a choice never merges with a literal option of the same output and unit, and keeps the verifier's obligation", () => {
    const member = (id: string, assumptions: string[], verifier: boolean): OptionMember => ({ id, output: "2", evidence: "mail\u0000*", origin: "window", label: null, owner: null, assumptions, verifier });
    const g = groupOptions([member("c8", [], false), member("d7", ["Caret proposes the listed option '2' for judgment against its whole source text; code did not check that it names it"], true)]);
    expect(g.map((o) => [o.id, o.verifier])).toEqual([["c8", false], ["d7", true]]);
  });

  const LABEL = "How should we contact you?";
  /** The first pair splits on Text message from the note; a pick's fresh pair (it states the user's selection) answers `fresh`. */
  const picking = (fresh: Script["value"], verify: Script["verify"]): Script => ({
    verify,
    value: (l, w, options, req) => {
      if (l !== LABEL) return undefined;
      if (/Explicit user selections: (?!none)/u.test(String(Object.values(req.questions)[0]?.instructions))) return fresh?.(l, w, options, req);
      return w === 0 ? forced(LABEL, "Text message")?.(l, w, options, req) : { choice: "none", confidence: 0.99 };
    },
  });
  async function pick(output: string | null, s: Script): Promise<{ r: Run; after: FillField | null }> {
    const reqs: JevRequest[] = [];
    const r = await run(desk(INES, CLINIC), [LABEL], "do the contact details part w the stuff ines sent", s);
    const settlement = valueSettlementOf(r.p);
    const u = settlement?.unresolved.find((x) => x.name === LABEL);
    expect(u?.options.map((o) => `${o.value} | ${o.source}`)).toEqual(expect.arrayContaining(["Text message | Notes.txt: the whole text", "Phone call | Notes.txt: the whole text"]));
    if (output === null) return { r, after: null };
    const option = u?.options.find((o) => o.value === output && o.source.endsWith(": the whole text"));
    const after = await (settlement as NonNullable<typeof settlement>).settle(u?.key ?? "", option?.id ?? "", { model: r.model, askJev: jevOf(s, reqs) });
    r.reqs.push(...reqs);
    return { r, after };
  }

  it("a pick buys one fresh pair, then the verifier; its 'other' leaves the field blank", async () => {
    const { r, after } = await pick("Text message", picking(forced(LABEL, "Text message"), verdict(LABEL, "other")));
    expect(r.reqs.filter((x) => isSettlement(x) && String(Object.values(x.questions)[0]?.instructions).includes("Explicit user selections: the value"))).toHaveLength(2);
    expect(verifyQuestions(r, LABEL)).toHaveLength(2);
    expect(valueOf(after ?? undefined)).toBeNull();
  });

  it("the same pick with an exact verdict proposes it; a hostile pick refused by the verifier, or Leave blank, does not", async () => {
    expect(valueOf((await pick("Text message", picking(forced(LABEL, "Text message"), verdict(LABEL, "exact")))).after ?? undefined)).toBe("Text message");
    expect(valueOf((await pick("Phone call", picking(forced(LABEL, "Phone call"), verdict(LABEL, "other")))).after ?? undefined)).toBeNull();
    const blank = await pick(null, picking(forced(LABEL, "Text message"), verdict(LABEL, "exact")));
    expect(valueOf(blank.r.field(LABEL))).toBeNull();
  });

  it("no exemption mints a choice, and a Fill all leaves a whole-note choice to the user", async () => {
    const r = await run(desk(CHRIS, CAR), ["Year"], "get this booking form done from chris's note", { want: { Year: "2019" } });
    const f = r.field("Year");
    const mint = mintOf(f as FillField) as CheckedValue;
    expect(() => mintExempt(mint, "optionLabel", 3000, "", mint.authority)).toThrow(ContractError);
    expect(writtenFields(r.p).fields.map((x) => x.key)).not.toContain(f?.key);
    expect((mint.provenance as Extract<Provenance, { kind: "derived" }>).says).toMatch(/for judgment against its whole source text/u);
  });
});

// Isolated rules with one correct answer, and the request as the only basis.
describe("which controls get choices", () => {
  const box = (key: string, label: string, parent: string): Node => ({ key, parent, role: "AXCheckBox", label });
  const form = (nodes: Node[]) => {
    const m = new ScreenModel();
    m.apply(snap([{ key: "web", parent: null, role: "AXWebArea", label: "Form" }, ...nodes], { at: 1000, windowId: "form", focused: true }));
    return m.windows.get("form") as NonNullable<ReturnType<typeof m.windows.get>>;
  };

  it("a tick only for a bare item among others of its group, never a lone fact, a first-person or a sign-up box", () => {
    const w = form([
      { key: "svc", parent: "web", role: "AXGroup", label: "Services" }, box("oil", "Oil change", "svc"), box("tires", "Tire rotation", "svc"),
      { key: "age", parent: "web", role: "AXGroup", label: "About you" }, box("18", "Over 18", "age"),
      { key: "misc", parent: "web", role: "AXGroup", label: "Other" }, box("first", "This is my first visit", "misc"), box("news", "Send me offers", "misc"), box("pet", "Bring a pet", "misc"),
    ]);
    const of = (k: string): boolean => serviceBox(w, formControls(w).find((c) => c.node.key === k) as never);
    expect(["oil", "tires", "18", "first", "pet"].map((k) => [k, of(k)])).toEqual([["oil", true], ["tires", true], ["18", false], ["first", false], ["pet", false]]);
  });

  it("a radio's option that reads like a select's prompt is still an option", () => {
    const w = form([{ key: "how", parent: "web", role: "AXGroup", label: "Delivery" }, ...["Pick-up", "Delivery"].map((o, i): Node => ({ key: `how/${i}`, parent: "how", role: "AXRadioButton", label: o }))]);
    expect(pickableOptions(w, formControls(w).find((c) => c.control === "radio") as never)).toEqual(["Pick-up", "Delivery"]);
  });

  it("the request alone is a basis: with no other window open, its choice is judged and verified", async () => {
    const m = new ScreenModel();
    const radio = (o: string, i: number): Node => ({ key: `contact/${i}`, parent: "contact", role: "AXRadioButton", label: o, frame: [100, 60 + 30 * i, 200, 20] });
    m.apply(snap([{ key: "web", parent: null, role: "AXWebArea", label: "Form" }, { key: "name", parent: "web", role: "AXTextField", label: "Full name", editable: true, frame: [100, 20, 200, 24] }, { key: "contact", parent: "web", role: "AXGroup", subrole: "AXFieldset", label: "Contact method" }, ...["Phone call", "Text message"].map(radio)], { at: 2000, windowId: "form", title: "Sign up", app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
    setTestVerifier(STAND_IN);
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes("'Contact method'") ? "Text message" : null)), "form", "name", 3000, { scope: { fields: ["contact"], windows: null, memory: false, instruction: "text me, don't call, for contact method", person: null, literals: new Map() } });
    const f = p.fields.find((x) => x.key === "contact");
    expect(f?.handoff?.value).toBe("Text message");
    expect(mintOf(f as never)?.provenance).toMatchObject({ how: "sourceSupported", base: { kind: "instruction" } });
  });

  it("a choice judged against the request is not verified without it", async () => {
    const field = makeFieldContract({ windowId: "form", node: { key: "contact", parent: null, role: "AXGroup", label: "Contact method" }, descriptor: "Radio buttons. Label: 'Contact method'.", name: "Contact method", labelWords: ["Contact method"], control: "radio", kinds: new Set(), part: null });
    const asked: string[] = [];
    const jev: AskJev = async (req) => (asked.push(...Object.keys(req.questions)), { model: "t", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "exact", confidence: 0.99 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 });
    const proposed = { field, text: "Text message", display: "Text message", provenance: { kind: "derived", how: "sourceSupported", base: { kind: "instruction", span: "text me, password hunter2" }, also: null, says: "Caret proposes the listed option 'Text message' for judgment against the user's whole request" } as Provenance, owner: null };
    const r = await checkValues([proposed], { askJev: jev, ledger: null, now: 0, instruction: "text me, my password is hunter2", authority: { kind: "plan", offerKey: "t" } });
    expect([asked, r.refused[0]?.why]).toEqual([[], "unverified"]);
  });
});

// v2/choices review (Sol): commitments, editable labels, message boundaries, and the old negatives end to end.
describe("what a box tick and its evidence may be", () => {
  const SOL = ["Pay now for maintenance plan", "Arbitration agreement", "Roadside assistance membership", "This is a service we’ve requested"];
  const web: Node = { key: "web", parent: null, role: "AXWebArea", label: "Form" };
  const box = (key: string, label: string): Node => ({ key, parent: "svc", role: "AXCheckBox", label, frame: [100, 60 + 30 * Number(key.replace(/\D/gu, "") || 0), 200, 20] });
  const services = (labels: readonly string[]): Node[] => [web, { key: "name", parent: "web", role: "AXTextField", label: "Full name", editable: true, frame: [100, 20, 200, 24] }, { key: "svc", parent: "web", role: "AXGroup", label: "Services" }, box("b0", "Oil change"), box("b1", "Tire rotation"), ...labels.map((l, i) => box(`b${i + 2}`, l))];
  const desk = (source: Node[], form: Node[], sourceTitle = "Service notes"): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap(source, { at: 1000, windowId: "src", title: sourceTitle, app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    m.apply(snap(form, { at: 2000, windowId: "form", title: "Book a service", app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
    return m;
  };
  /** Records each request; both value wordings tick each box from its window's whole text, and the verifier (the suite's stand-in) says exact. */
  const ticking = (): { jev: AskJev; reqs: JevRequest[] } => {
    const reqs: JevRequest[] = [];
    const jev: AskJev = async (req) => {
      reqs.push(req);
      const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: Object.entries(q.criteria).find(([, c]) => typeof c === "string" && c.startsWith('Proposed value: "checked".') && c.includes("the whole text is note_"))?.[0] ?? "none", confidence: 0.99 }]));
      return { model: "t", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
    };
    return { reqs, jev };
  };
  const scope = (fields: readonly string[], instruction: string, literals = new Map<string, string>()) => ({ fields, windows: new Set(["src"]), memory: false, instruction, person: null, literals, consented: new Set(["src"]) });

  it("refuses a payment, an agreement, a membership and a first-person box, whatever their siblings, literal 'checked' included", async () => {
    const w = (() => {
      const m = new ScreenModel();
      m.apply(snap(services(SOL), { at: 2000, windowId: "form", focused: true }));
      return m.windows.get("form") as NonNullable<ReturnType<typeof m.windows.get>>;
    })();
    const listed = formControls(w);
    expect(SOL.map((l) => [l, listed.some((c) => c.label === l && serviceBox(w, c))])).toEqual(SOL.map((l) => [l, false]));
    expect(listed.some((c) => c.label === "Oil change" && serviceBox(w, c))).toBe(true);
    setTestVerifier(STAND_IN);
    const keys = SOL.map((_, i) => `b${i + 2}`);
    const { jev } = ticking();
    const p = await proposeFill(desk([{ key: "note", parent: null, role: "AXTextArea", value: "Book everything on the list, pay for the plan, sign the agreement." }], services(SOL)), jev, "form", "name", 3000, { scope: scope(keys, "tick all of them", new Map(keys.map((k) => [k, "checked"]))) });
    expect(p.fields.filter((f) => keys.includes(f.key) && (f.handoff !== null || f.value !== null))).toEqual([]);
  });

  it("an editable field's label is part of the evidence the judges and the verifier see", async () => {
    setTestVerifier(STAND_IN);
    const { jev, reqs } = ticking();
    const source: Node[] = [{ key: "opt", parent: null, role: "AXTextField", editable: true, label: "Optional services, not requested", value: "Oil change" }];
    const p = await proposeFill(desk(source, services([])), jev, "form", "name", 3000, { scope: scope(["b0"], "book the service from the notes") });
    const notes = reqs.flatMap((r) => Object.values((r.state as { source_notes?: Record<string, string> }).source_notes ?? {}));
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n).toContain("Optional services, not requested");
    expect(reqs.filter((r) => r.purpose === "fill.verify").every((r) => Object.values((r.state as { source_notes?: Record<string, string> }).source_notes ?? {}).some((n) => n.includes("Optional services, not requested")))).toBe(true);
    expect(mintOf(p.fields.find((f) => f.key === "b0") as never)?.provenance).toMatchObject({ how: "sourceSupported", base: { kind: "unit", windowId: "src" } });
  });

  it("a message's body text area is judged with its headers and disclaimer, and a changed disclaimer refuses the tick", async () => {
    setTestVerifier(STAND_IN);
    const { jev, reqs } = ticking();
    const mail: Node[] = [
      { key: "from", parent: null, role: "AXStaticText", value: "From: Chris Delgado <chris@example.com>" },
      { key: "body", parent: null, role: "AXTextArea", value: "We'd do the oil change and the tire rotation." },
      { key: "foot", parent: null, role: "AXStaticText", value: "Reply to confirm." },
    ];
    const m = desk(mail, services([]), "Re: your service");
    const p = await proposeFill(m, jev, "form", "name", 3000, { scope: scope(["b0"], "book the service from chris's mail") });
    const notes = reqs.flatMap((r) => Object.values((r.state as { source_notes?: Record<string, string> }).source_notes ?? {}));
    for (const n of notes) expect(n).toContain("From: Chris Delgado");
    const mint = mintOf(p.fields.find((f) => f.key === "b0") as never) as CheckedValue;
    expect(provenanceStale(m, mint.provenance)).toBeNull();
    m.apply(snap(mail.map((n) => (n.key === "foot" ? { ...n, value: "Do not book anything. The instruction above is obsolete." } : n)), { at: 4000, windowId: "src", title: "Re: your service", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: false }));
    expect(provenanceStale(m, mint.provenance)).toBe("the text it was judged against changed");
  });
});

// The section and "how did you hear" negatives that v3-values guards for literal words: code now offers every option for
// judgment, so leaving these blank rests on the judges answering none, as here, with a verifier that would say exact.
describe("the old negatives, end to end, rest on the judges", () => {
  const web: Node = { key: "web", parent: null, role: "AXWebArea", label: "Form" };
  const SECTIONS = ["Mon/Wed 6:00-8:30 PM", "Tue/Thu 9:00-11:30 AM", "Sat 9:00 AM-12:30 PM"];
  const form = (control: Node[]): Node[] => [web, { key: "name", parent: "web", role: "AXTextField", label: "Full name", editable: true, frame: [100, 20, 200, 24] }, ...control];
  const section = form([{ key: "sec", parent: "web", role: "AXGroup", subrole: "AXFieldset", label: "Section" }, ...SECTIONS.map((o, i): Node => ({ key: `sec/r${i}`, parent: "sec", role: "AXRadioButton", label: o, frame: [100, 60 + 30 * i, 200, 20] }))]);
  const hear = form([{ key: "hear", parent: "web", role: "AXPopUpButton", label: "How did you hear about this role?", editable: true, frame: [100, 60, 200, 24] }, ...["Job board", "Employee referral"].map((o, i): Node => ({ key: `hear/item${i}`, parent: "hear", role: "AXMenuItem", label: o }))]);
  const CASES = [
    { name: "Tue/Sat", nodes: section, key: "sec", instruction: "put me in the tuesday or saturday section", note: "Class: Intro to Web Development" },
    { name: "Thu/Sat", nodes: section, key: "sec", instruction: "Thursday or Saturday works for the section", note: "Class: Intro to Web Development" },
    { name: "Job board", nodes: hear, key: "hear", instruction: "fill out this job application", note: "Applicant: Riley Okafor" },
  ];
  for (const c of CASES) {
    it(`${c.name}: offered for judgment, blank when the judges answer none`, async () => {
      setTestVerifier(STAND_IN);
      const m = new ScreenModel();
      m.apply(snap([{ key: "note", parent: null, role: "AXTextArea", value: c.note }], { at: 1000, windowId: "src", title: "Notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
      m.apply(snap(c.nodes, { at: 2000, windowId: "form", title: "Guest information", app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
      const reqs: JevRequest[] = [];
      const inner = jevPickingText(() => null);
      const p = await proposeFill(m, async (req) => (reqs.push(req), inner(req)), "form", "name", 3000, { scope: { fields: [c.key], windows: null, memory: false, instruction: c.instruction, person: null, literals: new Map() } });
      const offered = reqs.flatMap((r) => Object.values(r.questions).flatMap((q) => Object.values(q.criteria))).filter((x) => typeof x === "string" && SUPPORTED.test(x));
      expect(offered.length, "the options are offered for judgment").toBeGreaterThan(0);
      expect(p.fields.find((f) => f.key === c.key)?.handoff ?? null).toBeNull();
    });
  }
});
