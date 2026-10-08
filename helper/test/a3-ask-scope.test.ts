// A3: Jev decides which fields an Ask means (planner/intent-heads.ts); code only vetoes. The property every test here
// holds: no code path puts a field in scope that Jev did not answer "asks" for in both wordings at SCOPE_CUTOFF, and any
// "unclear" asks the user. Tested alone on readHeads and checkIntent, then through planAsk, on the real-form corpus's
// replayed desks. The instructions are written for these tests, not taken from the held-out Ask sets.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { Snapshot } from "../src/protocol.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { checkIntent, intentSnapshot, type IntentSnapshot } from "../src/planner/intent.ts";
import { headsIntentMaker, headsRequest, readHeads, SCOPE_CUTOFF, SCOPE_OPTIONS, SECTION_QUESTION, scopeId, scopeRequest } from "../src/planner/intent-heads.ts";
import { AskAsks, AskRefused, planAsk } from "../src/planner/ask.ts";
import { SAYS } from "../src/planner/says.ts";
import { PlannerError } from "../src/planner/validate.ts";
import type { MemoryValue } from "../src/planner/trace.ts";
import { buildDesk, loadCorpus, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { rng } from "./large-scene.ts";
import { field, node, scopeLabel, snap, optionIs } from "./builders.ts";

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const deskOf = (form: string): Desk => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === form) ?? (() => { throw new Error(`no form ${form}`); })());
const snapOn = (form: string, instruction: string, memory: readonly MemoryValue[] = []): IntentSnapshot => {
  const d = deskOf(form);
  return intentSnapshot(instruction, d.model, d.form, [...d.memory, ...memory]);
};

type A = { choice: string; confidence: number };
/** One wording's answer per field: by field name, "asks" at 0.99 for the names in `asks`, else "not" at 0.99. */
/** SCP1: on a form that shows headings, the section question too, answered "fields" (no one section), so no field is vetoed. */
const wording = (s: IntentSnapshot, by: (name: string) => A): JevResult => ({ model: "jev-test", answers: { ...Object.fromEntries(s.fields.map((f) => [scopeId(f.ref), by(f.name)])), ...(s.headings.length === 0 ? {} : { [SECTION_QUESTION]: { choice: "fields", confidence: 0.99 } }) }, inputTokens: 10, latencyMs: 1, costUsd: 0 });
const scopeOf = (s: IntentSnapshot, asks: readonly string[], second: (name: string) => A | undefined = () => undefined): [JevResult, JevResult] => {
  const first = (n: string): A => ({ choice: asks.includes(n) ? "asks" : "not", confidence: 0.99 });
  return [wording(s, first), wording(s, (n) => second(n) ?? first(n))];
};
/** The heads answered at 0.9: route some (a fill of particular fields), source any, whose user, unless `heads` says otherwise. */
const headsOf = (s: IntentSnapshot, heads: Record<string, string> = {}): JevResult => {
  const req = headsRequest(s);
  const dflt: Record<string, string> = { route: "some", why: "nothingToFill", source: "any", whose: "user" };
  return { model: "jev-test", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: heads[id] ?? dflt[id] ?? "none", confidence: 0.9 }])), inputTokens: 10, latencyMs: 1, costUsd: 0 };
};
const names = (s: IntentSnapshot, refs: readonly string[] | undefined): string[] => (refs ?? []).map((r) => s.fields.find((f) => f.ref === r)?.name ?? r);

