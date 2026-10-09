// S1: saved answers. The user's own words for prose questions, kept in answers.md only with their consent, offered
// again only when Jev matches the question, code finds no other organization in them and the field fits them, and
// never written without being shown whole. All people, organizations and text here are invented.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../src/memory/documents.ts";
import { AnswerError, answerNow, capture, putAnswer, savedAnswers, type SavedAnswer } from "../src/memory/answers.ts";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { guardAnswer, namesIn, pageText } from "../src/fill/answers.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { buildFillPopup, fillPlan, recheckFill, writtenFields } from "../src/offers/fill-popup.ts";
import { carriesAnswer, SAVED_ANSWER_RULE, withoutAnswers } from "../src/offers/answer-gate.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { FillProposal, PROTOCOL_VERSION, type AnswerFields, type HelperMessage, type Node } from "../src/protocol.ts";
import { field, node, snap } from "./builders.ts";
import { minted } from "./mint.ts";
/** W2: writtenFields on a hand-built proposal whose written fields the write contract minted first (test/mint.ts). */
const writtenMinted = async (p: FillProposal, ...rest: Parameters<typeof writtenFields> extends [unknown, ...infer R] ? R : never): Promise<ReturnType<typeof writtenFields>> => writtenFields(await minted(p), ...rest);

const CHROME = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const RAMP = "https://jobs.ashbyhq.com/ramp/34413f8d/application";

const WHY_NORTHWIND =
  "I've wanted to work on software that moves physical things for a long time, and Northwind Robotics is the team I'd learn the most from. The dispatch planner is the product I'd most like to make faster.";
const PROJECT =
  "The project I'm proudest of is a billing migration I led two years ago. Our invoices were built by a nightly job that had grown to four hours, and a failed run meant late bills for thousands of customers. I split it into small idempotent steps, ran the old and new paths side by side for a month, and moved customers over in batches. The job now takes eleven minutes, and nobody has been billed twice since.";

const saved = (id: string, question: string, answer: string, site: string | null = "https://job-boards.greenhouse.io/northwind/jobs/101"): SavedAnswer => ({
  id,
  status: "active",
  fields: { question, answer, site, form: "Job Application for Software Engineer at Northwind Robotics", savedOn: "2026-10-01T12:00:00.000Z" },
});

/** A page window: a form whose textareas are `prose`, each a node with that label (and maxLength, entry, value as given). */
function pageModel(title: string, prose: { key: string; label: string; extra?: Partial<Node> }[], kind = "page"): ScreenModel {
  const model = new ScreenModel();
  const nodes: Node[] = [node("frame-0", "AXWebArea", { label: title }), field("f-name", "", { label: "Full name", frame: [10, 10, 200, 20] })];
  prose.forEach((p, i) => nodes.push(node(p.key, "AXTextArea", { label: p.label, editable: true, frame: [10, 60 + i * 120, 400, 100], ...p.extra })));
  model.apply(snap(nodes, { at: 1000, windowId: "page-eng1-7", title, kind, app: CHROME, focused: true, focusedKey: prose[0]?.key ?? "f-name" }));
  return model;
}

/**
 * A fake Jev that answers each saved-answer question by the question an answer was saved for (`pick` returns it, or
 * null for none), whatever the ask's ids, and every other question "none".
 */
function jevPickingQuestion(pick: (instructions: string) => string | null, confidence = 0.92, sent: JevRequest[] = []): AskJev {
  return async (req) => {
    sent.push(req);
    return {
      model: "jev-test",
      answers: Object.fromEntries(
        Object.entries(req.questions).map(([id, q]) => {
          if (!id.endsWith("_answer")) return [id, { choice: "none", confidence }];
          const want = pick(String(q.instructions));
          const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.includes(`question "${want}"`));
          return [id, { choice: hit?.[0] ?? "none", confidence }];
        }),
      ),
      inputTokens: 500,
      latencyMs: 10,
      costUsd: 0.00002,
    };
  };
}

