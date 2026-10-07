// W1: the three wrong values LV1's first live Jev runs wrote (evidence/screen/lv1), each on its own desk, with a stand-in
// Jev that picks the wrong candidate at 0.9 as live Jev did at 0.77 to 0.96; then the readers the fixes rest on, each of
// which has one right answer per input and is tested alone. All text is synthetic fixture text.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill, type FillScope } from "../src/fill/fill.ts";
import { lineSpans, setGeneratorClock } from "../src/fill/candidates.ts";
import { instructionLine, LABELLED, questionAnswer, roleAt, severalValues } from "../src/fill/line-values.ts";
import { partFits } from "../src/fill/derive.ts";
import { Snapshot, type FillProposal, type Node } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { buildDesk, loadAsks, loadCorpus, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { field, jevPickingText, snap } from "./builders.ts";

beforeAll(() => setGeneratorClock(() => 0));
afterAll(() => setGeneratorClock(null));

const here = dirname(fileURLToPath(import.meta.url));
const REALFILL = join(here, "../../fixtures/realfill");
const corpus = loadCorpus(REALFILL);
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const deskOf = (form: string): Desk => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === form) ?? (() => { throw new Error(`no form ${form}`); })());
const fieldNode = (d: Desk, label: string): Node => {
  const n = [...d.form.nodes.values()].find((x) => x.editable === true && x.label === label);
  if (n === undefined) throw new Error(`no field ${label}`);
  return n;
};
/**
 * Whether a question is about the field labelled `label`. A descriptor cuts a long label ("… and what yo…"), so the
 * label's first 40 characters stand for it.
 */
