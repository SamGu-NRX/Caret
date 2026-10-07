// W1: the three wrong values LV1's first live Jev runs wrote (evidence/screen/lv1), each on its own desk, with a stand-in
// Jev that picks the wrong candidate at 0.9 as live Jev did at 0.77 to 0.96; then the readers and the shared write check
// the fixes rest on, each with one right answer per input, tested alone, with every example W1's review raised. All text
// is synthetic fixture text.
import { TEST_AUTHORITY } from "./mint.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill, type FillScope } from "../src/fill/fill.ts";
import { lineSpans, setGeneratorClock } from "../src/fill/candidates.ts";
import { instructionText, LABELLED, lineTexts, questionAnswer, roleAt, severalValues } from "../src/fill/line-values.ts";
import { familyRefusal, SHAPE_FAMILIES } from "../src/fill/writable.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { misfit } from "../src/fill/kinds.ts";
import { fieldPart } from "../src/fill/derive.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { validateMinted } from "./mint.ts";
import { Snapshot, type FillProposal, type Node } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { buildDesk, loadAsks, loadCorpus, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { field, jevPickingText, snap } from "./builders.ts";

/**
 * W2: since W1's text-shape families left the gate (fill/writable.ts RETIRED_FAMILIES, AC1 migration step 4), the
 * write contract's verifier refuses these values. The stand-in answers each with the verdicts live Jev gave it on the
 * dev set, both wordings, pass 1 (evidence/screen/w2/verify-eval-3; fixtures/verify/dev.json a-034, a-052, a-053, b-003,
 * r2-reception, r2-ring), and calls every other value exact. LV1 wrong 2 and 'Reception Desk' are refused only because
 * the two wordings disagree.
 */
const LIVE_VERDICTS: Readonly<Record<string, readonly [string, string, number]>> = {
  "Brightline Dental Labs, lab technician, $5,200/mo gross": ["more", "more", 0.93],
  "Junior Analyst at Ridgeline Outdoor Co (since 2024)": ["exact", "more", 0.72],
  "Junior Analyst at Ridgeline Outdoor Co": ["exact", "more", 0.48],
  "use the token-leak story, write it fresh.": ["note", "note", 0.92],
  "use the token-leak story, write it fresh": ["note", "note", 0.92],
  "Reception Desk": ["part", "exact", 0.28],
  "ring twice": ["part", "more", 0.51],
};
const liveLike: AskJev = async (req) => ({
  model: "verify-live-verdicts",
  answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => {
    const ins = String(q.instructions);
    const text = /nothing added or removed: "([^"]*)"|^Proposed text for the field '[^']*': "([^"]*)"/u.exec(ins);
    const v = LIVE_VERDICTS[text?.[1] ?? text?.[2] ?? ""];
    const second = ins.startsWith("Proposed text");
    return [id, v === undefined ? { choice: "exact", confidence: 0.95 } : { choice: second ? v[1] : v[0], confidence: v[2] }];
  })),
  inputTokens: 0,
  latencyMs: 0,
  costUsd: 0,
});
beforeAll(() => {
  setGeneratorClock(() => 0);
  setTestVerifier(liveLike);
});
afterAll(() => {
  setGeneratorClock(null);
  setTestVerifier(STAND_IN);
});

const here = dirname(fileURLToPath(import.meta.url));
const REALFILL = join(here, "../../fixtures/realfill");
const TASKS = join(here, "../../fixtures/web-form/tasks/expect");
const TASK_PAGES = ["ashby", "forty", "greenhouse", "reveal", "wizard-1", "wizard-2", "wizard-3"];
const corpus = loadCorpus(REALFILL);
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const deskOf = (form: string): Desk => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === form) ?? (() => { throw new Error(`no form ${form}`); })());
const fieldNode = (d: Desk, label: string): Node => {
  const n = [...d.form.nodes.values()].find((x) => x.editable === true && x.label === label);
  if (n === undefined) throw new Error(`no field ${label}`);
  return n;
};
/** Whether a question is about the field labelled `label`; a descriptor cuts a long label ("… what yo…"), so its first 40 characters stand for it. */
const about = (ins: string, label: string): boolean => ins.includes(`Label: '${label.slice(0, 40)}`);
/** A stand-in Jev that picks `want` (a candidate's text) in every question about the field labelled `label`, at 0.9. */
const picking = (label: string, want: string, seen?: JevRequest[]): AskJev => {
  const pick = jevPickingText((_id, ins) => (about(ins, label) ? want : null), 0.9);
  return async (req) => (seen?.push(req), pick(req));
};
/** The option descriptions in the questions about the field labelled `label`. */
const options = (seen: readonly JevRequest[], label: string): string[] =>
  seen.flatMap((r) => Object.entries(r.questions).filter(([id, q]) => /^f\d+$/u.test(id) && about(String(q.instructions), label)).flatMap(([, q]) => Object.values(q.criteria).map(String)));