describe("answers.md", () => {
  let dir: string;
  let store: MemoryDocumentStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-answers-"));
    store = new MemoryDocumentStore(join(dir, "Memory"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const fields = (question: string, answer: string, site: string | null = RAMP): AnswerFields => ({ question, answer, site, form: "Security Engineer, Cloud @ Ramp", savedOn: "2026-10-05T10:00:00.000Z" });

  it("keeps an answer verbatim, line breaks and quotes included, in its own readable file", () => {
    const words = 'First paragraph, with "quotes".\n\nSecond paragraph.  Two spaces stay.';
    const id = putAnswer(store, fields("What has been your proudest accomplishment?", words));
    const text = readFileSync(join(dir, "Memory", "answers.md"), "utf8");
    expect(text.startsWith("# Saved answers\n")).toBe(true);
    expect(text).toContain(`## What has been your proudest accomplishment? <!-- caret:id=${id} kind=answer -->`);
    // A fresh store reads back exactly what was saved.
    const again = new MemoryDocumentStore(join(dir, "Memory"));
    expect(answerNow(again, id)?.fields.answer).toBe(words);
    again.close();
  });

  it("updates the answer to the same question on the same site, and keeps another site's apart", () => {
    const a = putAnswer(store, fields("Why do you want to work here?", "Because of the mission, first version."));
    const b = putAnswer(store, fields("Why do you want to work here?", "Because of the mission, second version."));
    const c = putAnswer(store, fields("Why do you want to work here?", "A different company's answer.", "https://jobs.lever.co/brightfern/1/apply"));
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(savedAnswers(store).map((x) => x.fields.answer).sort()).toEqual(["A different company's answer.", "Because of the mission, second version."]);
  });

  it("refuses an answer holding what Caret never keeps, saying so, and writes nothing", () => {
    let caught: unknown = null;
    try {
      putAnswer(store, fields("Anything else?", "My card is 4111 1111 1111 1111 if you need it."));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AnswerError);
    expect((caught as AnswerError).why).toBe("secret");
    expect((caught as AnswerError).message).toContain("Caret doesn't keep card numbers in memory");
    expect(savedAnswers(store)).toEqual([]);
  });

  it("disables an answer the user edits to state a secret, naming the line (fix-check finding 4)", () => {
    const id = putAnswer(store, fields("Anything else?", "Original words."));
    const path = join(dir, "Memory", "answers.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("- Answer: Original words.", "- Answer: My password is violet-orchard-seven."));
    expect(answerNow(store, id)).toBeNull();
    expect(store.disabledWhy(id, "answer")).toContain("Caret doesn't keep passwords in memory");
  });

  it("follows the user's edit: a paused answer is not offered, and an edited one is read as edited", () => {
    const id = putAnswer(store, fields("Why do you want to work here?", "Original words."));
    const path = join(dir, "Memory", "answers.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("- Answer: Original words.", "- Answer: My edited words.").replace("- Status: active", "- Status: paused"));
    const now = answerNow(store, id);
    expect(now?.fields.answer).toBe("My edited words.");
    expect(now?.status).toBe("paused");
  });
});

describe("capture: only the user's own typing, on a page form's prose field", () => {
  const typed = { entry: "typed" as const, value: PROJECT };
  const one = (extra: Partial<Node> = typed, kind = "page") =>
    capture(pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "What has been your proudest accomplishment?", extra }], kind).windows.get("page-eng1-7")!, "q1", { site: RAMP, caretWrote: [] });

  it("captures what the user typed, with the question, site and form", () => {
    expect(one()).toEqual({ ok: true, fields: { question: "What has been your proudest accomplishment?", answer: PROJECT, site: RAMP, form: "Security Engineer, Cloud @ Ramp" } });
  });

  it("refuses text Caret wrote, though the page saw only typing in the field", () => {
    const w = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "What has been your proudest accomplishment?", extra: typed }]).windows.get("page-eng1-7")!;
    // Caret's executor wrote part of this text earlier; the user typed the rest around it.
    const r = capture(w, "q1", { site: RAMP, caretWrote: [PROJECT.slice(40, 120)] });
    expect(r).toEqual({ ok: false, why: "caretWrote", says: "Caret wrote some of this text, so it isn't yours to save." });
  });

  it("refuses a script's change (the page's, or Caret's own page write), a paste, and text it never saw typed", () => {
    expect(one({ value: PROJECT, entry: "other" })).toMatchObject({ ok: false, why: "notTyped" });
    expect(one({ value: PROJECT, entry: "pasted" })).toEqual({ ok: false, why: "pasted", says: "You pasted some of this text, so Caret can't tell the words are yours." });
    expect(one({ value: PROJECT })).toEqual({ ok: false, why: "unseen", says: "Caret didn't see you type this, so it won't save it as yours." });
  });

  it("refuses what the never-typed classifier flags, and a secret in the text", () => {
    const ssn = pageModel("Form", [{ key: "q1", label: "Social Security number", extra: { value: "123-45-6789", entry: "typed" } }]).windows.get("page-eng1-7")!;
    expect(capture(ssn, "q1", { site: null, caretWrote: [] })).toMatchObject({ ok: false, why: "neverTyped", says: "Caret doesn't keep government ID numbers in memory." });
    expect(one({ value: `${PROJECT} Card 4111 1111 1111 1111.`, entry: "typed" })).toMatchObject({ ok: false, why: "secret" });
    // Review finding 6: a secret the text states, though no shape gives it away.
    expect(one({ value: `${PROJECT} My password is violet-orchard-seven.`, entry: "typed" })).toEqual({ ok: false, why: "secret", says: "Caret doesn't keep passwords in memory, and this answer has one." });
    expect(one({ value: `${PROJECT} I built the password reset flow.`, entry: "typed" })).toMatchObject({ ok: true });
    // Fix-check finding 4: the same secret said other ways.
    for (const s of ["Password: violet-orchard-seven.", "My password for the demo is violet-orchard-seven.", "My PIN is 7319."]) {
      expect(one({ value: `${PROJECT} ${s}`, entry: "typed" }), s).toMatchObject({ ok: false, why: "secret" });
    }
  });

  it("refuses a native window, a short one-line field, and a field with no label", () => {
    expect(one(typed, "standard")).toMatchObject({ ok: false, why: "notPage" });
    const model = new ScreenModel();
    model.apply(snap([field("short", "Alex", { label: "Preferred name", entry: "typed" }), node("bare", "AXTextArea", { editable: true, value: PROJECT, entry: "typed" })], { at: 1, windowId: "w", kind: "page", app: CHROME }));
    const w = model.windows.get("w")!;
    expect(capture(w, "short", { site: null, caretWrote: [] })).toMatchObject({ ok: false, why: "notProse" });
    expect(capture(w, "bare", { site: null, caretWrote: [] })).toMatchObject({ ok: false, why: "noQuestion" });
  });
});