const about = (ins: string, label: string): boolean => ins.includes(`Label: '${label.slice(0, 40)}`);
/** A stand-in Jev that picks `want` (a candidate's text) in every question about the field labelled `label`, at 0.9. */
const picking = (label: string, want: string, seen?: JevRequest[]): AskJev => {
  const pick = jevPickingText((_id, ins) => (about(ins, label) ? want : null), 0.9);
  return async (req) => (seen?.push(req), pick(req));
};
/** The texts offered in the questions about the field labelled `label`. */
const offered = (seen: readonly JevRequest[], label: string): string[] =>
  seen.flatMap((r) => Object.entries(r.questions).filter(([id, q]) => /^f\d+$/u.test(id) && about(String(q.instructions), label)).flatMap(([, q]) => Object.values(q.criteria).map((d) => /^"(.*?)" \(/u.exec(String(d))?.[1] ?? "")));
const fieldOf = (p: FillProposal, key: string) => p.fields.find((f) => f.key === key) ?? (() => { throw new Error(`no proposal field ${key}`); })();
/** The goal path's Ask for the whole form: "fill out this form" (page-loop-eval), over the given fields. */
const wholeForm = (keys: readonly string[], instruction: string): FillScope => ({ fields: keys, windows: null, memory: true, instruction, person: null, literals: new Map(), wholeForm: true });

describe("LV1 wrong 1: the rental application's Job title took the whole work line", () => {
  // Live: "Brightline Dental Labs, lab technician, $5,200/mo gross" at 0.77 to 0.85, hoist on and off; key "lab technician".
  const LINE = "Brightline Dental Labs, lab technician, $5,200/mo gross";

  it("never writes the whole line into Job title, and offers the role alone, which it writes", async () => {
    const d = deskOf("rental-application");
    const job = fieldNode(d, "Job title");
    const seen: JevRequest[] = [];
    const bad = await proposeFill(d.model, picking("Job title", LINE, seen), d.form.window.windowId, job.key, T0, { about: d.about, rand: () => 0 });
    expect(fieldOf(bad, job.key).value).toBeNull();
    expect(offered(seen, "Job title")).toContain("lab technician");
    const good = await proposeFill(d.model, picking("Job title", "lab technician"), d.form.window.windowId, job.key, T0, { about: d.about, rand: () => 0 });
    expect(fieldOf(good, job.key)).toMatchObject({ value: "lab technician", withheld: null });
  });

  it("refuses the whole line as wrongKind after the pick when a window offers it as an unlabelled line", async () => {
    // An unlabelled line is still offered whole (no label bounds its parts), so the guard after Jev's pick must hold.
    const m = new ScreenModel();
    m.apply(snap([field("note/text", `${LINE}\n`, { role: "AXTextArea" })], { at: T0 - 30_000, windowId: "note", title: "Notes.txt", focused: true }));
    m.apply(snap([field("form/job", "", { label: "Job title" }), field("form/company", "", { label: "Current employer" })], { at: T0, windowId: "form", title: "Rental application", focused: true, focusedKey: "form/job" }));
    const p = await proposeFill(m, picking("Job title", LINE), "form", "form/job", T0, { rand: () => 0 });
    expect(fieldOf(p, "form/job")).toMatchObject({ value: null, withheld: "wrongKind", confidence: 0.9 });
  });
});

describe("LV1 wrong 2: B25 held-09's Current company took a role at the company", () => {
  // Live: "Junior Analyst at Ridgeline Outdoor Co" at 0.82 and 0.9 under "fill out the Northgate application for me";
  // key "Ridgeline Outdoor Co". The rerun still offered it (0.57).
  const BAD = "Junior Analyst at Ridgeline Outdoor Co";

  it.each([false, true])("never writes the role and company, and offers the company alone (Ask scope %s)", async (scoped) => {
    const d = deskOf("job-application");
    const company = fieldNode(d, "Current company");
    const opts = (ask: AskJev) => [d.model, ask, d.form.window.windowId, company.key, T0, { about: d.about, rand: () => 0, ...(scoped ? { scope: wholeForm([company.key], "fill out the Northgate application for me") } : {}) }] as const;
    const seen: JevRequest[] = [];
    const bad = await proposeFill(...opts(picking("Current company", BAD, seen)));
    expect(fieldOf(bad, company.key).value).toBeNull();
    expect(offered(seen, "Current company")).toContain("Ridgeline Outdoor Co");
    const good = await proposeFill(...opts(picking("Current company", "Ridgeline Outdoor Co")));
    expect(fieldOf(good, company.key)).toMatchObject({ value: "Ridgeline Outdoor Co", withheld: null });
  });

  it("refuses a role at a company as wrongKind after the pick when a window offers it whole", async () => {
    const m = new ScreenModel();
    m.apply(snap([field("note/text", `${BAD}\n`, { role: "AXTextArea" })], { at: T0 - 30_000, windowId: "note", title: "Notes.txt", focused: true }));
    m.apply(snap([field("form/company", "", { label: "Current company" })], { at: T0, windowId: "form", title: "Application", focused: true, focusedKey: "form/company" }));
    const p = await proposeFill(m, picking("Current company", BAD), "form", "form/company", T0, { rand: () => 0 });
    expect(fieldOf(p, "form/company")).toMatchObject({ value: null, withheld: "wrongKind" });
  });
});

describe("LV1 wrong 3: the Ashby task's incident question took a note-to-self instruction", () => {
  // Live, in all 5 passes: "use the token-leak story, write it fresh." from "Incident question: use the token-leak story,
  // write it fresh."; key none (the user writes that answer).
  const ashby = JSON.parse(readFileSync(join(here, "../../fixtures/web-form/tasks/expect/ashby.json"), "utf8")) as { sources: { note: string } };
  const INCIDENT = "Describe a security incident you helped resolve and what you changed afterwards.";

  it("never offers the instruction, so no pick can write it", async () => {
    const m = new ScreenModel();
    m.apply(snap([field("note/text", ashby.sources.note, { role: "AXTextArea" })], { at: T0 - 30_000, windowId: "note", title: "Application details.txt", focused: true }));
    m.apply(snap([field("form/phone", "", { label: "Phone" }), field("form/incident", "", { role: "AXTextArea", label: INCIDENT })], { at: T0, windowId: "form", title: "Platform Security Engineer @ Juniper Freight", focused: true, focusedKey: "form/phone" }));
    const seen: JevRequest[] = [];
    for (const scope of [undefined, wholeForm(["form/phone", "form/incident"], "fill out this form")]) {
      const p = await proposeFill(m, picking(INCIDENT, "use the token-leak story, write it fresh", seen), "form", "form/phone", T0, { rand: () => 0, ...(scope === undefined ? {} : { scope }) });
      expect(fieldOf(p, "form/incident").value).toBeNull();
    }
    expect(offered(seen, INCIDENT).filter((t) => t.includes("token-leak"))).toEqual([]);
    // The rest of the note is still offered: its phone.
    expect(offered(seen, INCIDENT)).toContain("555-0152");
  });
});

describe("severalValues", () => {
  it.each([
    ["Brightline Dental Labs, lab technician, $5,200/mo gross", ["Brightline Dental Labs", "lab technician", "$5,200/mo gross"]],
    ["Junior Analyst at Ridgeline Outdoor Co (since 2024)", ["Junior Analyst", "Ridgeline Outdoor Co"]],
    ["Junior Analyst at Ridgeline Outdoor Co", ["Junior Analyst", "Ridgeline Outdoor Co"]],
    ["lab technician at Brightline Dental Labs", ["lab technician", "Brightline Dental Labs"]],
    ["Gary Pruitt, (512) 555-0193, gpruitt@example.net", ["Gary Pruitt", "(512) 555-0193", "gpruitt@example.net"]],
    ["Dr. Simone Achebe, my manager at Ridgeline", ["Dr. Simone Achebe", "my manager at Ridgeline"]],
    ["moved in Aug 2022, rent $1,450/mo", ["moved in Aug 2022", "rent $1,450/mo"]],
    ["Lakeshore Polytechnic Institute, B.S. Electrical Engineering, September 2016 to May 2020.", ["Lakeshore Polytechnic Institute", "B.S. Electrical Engineering", "September 2016 to May 2020"]],
  ])("reads %s as several values", (text, parts) => {
    expect(severalValues(text)).toEqual(parts);
  });

  // Every comma, bracket or "at" in an answer key's value (the corpus, F1's tasks, W4 and the Ask sets), and the shapes
  // that keep their own commas.
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
    "Fri, Oct 9, 2026, 4:02 PM",
    "Can start Jan 4, 2027",
    "Acme, Inc.",
    "Okafor, Riley Ade",
    "Riley Okafor, MD",
    "University of California, Berkeley",
    "yes, US citizen",
    "Ridgeline Outdoor Co",
    "Elena Marisol Vance",
    "lab technician",
    "$5,200",
  ])("reads %s as one value", (text) => {
    expect(severalValues(text)).toBeNull();
  });

  it("splits a role from its organization only when the organization runs to the end in capitals", () => {
    expect(roleAt("Head of Operations at Lumen Labs")).toEqual({ role: "Head of Operations", org: "Lumen Labs" });
    expect(roleAt("Started at Tallgrass Mechatronics in August")).toBeNull();
    expect(roleAt("The University of Texas at Austin")).toBeNull();
    expect(roleAt("meet at the cafe")).toBeNull();
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

describe("parts of a name", () => {
  it.each([
    ["first", "Elena", true],
    ["first", "J.", true],
    ["first", "Elena Marisol Vance", false],
    ["first", "Riley Okafor", false],
    ["first", "dmitri-halvorsen-firmware.pdf", false],
    ["middle", "Marisol", true],
    ["middle", "Riley Ade Okafor", false],
    ["last", "Natarajan-Okafor", true],
    ["last", "de la Cruz", true],
    ["last", "van der Rohe", true],
    ["last", "Jordan Reyes", false],
    ["last", "O'Neil", true],
  ] as const)("%s takes %s: %s", (part, value, want) => {
    expect(partFits(part, value)).toBe(want);
  });
});

describe("instructions to the user are no value", () => {
  /** Every distinct "Label: value" line of the fixture notes and mails in this repository (W4's note lives with its evidence). */
  const labelled = (): { label: string; value: string }[] => {
    const texts: string[] = [];
    for (const f of ["application-details.txt", "checkout-notes.txt", "draft.txt", "enrollment-notes.txt", "job-notes.txt", "order-note.txt", "rental-notes.txt"]) texts.push(readFileSync(join(REALFILL, "sources", f), "utf8"));
    for (const f of ["clinic-from-ines", "colleague-thread", "rsvp-from-bea", "service-advisor", "traveler-details"]) texts.push((JSON.parse(readFileSync(join(REALFILL, "sources", `${f}.mail.json`), "utf8")) as { body: string }).body);
    for (const p of ["ashby", "forty", "greenhouse", "reveal", "wizard-1", "wizard-2", "wizard-3"]) {
      const e = JSON.parse(readFileSync(join(here, `../../fixtures/web-form/tasks/expect/${p}.json`), "utf8")) as { sources: { note?: string; email?: { body: string } } };
      texts.push(e.sources.note ?? "", e.sources.email?.body ?? "");
    }
    const out = new Map<string, { label: string; value: string }>();
    for (const t of texts) {
      for (const raw of t.split("\n")) {
        const m = LABELLED.exec(raw.replace(/\s+/g, " ").trim().replace(/^(?:[-*•·–—])\s+/u, ""));
        if (m?.[1] !== undefined && m[2] !== undefined) out.set(`${m[1]}\u0000${m[2]}`, { label: m[1].trim(), value: m[2].trim() });
      }
    }
    return [...out.values()];
  };

  it("takes exactly the two instructions among the fixtures' labelled lines (the count stated at line-values.ts INSTRUCTION)", () => {
    const lines = labelled();
    expect(lines.length).toBeGreaterThan(50);
    expect(lines.filter((l) => instructionLine(l.label, l.value)).map((l) => l.label).sort()).toEqual(["Incident question", "Reference #2"]);
  });

  it("leaves instructions for someone else and values that start like a verb alone", () => {
    expect(instructionLine("Instructions", "leave it at the side door")).toBe(false);
    expect(instructionLine("Delivery instructions", "use the side door")).toBe(false);
    expect(instructionLine("Contact", "text preferred")).toBe(false);
    expect(instructionLine("Cover letter", "write one about the move")).toBe(true);
  });

  it("offers no span of an instruction line, and the parts of a labelled line of several values instead of its whole", () => {
    expect(lineSpans("Incident question: use the token-leak story, write it fresh.")).toEqual([]);
    expect(lineSpans("work: Brightline Dental Labs, lab technician, $5,200/mo gross").map((s) => s.text)).toEqual(["Brightline Dental Labs", "lab technician"]);
    expect(lineSpans("Currently: Junior Analyst at Ridgeline Outdoor Co (since 2024)").map((s) => s.text)).toEqual(["Junior Analyst", "Ridgeline Outdoor Co"]);
    // A warned value keeps its whole span, which Jev reads with the warning.
    expect(lineSpans("Name: Josephine Abernathy-Cole, but everyone calls me Jo. Pronouns she/her.").map((s) => s.text)).toContain("Josephine Abernathy-Cole, but everyone calls me Jo. Pronouns she/her.");
  });

  it("refuses no answer-key value as an instruction or a question with its answer", () => {
    const keys: string[] = [];
    for (const f of corpus.forms) for (const x of f.fields) keys.push(x.expected, ...(x.accept ?? []));
    for (const file of ["asks.json", "asks-heldout.json", "asks-heldout-2.json", "asks-b31.json"]) for (const a of loadAsks(REALFILL, corpus, file)) if (a.expected !== "refuse") keys.push(...Object.values(a.expected));
    for (const p of ["ashby", "forty", "greenhouse", "reveal", "wizard-1", "wizard-2", "wizard-3"]) keys.push(...Object.values((JSON.parse(readFileSync(join(here, `../../fixtures/web-form/tasks/expect/${p}.json`), "utf8")) as { expected: Record<string, string> }).expected));
    expect(keys.filter((k) => instructionLine("Answer", k) || questionAnswer(k))).toEqual([]);
  });
});

describe("the guard adversary (scripts/guard-adversary.ts) on the committed desks", () => {
  it("writes no value that strictly holds a key's value, and never the instruction, on the corpus's recorded windows and the four Ask sets", () => {
    const out = mkdtempSync(join(tmpdir(), "w1-adversary-"));
    try {
      execFileSync(process.execPath, [join(here, "../scripts/guard-adversary.ts"), "--out", out, "--sets", "corpus,b24,b25,b26,b31", "--corpus-pages", join(out, "none")], { stdio: "pipe" });
      const r = JSON.parse(readFileSync(join(out, "guard-adversary.json"), "utf8")) as { desks: Record<string, number>; a: { written: number }; attempts: { cls: string; value: string; outcome: string }[]; canned: { outcome: string }[] };
      expect(r.desks).toMatchObject({ "corpus-reader": 14, b24: 15, b25: 14, b26: 13, b31: 22 });
      expect(r.attempts.filter((x) => x.cls === "a").length).toBeGreaterThan(100);
      expect(r.a.written).toBe(0);
      expect(r.canned.filter((x) => x.outcome === "right").length).toBeGreaterThan(200);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