describe("the scope ask's requests", () => {
  it("asks one categorical question per field in each of two wordings, with asks, not and unclear", () => {
    const s = snapOn("clinic-intake", "use Ines for the emergency contact");
    for (const w of [0, 1] as const) {
      const req = scopeRequest(s, w);
      // SCP1: and the section question, since the form shows headings.
      expect(Object.keys(req.questions)).toEqual([...s.fields.map((f) => scopeId(f.ref)), SECTION_QUESTION]);
      for (const f of s.fields) expect(req.questions[scopeId(f.ref)]?.criteria).toEqual(SCOPE_OPTIONS);
    }
    expect(scopeRequest(s, 0).questions[scopeId(s.fields[0]?.ref ?? "")]?.instructions).not.toBe(scopeRequest(s, 1).questions[scopeId(s.fields[0]?.ref ?? "")]?.instructions);
    // The heads ask no field question any more.
    expect(Object.keys(headsRequest(s).questions).sort()).toEqual(["route", "source", "whose", "why"]);
    expect(headsRequest(s).nouls).toBeUndefined();
  });

  it("shows each field's label, kind and section path, and its section's fields (A2: the phone under EMERGENCY CONTACT was shown bare)", () => {
    const s = snapOn("clinic-intake", "use Ines for the emergency contact");
    const phone = s.fields.find((f) => f.name === "Emergency contact phone");
    if (phone === undefined) throw new Error("no phone");
    for (const w of [0, 1] as const) {
      const req = scopeRequest(s, w);
      const text = String(req.questions[scopeId(phone.ref)]?.instructions);
      for (const part of ['Field: "Emergency contact phone"', 'Control: "text field"', 'Section/group path: "EMERGENCY CONTACT"', '"use Ines for the emergency contact"']) expect(text, `wording ${w}`).toContain(part);
      const outline = (req.state as unknown as { form: { sections: { path: string; fields: string[] }[] } }).form;
      expect(outline.sections.find((x) => x.path === "EMERGENCY CONTACT")?.fields).toEqual(expect.arrayContaining(["Relationship to patient", "Emergency contact phone"]));
    }
    // A group's label is part of the path.
    const d = snapOn("airline-passenger", "my birthday");
    const month = d.fields.find((f) => f.name === "Month");
    expect(String(scopeRequest(d, 0).questions[scopeId(month?.ref ?? "")]?.instructions)).toMatch(/Control: "pop-up menu"\. Section\/group path: "[^"]*Date of birth"/u);
  });

  it("declares every piece of screen text a scope request sends, a heading with quotes included (A3 review 2)", () => {
    const m = deskOf("hubspot-contact").model;
    m.apply(snap([node("pg/h", "AXHeading", { label: 'Applicant "primary" \\ one' }), field("pg/email", "", { label: "Email" })], { at: T0 + 1000, windowId: "page:a3:4", kind: "page", focused: true }));
    const w = m.windows.get("page:a3:4");
    if (w === undefined) throw new Error("no page");
    const s = intentSnapshot("my email", m, w, []);
    expect(s.fields[0]?.heading).toBe('Applicant "primary" \\ one');
    for (const wd of [0, 1] as const) expect(scopeRequest(s, wd).snippets.map((x) => x.text)).toEqual(expect.arrayContaining(['Applicant "primary" \\ one', "Email"]));
  });

  it("sends the heads and both wordings together, three requests", async () => {
    const s = snapOn("conference-registration", "my name and email please");
    const seen: JevRequest[] = [];
    const ask: AskJev = async (req) => {
      seen.push(req);
      if ("route" in req.questions) return headsOf(s);
      return wording(s, (n) => ({ choice: ["First name", "Last name", "Email address"].includes(n) ? "asks" : "not", confidence: 0.99 }));
    };
    const r = await headsIntentMaker(ask).make(s);
    expect(seen).toHaveLength(3);
    expect(r.use).toMatchObject({ maker: "heads", calls: 3 });
    expect(names(s, r.intent.fields)).toEqual(["First name", "Last name", "Email address"]);
    expect(r.intent).toMatchObject({ route: "fill", scope: "list", agreed: true });
  });

  it("fails loudly on a missing or unknown scope answer", () => {
    const s = snapOn("hubspot-contact", "my email");
    const [a, b] = scopeOf(s, ["Email"]);
    const { [scopeId("f1")]: _, ...rest } = b.answers;
    expect(() => readHeads(s, headsOf(s), [a, { ...b, answers: rest }])).toThrow(PlannerError);
    expect(() => readHeads(s, headsOf(s), [a, { ...b, answers: { ...b.answers, [scopeId("f1")]: { choice: "maybe", confidence: 0.9 } } }])).toThrow(/not a scope option/u);
  });
});