describe("the organization guard", () => {
  const page = (title: string, site: string | null = null, labels: string[] = []) =>
    pageText(pageModel(title, labels.map((label, i) => ({ key: `q${i}`, label }))).windows.get("page-eng1-7")!, { site, headings: [] });

  it("names what a text names, not its sentence openers", () => {
    expect(namesIn(WHY_NORTHWIND)).toEqual(["Northwind Robotics"]);
    expect(namesIn("The team at Harbor & Pine shipped it. When I joined, AWS and Terraform ran everything.")).toEqual(["Harbor & Pine", "AWS", "Terraform"]);
    expect(namesIn(PROJECT)).toEqual([]);
    // A sentence capitalizes its first word: alone, that is no name (the corpus's "Month-end", "Tools", "Describe").
    expect(namesIn("Month-end close was mine. Tools like that help. Describe it and you see why.")).toEqual([]);
    // It is one when the texts use it as one: where the answer was saved, or mid-sentence.
    expect(namesIn("Quillmate changed how I write.", ["Why are you interested in Quillmate?"])).toEqual(["Quillmate"]);
    expect(namesIn("Contoso hired me in 2019. I left Contoso in 2023.")).toEqual(["Contoso"]);
    expect(namesIn("Harbor & Pine shipped it.")).toEqual(["Harbor & Pine"]);
  });

  it("withholds an answer written for another organization, naming both", () => {
    const why = saved("a1", "Why do you want to work at Northwind Robotics?", WHY_NORTHWIND);
    expect(guardAnswer(why, page("Security Engineer, Cloud @ Ramp", RAMP), undefined)).toEqual({ why: "otherOrganization", says: "This answer was written for Northwind Robotics; this page is for Ramp." });
    // Saved elsewhere and naming it only in its text: it mentions the organization.
    const text = { ...saved("a2", "Anything else we should know?", WHY_NORTHWIND, "https://jobs.lever.co/larkspur/1/apply"), fields: { ...saved("a2", "Anything else we should know?", WHY_NORTHWIND, "https://jobs.lever.co/larkspur/1/apply").fields, form: "Larkspur Health - Site Reliability Engineer" } };
    expect(guardAnswer(text, page("Job Application for Commercial Policy Lead at Discord"), undefined)).toEqual({ why: "otherOrganization", says: "This answer mentions Northwind Robotics; this page is for Discord." });
    // A page code cannot name: the sentence says only what the answer mentions.
    expect(guardAnswer(text, page("Careers"), undefined)?.says).toBe("This answer mentions Northwind Robotics, which this page doesn't.");
  });

  it("withholds an answer for the organization it was saved for, however the text names it, or a why-us answer anywhere else", () => {
    const stripe = (answer: string, question = "Why us?", form = "Job Application for Engineer at Stripe") =>
      ({ id: "s", status: "active" as const, fields: { question, answer, site: "https://job-boards.greenhouse.io/stripe/jobs/1", form, savedOn: "2026-10-01T12:00:00.000Z" } });
    const ramp = page("Security Engineer, Cloud @ Ramp", RAMP);
    // Review finding 2: a sentence's first word, and a lower-case name.
    expect(guardAnswer(stripe("Stripe builds the tools I want to work on."), ramp, undefined)?.says).toBe("This answer was written for Stripe; this page is for Ramp.");
    expect(guardAnswer(stripe("I admire stripe and want to join the team.", "Anything else?"), ramp, undefined)?.why).toBe("otherOrganization");
    // A why-us answer that names no one is still for the organization it was saved for.
    expect(guardAnswer(stripe("The mission matters to me.", "Why do you want to work here?"), ramp, undefined)?.says).toBe("This answer was written for Stripe; this page is for Ramp.");
    // Saved where code could not tell for whom: a why-us answer is offered nowhere else.
    const unknown = { id: "u", status: "active" as const, fields: { question: "Why us?", answer: "The mission matters to me.", site: null, form: "Careers", savedOn: "2026-10-01T12:00:00.000Z" } };
    expect(guardAnswer(unknown, ramp, undefined)?.says).toBe("This answer was written for another organization's form; this page is for Ramp.");
    // On the organization's own page it is offered.
    expect(guardAnswer(stripe("Stripe builds the tools I want to work on."), page("Job Application for Backend Engineer at Stripe", "https://job-boards.greenhouse.io/stripe/jobs/2"), undefined)).toBeNull();
  });

  it("judges two pages one organization only on affirmative evidence (fix-check finding 3)", () => {
    const why = (site: string | null, form: string) => ({ id: "w", status: "active" as const, fields: { question: "Why us?", answer: "The mission matters to me.", site, form, savedOn: "2026-10-01T12:00:00.000Z" } });
    const stripe = why("https://job-boards.greenhouse.io/stripe/jobs/1", "Job Application for Engineer at Stripe");
    // A page that only mentions the organization in a label is not theirs.
    expect(guardAnswer(stripe, page("Careers", "https://acme.example/jobs/1", ["Have you used Stripe?"]), undefined)?.why).toBe("otherOrganization");
    // The embed route and a non-ATS host's path name no one.
    const embed = why("https://job-boards.greenhouse.io/embed/job_app?for=stripe", "Careers");
    expect(guardAnswer(embed, page("Careers", "https://job-boards.greenhouse.io/embed/job_app?for=acme"), undefined)?.why).toBe("otherOrganization");
    expect(guardAnswer(why("https://acme.example/jobs/1", "Careers"), page("Careers", "https://acme.example/jobs/2"), undefined)?.why).toBe("otherOrganization");
    // Two names that differ are two organizations, whatever the addresses say.
    expect(guardAnswer(stripe, page("Job Application for Engineer at Acme", "https://job-boards.greenhouse.io/stripe/jobs/9"), undefined)?.why).toBe("otherOrganization");
    // A site's own title suffix is not part of the name; the same tenant with no name in the title is the same.
    expect(guardAnswer(stripe, page("Job Application for Backend Engineer at Stripe | Greenhouse"), undefined)).toBeNull();
    expect(guardAnswer(stripe, page("Apply", "https://job-boards.greenhouse.io/stripe/jobs/7"), undefined)).toBeNull();
  });

  it("never lets what the applicant typed on the page vouch for an answer (review finding 3)", () => {
    // Saved on another organization's form, naming Northwind only in passing: only the page's own text may vouch for it.
    const base = saved("a1", "Anything else we should know?", WHY_NORTHWIND, "https://jobs.lever.co/larkspur/1/apply");
    const passing = { ...base, fields: { ...base.fields, form: "Larkspur Health - Site Reliability Engineer" } };
    const model = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "Previous employer", extra: { value: "Northwind Robotics", entry: "typed" } }]);
    expect(guardAnswer(passing, pageText(model.windows.get("page-eng1-7")!, { site: RAMP, headings: [] }), undefined)?.says).toBe("This answer mentions Northwind Robotics; this page is for Ramp.");
  });

  it("offers an answer naming the page's own organization, or no organization at all", () => {
    const why = saved("a1", "Why do you want to work at Northwind Robotics?", WHY_NORTHWIND);
    expect(guardAnswer(why, page("Job Application for Senior Engineer, Dispatch at Northwind Robotics"), undefined)).toBeNull();
    expect(guardAnswer(saved("a3", "What has been your proudest accomplishment?", PROJECT), page("Security Engineer, Cloud @ Ramp"), undefined)).toBeNull();
  });

  it("withholds an answer longer than the field's maxlength, never cutting it", () => {
    const a = saved("a3", "What has been your proudest accomplishment?", PROJECT);
    expect(guardAnswer(a, page("Brightfern - Software Engineer"), 300)).toEqual({ why: "tooLong", says: `This answer is ${PROJECT.length} characters, and this field takes at most 300.` });
    expect(guardAnswer(a, page("Brightfern - Software Engineer"), PROJECT.length)).toBeNull();
  });
});