const offered = (seen: readonly JevRequest[], label: string): string[] => options(seen, label).map((d) => /^"(.*?)" \(/u.exec(d)?.[1] ?? "");
const fieldOf = (p: FillProposal, key: string) => p.fields.find((f) => f.key === key) ?? (() => { throw new Error(`no proposal field ${key}`); })();
/** The goal path's Ask for the whole form, over the given fields. */
const wholeForm = (keys: readonly string[], instruction: string): FillScope => ({ fields: keys, windows: null, memory: true, instruction, person: null, literals: new Map(), wholeForm: true });
/** A desk of one note (the window the user just left) and a form of the given fields. */
function noteDesk(note: string, fields: readonly Node[]): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("note/text", note, { role: "AXTextArea" })], { at: T0 - 30_000, windowId: "note", title: "Notes.txt", focused: true }));
  m.apply(snap([...fields], { at: T0, windowId: "form", title: "Application", focused: true, focusedKey: fields[0]?.key ?? null }));
  return m;
}

describe("LV1 wrong 1: the rental application's Job title took the whole work line", () => {
  // Live: "Brightline Dental Labs, lab technician, $5,200/mo gross" at 0.77 to 0.85, hoist on and off; key "lab technician".
  const LINE = "Brightline Dental Labs, lab technician, $5,200/mo gross";

  it("never writes the whole line into Job title, and offers the role alone, which it writes", async () => {
    const d = deskOf("rental-application");
    const job = fieldNode(d, "Job title");
    const seen: JevRequest[] = [];
    const bad = await proposeFill(d.model, picking("Job title", LINE, seen), d.form.window.windowId, job.key, T0, { about: d.about, rand: () => 0 });
    expect(fieldOf(bad, job.key)).toMatchObject({ value: null, withheld: "notExact" });
    expect(offered(seen, "Job title")).toEqual(expect.arrayContaining(["lab technician", LINE]));
    const good = await proposeFill(d.model, picking("Job title", "lab technician"), d.form.window.windowId, job.key, T0, { about: d.about, rand: () => 0 });
    expect(fieldOf(good, job.key)).toMatchObject({ value: "lab technician", withheld: null });
  });

  it("refuses the whole line from an unlabelled note line too", async () => {
    const m = noteDesk(`${LINE}\n`, [field("form/job", "", { label: "Job title" })]);
    const p = await proposeFill(m, picking("Job title", LINE), "form", "form/job", T0, { rand: () => 0 });
    expect(fieldOf(p, "form/job")).toMatchObject({ value: null, withheld: "notExact", confidence: 0.9 });
  });

  it("is refused by the planner's validation, which the writer's plans meet (review 7)", async () => {
    const m = noteDesk(`work: ${LINE}\n`, [field("form/job", "", { label: "Job title" })]);
    const step = { says: "Job title", end: { kind: "valueEquals" as const, window: { bundleId: "dev.caret.fixture", title: "Application" }, target: { key: "form/job", describe: "Job title" }, value: LINE } };
    const run = async (value: string): Promise<string> => {
      try {
        await validateMinted({ id: "p", title: "p", slots: {}, steps: [{ ...step, end: { ...step.end, value } }] }, {}, { model: m, memory: [], instruction: "fill in my job" });
        return "passed";
      } catch (e) {
        if (e instanceof PlannerError) return e.code;
        throw e;
      }
    };
    expect(await run(LINE)).toBe("wrongKind");
    expect(await run("lab technician")).toBe("passed");
  });
});

