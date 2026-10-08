// Source-supported choices (design/ask/MISSING-CANDIDATES.md, "Choice options with source evidence"): a select's or radio
// group's listed option, or a service box's tick, that no source names literally is proposed for judgment against one
// whole basis (a source unit, a memory entry, the user's whole request). Both value questions and the verifier must admit
// it; every ownership, scope, consent, privacy and stale-target check still applies. Each test asserts the candidate's body
// before any scripted answer, so a blank is never mistaken for a correct refusal. B31 corpus desks only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkValues, guardFor, isChecked, makeFieldContract, mintExempt, provenanceStale, setTestVerifier, ContractError, type CheckedValue, type Provenance } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { mintOf, proposeFill, VALUE_TASK } from "../src/fill/fill.ts";
import { formControls, pickableOptions, serviceBox } from "../src/fill/controls.ts";
import { ScreenModel } from "../src/model.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { Node } from "../src/protocol.ts";
import { jevPickingText, snap } from "./builders.ts";
import { unitOf } from "../src/fill/note-unit.ts";
import { groupOptions, type OptionMember } from "../src/fill/value-options.ts";
import { writtenFields } from "../src/offers/fill-popup.ts";
import { AskRefused, answerQuestion, type AskDraft } from "../src/planner/ask.ts";
import type { JevRequest } from "../src/fill/jev.ts";
import type { Snapshot } from "../src/protocol.ts";
import { pageForm, T0 } from "../scripts/realfill-corpus.ts";
import { corpus, proposedOf, runB31, snaps, valueQuestionFor, valueQuestions, type Answer, type Option, type Overrides, type Run } from "./vs1-kit.ts";

// The verifier's requests go to the run's Jev (the scripted oracle, or a test's answers), not the suite's stand-in.
beforeEach(() => setTestVerifier(null));
afterEach(() => setTestVerifier(STAND_IN));

/** fill.ts's derivation for a source-supported choice, as its criterion and the verifier state it. */
const SUPPORTED = /Derivation: not copied from the source; Caret proposes /u;
const isSupported = (o: Option): boolean => SUPPORTED.test(o.criterion);
const fromUnit = (o: Option): boolean => isSupported(o) && /; the whole text is note_\d+ in source_notes\. Observed label: unavailable\. Supporting text: the whole text, note_\d+ in source_notes\./u.test(o.criterion);
const fromRequest = (o: Option): boolean => isSupported(o) && o.criterion.includes("Source: the user's request.");
/** The source-supported options for `label` in each settlement wording, as "output (unit|request)", sorted. */
function supportedOf(r: Run, label: string): string[][] {
  return valueQuestions(r, label).map((q) => q.options.filter(isSupported).map((o) => `${o.output} (${fromUnit(o) ? "unit" : fromRequest(o) ? "request" : "memory"})`).sort());
}
/** The note id a unit-based option names, and that note as each request carries it. */
function noteOf(req: JevRequest, o: Option): string | undefined {
  const id = /the whole text is (note_\d+) in source_notes/u.exec(o.criterion)?.[1];
  return id === undefined ? undefined : (req.state as { source_notes?: Record<string, string> }).source_notes?.[id];
}
/** Both wordings answer the source-supported option for `output` from the basis `basis` picks. */
const forced = (label: string, output: string, basis: (o: Option) => boolean = fromUnit, confidence = 0.99): Overrides["value"] => (l, _w, options) => {
  if (l !== label) return undefined;
  const o = options.find((x) => x.output === output && basis(x));
  return o === undefined ? { choice: "none", confidence } : { choice: o.id, confidence };
};
/** The verifier's answer for `label`'s value, found by the question's own label: the kit's label match takes the first label the question holds anywhere, an option's text included ('Email'). */
const verdict = (label: string, choice: string, confidence = 0.99): Overrides["verify"] => (_l, _w, _o, ins) => (ins.includes(`Label: '${label}'`) ? { choice, confidence } : undefined);
/** Puts `labels` in the Ask's scope: the scope question says it asks for them, and its confirmation says yes. */
const inScope = (...labels: string[]): Overrides["raw"] => (_req, qid, q) => {
  const ins = String(q.instructions);
  if (!labels.some((l) => ins.includes(`"${l}"`) || ins.includes(`'${l}'`))) return undefined;
  if (qid.startsWith("s_") && "asks" in q.criteria) return { choice: "asks", confidence: 0.99 };
  if ("yes" in q.criteria) return { choice: "yes", confidence: 0.99 };
  return undefined;
};
const both = (...xs: (Overrides["raw"] | undefined)[]): Overrides["raw"] => (req, qid, q) => xs.reduce<Answer | undefined>((a, x) => a ?? x?.(req, qid, q), undefined);
/** The unit (note-unit.ts) of the node in the window titled `title` that holds `text`. */
function unitHolding(r: Run, title: string, text: string) {
  const w = [...r.desk.model.windows.values()].find((x) => x.window.title.startsWith(title));
  const n = [...(w?.nodes.values() ?? [])].find((x) => (x.label ?? x.value ?? "").includes(text));
  return w === undefined || n === undefined ? null : unitOf(r.desk.model, w.window.windowId, n.key);
}
/** A recorded window with `from` replaced by `to` in its text. */
const rewrite = (title: string, from: string, to: string) => (s: Snapshot): Snapshot =>
  s.window.title.startsWith(title) ? { ...s, nodes: s.nodes.map((n) => (n.label?.includes(from) === true ? { ...n, label: n.label.replace(from, to) } : n.value?.includes(from) === true ? { ...n, value: n.value.replace(from, to) } : n)) } : s;