describe("matching a saved answer in fill", () => {
  const answers = [saved("a1", "Why do you want to work at Northwind Robotics?", WHY_NORTHWIND), saved("a3", "What has been your proudest accomplishment?", PROJECT, null)];

  it("asks one Choice per prose field between the saved answers and none, carrying only each answer's first 300 characters, as memory", async () => {
    const sent: JevRequest[] = [];
    const model = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "What has been your favorite project or proudest accomplishment? Why?" }]);
    const p = await proposeFill(model, jevPickingQuestion(() => "What has been your proudest accomplishment?", 0.9, sent), "page-eng1-7", "q1", 2000, { answers, page: { site: RAMP, headings: [] }, rand: () => 0 });
    const f = p.fields.find((x) => x.key === "q1")!;
    expect(FillProposal.parse(p)).toBeTruthy();
    expect(f).toMatchObject({ value: PROJECT, source: null, memory: { id: "a3", label: "What has been your proudest accomplishment?", says: "your saved answer" }, withheld: null });
    expect(f.answer).toEqual({ id: "a3", question: "What has been your proudest accomplishment?", site: null, form: answers[1]!.fields.form, savedOn: "2026-10-01T12:00:00.000Z", withheld: null });
    expect(sent).toHaveLength(2);
    for (const r of sent) {
      const q = Object.entries(r.questions).find(([id]) => id.endsWith("_answer"))?.[1];
      expect(Object.keys(q?.criteria ?? {}).sort()).toHaveLength(3);
      const body = JSON.stringify(r.questions);
      expect(body).toContain(PROJECT.slice(0, 300));
      expect(body).not.toContain(PROJECT.slice(300));
      // Declared as memory, as the ledger charged it; no window is charged for the user's own words.
      expect(r.snippets.filter((s) => s.windowId === "memory").map((s) => s.text)).toEqual(expect.arrayContaining(["What has been your proudest accomplishment?", `${PROJECT.slice(0, 300)}…`]));
    }
  });

  it("offers an answer saved for the very question the page asks, though its long label is the page's own prose", async () => {
    const long = "We believe exceptional performance in one area is a good indication of performance in other areas. Do you have any examples of exceptional performance you want to highlight?";
    const model = pageModel("Security Engineer, Cloud @ Ramp", [
      { key: "q0", label: "Please elaborate on your experience building software in AWS (with Terraform)" },
      { key: "q1", label: long },
    ]);
    const mine = [saved("a10", long, PROJECT, null)];
    const p = await proposeFill(model, jevPickingQuestion(() => `${long.slice(0, 59)}…`), "page-eng1-7", "q0", 2000, { answers: mine, page: { site: RAMP, headings: [] } });
    expect(p.fields.find((x) => x.key === "q1")).toMatchObject({ value: PROJECT, withheld: null });
  });

  it("asks a text area whose question names a kind ('Describe a time…')", async () => {
    const model = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "Describe a time you received difficult feedback. How did you respond?" }]);
    const p = await proposeFill(model, jevPickingQuestion(() => "What has been your proudest accomplishment?"), "page-eng1-7", "q1", 2000, { answers, page: { site: RAMP, headings: [] } });
    expect(p.fields.find((x) => x.key === "q1")?.answer?.id).toBe("a3");
  });

  it("withholds the right answer for the wrong company, with the sentence", async () => {
    const model = pageModel("Job Application for Commercial Policy Lead at Discord", [{ key: "q1", label: "Why do you want to work at Discord?" }]);
    const p = await proposeFill(model, jevPickingQuestion(() => "Why do you want to work at Northwind Robotics?"), "page-eng1-7", "q1", 2000, { answers, page: { site: "https://job-boards.greenhouse.io/discord/jobs/8806482002", headings: [] } });
    const f = p.fields.find((x) => x.key === "q1")!;
    expect(f.value).toBeNull();
    expect(f.withheld).toBe("otherPerson");
    expect(f.answer?.withheld).toEqual({ why: "otherOrganization", says: "This answer was written for Northwind Robotics; this page is for Discord." });
  });

  it("withholds an answer longer than the field's maxlength", async () => {
    const model = pageModel("Brightfern - Software Engineer", [{ key: "q1", label: "What's the accomplishment you're proudest of?", extra: { maxLength: 300 } }]);
    const p = await proposeFill(model, jevPickingQuestion(() => "What has been your proudest accomplishment?"), "page-eng1-7", "q1", 2000, { answers, page: { site: null, headings: [] } });
    const f = p.fields.find((x) => x.key === "q1")!;
    expect([f.value, f.withheld, f.answer?.withheld?.why]).toEqual([null, "wrongKind", "tooLong"]);
  });

  it("offers nothing when the asks disagree or are unsure, and asks nothing about answers without them", async () => {
    const model = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "Tell us about a project you're proud of." }]);
    let n = 0;
    const split: AskJev = jevPickingQuestion(() => (n++ === 0 ? "What has been your proudest accomplishment?" : null));
    const p = await proposeFill(model, split, "page-eng1-7", "q1", 2000, { answers, page: { site: RAMP, headings: [] } });
    expect(p.fields.find((x) => x.key === "q1")).toMatchObject({ value: null, withheld: "disagree" });
    // Review finding 4: no answer text rides in the asks, which a host without the capability is sent.
    expect(JSON.stringify(p)).not.toContain(PROJECT.slice(0, 40));
    const low = await proposeFill(model, jevPickingQuestion(() => "What has been your proudest accomplishment?", 0.6), "page-eng1-7", "q1", 2000, { answers, page: { site: RAMP, headings: [] } });
    expect(low.fields.find((x) => x.key === "q1")).toMatchObject({ value: null, withheld: "lowConfidence" });
    expect(JSON.stringify(low)).not.toContain(PROJECT.slice(0, 40));
    const sent: JevRequest[] = [];
    await proposeFill(model, jevPickingQuestion(() => null, 0.9, sent), "page-eng1-7", "q1", 2000, {}).catch(() => undefined);
    expect(sent.some((r) => Object.keys(r.questions).some((q) => q.endsWith("_answer")))).toBe(false);
  });
});

