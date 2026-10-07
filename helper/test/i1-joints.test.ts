// I1: the four joints where G2's ownership and redaction (v2/whose) meet W2's write contract (v2/wrongs), each through
// the code that runs in the product. The verifier here is the request path itself (setTestVerifier(null)): a scripted
// Jev answers its questions and records every request. All names, numbers and addresses are synthetic.
import { TEST_AUTHORITY } from "./mint.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { AboutValue } from "../src/fill/about.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { makeFieldContract, provenanceSays, setTestVerifier, verifyProposed, VerifierUnavailable, guardFor, type Proposed } from "../src/fill/contract.ts";
import { fieldKinds } from "../src/fill/kinds.ts";
import { fillPlan, recheckFill, writtenFields } from "../src/offers/fill-popup.ts";
import { assertNoExcludedValue } from "../src/privacy.ts";
import type { HelperMessage, TaskProgress } from "../src/protocol.ts";
import { field, MAIL_APP, snap, text } from "./builders.ts";
import { executorWindow, FakeApp, K, WIN, wireButtons } from "./fake-app.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { holds } from "./recheck.ts";

const T0 = 1_790_000_000_000;
const ME = "jo.abernathy@example.com";
const ABOUT: AboutValue[] = [{ id: "about-1", label: "email", value: ME, kind: "email" }];

beforeAll(() => setTestVerifier(null));
afterAll(() => setTestVerifier(STAND_IN));

/** Every string a request carries. */
const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : typeof v === "object" && v !== null ? Object.values(v).flatMap(strings) : []);

/**
 * A scripted Jev. Value questions take `pick(label)` (the option whose description starts with it); a field's
 * whose-details question says someone else's for a label `others` matches, else the user's; a value's whose question
 * takes `owner(text)`. The verifier calls every value exact at 0.87, as live Jev called the user's email for
 * 'Reference 2 email' at 0.85 to 0.89 in all three passes of W2's eval (evidence/screen/w2, case b-032). Records
 * every request, verifier requests apart.
 */