const fieldOf = (r: Run, label: string) => (r.outcome as AskDraft).fill?.fields.find((f) => r.labelOf.get(f.key) === label);
const draftOf = (r: Run): AskDraft => {
  if (r.outcome instanceof AskRefused) throw new Error(`the Ask refused: ${r.outcome.message}`);
  return r.outcome;
};

const BEA = "Re: plus-one for Jun & Priscilla's party?";
const INES = "Harbor Family Clinic new-patient form";
const CHRIS = "Re: 60k service for your Outback";
const TUE_THU = "Tue/Thu 9:00-11:30 AM";
const REQUEST_22 = "sign me up for the web dev class in spring but the tue/thu morning one, not sat";

// Item 1: each missing exact output of Asks 08, 12, 13 and 22, as an option of both value questions, then proposed by the
// scripted oracle. Year in Ask 02 already exists at baseline and Asks 05 and 11 are derived parts, not choices.
const MISSING: readonly (readonly [string, string, string])[] = [
  ["b31-08", "How should we contact you?", "Text message"],
  ["b31-12", "Will you be joining us?", "Joyfully accepts"],
  ["b31-12", "How many in your party?", "2"],
  ["b31-12", "Your meal choice", "Braised short rib"],
  ["b31-12", "Guest's meal choice", "Wild mushroom risotto (vegetarian)"],
  ["b31-13", "Year", "2019"],
  ["b31-13", "Oil and filter change", "checked"],
  ["b31-13", "Tire rotation", "checked"],
  ["b31-13", "Brake inspection", "checked"],
  ["b31-22", "Section", TUE_THU],
];

describe("the missing exact outputs are candidates", () => {
  it.each(MISSING.map((m) => [`${m[0]} ${m[1]}`, ...m] as const))("%s", async (_, ask, label, output) => {
    const r = await runB31(ask, { values: true, firstPass: "oracle" });
    const qs = valueQuestions(r, label);
    expect(qs, "both settlement wordings ask about the field").toHaveLength(2);
    for (const q of qs) expect(q.options.filter((o) => o.output === output && isSupported(o)).length, `wording ${q.id}`).toBeGreaterThan(0);
    expect(proposedOf(r, r.outcome)[label]).toBe(output);
  });
});