describe("a saved answer is never written without the user seeing it whole", () => {
  const answerField = (key: string, answer: string) => ({
    key,
    control: "text" as const,
    handoff: null,
    frame: null,
    descriptor: "Text area.",
    choice: "s1",
    confidence: 0.9,
    value: answer,
    source: null,
    memory: { id: `ans-${key}`, label: "What has been your proudest accomplishment?", says: "your saved answer" },
    withheld: null,
    asks: [] as [],
    answer: { id: `ans-${key}`, question: "What has been your proudest accomplishment?", site: null, form: null, savedOn: "2026-10-01T12:00:00.000Z", withheld: null },
  });
  const valueField = (key: string, value: string) => ({
    key,
    control: "text" as const,
    handoff: null,
    frame: null,
    descriptor: "Text field.",
    choice: "c1",
    confidence: 0.9,
    value,
    source: { pid: 1, windowId: "notes", bundleId: "n", appName: "Notes", windowTitle: "Me", nodeKey: "n1", kind: null },
    memory: null,
    withheld: null,
    asks: [] as [],
  });
  const proposal = (fields: unknown[]): FillProposal =>
    FillProposal.parse({ type: "fillProposal", v: PROTOCOL_VERSION, id: "p1", at: 1, pid: CHROME.pid, windowId: "page-eng1-7", bundleId: CHROME.bundleId, triggerKey: "q1", fields, candidates: 1, jev: { model: "jev-test", latencyMs: 1, inputTokens: 1, costUsd: 0 }, cutoff: 0.75 });

  it("shows every answer in a pop-up row, whole, ahead of fields that fold into 'and N more'", async () => {
    const model = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "Proudest accomplishment?" }]);
    const fields = [...["a", "b", "c", "d", "e", "f"].map((k) => valueField(`v-${k}`, `value ${k}`)), answerField("q1", PROJECT)];
    const spec = buildFillPopup(model, await writtenMinted(proposal(fields))).spec;
    const block = spec.blocks.find((b) => b.type === "fields") as { rows: { value?: { text: string; ref: unknown } }[]; more?: number };
    const row = block.rows.find((r) => r.value?.text === PROJECT);
    expect(row?.value?.ref).toEqual({ rule: SAVED_ANSWER_RULE, derived: [{ memory: "ans-q1" }] });
    expect(block.rows).toHaveLength(5);
    expect(block.more).toBe(2);
  });

  it("writes no more answers than one pop-up shows, and none from Command-1, which shows nothing first", async () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((k) => answerField(`q-${k}`, `${PROJECT} (${k})`));
    expect((await writtenMinted(proposal(six))).fields).toHaveLength(5);
    expect((await writtenMinted(proposal([...six.slice(0, 1), valueField("v", "x")]), undefined, { answers: false })).fields.map((f) => f.key)).toEqual(["v"]);
  });

  it("keeps an answer out of step sentences, and gates a task that writes one (fix-check finding 1)", async () => {
    const model = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "Proudest accomplishment?" }]);
    const g = await writtenMinted(proposal([answerField("q1", PROJECT), valueField("v", "x")]));
    const { plan } = fillPlan(model, g);
    expect((plan as { steps: { says: string }[] }).steps.map((s) => s.says)).toEqual(["{{l0}} holds your saved answer", "{{l1}} holds {{v1}}"]);
    const progress = { type: "taskProgress", v: PROTOCOL_VERSION, at: 1, taskId: "p1", planId: "p1", phase: "acting", step: 0, steps: 2, says: null, detail: `write value; expect q1: '' becomes '${PROJECT.slice(0, 30)}'`, stopReason: null } as unknown as HelperMessage;
    expect(carriesAnswer(progress, (id) => id === "p1")).toBe(true);
    expect(carriesAnswer(progress, () => false)).toBe(false);
  });

  it("sends a host without the capability no answer, and stops a pop-up whose answer changed in answers.md", async () => {
    const p = proposal([answerField("q1", PROJECT), valueField("v", "x")]);
    expect(carriesAnswer(p)).toBe(true);
    const stripped = withoutAnswers(p);
    expect(JSON.stringify(stripped)).not.toContain(PROJECT.slice(0, 40));
    expect(FillProposal.parse(stripped).fields[0]).toMatchObject({ value: null, memory: null, choice: "none" });
    const model = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "Proudest accomplishment?" }]);
    const g = await writtenMinted(proposal([answerField("q1", PROJECT)]));
    g.fields[0] = { ...g.fields[0]!, descriptor: "Text area. Label: 'Proudest accomplishment?'." };
    const same = (): SavedAnswer => saved("ans-q1", "What has been your proudest accomplishment?", PROJECT, null);
    expect(recheckFill(model, g, () => null, same)).toBeNull();
    expect(recheckFill(model, g, () => null, () => saved("ans-q1", "What has been your proudest accomplishment?", `${PROJECT} Edited.`, null))).toBe('your saved answer to "What has been your proudest accomplishment?" changed');
    expect(recheckFill(model, g, () => null)).not.toBeNull();
    // The guards run again before the write: a page that lowered the field's maxlength since the offer stops it.
    const lowered = pageModel("Security Engineer, Cloud @ Ramp", [{ key: "q1", label: "Proudest accomplishment?", extra: { maxLength: 10 } }]);
    expect(recheckFill(lowered, g, () => null, same)).toBe(`This answer is ${PROJECT.length} characters, and this field takes at most 10.`);
  });
});

