// Value settlement's two requests, captured as sent (each sealed by the fill's Disclosure). The value questions carry the
// complete redacted Ask with its exclusions, the field's contract and observed section path, each option's exact output
// with its source, label, line and derivation, and the source units once in state; no recency instruction and no
// sentence restating an inferred person as the user's instruction. The verifier gets the exact operation and output, the
// parent value, the source unit and every assumption, and no confidence. Redacted text never comes back through any of
// them. Synthetic desks: every value is invented.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill, valueSettlementOf, type FillScope } from "../src/fill/fill.ts";
import { aboutValues } from "../src/fill/about.ts";
import { setTestVerifier, VERDICTS, VERIFY_TASK } from "../src/fill/contract.ts";
import { VALUE_NONE, VALUE_TASK } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { field, snap } from "./builders.ts";
import { optionOutput } from "./vs1-kit.ts";

const T0 = 2_000_000;
const TEXTEDIT = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };

beforeEach(() => setTestVerifier(null));
afterEach(() => setTestVerifier(STAND_IN));

function desk(note: string, labels: readonly string[], title = "Ines contact.txt"): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("note/body", note, { role: "AXTextArea" })], { at: T0 - 20_000, windowId: "note", title, app: TEXTEDIT, focused: true }));
  m.apply(snap(labels.map((l, i) => field(`form/${i}`, "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })), { at: T0, windowId: "form", title: "Patient intake", focused: true, focusedKey: "form/0" }));
  return m;
}
const scope = (labels: readonly string[], instruction: string, o: Partial<FillScope> = {}): FillScope => ({ fields: labels.map((_, i) => `form/${i}`), windows: null, memory: true, instruction, person: null, literals: new Map(), ...o });

/** Records every request; picks each field's `want` output in both wordings; owners and whose the user's; the verifier exact. */
function recorder(want: Record<string, string>): AskJev & { reqs: JevRequest[] } {
  const reqs: JevRequest[] = [];
  const f: AskJev = async (req) => {
    reqs.push(req);
    const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
      const ins = String(q.instructions);
      if (req.purpose === "fill.verify") return [id, { choice: "exact", confidence: 0.99 }];
      if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "person" in q.criteria ? "person" : "user", confidence: 0.99 }];
      const label = Object.keys(want).find((l) => ins.includes(`'${l}'`));
      const hit = Object.entries(q.criteria).find(([, d]) => label !== undefined && optionOutput(d) === want[label])?.[0];
      return [id, { choice: hit ?? "none", confidence: 0.99 }];
    }));
    return { model: "jev-vs1", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  return Object.assign(f, { reqs });
}
const values = (reqs: readonly JevRequest[]): JevRequest[] => reqs.filter((r) => r.purpose === "fill.values");
const verifies = (reqs: readonly JevRequest[]): JevRequest[] => reqs.filter((r) => r.purpose === "fill.verify");
const json = (r: JevRequest): string => JSON.stringify({ state: r.state, questions: r.questions });

const NOTE = ["From Ines Lindqvist", "My cell is (617) 555-0129, use that one.", "Office: (617) 555-0166", "Email: ines.lindqvist@example.org"].join("\n");
const INSTRUCTION = "do the contact part w the stuff ines sent, not her office line";