describe("which fields: Jev's, never code's", () => {
  it("puts a field in scope only when both wordings answer asks at the cutoff", () => {
    const s = snapOn("conference-registration", "my name and email please");
    const both = ["First name", "Last name", "Email address"];
    expect(names(s, readHeads(s, headsOf(s), scopeOf(s, both)).fields)).toEqual(both);
    // One wording under the cutoff, or saying not: that field is out of scope, and only offered to the user (G35).
    const low = readHeads(s, headsOf(s), scopeOf(s, both, (n) => (n === "Last name" ? { choice: "asks", confidence: SCOPE_CUTOFF - 0.01 } : undefined)));
    expect(low).toMatchObject({ route: "ask", fields: [] });
    expect(names(s, low.sure)).toEqual(["First name", "Email address"]);
    expect(names(s, low.options)).toEqual(["Last name"]);
    const at = readHeads(s, headsOf(s), scopeOf(s, both, (n) => (n === "Last name" ? { choice: "asks", confidence: SCOPE_CUTOFF } : undefined)));
    expect(names(s, at.fields)).toEqual(both);
    const no = readHeads(s, headsOf(s), scopeOf(s, both, (n) => (n === "Email address" ? { choice: "not", confidence: 0.3 } : undefined)));
    expect(names(s, no.sure)).toEqual(["First name", "Last name"]);
    expect(names(s, no.options)).toEqual(["Email address"]);
  });

  // I3 lead ruling: the chosen fields are kept beside the question (`sure`), which offers only the unclear ones.
  it("asks which fields on any unclear, offering the unclear fields beside the chosen ones, whatever the confidence", () => {
    const s = snapOn("clinic-intake", "use Ines for the emergency contact");
    const i = readHeads(s, headsOf(s), scopeOf(s, ["Emergency contact name"], (n) => (n === "Emergency contact phone" ? { choice: "unclear", confidence: 0.02 } : undefined)));
    expect(i).toMatchObject({ route: "ask", why: "whichFields", open: ["fields"] });
    expect(names(s, i.options ?? [])).toEqual(["Emergency contact phone"]);
    expect(names(s, i.sure ?? [])).toEqual(["Emergency contact name"]);
    expect(i.agreed).toBeUndefined();
  });

  it("asks with the fields either wording voted for when none is settled, and refuses when every field is not", () => {
    const s = snapOn("clinic-intake", "use Ines for the emergency contact");
    const split = readHeads(s, headsOf(s), scopeOf(s, ["Emergency contact name"], (n) => (n === "Emergency contact name" ? { choice: "not", confidence: 0.6 } : undefined)));
    expect(split).toMatchObject({ route: "ask", open: ["fields"] });
    expect(names(s, split.options ?? [])).toEqual(["Emergency contact name"]);
    expect(readHeads(s, headsOf(s), scopeOf(s, []))).toMatchObject({ route: "refuse", why: "noSuchField" });
    // With the route unsettled, nothing is claimed about the form: which fields?
    const low = { ...headsOf(s), answers: { ...headsOf(s).answers, route: { choice: "some", confidence: 0.5 } } };
    expect(readHeads(s, low, scopeOf(s, []))).toMatchObject({ route: "ask", why: "whichFields", options: [] });
  });

  it("lists every empty field chosen, never the whole form, and asks their values as Fill all does only on a whole-form route", () => {
    const s = snapOn("hubspot-contact", "fill out this contact form");
    // Every field chosen alone is not a request that narrows nothing (A3 review 2: "use my work email" on a form whose
    // one email field is every empty field must keep its words in the value question).
    expect(readHeads(s, headsOf(s), scopeOf(s, s.fields.map((f) => f.name))).wholeForm).toBeUndefined();
    const i = readHeads(s, headsOf(s, { route: "all" }), scopeOf(s, s.fields.map((f) => f.name)));
    expect(i).toMatchObject({ route: "fill", scope: "list", fields: s.fields.map((f) => f.ref), agreed: true, wholeForm: true });
    const checked = checkIntent(i, s);
    expect(checked.route === "fill" && checked.scope.wholeForm).toBe(true);
    expect(checked.route === "fill" && checkIntent(i, s, { fields: [s.fields[0]?.key ?? ""] }).route === "fill").toBe(true);
  });

  it("still plans or refuses on a settled route head, and lets the fields decide under its floor", () => {
    const s = snapOn("job-application", "submit it for me");
    expect(readHeads(s, headsOf(s, { route: "plan" }), scopeOf(s, []))).toMatchObject({ route: "plan" });
    expect(readHeads(s, headsOf(s, { route: "refuse", why: "pressOrSend" }), scopeOf(s, []))).toMatchObject({ route: "refuse", why: "pressOrSend" });
    const low = headsOf(s, { route: "plan" });
    low.answers.route = { choice: "plan", confidence: 0.4 };
    expect(names(s, readHeads(s, low, scopeOf(s, ["Email ✱"])).fields)).toEqual(["Email ✱"]);
  });

  // The design property, on random answers over every corpus form: no field reaches the fill's scope unless both wordings
  // answered "asks" at the cutoff, and an "unclear" never reaches a fill.
  it("never adds a field Jev did not choose, and never fills past an unclear (random answers, every corpus form)", () => {
    const r = rng(31);
    const choices = ["asks", "not", "unclear"];
    const instructions = ["fill out the whole form", "my name and email", "use Gary for the landlord part", "set the priority to high", "do everything but the phone"];
    let fills = 0;
    let asks = 0;
    for (const form of corpus.forms) {
      for (let n = 0; n < 40; n++) {
        const s = snapOn(form.id, instructions[n % instructions.length] as string);
        const pick = (): A => ({ choice: choices[Math.floor(r() * (r() < 0.1 ? 3 : 2))] as string, confidence: r() });
        const scope: [JevResult, JevResult] = [wording(s, pick), wording(s, pick)];
        const chosen = new Set(s.fields.filter((f) => scope.every((x) => x.answers[scopeId(f.ref)]?.choice === "asks" && (x.answers[scopeId(f.ref)]?.confidence ?? 0) >= SCOPE_CUTOFF)).map((f) => f.key));
        const unclear = s.fields.some((f) => scope.some((x) => x.answers[scopeId(f.ref)]?.choice === "unclear"));
        const i = readHeads(s, headsOf(s, n % 7 === 0 ? { route: "plan" } : {}), scope);
        // Never the whole form: a page goal's "all" would take inputs past the snapshot (A3 review 1).
        expect(i.scope).not.toBe("all");
        // I3 lead ruling: an unclear field is asked about, or, beside chosen ones, too many to ask about, left to the user.
        const unsure = new Set(i.unsure ?? []);
        if (unclear) expect(i.route === "ask" || (i.route === "plan" && i.options !== undefined) || s.fields.every((f) => !scope.some((x) => x.answers[scopeId(f.ref)]?.choice === "unclear") || unsure.has(f.ref)), form.id).toBe(true);
        for (const ref of i.unsure ?? []) expect(i.fields.includes(ref), `${form.id}: unsure ${ref} in scope`).toBe(false);
        if (i.route === "plan") expect(i.agreed === true ? i.fields.every((ref) => chosen.has(s.fields.find((f) => f.ref === ref)?.key ?? "")) : i.fields.length === 0).toBe(true);
        if (i.route !== "fill") {
          asks++;
          continue;
        }
        fills++;
        let checked: ReturnType<typeof checkIntent>;
        try {
          checked = checkIntent(i, s);
        } catch (e) {
          // A veto (only never-typed fields in scope, say) refuses; it never widens.
          expect(e).toBeInstanceOf(PlannerError);
          continue;
        }
        if (checked.route !== "fill") throw new Error("a fill intent checked as a plan");
        for (const f of [...checked.fields, ...checked.leftToYou]) expect(chosen.has(f.key), `${form.id}: ${f.name}`).toBe(true);
        for (const k of checked.scope.literals.keys()) expect(chosen.has(k)).toBe(true);
      }
    }
    expect(fills).toBeGreaterThan(50);
    expect(asks).toBeGreaterThan(50);
  });
});