describe("saving through the helper: an offer when the user leaves the field, and only their yes saves", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let out: HelperMessage[];
  /** What the page holds now: a walk (the reader link below) shows it, as the page engine would. */
  let page: { value: string; entry: Node["entry"] };
  let walks = 0;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-answers-helper-"));
    store = new Store(join(dir, "data"));
    out = [];
    walks = 0;
    page = { value: "", entry: undefined };
    const readerLink = {
      run: async (verb: { kind: string }) => {
        if (verb.kind === "walk") {
          walks++;
          await walk(page.value, page.entry, "f-name", 9000 + walks);
        }
        return { type: "verbResult" as const, v: PROTOCOL_VERSION, id: "page", at: 1, outcome: "ok" as const, detail: null };
      },
    };
    helper = new Helper({ store, askJev: () => Promise.reject(new Error("no Jev here")), shadow: false, allowBackgroundFocus: true, publish: (m) => void out.push(m), pageContext: () => ({ site: RAMP, headings: [] }), readerLink: readerLink as never });
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const walk = (value: string, entry: Node["entry"], focusedKey: string, at: number) => {
    page = { value, entry };
    return helper.handleReader(
      snap([node("frame-0", "AXWebArea", { label: "Ramp" }), node("q1", "AXTextArea", { label: "What has been your proudest accomplishment?", editable: true, value, ...(entry === undefined ? {} : { entry }) }), field("f-name", "", { label: "Full name" })], {
        at,
        windowId: "page-eng1-7",
        kind: "page",
        title: "Security Engineer, Cloud @ Ramp",
        app: CHROME,
        focused: true,
        focusedKey,
      }),
    );
  };

  it("offers to save typed text when focus leaves the field, and saves it on the user's yes", async () => {
    helper.setAnswerHosts(1);
    await walk(PROJECT, "typed", "q1", 1000);
    await walk(PROJECT, "typed", "f-name", 2000);
    const offer = out.find((m) => m.type === "answerSaveOffer");
    expect(offer).toMatchObject({ question: "What has been your proudest accomplishment?", answer: PROJECT, site: RAMP, says: "Save this answer for next time?", replaces: null });
    expect(savedAnswers(helper.memory.files!)).toEqual([]);
    const reply = await helper.handleAnswerSave({ type: "answerSave", v: PROTOCOL_VERSION, requestId: "r1", from: { kind: "offer", offerId: (offer as { id: string }).id } });
    expect(reply).toMatchObject({ outcome: "saved", why: null, says: 'Saved your answer to "What has been your proudest accomplishment?".' });
    expect(savedAnswers(helper.memory.files!).map((a) => a.fields.answer)).toEqual([PROJECT]);
  });

  it("makes no offer without a host that shows answers, or for text the user did not type", async () => {
    await walk(PROJECT, "typed", "q1", 1000);
    await walk(PROJECT, "typed", "f-name", 2000);
    helper.setAnswerHosts(1);
    await walk(PROJECT, "other", "q1", 3000);
    await walk(PROJECT, "other", "f-name", 4000);
    expect(out.filter((m) => m.type === "answerSaveOffer")).toEqual([]);
  });

  it("refuses a yes when the text changed since the offer, and a direct save of pasted text", async () => {
    helper.setAnswerHosts(1);
    await walk(PROJECT, "typed", "q1", 1000);
    await walk(PROJECT, "typed", "f-name", 2000);
    const offer = out.find((m) => m.type === "answerSaveOffer") as { id: string };
    await walk(`${PROJECT} And one more line.`, "typed", "f-name", 3000);
    expect(await helper.handleAnswerSave({ type: "answerSave", v: PROTOCOL_VERSION, requestId: "r1", from: { kind: "offer", offerId: offer.id } })).toMatchObject({ outcome: "refused", why: "changed", answerId: null });
    await walk(PROJECT, "pasted", "f-name", 4000);
    expect(await helper.handleAnswerSave({ type: "answerSave", v: PROTOCOL_VERSION, requestId: "r2", from: { kind: "field", windowId: "page-eng1-7", fieldKey: "q1" } })).toEqual({
      type: "answerSaveReply",
      v: PROTOCOL_VERSION,
      requestId: "r2",
      outcome: "refused",
      answerId: null,
      why: "pasted",
      says: "You pasted some of this text, so Caret can't tell the words are yours.",
    });
    expect(savedAnswers(helper.memory.files!)).toEqual([]);
  });

  it("walks the page again at the user's yes, and refuses what a script changed since the offer (review finding 5)", async () => {
    helper.setAnswerHosts(1);
    await walk(PROJECT, "typed", "q1", 1000);
    await walk(PROJECT, "typed", "f-name", 2000);
    const offer = out.find((m) => m.type === "answerSaveOffer") as { id: string };
    // The page's script rewrote the field after the last snapshot; only a fresh walk shows it.
    page = { value: `${PROJECT} Added by the page.`, entry: "other" };
    const reply = await helper.handleAnswerSave({ type: "answerSave", v: PROTOCOL_VERSION, requestId: "r1", from: { kind: "offer", offerId: offer.id } });
    expect(walks).toBe(1);
    expect(reply).toMatchObject({ outcome: "refused", why: "notTyped" });
    expect(savedAnswers(helper.memory.files!)).toEqual([]);
  });

  it("refuses a yes when the walk refreshed nothing for that page (fix-check finding 2)", async () => {
    helper.setAnswerHosts(1);
    await walk(PROJECT, "typed", "q1", 1000);
    await walk(PROJECT, "typed", "f-name", 2000);
    const offer = out.find((m) => m.type === "answerSaveOffer") as { id: string };
    // The walk answers ok but applies nothing to this window (it walked another tab, say).
    (helper as unknown as { opts: { readerLink: unknown } }).opts.readerLink = { run: async () => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "page", at: 1, outcome: "ok", detail: null }) };
    expect(await helper.handleAnswerSave({ type: "answerSave", v: PROTOCOL_VERSION, requestId: "r1", from: { kind: "offer", offerId: offer.id } })).toMatchObject({ outcome: "refused", why: "unavailable" });
    expect(savedAnswers(helper.memory.files!)).toEqual([]);
  });

  it("guards an answer again right before the executor writes it (fix-check finding 5)", async () => {
    const files = helper.memory.files!;
    const id = putAnswer(files, { question: "What has been your proudest accomplishment?", answer: PROJECT, site: null, form: null, savedOn: "2026-10-01T12:00:00.000Z" });
    await walk("", undefined, "q1", 1000);
    const h = helper as unknown as { answerWrites: Map<string, unknown[]>; memoryHolds(ref: string, value: string): boolean };
    h.answerWrites.set("task-1", [{ answerId: id, windowId: "page-eng1-7", key: "q1" }]);
    expect(h.memoryHolds(id, PROJECT)).toBe(true);
    // The page lowered the field's maxlength after the user's Tab; the executor's fresh read shows it.
    await helper.handleReader(snap([node("q1", "AXTextArea", { label: "What has been your proudest accomplishment?", editable: true, maxLength: 10 }), field("f-name", "", { label: "Full name" })], { at: 2000, windowId: "page-eng1-7", kind: "page", title: "Security Engineer, Cloud @ Ramp", app: CHROME, focused: true, focusedKey: "q1" }));
    expect(h.memoryHolds(id, PROJECT)).toBe(false);
  });

  it("never saves what Caret's own executor wrote into the field", async () => {
    helper.setAnswerHosts(1);
    // The journal sees every write the executor is about to make; this is that hook, as a run of Caret's would call it.
    (helper as unknown as { noteWrite(w: string, k: string, v: string): void }).noteWrite("page-eng1-7", "q1", PROJECT);
    await walk(PROJECT, "typed", "q1", 1000);
    await walk(PROJECT, "typed", "f-name", 2000);
    expect(out.filter((m) => m.type === "answerSaveOffer")).toEqual([]);
    expect(await helper.handleAnswerSave({ type: "answerSave", v: PROTOCOL_VERSION, requestId: "r1", from: { kind: "field", windowId: "page-eng1-7", fieldKey: "q1" } })).toMatchObject({ outcome: "refused", why: "caretWrote" });
  });
});

describe("the page engine carries what saved answers need", () => {
  it("passes a field's maxlength and how its text was entered from the walk into the screen model", async () => {
    const { toWindowSnapshot } = await import("../src/engines/page-link.ts");
    const { EngineSession } = await import("../src/engines/session.ts");
    const session = new EngineSession({ engine: "eng1", browser: CHROME, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
    const s = toWindowSnapshot(
      {
        type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
        frames: [{
          frameId: 0, parentFrameId: -1, documentId: "D0", origin: "https://jobs.ashbyhq.com", path: "/ramp/1/application", navGen: 1, title: "Apply", headings: [], iframes: [], excluded: {}, truncated: false,
          controls: [{ id: "e1", key: "form/textbox:why~0", strongKey: null, kind: "textarea", role: "textbox", name: "Why Ramp?", value: "Because", form: null, rect: [0, 0, 100, 40], maxLength: 500, entry: "typed" }],
        }],
        focused: null, missing: [],
      } as never,
      session,
      1,
    );
    expect(s.nodes.find((n) => n.role === "AXTextArea")).toMatchObject({ maxLength: 500, entry: "typed" });
  });
});