describe("the value requests", () => {
  it("carry the shared instruction and both wordings around the complete Ask, with no recency or inferred-person prose", async () => {
    const labels = ["Mobile phone", "Email"];
    const j = recorder({ "Mobile phone": "(617) 555-0129", Email: "ines.lindqvist@example.org" });
    await proposeFill(desk(NOTE, labels), j, "form", "form/0", T0, { rand: () => 0, scope: scope(labels, INSTRUCTION, { person: "ines" }) });
    const vs = values(j.reqs);
    expect(vs).toHaveLength(2);
    for (const r of vs) {
      expect((r.state as Record<string, unknown>).task).toBe(VALUE_TASK);
      expect(json(r)).not.toMatch(/just left|usually cop|most often cop|asks for ines's details/iu);
    }
    const [a, b] = vs.map((r) => String(r.questions.f1?.instructions));
    expect(a).toMatch(new RegExp(`^User request: "${INSTRUCTION}"\\. Explicit user selections: none\\. Field: .*'Mobile phone'.* Section/group: .+\\. Required content and format: .+\\. Which candidate's proposed value is supported by its source for this field, respecting the request's source, person and other restrictions\\? Choose none if none is supported\\.$`, "su"));
    expect(b).toMatch(new RegExp(`^Field: .*'Mobile phone'.* Section/group: .+\\. Required content and format: .+\\. User request: "${INSTRUCTION}"\\. Explicit user selections: none\\. Which listed proposed value can fill this field without guessing, using the source evidence and respecting all restrictions in the request\\? Choose none if no listed value qualifies\\.$`, "su"));
    for (const r of vs) expect(r.questions.f1?.criteria.none).toBe(VALUE_NONE);
  });

  it("sends the whole source unit once in state, and each option names it beside its own label and line", async () => {
    const labels = ["Mobile phone"];
    const j = recorder({ "Mobile phone": "(617) 555-0129" });
    await proposeFill(desk(NOTE, labels), j, "form", "form/0", T0, { rand: () => 0, scope: scope(labels, INSTRUCTION) });
    const [r] = values(j.reqs);
    const notes = (r?.state as { source_notes?: Record<string, string> }).source_notes ?? {};
    expect(Object.values(notes)).toEqual([NOTE]);
    const id = Object.keys(notes)[0] as string;
    const cell = Object.values(r?.questions.f1?.criteria ?? {}).find((c) => optionOutput(c) === "(617) 555-0129");
    expect(cell).toBe(`Proposed value: "(617) 555-0129". Source: TextEdit window 'Ines contact.txt'; the whole text is ${id} in source_notes. Observed label: unavailable. Supporting text: "My cell is (617) 555-0129, use that one.". Derivation: literal copy.`);
    // Once: no criterion repeats the unit.
    expect(Object.values(r?.questions ?? {}).flatMap((q) => Object.values(q.criteria)).some((c) => c?.includes("Office: (617) 555-0166\nEmail"))).toBe(false);
  });

  it("states a memory part's parent value and how it was split, and a conversion's assumption", async () => {
    const labels = ["First name", "Monthly rent ($)"];
    const about = aboutValues([{ id: "about-name", fields: { label: "Name", value: "Grace Oduya", source: "typed" } }]);
    const j = recorder({ "First name": "Grace", "Monthly rent ($)": "1,450" });
    await proposeFill(desk("Rent: $1,450 a month", labels, "Lease.txt"), j, "form", "form/0", T0, { about, rand: () => 0, scope: scope(labels, "my first name and the rent") });
    const [r] = values(j.reqs);
    const grace = Object.values(r?.questions.f1?.criteria ?? {}).find((c) => optionOutput(c) === "Grace");
    expect(grace).toMatch(/^Proposed value: "Grace"\. Source: the user's own details, which the user told Caret, saved as 'Name'\. Observed label: Name\. Supporting text: "Grace Oduya"\. Derivation: the first name, split from the whole name\.$/u);
    const rent = Object.values(r?.questions.f2?.criteria ?? {}).find((c) => optionOutput(c) === "1,450");
    expect(rent).toMatch(/Supporting text: "Rent: \$1,450 a month"\. Derivation: the amount's number without its currency sign\.$/u);
  });

  it("never carries a unit redaction cut, nor the cut text, in any request", async () => {
    const labels = ["Booking reference"];
    const note = ["Booking reference: QX-4471", "Password: hunter2-orchard"].join("\n");
    const j = recorder({ "Booking reference": "QX-4471" });
    await proposeFill(desk(note, labels), j, "form", "form/0", T0, { rand: () => 0, scope: scope(labels, "the booking reference from my note") });
    for (const r of j.reqs) expect(json(r)).not.toContain("hunter2");
    const [r] = values(j.reqs);
    expect((r?.state as { source_notes?: Record<string, string> }).source_notes).toBeUndefined();
    expect(Object.values(r?.questions.f1?.criteria ?? {}).find((c) => optionOutput(c) === "QX-4471")).toMatch(/^Proposed value: "QX-4471"\. Source: TextEdit window 'Ines contact\.txt'\. Observed label: /u);
  });

  it("does not offer a person's value whose whole note redaction cut: its owner was judged on part of it", async () => {
    const labels = ["Mobile phone"];
    const note = ["My cell is (617) 555-0129.", "Password: hunter2-orchard"].join("\n");
    const j = recorder({ "Mobile phone": "(617) 555-0129" });
    await proposeFill(desk(note, labels), j, "form", "form/0", T0, { rand: () => 0, scope: scope(labels, "my cell from the note") });
    for (const r of j.reqs) expect(json(r)).not.toContain("hunter2");
    expect(Object.values(values(j.reqs)[0]?.questions.f1?.criteria ?? {}).map(optionOutput)).not.toContain("(617) 555-0129");
  });
});

describe("the verifier's requests", () => {
  it("name the operation, exact output, parent value, unit and derivation, with the shared instruction and no confidence", async () => {
    const labels = ["First name", "Mobile phone"];
    const about = aboutValues([{ id: "about-name", fields: { label: "Name", value: "Grace Oduya", source: "typed" } }]);
    const j = recorder({ "First name": "Grace", "Mobile phone": "(617) 555-0129" });
    await proposeFill(desk(NOTE, labels), j, "form", "form/0", T0, { about, rand: () => 0, scope: scope(labels, "my first name and ines's cell") });
    const vs = verifies(j.reqs);
    expect(vs).toHaveLength(2);
    for (const r of vs) {
      expect((r.state as Record<string, unknown>).task).toBe(VERIFY_TASK);
      expect(json(r)).not.toMatch(/confiden|approved|0\.99/iu);
      for (const q of Object.values(r.questions)) expect(q.criteria).toEqual(VERDICTS);
    }
    const all = vs.flatMap((r) => Object.values(r.questions).map((q) => String(q.instructions)));
    const a = all.find((t) => t.startsWith("Field:") && t.includes('"Grace"'));
    const b = all.find((t) => t.startsWith("Exact output:") && t.includes('"Grace"'));
    expect(a).toMatch(/^Field: .*'First name'.* Required content and format: only a person's first name\. User request: "my first name and ines's cell"\. Explicit user selections: none\. Proposed operation: type this text into the text field\. Exact output: "Grace"\. Source evidence: what the user told Caret as 'Name', "Grace Oduya"\. Derivation: the first name, split from the whole name\. How does this output fit this field\?$/su);
    expect(b).toMatch(/^Exact output: "Grace"\. Operation: type this text into the text field\. Source evidence: what the user told Caret as 'Name', "Grace Oduya"\. Derivation: the first name, split from the whole name\. Field: .*'First name'.* If Caret performs this operation without changing the output, which description applies to the field's resulting value\?$/su);
    const cell = all.find((t) => t.startsWith("Field:") && t.includes('"(617) 555-0129"'));
    const notes = vs.map((r) => (r.state as { source_notes?: Record<string, string> }).source_notes ?? {});
    expect(notes.every((n) => Object.values(n).includes(NOTE))).toBe(true);
    expect(cell).toMatch(/Source evidence: the line "My cell is \(617\) 555-0129" in TextEdit 'Ines contact\.txt', whose whole text is note_\d+ in source_notes\. Derivation: none\./u);
  });
});

describe("a picked value's fresh pair", () => {
  // Live B26: the verifier had quoted the field (its descriptor and contract minted again as plan text), and the fresh pair's
  // question, composed from more ways than Disclosure keeps apart, carried "plan" and failed its shape at seal.
  it("seals after the verifier quoted the field and its contract", async () => {
    const labels = ["Start date (MM/YYYY)", "Email"];
    const note = ["Start date: 08/2022", "Email: ines.lindqvist@example.org"].join("\n");
    const low: AskJev = async (req) => req.purpose === "fill.verify"
      ? { model: "v", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "exact", confidence: 0.6 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 }
      : recorder({ "Start date (MM/YYYY)": "08/2022", Email: "ines.lindqvist@example.org" })(req);
    const m = desk(note, labels);
    const p = await proposeFill(m, low, "form", "form/0", T0, { rand: () => 0, scope: scope(labels, "my start date and email from the note", { picked: { fields: ["form/0", "form/1"] } }) });
    const s = valueSettlementOf(p);
    const u = s?.unresolved.find((x) => x.key === "form/0");
    expect(u?.why).toBe("verifier");
    await expect(s?.settle("form/0", u?.options[0]?.id ?? "", { model: m, askJev: low })).resolves.toMatchObject({ key: "form/0" });
  });
});