describe("LV1 wrong 2: B25 held-09's Current company took a role at the company", () => {
  // Live: "Junior Analyst at Ridgeline Outdoor Co" at 0.82 and 0.9 under "fill out the Northgate application for me";
  // key "Ridgeline Outdoor Co". The rerun still offered it (0.57).
  const BAD = "Junior Analyst at Ridgeline Outdoor Co";

  it.each([false, true])("never writes the role and company, and offers the company alone (Ask scope %s)", async (scoped) => {
    const d = deskOf("job-application");
    const company = fieldNode(d, "Current company");
    const args = (ask: AskJev) => [d.model, ask, d.form.window.windowId, company.key, T0, { about: d.about, rand: () => 0, ...(scoped ? { scope: wholeForm([company.key], "fill out the Northgate application for me") } : {}) }] as const;
    const seen: JevRequest[] = [];
    const bad = await proposeFill(...args(picking("Current company", BAD, seen)));
    expect(fieldOf(bad, company.key)).toMatchObject({ value: null, withheld: "notExact" });
    expect(offered(seen, "Current company")).toContain("Ridgeline Outdoor Co");
    const good = await proposeFill(...args(picking("Current company", "Ridgeline Outdoor Co")));
    expect(fieldOf(good, company.key)).toMatchObject({ value: "Ridgeline Outdoor Co", withheld: null });
  });
});

describe("LV1 wrong 3: the Ashby task's incident question took a note-to-self instruction", () => {
  // Live, in all 5 passes: "use the token-leak story, write it fresh." from "Incident question: use the token-leak story,
  // write it fresh."; key none (the user writes that answer).
  const ashby = JSON.parse(readFileSync(join(TASKS, "ashby.json"), "utf8")) as { sources: { note: string } };
  const INCIDENT = "Describe a security incident you helped resolve and what you changed afterwards.";

  it("never writes the instruction, labelled or not, by fill or by Ask", async () => {
    for (const note of [ashby.sources.note, "use the token-leak story, write it fresh.\nPhone: 555-0152"]) {
      const m = noteDesk(note, [field("form/phone", "", { label: "Phone" }), field("form/incident", "", { role: "AXTextArea", label: INCIDENT })]);
      for (const scope of [undefined, wholeForm(["form/phone", "form/incident"], "fill out this form")]) {
        const seen: JevRequest[] = [];
        const p = await proposeFill(m, picking(INCIDENT, "use the token-leak story, write it fresh", seen), "form", "form/phone", T0, { rand: () => 0, ...(scope === undefined ? {} : { scope }) });
        // G2 round 4: "token-leak" holds a secret marker word (memory/sensitive.ts markerWord), so the redacted view
        // (fill/redact.ts) drops the line and it is no longer offered at all; never written either way.
        expect(offered(seen, INCIDENT).some((t) => t.startsWith("use the token-leak story"))).toBe(false);
        expect(fieldOf(p, "form/incident").value).toBeNull();
      }
    }
  });
});