describe("a choice carries its whole evidence and is verified", () => {
  it("both of us: the party count rests on Bea's whole mail, headers and signature included, in both requests", async () => {
    const r = await runB31("b31-12", { values: true, firstPass: "oracle" });
    const unit = unitHolding(r, BEA, "both of us");
    expect(unit?.complete).toBe(true);
    expect(unit?.text).toContain("Can you RSVP for both of us?");
    expect(valueQuestions(r, "How many in your party?")).toHaveLength(2);
    for (const q of valueQuestions(r, "How many in your party?")) {
      const two = q.options.find((o) => o.output === "2" && fromUnit(o)) as Option;
      expect(two.criterion).toMatch(/^Proposed value: "2"\. Source: Google Chrome window 'Re: plus-one/u);
      expect(two.criterion).toContain("Caret proposes the listed option '2' for judgment against its whole source text; code did not check that it names it.");
      expect(noteOf(q.req, two)).toBe(unit?.text);
    }
  });

  it("the two meals are two fields' questions over the same evidence; neither question says whose meal is whose", async () => {
    const r = await runB31("b31-12", { values: true, firstPass: "oracle" });
    for (const label of ["Your meal choice", "Guest's meal choice"]) {
      const qs = valueQuestions(r, label);
      expect(qs.map((q) => q.instructions.includes(`Label: '${label}'`))).toEqual([true, true]);
      expect(supportedOf(r, label)).toEqual(Array(2).fill(["Braised short rib (request)", "Braised short rib (unit)", "Herb-roasted salmon (request)", "Herb-roasted salmon (unit)", "Wild mushroom risotto (vegetarian) (request)", "Wild mushroom risotto (vegetarian) (unit)"]));
    }
    expect(proposedOf(r, r.outcome)).toMatchObject({ "Your meal choice": "Braised short rib", "Guest's meal choice": "Wild mushroom risotto (vegetarian)" });
  });

  it("each requested service names its box, and its tick is minted only by the verifier, against Chris's whole mail", async () => {
    const r = await runB31("b31-13", { values: true, firstPass: "oracle" });
    const verify = r.requests.filter((q) => q.purpose === "fill.verify");
    for (const label of ["Oil and filter change", "Tire rotation", "Brake inspection"]) {
      for (const q of valueQuestions(r, label)) expect(q.options.find((o) => isSupported(o) && fromUnit(o))?.criterion).toContain(`Caret proposes ticking the box '${label}' for judgment against its whole source text`);
      const asked = verify.flatMap((q) => Object.values(q.questions).map((x) => String(x.instructions))).filter((x) => x.includes(`Label: '${label}'`));
      expect(asked).toHaveLength(2);
      for (const x of asked) expect(x).toMatch(/Operation: tick this checkbox|Proposed operation: tick this checkbox/u);
      const mint = mintOf(fieldOf(r, label) as never) as CheckedValue;
      expect(mint.verdict.by).toBe("verifier");
      expect(mint.provenance).toMatchObject({ kind: "derived", how: "sourceSupported", base: { kind: "unit", nodeKey: null, title: expect.stringContaining(CHRIS) } });
    }
    const units = verify.map((q) => Object.values((q.state as { source_notes?: Record<string, string> }).source_notes ?? {}));
    for (const u of units) expect(u.some((t) => t.includes("we'd do the oil change, tire rotation and brake inspection. The cabin air filter is optional, your call."))).toBe(true);
  });

  it("2019 Outback: the year is a listed option judged against the mail, not a date part", async () => {
    const r = await runB31("b31-13", { values: true, firstPass: "oracle" });
    for (const q of valueQuestions(r, "Year")) {
      const y = q.options.find((o) => o.output === "2019" && fromUnit(o)) as Option;
      expect(noteOf(q.req, y)).toContain("For the 60,000-mile service on your 2019 Outback");
    }
    expect((mintOf(fieldOf(r, "Year") as never) as CheckedValue).provenance).toMatchObject({ how: "sourceSupported" });
  });

  it("text preference: the contact method rests on Ines's whole mail", async () => {
    const r = await runB31("b31-08", { values: true, firstPass: "oracle" });
    expect(valueQuestions(r, "How should we contact you?")).toHaveLength(2);
    for (const q of valueQuestions(r, "How should we contact you?")) {
      const t = q.options.find((o) => o.output === "Text message" && fromUnit(o)) as Option;
      expect(noteOf(q.req, t)).toContain("And you said you'd rather they text you than call, so pick text.");
    }
  });

  it("Tue/Thu: the section option quotes the whole request, its 'not sat' included", async () => {
    const r = await runB31("b31-22", { values: true, firstPass: "oracle" });
    for (const q of valueQuestions(r, "Section")) {
      const t = q.options.find((o) => o.output === TUE_THU && fromRequest(o)) as Option;
      expect(t.criterion).toContain(`Supporting text: the whole request, "${REQUEST_22}".`);
    }
    const asked = r.requests.filter((q) => q.purpose === "fill.verify").flatMap((q) => Object.values(q.questions).map((x) => String(x.instructions))).filter((x) => x.includes("Label: 'Section'"));
    expect(asked).toHaveLength(2);
    for (const x of asked) expect(x).toContain(`User request: "${REQUEST_22}"`);
  });
});

// Item 5: wrong role, a past preference, an optional service, an unrelated year and a lookalike section. Each wrong option is
// a candidate; both value answers forced to it with the verifier calling it other, a split, none, or a verifier that
// fails, write nothing.
const WRONG: readonly { name: string; ask: string; label: string; output: string; basis?: (o: Option) => boolean; o?: Overrides }[] = [
  { name: "Bea's vegetarian meal in Avery's own field", ask: "b31-12", label: "Your meal choice", output: "Wild mushroom risotto (vegetarian)" },
  { name: "a preference Ines says Theo no longer has", ask: "b31-08", label: "How should we contact you?", output: "Text message", o: { mapSnap: rewrite(INES, "And you said you'd rather they text you than call, so pick text.", "You used to prefer texts, but you said you'd rather they call now.") } },
  { name: "the optional cabin filter", ask: "b31-13", label: "Cabin air filter replacement", output: "checked", o: { raw: inScope("Cabin air filter replacement") } },
  { name: "2026, the year the mail was sent", ask: "b31-13", label: "Year", output: "2026" },
  { name: "the Saturday section the request rules out", ask: "b31-22", label: "Section", output: "Sat 9:00 AM-12:30 PM", basis: fromRequest },
];

describe("a wrong choice is never written", () => {
  for (const c of WRONG) {
    const basis = c.basis ?? fromUnit;
    it(`${c.name}: a candidate, and refused after a forced agreement`, async () => {
      const r = await runB31(c.ask, { ...c.o, values: true, firstPass: "oracle", value: forced(c.label, c.output, basis), verify: verdict(c.label, "other") });
      for (const q of valueQuestions(r, c.label)) expect(q.options.some((o) => o.output === c.output && basis(o)), "the wrong option is offered").toBe(true);
      const asked = r.requests.filter((q) => q.purpose === "fill.verify").flatMap((q) => Object.values(q.questions).map((x) => String(x.instructions))).filter((x) => x.includes(`'${c.label}'`) && x.includes(`"${c.output}"`));
      expect(asked, "the verifier is asked").toHaveLength(2);
      expect(proposedOf(r, r.outcome)[c.label]).toBeUndefined();
    });
    it(`${c.name}: a split, none, or an unavailable verifier write nothing`, async () => {
      const split: Overrides["value"] = (l, w, options) => (l === c.label ? (w === 0 ? forced(c.label, c.output, basis)?.(l, w, options, {} as JevRequest) : { choice: "none", confidence: 0.99 }) : undefined);
      const none: Overrides["value"] = (l) => (l === c.label ? { choice: "none", confidence: 0.99 } : undefined);
      for (const o of [{ value: split }, { value: none }, { value: forced(c.label, c.output, basis), verify: verdict(c.label, "unsure") }] as const) {
        const r = await runB31(c.ask, { ...c.o, values: true, firstPass: "oracle", ...o });
        expect(valueQuestions(r, c.label).flatMap((q) => q.options).some((x) => x.output === c.output && basis(x))).toBe(true);
        expect(proposedOf(r, r.outcome)[c.label]).toBeUndefined();
      }
    });
  }
});

describe("a month or day menu", () => {
  // Morgan's mail says only "Date of birth: 04/12/1990": April or December is the date's order, which no judgment may guess.
  it("gets no source-supported choice, even with Month asked and both judgments forced to April", async () => {
    const r = await runB31("b31-02", { values: true, firstPass: "oracle", value: forced("Month", "April"), verify: verdict("Month", "exact") });
    const t = r.traces.find((x) => x.fields.some((f) => r.labelOf.get(f.key) === "Month"));
    expect(t, "Month is asked").toBeDefined();
    expect([...(t?.options.values() ?? [])].some((o) => o.from === "choice")).toBe(false);
    expect(proposedOf(r, r.outcome).Month).toBeUndefined();
  });
});

describe("a settlement provider that fails", () => {
  it("leaves the choices blank and keeps the base's own values", async () => {
    const r = await runB31("b31-13", { values: true, firstPass: "oracle", fail: (req) => (req.state as { task?: string }).task === VALUE_TASK });
    expect(r.requests.some((q) => (q.state as { task?: string }).task === VALUE_TASK && Object.values(q.questions).some((x) => String(x.instructions).includes("Label: 'Year'")))).toBe(true);
    const got = proposedOf(r, r.outcome);
    for (const label of ["Year", "Oil and filter change", "Tire rotation", "Brake inspection"]) expect(got[label], label).toBeUndefined();
    expect(got["Full name"]).toBe("Jamie Torres");
  });
});

// Item 6: the judgments forced to approve, where a deterministic veto applies.
describe("a deterministic veto holds whatever the judgments say", () => {
  it("ownership: State is the patient's address part, and a choice has no owner judgement, so none is offered", async () => {
    const r = await runB31("b31-08", { values: true, firstPass: "oracle", value: forced("State", "MA"), verify: verdict("State", "exact") });
    const t = r.traces.find((x) => x.fields.some((f) => r.labelOf.get(f.key) === "State"));
    const fid = t?.fields.find((f) => r.labelOf.get(f.key) === "State")?.id ?? "";
    const vetoes = [...(t?.vetoed?.get(fid) ?? [])].filter(([id]) => t?.options.get(id)?.from === "choice");
    expect(vetoes.length, "State's choices were built, then vetoed").toBeGreaterThan(0);
    expect(new Set(vetoes.map(([, v]) => v))).toEqual(new Set(["otherPerson"]));
    expect(proposedOf(r, r.outcome).State).toBeUndefined();
  });

  it("scope: a choice field the Ask did not scope is never asked about", async () => {
    const r = await runB31("b31-08", { values: true, firstPass: "oracle", value: forced("Preferred language", "English") });
    expect(supportedOf(r, "How should we contact you?")[0]?.length, "the scoped choice field is enumerated").toBe(6);
    expect(valueQuestions(r, "Preferred language")).toEqual([]);
    expect(proposedOf(r, r.outcome)["Preferred language"]).toBeUndefined();
  });

  it("consent: a sign-up or a privacy notice box gets no tick to judge, even in scope", async () => {
    const boxes = ["I have read the Notice of Privacy Practices.", "Sign me up for the Harbor Health newsletter."];
    const r = await runB31("b31-08", { values: true, firstPass: "oracle", raw: inScope(...boxes), value: (l, w, options) => (boxes.includes(l) ? forced(l, "checked")?.(l, w, options, {} as JevRequest) : undefined), verify: () => ({ choice: "exact", confidence: 0.99 }) });
    expect(supportedOf(r, "How should we contact you?")[0]?.length, "the scoped choice field is enumerated").toBe(6);
    for (const b of boxes) {
      expect(valueQuestions(r, b)).toEqual([]);
      expect(proposedOf(r, r.outcome)[b]).toBeUndefined();
    }
    const r2 = await runB31("b31-12", { values: true, firstPass: "oracle", raw: inScope("Text me updates about the day") });
    expect(valueQuestions(r2, "Text me updates about the day")).toEqual([]);
  });

  it("privacy: a mail with a line redaction removed is no unit to judge against", async () => {
    const o = { mapSnap: rewrite(INES, "Preferred language: English for both of us.", "Preferred language: English for both of us. The portal password is violet-orchard-seven.") } as const;
    const r = await runB31("b31-08", { ...o, values: true, firstPass: "oracle", value: forced("How should we contact you?", "Text message"), verify: verdict("How should we contact you?", "exact") });
    expect(unitHolding(r, INES, "pick text")?.complete).toBe(false);
    expect(supportedOf(r, "How should we contact you?")[0], "only the request is left to judge against").toEqual(["Email (request)", "Phone call (request)", "Text message (request)"]);
    expect(proposedOf(r, r.outcome)["How should we contact you?"]).toBeUndefined();
  });
});

// Item 7: a unit that does not fit, and a change between judgment and dispatch.
describe("missing or changed evidence", () => {
  it("a mail too long to send whole gives no unit-based choice", async () => {
    const long = `${"We can also talk about parking and the lobby hours another time. ".repeat(24)}And you said you'd rather they text you than call, so pick text.`;
    const r = await runB31("b31-08", { values: true, firstPass: "oracle", mapSnap: rewrite(INES, "And you said you'd rather they text you than call, so pick text.", long), value: forced("How should we contact you?", "Text message"), verify: verdict("How should we contact you?", "exact") });
    const t = r.traces.find((x) => x.fields.some((f) => r.labelOf.get(f.key) === "How should we contact you?"));
    const fid = t?.fields.find((f) => r.labelOf.get(f.key) === "How should we contact you?")?.id ?? "";
    const unshown = [...(t?.vetoed?.get(fid) ?? [])].filter(([id, v]) => t?.options.get(id)?.from === "choice" && v === "notSendable");
    expect(unshown.length, "the unit's choices were built and withheld").toBe(3);
    expect(supportedOf(r, "How should we contact you?")[0], "only the request is left to judge against").toEqual(["Email (request)", "Phone call (request)", "Text message (request)"]);
    expect(proposedOf(r, r.outcome)["How should we contact you?"]).toBeUndefined();
  });

  it("after the judgment, a changed signature, a changed option label or a changed field refuses the write at dispatch", async () => {
    const r = await runB31("b31-13", { values: true, firstPass: "oracle" });
    const f = fieldOf(r, "Year");
    const mint = mintOf(f as never) as CheckedValue;
    expect(isChecked(mint) && mint.text).toBe("2019");
    const form = r.desk.form;
    const node = form.nodes.get(mint.field.key);
    if (node === undefined) throw new Error("no Year control");
    const guard = (): string | null => guardFor(() => r.desk.model, new Map([[0, mint]]), mint.authority, null, null)(0, "2019", { windowId: form.window.windowId, node: r.desk.model.windows.get(form.window.windowId)?.nodes.get(node.key) ?? node, window: r.desk.model.windows.get(form.window.windowId) });
    expect(guard()).toBeNull();
    const mail = snaps.find((s) => s.window.title.startsWith(CHRIS)) as Snapshot;
    const edited = rewrite(CHRIS, "1450 Foothills Pkwy, Golden, CO 80401", "1450 Foothills Pkwy, Golden, CO 80401 (this booking is for my brother's car)")(mail);
    r.desk.model.apply({ ...edited, at: T0 + 1_000, focused: false, focusedKey: null });
    expect(provenanceStale(r.desk.model, mint.provenance)).toBe("the text it was judged against changed");
    expect(guard()).toMatch(/the text it was judged against changed/u);
    r.desk.model.apply({ ...mail, at: T0 + 2_000, focused: false, focusedKey: null });
    expect(guard()).toBeNull();
    r.desk.model.apply({ ...mail, window: { ...mail.window, title: `${mail.window.title} (forwarded to my brother)` }, at: T0 + 2_500, focused: false, focusedKey: null });
    expect(guard(), "a changed title").toMatch(/the text it was judged against changed/u);
    r.desk.model.apply({ ...mail, at: T0 + 2_700, focused: false, focusedKey: null });
    expect(guard()).toBeNull();
    const page = pageForm(corpus.forms.find((x) => x.id === "car-service-booking") as never);
    const relabel = (from: string, to: string): Snapshot => ({ ...page, nodes: page.nodes.map((n) => (n.parent === node.key && n.label === from ? { ...n, label: to } : n.key === node.key && n.label?.startsWith(from) === true ? { ...n, label: to } : n)) });
    r.desk.model.apply({ ...relabel("2019", "2019 (sold out)"), at: T0 + 3_000, focused: true, focusedKey: null });
    expect(guard()).toMatch(/changed since Caret asked about it/u);
    r.desk.model.apply({ ...relabel("Year", "Model year of the loaner"), at: T0 + 4_000, focused: true, focusedKey: null });
    expect(guard()).not.toBeNull();
  });
});

// Item 8: ids, grouping, the fresh pair after a pick, and consumers that cannot carry a choice.
describe("identity and obligations through remapping, grouping and picks", () => {
  it("the second wording lists the same options, bases and units under its own ids", async () => {
    const r = await runB31("b31-13", { values: true, firstPass: "oracle" });
    const [a, b] = valueQuestions(r, "Year");
    const supported = (q: typeof a) => (q?.options ?? []).filter(isSupported);
    expect(supported(a).map((o) => o.criterion).sort()).toEqual(supported(b).map((o) => o.criterion).sort());
    expect(supported(a).every((o) => /^d\d+$/u.test(o.id)) && supported(b).every((o) => /^e\d+$/u.test(o.id))).toBe(true);
    expect(supported(a).length).toBe(24);
  });

  it("a choice never merges with a literal option of the same output and unit, and keeps the verifier's obligation", () => {
    const member = (id: string, assumptions: string[], verifier: boolean): OptionMember => ({ id, output: "2", evidence: "mail\u0000*", origin: "window", label: null, owner: null, assumptions, verifier });
    const g = groupOptions([member("c8", [], false), member("d7", ["Caret proposes the listed option '2' for judgment against its whole source text; code did not check that it names it"], true)]);
    expect(g.map((o) => [o.id, o.verifier])).toEqual([["c8", false], ["d7", true]]);
  });

  const LABEL = "How should we contact you?";
  const split: Overrides["value"] = (l, w, options, req) => {
    if (l !== LABEL) return undefined;
    if (/Explicit user selections: (?!none)/u.test(String(Object.values(req.questions).find((q) => String(q.instructions).includes(LABEL))?.instructions))) return undefined;
    return w === 0 ? (forced(LABEL, "Text message")?.(l, w, options, req) as Answer) : { choice: "none", confidence: 0.99 };
  };
  async function pickRun(pick: string, fresh: Overrides["value"], verify: Overrides["verify"]): Promise<{ r: Run; after: Record<string, string> }> {
    const r = await runB31("b31-08", { values: true, firstPass: "oracle", value: (l, w, o, req) => split?.(l, w, o, req) ?? fresh?.(l, w, o, req), verify });
    const q = await valueQuestionFor(r, LABEL);
    expect(q, "a value question about the contact method").not.toBeNull();
    const rows = (q as NonNullable<typeof q>).options;
    expect(rows.filter((o) => o.option.kind === "value").map((o) => (o.option.kind === "value" ? `${o.option.value} | ${o.option.source}` : ""))).toEqual(expect.arrayContaining([`Text message | ${INES} - Google Chrome: the whole text`, "Text message | Your request", `Phone call | ${INES} - Google Chrome: the whole text`]));
    const row = pick === "blank" ? rows.find((o) => o.option.kind === "blank") : rows.find((o) => o.option.kind === "value" && o.option.value === pick && o.option.source.endsWith(": the whole text"));
    const resume = answerQuestion(q as NonNullable<typeof q>, [row?.option.id ?? ""]);
    if (typeof resume === "string") throw new Error(resume);
    return { r, after: proposedOf(r, await r.resume(resume)) };
  }

  it("a pick buys one fresh pair, then the verifier; its 'other' leaves the field blank", async () => {
    const fresh: Overrides["value"] = (l, w, o) => (l === LABEL ? forced(LABEL, "Text message")?.(l, w, o, {} as JevRequest) : undefined);
    const { r, after } = await pickRun("Text message", fresh, verdict(LABEL, "other"));
    expect(r.requests.filter((x) => x.purpose === "fill.values" && String(Object.values(x.questions)[0]?.instructions).includes("Explicit user selections: the value"))).toHaveLength(2);
    expect(r.requests.filter((x) => x.purpose === "fill.verify" && Object.values(x.questions).some((q) => String(q.instructions).includes(`'${LABEL}'`)))).toHaveLength(2);
    expect(after[LABEL]).toBeUndefined();
  });

  it("the same pick with an exact verdict proposes it; a hostile pick of Phone call refused by the verifier does not", async () => {
    const fresh = (out: string): Overrides["value"] => (l, w, o) => (l === LABEL ? forced(LABEL, out)?.(l, w, o, {} as JevRequest) : undefined);
    expect((await pickRun("Text message", fresh("Text message"), verdict(LABEL, "exact"))).after[LABEL]).toBe("Text message");
    expect((await pickRun("Phone call", fresh("Phone call"), verdict(LABEL, "other"))).after[LABEL]).toBeUndefined();
    expect((await pickRun("blank", fresh("Text message"), verdict(LABEL, "exact"))).after[LABEL]).toBeUndefined();
  });

  it("no exemption mints a choice, and a Fill all leaves a unit-based choice to the user", async () => {
    const r = await runB31("b31-13", { values: true, firstPass: "oracle" });
    const d = draftOf(r);
    const f = fieldOf(r, "Year");
    const mint = mintOf(f as never) as CheckedValue;
    expect(() => mintExempt(mint, "optionLabel", T0, "", mint.authority)).toThrow(ContractError);
    const written = writtenFields(d.fill as NonNullable<AskDraft["fill"]>);
    expect(written.fields.map((x) => x.key)).not.toContain(f?.key);
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