describe("the vetoes", () => {
  it("never types a kind Caret never types, even when Jev asks for it", () => {
    const s = snapOn("rental-application", "put my social security number in");
    const i = readHeads(s, headsOf(s), scopeOf(s, ["Social Security number"]));
    expect(i.route).toBe("fill");
    expect(() => checkIntent(i, s)).toThrow("Caret doesn't type Social Security numbers. Type it yourself.");
  });

  it("asks which person when the instruction names two: one person per Ask", () => {
    const s = snapOn("event-rsvp", "fill out the RSVP for Jun or Bea");
    expect(readHeads(s, headsOf(s), scopeOf(s, s.fields.map((f) => f.name)))).toMatchObject({ route: "ask", open: ["person"] });
  });

  it("ties a spelled-out value only to a field Jev chose, and only as an exact span of the instruction", () => {
    const s = snapOn("httpbin-pizza", "actually make the delivery 8:15 instead");
    const time = s.fields.find((f) => f.name === "Preferred delivery time")?.ref;
    expect(readHeads(s, headsOf(s), scopeOf(s, ["Preferred delivery time"])).literals).toEqual([{ field: time, text: "8:15" }]);
    // The clause names a field Jev did not choose better than the one it chose: the value is tied to nothing, and the
    // field it names stays out.
    const r = snapOn("rental-application", "set the landlord phone to 512-555-0193");
    const other = readHeads(r, headsOf(r), scopeOf(r, ["Mobile phone"]));
    expect(other.literals).toEqual([]);
    expect(names(r, other.fields)).toEqual(["Mobile phone"]);
    // A clause that names no field: a time ties to the one time field in scope (A3 review 2).
    const c = snapOn("car-service-booking", "saturday works, at 9:30");
    expect(readHeads(c, headsOf(c), scopeOf(c, ["Preferred date", "Preferred time"])).literals).toEqual([{ field: c.fields.find((f) => f.name === "Preferred time")?.ref, text: "9:30" }]);
    // A literal that is not a span of the instruction is refused by checkIntent.
    expect(() => checkIntent({ ...readHeads(s, headsOf(s), scopeOf(s, ["Preferred delivery time"])), literals: [{ field: time ?? "", text: "9:15" }] }, s)).toThrow(PlannerError);
  });

  it("reads only the windows the instruction names, whatever source Jev chose", () => {
    const s = snapOn("rental-application", "fill in everything from my rental notes");
    const notes = s.windows.find((w) => w.title === "Rental notes.txt")?.ref;
    const other = s.windows.find((w) => w.ref !== notes)?.ref ?? "memory";
    const i = readHeads(s, headsOf(s, { source: other }), scopeOf(s, s.fields.map((f) => f.name)));
    expect(i.sources).toEqual([notes]);
  });
});