describe("W1 review: parts keep what their line says about them", () => {
  it("quotes the whole value beside a part, so a qualifier goes with it (review 1)", async () => {
    const value = "Junior Analyst at Ridgeline Outdoor Co (for my sister)";
    expect(lineTexts(`Work: ${value}`).filter((t) => t.text === "Junior Analyst")).toEqual([{ text: "Junior Analyst", label: "Work", with: value, partOf: value }]);
    const m = noteDesk(`Work: ${value}\n`, [field("form/job", "", { label: "Job title" })]);
    const seen: JevRequest[] = [];
    await proposeFill(m, picking("Job title", "none", seen), "form", "form/job", T0, { rand: () => 0 });
    expect(options(seen, "Job title").find((o) => o.startsWith('"Junior Analyst"'))).toContain("for my sister");
  });

  it("keeps every whole labelled value, and adds its parts (review 3, lead direction a)", () => {
    expect(lineSpans("Delivery instructions: Reception Desk, ring twice").map((s) => s.text)).toEqual(["Reception Desk, ring twice", "Reception Desk", "ring twice"]);
    expect(lineSpans("Address: PO Box 12, Austin, TX 78701").map((s) => s.text)).toContain("PO Box 12, Austin, TX 78701");
    expect(lineSpans("work: Brightline Dental Labs, lab technician, $5,200/mo gross").map((s) => s.text)).toEqual(["Brightline Dental Labs, lab technician, $5,200/mo gross", "Brightline Dental Labs", "lab technician"]);
    expect(lineSpans("Currently: Junior Analyst at Ridgeline Outdoor Co (since 2024)").map((s) => s.text)).toEqual(["Junior Analyst at Ridgeline Outdoor Co (since 2024)", "Junior Analyst at Ridgeline Outdoor Co", "Junior Analyst", "Ridgeline Outdoor Co"]);
    expect(lineSpans("Incident question: use the token-leak story, write it fresh.").map((s) => s.text)).toEqual(["use the token-leak story, write it fresh."]);
  });

  it("writes a part only into a field that takes one value: never 'ring twice' into Delivery instructions (review 3)", async () => {
    const m = noteDesk("Delivery instructions: Reception Desk, ring twice\n", [field("form/notes", "", { role: "AXTextArea", label: "Delivery instructions" })]);
    const part = await proposeFill(m, picking("Delivery instructions", "ring twice"), "form", "form/notes", T0, { rand: () => 0 });
    expect(fieldOf(part, "form/notes")).toMatchObject({ value: null, withheld: "notExact" });
    const whole = await proposeFill(m, picking("Delivery instructions", "Reception Desk, ring twice"), "form", "form/notes", T0, { rand: () => 0 });
    expect(fieldOf(whole, "form/notes")).toMatchObject({ value: "Reception Desk, ring twice", withheld: null });
  });

  it("offers a company's parts under a label that names a company, though it says 'name' (review 5)", () => {
    expect(lineTexts("Company name: Junior Analyst at Ridgeline Outdoor Co").map((t) => t.text)).toEqual(expect.arrayContaining(["Junior Analyst", "Ridgeline Outdoor Co"]));
    // A person's label still gives only the person: "Dr. Simone Achebe".
    expect(lineTexts("Reference: Dr. Simone Achebe, my manager at Ridgeline").map((t) => t.text)).toEqual(["Dr. Simone Achebe"]);
  });
});

describe("W1 round-2 review: one span found twice keeps what both readings say", () => {
  it("keeps 'Reception Desk' a part, quoting its whole value, though the first-part reading found it bare", async () => {
    const value = "Reception Desk, ring twice";
    expect(lineTexts(`Delivery instructions: ${value}`).find((t) => t.text === "Reception Desk")).toEqual({ text: "Reception Desk", label: "Delivery instructions", with: value, partOf: value });
    const m = noteDesk(`Delivery instructions: ${value}\n`, [field("form/notes", "", { role: "AXTextArea", label: "Delivery instructions" })]);
    const p = await proposeFill(m, picking("Delivery instructions", "Reception Desk"), "form", "form/notes", T0, { rand: () => 0 });
    expect(fieldOf(p, "form/notes")).toMatchObject({ value: null, withheld: "notExact" });
  });

  it("keeps the qualifier beside 'Lumen Labs' from 'Lumen Labs, lab technician (for my sister)'", async () => {
    const value = "Lumen Labs, lab technician (for my sister)";
    const texts = lineTexts(`work: ${value}`);
    for (const part of ["Lumen Labs", "lab technician"]) expect(texts.find((t) => t.text === part)).toEqual({ text: part, label: "work", with: value, partOf: value });
    const m = noteDesk(`work: ${value}\n`, [field("form/company", "", { label: "Current employer" })]);
    const seen: JevRequest[] = [];
    await proposeFill(m, picking("Current employer", "none", seen), "form", "form/company", T0, { rand: () => 0 });
    expect(options(seen, "Current employer").find((o) => o.startsWith('"Lumen Labs" ('))).toContain("for my sister");
  });
});