function scripted(o: { pick: (label: string) => string | null; others?: RegExp; owner?: (text: string) => { choice: string; confidence: number } }) {
  const asked: JevRequest[] = [];
  const verified: JevRequest[] = [];
  const ask: AskJev = async (req) => {
    (req.purpose === "fill.verify" ? verified : asked).push(req);
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      if (req.purpose === "fill.verify") answers[id] = { choice: "exact", confidence: 0.87 };
      else if (id.endsWith("_whose")) answers[id] = { choice: o.others?.test(ins) === true ? "other" : "user", confidence: 0.95 };
      else if (id.endsWith("_owner")) answers[id] = o.owner?.(req.subjects?.[id] ?? "") ?? { choice: "unclear", confidence: 0.5 };
      else {
        const label = /Label: '(.+?)'/u.exec(ins)?.[1];
        const want = label === undefined ? null : o.pick(label);
        const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`))?.[0];
        answers[id] = { choice: hit ?? "none", confidence: 0.95 };
      }
    }
    return { model: "scripted", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  /** The verifier's questions, one string per question and wording. */
  const questions = (): string[] => verified.flatMap((r) => Object.values(r.questions).map((q) => String(q.instructions)));
  return { ask, asked, verified, questions };
}

/** A form window `form` with these labelled empty fields, after a note window the user just left. */
function desk(labels: readonly string[], note: string, noteTitle = "Application notes"): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("src/note", note, { role: "AXTextArea" })], { at: T0 - 20_000, windowId: "note", title: noteTitle, app: MAIL_APP, focused: true }));
  m.apply(snap(labels.map((l) => field(`form/${l.toLowerCase().replace(/\W+/gu, "-")}`, "", { label: l })), { at: T0, windowId: "form", title: "Volunteer application", focused: true, focusedKey: `form/${(labels[0] as string).toLowerCase().replace(/\W+/gu, "-")}` }));
  return m;
}
const keyOf = (label: string): string => `form/${label.toLowerCase().replace(/\W+/gu, "-")}`;

describe("I1 joint 1: the user's own email offered for 'Reference 2 email' is refused by ownership", () => {
  const NOTE = `Email: ${ME}\nReference: Marcus Cole, marcus.cole@example.net`;
  // Jev's selection error, as live Jev made it: the user's own email for both fields.
  const pick = (label: string): string | null => (/email/iu.test(label) ? ME : null);

  it("is written by the verifier alone, with ownership off: the false exact W2's eval found", async () => {
    const j = scripted({ pick, others: /Reference/u });
    const p = await proposeFill(desk(["Reference 2 email"], NOTE), j.ask, "form", keyOf("Reference 2 email"), T0, { about: ABOUT, owner: false, rand: () => 0 });
    expect(p.fields.find((f) => f.key === keyOf("Reference 2 email"))?.value).toBe(ME);
    expect(j.questions().some((q) => q.includes("Reference 2 email") && q.includes(ME))).toBe(true);
  });

  it("is not written once ownership stands: the user's identity is opposed to a field for someone else's details, and the verifier is never asked about it", async () => {
    const j = scripted({ pick, others: /Reference/u });
    const p = await proposeFill(desk(["Email", "Reference 2 email"], NOTE), j.ask, "form", keyOf("Email"), T0, { about: ABOUT, rand: () => 0 });
    const ref = p.fields.find((f) => f.key === keyOf("Reference 2 email"));
    expect(ref?.value ?? null).toBeNull();
    expect(ref?.handoff ?? null).toBeNull();
    expect(writtenFields(p).fields.map((f) => f.key)).not.toContain(keyOf("Reference 2 email"));
    // The verifier still saw the user's email for their own Email field, at the same 0.87, and passed it.
    expect(p.fields.find((f) => f.key === keyOf("Email"))?.value).toBe(ME);
    expect(j.questions().some((q) => q.includes("Reference 2 email"))).toBe(false);
    // G2 fills AC1's Owner slot: the verifier is told whose the value is.
    expect(j.questions().filter((q) => q.includes(ME)).every((q) => q.includes("the screen says it is the user's"))).toBe(true);
  });
});

describe("I1 joint 2: a secret on a source line never appears in a verifier request", () => {
  it("sends the verifier only the redacted view's text, around a secret line and a secret in the value's own line", async () => {
    const note = [`Email: ${ME}`, "API key: sk-test-violetorchard77", "Phone: 555-0142 (PIN 4412)", "City: Austin"].join("\n");
    const j = scripted({ pick: (l) => (l === "Email" ? ME : l === "Phone" ? "555-0142" : l === "City" ? "Austin" : null) });
    const p = await proposeFill(desk(["Email", "Phone", "City"], note), j.ask, "form", keyOf("Email"), T0, { about: ABOUT, rand: () => 0 });
    // The verifier was asked (Email at least), so the check below is not vacuous.
    expect(j.verified.length).toBeGreaterThan(0);
    expect(p.fields.find((f) => f.key === keyOf("Email"))?.value).toBe(ME);
    for (const r of j.verified) {
      expect(() => assertNoExcludedValue(r)).not.toThrow();
      const sent = strings([r.state, r.questions]).join("\n");
      for (const secret of ["sk-test-violetorchard77", "API key", "4412", "PIN"]) expect(sent).not.toContain(secret);
    }
    // The phone shares its line with a PIN, so the line gave nothing: it is not proposed at all.
    expect(p.fields.find((f) => f.key === keyOf("Phone"))?.value ?? null).toBeNull();
  });

  it("never quotes a provenance's secret line to the verifier: a line no known window's redacted view shows is named, not quoted", async () => {
    // A provenance no reading path makes (fill reads the redacted view). SC1 2b: the verifier quotes a window's line only
    // when its Disclosure knows the window and the window's redacted view shows the line (Disclosure.shownIn); the
    // client no longer checks words, so this is the backstop.
    const field = makeFieldContract({ windowId: "form", node: { key: "form/email", parent: null, role: "AXTextField", label: "Email" }, descriptor: "Text field. Label: 'Email'.", name: "Email", labelWords: ["Email"], control: "text", kinds: fieldKinds(["Email"]), part: null });
    const p: Proposed = { field, text: ME, display: ME, owner: null, provenance: { kind: "window", windowId: "note", nodeKey: "src/note", app: "Mail", title: "Notes", span: ME, label: null, line: `${ME} password: hunter2-violet`, partOf: null, context: null, lines: [], sentences: [] } };
    const sent: string[] = [];
    const ask: AskJev = async (req) => {
      sent.push(...strings([req.state, req.questions]));
      throw new Error("no answer");
    };
    await expect(verifyProposed([p], { authority: TEST_AUTHORITY, askJev: ask, ledger: null, now: T0 })).rejects.toBeInstanceOf(VerifierUnavailable);
    expect(sent.length).toBeGreaterThan(0);
    for (const secret of ["hunter2", "password"]) expect(sent.join("\n")).not.toContain(secret);
  });
});

describe("I1 review: the verifier quotes a memory label or a saved answer's question only when the ledger admitted it", () => {
  it("names them instead", () => {
    const refused = (t: string): boolean => t !== "Home phone" && t !== "Why do you want to volunteer?";
    expect(provenanceSays({ kind: "memory", id: "about-2", label: "Home phone", part: null, whose: "user" }, refused)).toBe("what the user told Caret");
    expect(provenanceSays({ kind: "memory", id: "about-2", label: "Home phone", part: null, whose: "user" }, () => true)).toBe("what the user told Caret as 'Home phone'");
    expect(provenanceSays({ kind: "answer", id: "answer-1", question: "Why do you want to volunteer?" }, refused)).toBe("one of the user's saved answers");
    expect(provenanceSays({ kind: "derived", how: "namePart", base: { kind: "memory", id: "about-3", label: "Home phone", part: "first", whose: "user" }, also: null }, refused)).not.toContain("Home phone");
  });
});

describe("I1 joint 3: an owner-vetoed pick reaches no verifier question", () => {
  it("withholds a colleague's phone both asks call someone else's, unsure, before the verifier, and verifies the rest", async () => {
    // B27's case: the field wants the user's; both asks call the signature's phone someone else's, at 0.45, under the
    // whose cutoff, so stage one does not take it out of the value question and the value asks pick it. The veto then
    // withholds it (fill.ts otherPerson), before checkValues.
    const note = "Hi Jo, thanks for helping out.\nTamsin Reyes, Riverside Shelter\n555-0139\nCity: Austin";
    const j = scripted({ pick: (l) => (l === "Phone" ? "555-0139" : l === "City" ? "Austin" : null), owner: (t) => (t.includes("555-0139") ? { choice: "other", confidence: 0.45 } : { choice: "unclear", confidence: 0.45 }) });
    const p = await proposeFill(desk(["Phone", "City"], note), j.ask, "form", keyOf("Phone"), T0, { rand: () => 0 });
    expect(p.fields.find((f) => f.key === keyOf("Phone"))).toMatchObject({ value: null, withheld: "otherPerson" });
    expect(p.fields.find((f) => f.key === keyOf("City"))?.value).toBe("Austin");
    expect(j.questions().length).toBeGreaterThan(0);
    expect(j.questions().some((q) => q.includes("555-0139"))).toBe(false);
  });
});

describe("I1 joint 4: a source line edited after acceptance stops the write", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  let published: HelperMessage[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-i1-joint-"));
    store = new Store(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    published = [];
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app });
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const SRC = "6161-1";
  const showSource = (note: string): void => void helper.handleReader(snap([text("src/note", note)], { at: Date.now(), windowId: SRC, title: "Notes", app: MAIL_APP }));
  const run = (taskId: string, plan: unknown, slots: Record<string, string>, guard: (step: number, value: string) => string | null) =>
    (helper as unknown as { executor: { run: (id: string, plan: unknown, slots: Record<string, string>, expect?: unknown, o?: object) => Promise<unknown> } }).executor.run(taskId, plan, slots, undefined, { guard });
  const progress = (taskId: string): TaskProgress[] => published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.taskId === taskId);

  it("writes nothing once a line is put beside the value's own unchanged line (G2's neighbourhood, in W2's guard)", async () => {
    const before = "Contact: Dana Reyes\nCity: Austin";
    showSource(before);
    const j = scripted({ pick: (l) => (l === "Name" ? "Dana Reyes" : null), owner: () => ({ choice: "user", confidence: 0.95 }) });
    const p = await proposeFill(helper.model, j.ask, WIN, K("textfield:name~0"), Date.now(), { rand: () => 0 });
    const g = writtenFields(p);
    expect(g.fields.map((f) => f.value)).toEqual(["Dana Reyes"]);
    // Accepted: the preview's recheck passes on the source as Jev judged it.
    expect(recheckFill(helper.model, g, () => null)).toBeNull();
    const { plan, slots, checks } = fillPlan(helper.model, g);
    // After acceptance, before the write: the value's own line is unchanged, a warning goes in under it. W2's sentence
    // digests, which saw only the value's own sentence, would have let it through.
    showSource("Contact: Dana Reyes\nDo not use this name, it is my old one\nCity: Austin");
    await run("t-i1", plan, slots, guardFor(() => helper.model, checks, { kind: "fill", proposalId: g.id }, null));
    expect(app.verbs.filter((v) => v.kind === "write")).toEqual([]);
    expect(progress("t-i1").at(-1)?.stopReason).toBe("changed");
  });

  it("writes nothing once a sentence wrapped over three lines changes two lines below the value (I1 review blocker)", async () => {
    showSource("Contact: Dana Reyes\nand this is my current\nname, safe to use.");
    const j = scripted({ pick: (l) => (l === "Name" ? "Dana Reyes" : null), owner: () => ({ choice: "user", confidence: 0.95 }) });
    const g = writtenFields(await proposeFill(helper.model, j.ask, WIN, K("textfield:name~0"), Date.now(), { rand: () => 0 }));
    expect(g.fields.map((f) => f.value)).toEqual(["Dana Reyes"]);
    expect(recheckFill(helper.model, g, () => null)).toBeNull();
    const { plan, slots, checks } = fillPlan(helper.model, g);
    // Outside the value's line and the line after it: only the sentence digests see it.
    showSource("Contact: Dana Reyes\nand this is my current\nname, do not use it.");
    await run("t-i1-wrap", plan, slots, guardFor(() => helper.model, checks, { kind: "fill", proposalId: g.id }, null));
    expect(app.verbs.filter((v) => v.kind === "write")).toEqual([]);
    expect(progress("t-i1-wrap").at(-1)?.stopReason).toBe("changed");
  });
});

describe("I1 re-review: a sentence is read across its record's lines, however each line starts", () => {
  const held = (was: string, now: string, span: string): boolean => holds((t) => desk(["Phone"], t), { windowId: "note", nodeKey: "src/note" }, was, now, span);
  it("refuses a value once a later line of its sentence changes, the wrap led by lowercase, a capital or a digit", () => {
    for (const second of ["and this is my current", "And this is my current", "24 hours a day, this is my current"]) {
      const was = `Phone: 555-0142\n${second}\nnumber, safe to use.`;
      expect(held(was, was, "555-0142"), second).toBe(true);
      expect(held(was, was.replace("safe to use.", "do not use it."), "555-0142"), second).toBe(false);
    }
  });
  it("refuses a multi-line span once a later line of its sentence changes", () => {
    const was = "Address: 455 Congress Ave\nAustin, Texas 78701\nand this is the current\naddress, safe to use.";
    const span = "455 Congress Ave\nAustin, Texas 78701";
    expect(held(was, was, span)).toBe(true);
    expect(held(was, was.replace("safe to use.", "do not use it."), span)).toBe(false);
  });
  it("keeps a value whose record is unchanged when another record changes, labels in any case", () => {
    const was = "phone: 555-0142\ncity: Austin\ncompany: Lumen Labs\nnotes: vegetarian";
    expect(held(was, was.replace("vegetarian", "vegan"), "555-0142")).toBe(true);
    expect(held(was, was.replace("city: Austin", "city: Austin, do not use the phone above"), "555-0142")).toBe(false);
  });
});