describe("whose details (people.ts)", () => {
  const whose = (form: string, instruction: string, asks: readonly string[], memory: readonly MemoryValue[] = []) => {
    const s = snapOn(form, instruction, memory);
    return readHeads(s, headsOf(s), scopeOf(s, asks));
  };

  it("is the person the instruction names, beside a relation that only says who they are", () => {
    expect(whose("rental-application", "use Gary's info for the landlord part", ["Landlord or property manager name", "Landlord phone"])).toMatchObject({ route: "fill", whose: "p1" });
  });

  it("is each field's own when the user is named beside someone", () => {
    expect(whose("event-rsvp", "RSVP for me and Bea, everything's in her email", ["Your full name", "Guest's full name"])).toMatchObject({ route: "fill", whose: "user" });
  });

  it("is the memory entry for a relation, when exactly one has it", () => {
    const wife: MemoryValue = { id: "people-1", label: "my wife", text: "Ines Lindqvist", whose: "other" };
    expect(whose("clinic-intake", "put my wife down as the emergency contact", ["Emergency contact name"], [wife])).toMatchObject({ route: "fill", person: "Ines Lindqvist" });
  });

  it("is the user's own for 'my' with a person named only as the source", () => {
    expect(whose("clinic-intake", "put my date of birth in, from Ines's email", ["Date of birth"])).toMatchObject({ route: "fill", whose: "user" });
  });

  it("asks for a pronoun when the instruction's sources hold more than one other person", () => {
    const d = deskOf("rental-application");
    d.model.apply(snap([field("te/old", "Landlord: Gary Pruitt\n(512) 555-0193", { role: "AXTextArea" })], { at: T0 - 35_000, windowId: "old-note", title: "Old lease.txt", app: { pid: 7999, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: false }));
    const form = d.model.windows.get(d.form.window.windowId);
    if (form === undefined) throw new Error("form window gone");
    const s = intentSnapshot("add his phone", d.model, form, d.memory);
    expect(readHeads(s, headsOf(s), scopeOf(s, ["Landlord phone"]))).toMatchObject({ route: "ask", open: ["person"] });
  });
});

describe("through planAsk", () => {
  /** A stand-in Jev: heads at 0.9, the scope ask by `asks` (or `unclear`), value questions by `values`, owners "user". */
  const jevFor = (asks: readonly string[], values: Record<string, string> = {}, unclear: readonly string[] = []) => {
    const seen: JevRequest[] = [];
    const ask: AskJev = async (req) => {
      seen.push(req);
      const answers = Object.fromEntries(
        Object.entries(req.questions).map(([id, q]) => {
          const ins = String(q.instructions);
          if (id === "route") return [id, { choice: "some", confidence: 0.9 }];
          if (id === "source") return [id, { choice: "any", confidence: 0.9 }];
          // Ines's values are hers, and an emergency contact field wants someone else's; the rest is the user's.
          if (id.endsWith("_owner") && "person" in q.criteria && /Ines/u.test(ins)) return [id, { choice: "person", confidence: 0.9 }];
          if (id.endsWith("_whose") && "other" in q.criteria && /Emergency/u.test(ins)) return [id, { choice: "other", confidence: 0.9 }];
          if (id === "whose" || id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user" in q.criteria ? "user" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 }];
          if (id === SECTION_QUESTION) return [id, { choice: "fields", confidence: 0.99 }];
          if (id.startsWith("s_")) {
            const label = scopeLabel(ins);
            return [id, { choice: unclear.includes(label) ? "unclear" : asks.includes(label) ? "asks" : "not", confidence: 0.99 }];
          }
          if ("yes" in q.criteria) return [id, { choice: "yes", confidence: 0.9 }];
          const want = Object.entries(values).find(([label]) => ins.includes(`'${label}'`))?.[1];
          const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => optionIs(d, want));
          return [id, { choice: hit?.[0] ?? "none", confidence: 0.9 }];
        }),
      );
      return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
    };
    return { ask, seen, confirms: () => seen.filter((r) => Object.values(r.questions).some((q) => "yes" in q.criteria)).length };
  };
  const run = (form: string, instruction: string, jev: ReturnType<typeof jevFor>, resume?: Parameters<typeof planAsk>[4]["resume"]) => {
    const d = deskOf(form);
    return planAsk(instruction, d.model, { values: () => d.memory }, d.about, { askJev: jev.ask, maker: headsIntentMaker(jev.ask), writer: null, offerKey: "a3", windowId: d.form.window.windowId, now: 2000, ...(resume === undefined ? {} : { resume }) });
  };

  it("fills the fields Jev chose with no further confirmation", async () => {
    const jev = jevFor(["First name", "Last name", "Email address"], { "First name": "Kenji", "Last name": "Watanabe", "Email address": "kenji.watanabe@example.net" });
    const draft = await run("conference-registration", "my name and email please", jev);
    expect(draft.checked.writes.map((w) => w.value)).toEqual(["Kenji", "Watanabe", "kenji.watanabe@example.net"]);
    expect(draft.intent).toMatchObject({ route: "fill", scope: "list", agreed: true });
    expect(jev.confirms()).toBe(0);
  });

  // I3 lead ruling: the field Jev chose is filled whatever the pick; the question offers only the unclear ones.
  it("asks on unclear with exactly Jev's unclear fields offered, and a pick adds to the chosen one", async () => {
    const jev = jevFor(["Emergency contact name"], { "Emergency contact name": "Ines Lindqvist" }, ["Relationship to patient", "Emergency contact phone"]);
    const e = await run("clinic-intake", "use Ines for the emergency contact", jev).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    expect(q.part).toBe("fields");
    expect(q.options.map((c) => (c.option.kind === "field" ? c.option.label : c.option.kind))).toEqual(["Relationship to patient", "Emergency contact phone"]);
    const relation = q.options[0];
    if (relation === undefined) throw new Error("no option");
    const after = await run("clinic-intake", "use Ines for the emergency contact", jev, { ...q.resume, fixed: { ...q.resume.fixed, ...relation.fixes } });
    // Only the name has a value in this stand-in: the picked relationship is asked and finds none.
    expect(after.checked.writes.map((w) => w.value)).toEqual(["Ines Lindqvist"]);
  });

  it("fills only Jev's fields, or asks, when a page host fills a plan's form (A3 review 1)", async () => {
    const m = deskOf("hubspot-contact").model;
    m.apply(snap([field("pg/name", "", { label: "Full name" }), field("pg/email", "", { label: "Email" })], { at: T0 + 1000, windowId: "page:a3:1", kind: "page", focused: true }));
    const planJev = (asks: readonly string[], unclear: readonly string[] = []): AskJev => {
      const inner = jevFor(asks, {}, unclear).ask;
      return async (req) => {
        const r = await inner(req);
        return "route" in req.questions ? { ...r, answers: { ...r.answers, route: { choice: "plan", confidence: 0.9 } } } : r;
      };
    };
    const go = (ask: AskJev) => planAsk("register me", m, { values: () => [] }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "a3p", windowId: "page:a3:1", now: T0 + 2000, goals: true });
    const goal = await go(planJev(["Email"]));
    expect(goal).toMatchObject({ route: "goal", page: { kind: "list", scope: { fields: ["pg/email"] } } });
    const asked = await go(planJev([], ["Full name"])).catch((x: unknown) => x);
    expect(asked).toBeInstanceOf(AskAsks);
    expect((asked as AskAsks).question.options.map((c) => (c.option.kind === "field" ? c.option.label : c.option.kind))).toEqual(["Full name"]);
  });

  it("fills a plan's page form from the sources it read, and asks what it left open first (A3 review 2)", async () => {
    const m = deskOf("hubspot-contact").model;
    m.apply(snap([field("pg/name", "", { label: "Full name" }), field("pg/email", "", { label: "Email" })], { at: T0 + 1000, windowId: "page:a3:2", kind: "page", focused: true }));
    const planJev = (heads: Record<string, string>): AskJev => {
      const inner = jevFor(["Full name", "Email"]).ask;
      return async (req) => {
        const r = await inner(req);
        if (!("route" in req.questions)) return r;
        const answers: Record<string, { choice: string; confidence: number }> = { ...r.answers, route: { choice: "plan", confidence: 0.9 } };
        for (const [k, v] of Object.entries(heads)) answers[k] = { choice: v, confidence: 0.9 };
        return { ...r, answers };
      };
    };
    const go = (instruction: string, ask: AskJev) => planAsk(instruction, m, { values: () => [] }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "a3q", windowId: "page:a3:2", now: T0 + 2000, goals: true });
    const own = await go("register me, don't read other windows", planJev({ source: "instruction" }));
    expect(own).toMatchObject({ route: "goal", page: { kind: "list", scope: { memory: false } } });
    expect((own as { page: { scope: { windows: Set<string> | null } } }).page.scope.windows).toEqual(new Set());
    const which = await go("register me, don't read other windows", planJev({ source: "any" })).catch((x: unknown) => x);
    expect(which).toBeInstanceOf(AskRefused);
    expect((which as AskRefused).message).toBe(SAYS.whichSource);
  });

  it("refuses a continued Ask whose field now sits under another heading (A3 review 2)", async () => {
    const m = deskOf("hubspot-contact").model;
    const page = (heading: string) => snap([node("pg/h", "AXHeading", { label: heading }), field("pg/email", "", { label: "Email" }), field("pg/phone", "", { label: "Phone" })], { at: T0 + 1000, windowId: "page:a3:3", kind: "page", focused: true });
    m.apply(page("Applicant"));
    const jev = jevFor([], {}, ["Email"]);
    const go = (resume?: Parameters<typeof planAsk>[4]["resume"]) => planAsk("my email", m, { values: () => [] }, [], { askJev: jev.ask, maker: headsIntentMaker(jev.ask), writer: null, offerKey: "a3h", windowId: "page:a3:3", now: T0 + 2000, goals: true, ...(resume === undefined ? {} : { resume }) });
    const e = await go().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    m.apply(page("Emergency contact"));
    const after = await go({ ...q.resume, fixed: { ...q.resume.fixed, ...q.options[0]?.fixes } }).catch((x: unknown) => x);
    expect(after).toBeInstanceOf(AskRefused);
    expect((after as AskRefused).detail).toMatch(/changed/u);
  });

  it("still refuses what Ask refuses, with its sentence", async () => {
    const ssn = await run("rental-application", "put my social security number in", jevFor(["Social Security number"])).catch((x: unknown) => x);
    expect(ssn).toBeInstanceOf(AskRefused);
    expect((ssn as AskRefused).message).toBe("Caret doesn't type Social Security numbers. Type it yourself.");
    const none = await run("hubspot-contact", "add my fax number", jevFor([])).catch((x: unknown) => x);
    expect((none as AskRefused).message).toBe(SAYS.noSuchField);
  });
});