describe("severalValues", () => {
  it.each([
    ["Brightline Dental Labs, lab technician, $5,200/mo gross", ["Brightline Dental Labs", "lab technician", "$5,200/mo gross"]],
    ["Junior Analyst at Ridgeline Outdoor Co (since 2024)", ["Junior Analyst", "Ridgeline Outdoor Co"]],
    ["Junior Analyst at Ridgeline Outdoor Co", ["Junior Analyst", "Ridgeline Outdoor Co"]],
    ["Junior Analyst at Ridgeline Outdoor Co, Inc.", ["Junior Analyst", "Ridgeline Outdoor Co, Inc."]],
    ["lab technician at Brightline Dental Labs", ["lab technician", "Brightline Dental Labs"]],
    ["Gary Pruitt, (512) 555-0193, gpruitt@example.net", ["Gary Pruitt", "(512) 555-0193", "gpruitt@example.net"]],
    ["Dr. Simone Achebe, my manager at Ridgeline", ["Dr. Simone Achebe", "my manager at Ridgeline"]],
    ["moved in Aug 2022, rent $1,450/mo", ["moved in Aug 2022", "rent $1,450/mo"]],
    ["Lakeshore Polytechnic Institute, B.S. Electrical Engineering, September 2016 to May 2020.", ["Lakeshore Polytechnic Institute", "B.S. Electrical Engineering", "September 2016 to May 2020"]],
    // Review 8.
    ["$5,200, lab technician", ["$5,200", "lab technician"]],
    ["12 Main St, lab technician, $5,200/mo", ["12 Main St", "lab technician", "$5,200/mo"]],
    ["Elena Varga, Marcus Cole", ["Elena Varga", "Marcus Cole"]],
  ])("reads %s as several values", (text, parts) => {
    expect(severalValues(text)).toEqual(parts);
  });

  // Every comma, bracket or "at" in an answer key's value (the corpus, F1's tasks, W4 and the Ask sets), the shapes that
  // keep their own commas, and the review's false positives.
  it.each([
    "The University of Texas at Austin",
    "side door, ring twice",
    "English, Spanish",
    "Some college, no degree",
    "San Diego, California, United States",
    "Oakland, California, United States (in the Bay Area)",
    "9 years building software, 6 of them building on AWS with Terraform.",
    "Wild mushroom risotto (vegetarian)",
    "Standard (5-7 business days)",
    "4410 Speedway Apt 2, Austin, Texas 78751",
    "27 Linden Terrace, Unit 3, Somerville, Massachusetts 02143",
    "PO Box 12, Austin, TX 78701",
    "Fri, Oct 9, 2026, 4:02 PM",
    "Can start Jan 4, 2027",
    "Acme, Inc.",
    "Okafor, Riley Ade",
    "Riley Okafor, MD",
    "University of California, Berkeley",
    "University of California, Berkeley (UC Berkeley)",
    "Stanford University, Palo Alto",
    "yes, US citizen",
    "Editor at Large",
    "Software at Scale",
    "Ridgeline Outdoor Co",
    "lab technician",
    "$5,200",
  ])("reads %s as one value", (text) => {
    expect(severalValues(text)).toBeNull();
  });

  it("splits a role from its organization only for a role word and an organization of two words or more", () => {
    expect(roleAt("Head of Operations at Lumen Labs")).toEqual({ role: "Head of Operations", org: "Lumen Labs" });
    expect(roleAt("Started at Tallgrass Mechatronics in August")).toBeNull();
    expect(roleAt("Meet at Blue Bottle Coffee")).toBeNull();
    expect(roleAt("Editor at Large")).toBeNull();
  });
});

/**
 * W2: W1's text-shape families, retired from the gate (fill/writable.ts RETIRED_FAMILIES) and kept as code with one
 * right answer per input: each row asks whether any family refuses the value, as writeMisfit did before W2.
 */
const anyFamily = (value: string, field: { labelWords: readonly string[]; part?: ReturnType<typeof fieldPart> }, from: string | null = null): string | null =>
  SHAPE_FAMILIES.map((f) => familyRefusal(f, value, field, { label: from })).find((x) => x !== null) ?? null;

describe("W1's text-shape families (writable.ts familyRefusal), retired from the gate", () => {
  const N = null;
  it.each([
    // The three live wrongs and the review's holes: refused.
    ["Brightline Dental Labs, lab technician, $5,200/mo gross", "Job title", N, false],
    ["Junior Analyst at Ridgeline Outdoor Co", "Current company", N, false],
    ["Junior Analyst at Ridgeline Outdoor Co, Inc.", "Current company", N, false],
    ["use the token-leak story, write it fresh.", "Describe a security incident you helped resolve and what you changed afterwards.", N, false],
    ["use the token-leak story, write it fresh.", "Message", N, false],
    ["What are your salary expectations?: $185,000", "What are your salary expectations?", N, false],
    ["$5,200, lab technician", "Amount", N, false],
    ["12 Main St, lab technician, $5,200/mo", "Job title", N, false],
    ["Elena Varga, Marcus Cole", "Full name", N, false],
    ["Austin, Texas", "City", N, false],
    ["Elena Marisol Vance", "First name", "Legal name", false],
    ["Elena Marisol Vance", "Last name", "Legal name", false],
    ["Riley Okafor", "First name / Given name", N, false],
    ["Jo Abernathy-Cole", "Preferred name", "To", false],
    // Right values, the review's false positives included: written.
    ["lab technician", "Job title", "work", true],
    ["Ridgeline Outdoor Co", "Current company", "Currently", true],
    ["Editor at Large", "Job title", N, true],
    ["Software at Scale", "Company", N, true],
    ["Send Labs", "Company name", "Company", true],
    ["Skip", "First name", "First name", true],
    ["Mary Ann", "First name", "First name", true],
    ["García Márquez", "Last name", "Last name", true],
    ["Mary Ann", "Preferred name", "Preferred name", true],
    ["Elena", "First name", "Legal name", true],
    ["PO Box 12, Austin, TX 78701", "Address", "Address", true],
    ["4410 Speedway Apt 2, Austin, Texas 78751", "Address", N, true],
    ["Reception Desk, ring twice", "Delivery instructions", "Delivery instructions", true],
    ["use the side door", "Delivery instructions", N, true],
    ["Oakland, California, United States", "Location (City)", N, true],
    ["Austin", "City", N, true],
    ["the lease ends Oct 31 and they're raising rent", "Reason for moving", N, true],
  ] as const)("'%s' into %s (source label %s): %s", (value, label, from, ok) => {
    expect(misfit(value, [label]) === null && anyFamily(value, { labelWords: [label] }, from) === null).toBe(ok);
  });

  it.each([
    ["dmitri-halvorsen-firmware.pdf", { labelWords: ["First Name"] }, false],
    ["dmitri-halvorsen-firmware.pdf", { labelWords: ["Resume file name"] }, true],
    ["1907 Alameda de las Pulgas, apt 12", { labelWords: ["Address"], part: "street" }, false],
    ["1907 Alameda de las Pulgas", { labelWords: ["Address"], part: "street" }, true],
    ["1907 Alameda de las Pulgas, apt 12", { labelWords: ["Address"], part: null }, true],
  ] as const)("'%s' into %j: %s (the adversary's Ask run)", (value, f, ok) => {
    expect(misfit(value, f.labelWords) === null && anyFamily(value, f) === null).toBe(ok);
  });

  it("reads no phone's area code as a remark (the mileage clause the adversary's Ask run wrote)", () => {
    expect(lineTexts("From your earlier note: mileage is 59,870 and the best number for you is (720) 555-0146.").map((t) => t.text)).not.toContain("mileage is 59,870 and the best number for you is");
    expect(lineTexts("Preferred first name: Dima (legal name Dmitri Halvorsen).").map((t) => t.text)).toContain("Dima");
  });

  it("refuses no answer-key value that misfit took, in its own field read as fill reads it (the corpus and the four Ask sets)", () => {
    const pairs: [string, string, ReturnType<typeof fieldPart>][] = [];
    const partOf = (form: (typeof corpus.forms)[number], label: string) => fieldPart(label, form.fields.some((x) => fieldPart(x.label, false) === "city"));
    for (const f of corpus.forms) for (const x of f.fields) if (!["select", "radio", "checkbox", "date", "time", "file"].includes(x.control)) for (const v of [x.expected, ...(x.accept ?? [])]) pairs.push([v, x.label, partOf(f, x.label)]);
    for (const file of ["asks.json", "asks-heldout.json", "asks-heldout-2.json", "asks-b31.json"]) for (const a of loadAsks(REALFILL, corpus, file)) {
      const f = corpus.forms.find((x) => x.id === a.form);
      if (a.expected !== "refuse" && f !== undefined) for (const [l, v] of Object.entries(a.expected)) if (!["select", "radio", "checkbox", "date", "time", "file"].includes(f.fields.find((x) => x.label === l)?.control ?? "")) pairs.push([v, l, partOf(f, l)]);
    }
    const refused = pairs.filter(([v, l, part]) => !["none", "handoff"].includes(v) && misfit(v, [l]) === null && anyFamily(v, { labelWords: [l], part }) !== null);
    expect(refused).toEqual([]);
  });
});

describe("a question and its answer on one line", () => {
  it.each([
    ["What are your salary expectations?: $185,000", true],
    ["Do you have pets?: No", true],
    ["$185,000", false],
    ["Phone: 555-0152", false],
    ["Meeting at 3:00 PM?", false],
  ])("%s -> %s", (text, want) => {
    expect(questionAnswer(text)).toBe(want);
  });
});

/** Every answer-key value: the corpus's, the four Ask sets' and F1's task pages'. */
function keyValues(): string[] {
  const keys: string[] = [];
  for (const f of corpus.forms) for (const x of f.fields) keys.push(x.expected, ...(x.accept ?? []));
  for (const file of ["asks.json", "asks-heldout.json", "asks-heldout-2.json", "asks-b31.json"]) for (const a of loadAsks(REALFILL, corpus, file)) if (a.expected !== "refuse") keys.push(...Object.values(a.expected));
  for (const p of TASK_PAGES) keys.push(...Object.values((JSON.parse(readFileSync(join(TASKS, `${p}.json`), "utf8")) as { expected: Record<string, string> }).expected));
  return keys;
}

describe("instructions to the user", () => {
  /** Every distinct line, and value of a "Label: value" line, of the fixture notes and mails in this repository. */
  const lines = (): string[] => {
    const texts: string[] = [];
    for (const f of ["application-details.txt", "checkout-notes.txt", "draft.txt", "enrollment-notes.txt", "job-notes.txt", "order-note.txt", "rental-notes.txt"]) texts.push(readFileSync(join(REALFILL, "sources", f), "utf8"));
    for (const f of ["clinic-from-ines", "colleague-thread", "rsvp-from-bea", "service-advisor", "traveler-details"]) texts.push((JSON.parse(readFileSync(join(REALFILL, "sources", `${f}.mail.json`), "utf8")) as { body: string }).body);
    for (const p of TASK_PAGES) {
      const e = JSON.parse(readFileSync(join(TASKS, `${p}.json`), "utf8")) as { sources: { note?: string; email?: { body: string } } };
      texts.push(e.sources.note ?? "", e.sources.email?.body ?? "");
    }
    const out = new Set<string>();
    for (const t of texts) {
      for (const raw of t.split("\n")) {
        const line = raw.replace(/\s+/g, " ").trim().replace(/^(?:[-*•·–—])\s+/u, "");
        if (line === "") continue;
        out.add(line);
        const m = LABELLED.exec(line);
        if (m?.[2] !== undefined) out.add(m[2].trim());
      }
    }
    return [...out];
  };

  it("takes exactly the two instructions among the fixtures' lines (the count stated at line-values.ts INSTRUCTION)", () => {
    const all = lines();
    expect(all.length).toBe(236);
    expect(all.filter(instructionText).sort()).toEqual(["still need to ask someone.", "use the token-leak story, write it fresh."]);
  });

  it("splits a role from its organization in one fixture line only, and in no answer-key value (line-values.ts ROLE_WORDS)", () => {
    expect(lines().filter((l) => roleAt(l.replace(/\s*\([^()]*\)$/u, "")) !== null)).toEqual(["Junior Analyst at Ridgeline Outdoor Co (since 2024)"]);
    expect(keyValues().filter((k) => roleAt(k) !== null)).toEqual([]);
  });

  it("takes no answer-key value (0 wrongly dropped)", () => {
    expect(keyValues().filter((k) => instructionText(k) || questionAnswer(k))).toEqual([]);
  });

  it("leaves a name that starts like a verb alone (review 6)", () => {
    for (const v of ["Send Labs", "Skip", "Use Case Partners", "Ask Jeeves"]) expect(instructionText(v)).toBe(false);
    for (const v of ["use the token-leak story", "Write it fresh", "ask someone at work", "still need to ask someone."]) expect(instructionText(v)).toBe(true);
  });
});

describe("the guard adversary (scripts/guard-adversary.ts) on the committed desks", () => {
  it("loses no canned right value when every value check says exact, on the corpus's recorded windows and the four Ask sets", () => {
    const out = mkdtempSync(join(tmpdir(), "w1-adversary-"));
    try {
      execFileSync(process.execPath, [join(here, "../scripts/guard-adversary.ts"), "--out", out, "--sets", "corpus,b24,b25,b26,b31", "--corpus-pages", join(out, "none")], { stdio: "pipe" });
      const r = JSON.parse(readFileSync(join(out, "guard-adversary.json"), "utf8")) as { desks: Record<string, number>; a: { written: number }; attempts: { cls: string; value: string; outcome: string }[]; canned: { outcome: string }[] };
      expect(r.desks).toMatchObject({ "corpus-reader": 14, b24: 15, b25: 14, b26: 13, b31: 22 });
      expect(r.attempts.filter((x) => x.cls === "a").length).toBeGreaterThan(100);
      // W2: with every value check saying exact, class (a) measures code alone, which no longer reads text shapes (W1's
      // families left the gate on the verifier's evidence, fill/writable.ts RETIRED_FAMILIES); the refuse-mode run below
      // holds every class at 0. Canned right values measured on these desks when W1's review fixes landed (the corpus by the reader's windows, the Ask sets through
      // planAsk): the guards must not cost one.
      // HA2 (lead decision, cost accepted): a user's value admitted by owner questions counts only when both questions
      // showed its whole source note. A fill on focus from a note the user did not name sends under half of the note's
      // prose (privacy.ts prose share), so a note with any line over 80 characters never goes whole and its user values
      // are withheld; an Ask that names the note keeps the full budget. Measured on these desks: 199 right at 68a7daa,
      // 164 with HA2 (evidence/screen/ha2; all four sets 353 -> 283). Lead decision 2 then held every address part to the
      // same rule (a lone city or ZIP line is asked whose it is too): 162 (all four sets 271). The review's fail-closed
      // rules (fill/note-unit.ts) then showed every text that holds a value, (a), and a mail's or page's whole window, (c):
      // 139 (all four sets 243; (a) alone cost 14 here, (c) 19, (b) none). The owner-note allotment (privacy.ts
      // OWNER_NOTE_CHARS, 2,000, conversations kept out) then brought it to 160 (all four sets 306). The floor is the
      // measured value, and the guards must not cost one more.
      expect(r.canned.filter((x) => x.outcome === "right").length).toBeGreaterThanOrEqual(160);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);

  it("writes nothing outside a named exemption when every value check refuses (W2: no path skips the write contract), routines included", () => {
    const out = mkdtempSync(join(tmpdir(), "w2-adversary-"));
    try {
      execFileSync(process.execPath, [join(here, "../scripts/guard-adversary.ts"), "--out", out, "--verifier", "refuse", "--sets", "corpus,b24,b25,b26,b31,routine", "--corpus-pages", join(out, "none")], { stdio: "pipe" });
      const r = JSON.parse(readFileSync(join(out, "guard-adversary.json"), "utf8")) as { unexempt: number; c: { written: number }; attempts: { cls: string; outcome: string; via: string | null }[]; routine: { offers: number; cells: number; errors: string[] }; failures: string[] };
      expect(r.attempts.filter((x) => x.cls === "c").length).toBeGreaterThan(1000);
      expect(r.unexempt).toBe(0);
      // Every write left is an option's own label or a resolved date (named exemptions); none is unchecked.
      expect(r.attempts.filter((x) => x.outcome === "written" && x.via?.startsWith("exempt:") !== true)).toEqual([]);
      expect(r.routine.offers).toBeGreaterThan(0);
      expect(r.routine.errors).toEqual([]);
      expect(r.failures).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 300_000);
});
