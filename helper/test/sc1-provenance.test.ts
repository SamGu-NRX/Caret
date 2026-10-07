// T-P1 (SC1 section 4, provenance): every request builder, run over fixture scenes, sends its request through the real
// Jev client with a stubbed fetch (writer requests through the writer port's own check), and every string on the wire
// was minted by that request's Disclosure (privacy/disclosure.ts). Then each recorded request is sent again with one raw
// string inserted where a builder could have put it, and the client refuses it with UnmintedText before any fetch.
//
// The stub answers every choice with its first option at 0.95 and every yes/no at 0.97, so a flow goes as far as the
// first options take it; flows that need a particular answer to reach a builder say so.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeJevClient, jevSettings, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { DailySpend } from "../src/engines/decide/daily-cap.ts";
import { UnmintedText, verifyWriterInput } from "../src/privacy/disclosure.ts";
import type { WriterPort, WriterRequest } from "../src/writer/port.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { Snapshot, type Node } from "../src/protocol.ts";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { setTestVerifier, checkValues, makeFieldContract, type Proposed } from "../src/fill/contract.ts";
import { fieldKinds } from "../src/fill/kinds.ts";
import { fieldPart } from "../src/fill/derive.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { jevChooser } from "../src/codemode/jev-chooser.ts";
import { resolveTarget } from "../src/executor/target.ts";
import { confirmClaims } from "../src/goals/drafts.ts";
import { askAttend } from "../src/offers/event-card.ts";
import { nameRoutine, type RoutineFacts } from "../src/patterns/naming.ts";
import { planAsk } from "../src/planner/ask.ts";
import { planWithCode, verifyWrites } from "../src/planner/codeplan.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { jevIntentMaker, writerIntentMaker, type IntentMaker } from "../src/planner/intent-makers.ts";
import { intentSnapshot, type AskIntent } from "../src/planner/intent.ts";
import { planTask } from "../src/planner/planner.ts";
import { router1Request, router2Request } from "../src/routing/judge.ts";
import { freeze } from "../src/routing/routes.ts";
import { contextNow } from "../src/routing/context.ts";
import { buildLookRequest, buildPendingRequest } from "../src/tasks/pending.ts";
import { Disclosure } from "../src/privacy/disclosure.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { buildDesk, loadCorpus } from "../scripts/realfill-corpus.ts";
import { MemoryDocumentStore } from "../src/memory/documents.ts";
import { normalizeQuestion, saveFile } from "../src/memory/files.ts";
import { SavedFiles } from "../src/goals/saved-files.ts";
import { planGoal } from "../src/goals/propose.ts";
import { macClock } from "../src/offers/event-time.ts";
import { MAIL_APP, field, node, snap, text, value } from "./builders.ts";
import { executorWindow, TITLE as EXEC_TITLE, WIN as EXEC_WIN } from "./fake-app.ts";
import { notesWindow } from "./desks.ts";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "caret-sc1-tp1-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(() => {
  setGeneratorClock(() => 0);
  setTestVerifier(null);
});
afterAll(() => setGeneratorClock(null));

/** What the stubbed fetch saw, and the requests each builder handed the client. */
const fetched: string[] = [];
const sent: JevRequest[] = [];
const written: WriterRequest[] = [];

const stubFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
  fetched.push(String(init?.body));
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(body.questions)) answers[id] = q.type === "noul" ? { type: "noul", noul: 0.97 } : { choice: Object.keys(q.criteria ?? {})[0] ?? "none", confidence: 0.95 };
  return new Response(JSON.stringify({ model: "jev-test", answers, usage: { input_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
};
const client = makeJevClient(() => "test-key", 10_000, new DailySpend({ dir, capUsd: 100 }), jevSettings({}), stubFetch);
/** The real client, recording each request it is handed. */
const ask: AskJev = async (req) => {
  sent.push(req);
  return client(req);
};

/** A writer with the real port's minting check (writer/port.ts verifyWriterInput), answering `reply`. */
const writer = (reply: (req: WriterRequest) => { program: string | null; reply: string; json?: unknown }): WriterPort => ({
  route: FAKE_WRITER_ROUTE,
  async write(req) {
    verifyWriterInput(req);
    written.push(req);
    return { model: "fake", provider: "groq", output: reply(req), inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
  },
});

const swallow = async (p: Promise<unknown>): Promise<void> => {
  try {
    await p;
  } catch (e) {
    // A flow may end in a refusal or an ask-back once the stub's first options run out; only a minting failure counts.
    if (e instanceof UnmintedText) throw e;
  }
};

// MARK: - fixture scenes

const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const deskOf = (form: string) => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === form) ?? (() => { throw new Error(`no form ${form}`); })());

const P = "com.google.Chrome/standard";
const NOTE = ["Rental notes", "Name: Elena Vance", "Email: elena.vance@example.com", "Landlord: Gary Pruitt", "Landlord phone: (512) 555-0193", "Deliver around 7:30 pm"].join("\n");
/** A note beside a rental form, as test/ask.test.ts's desk. */
function rentalDesk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", NOTE, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Rental notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [value("email", "elena.vance@example.com", "te/note"), value("phone", "(512) 555-0193", "te/note")] }));
  const fields = ["Full name", "Email", "Landlord name", "Landlord phone", "Notes"].map((l, i) => field(`${P}/textfield:${l.toLowerCase()}~0`, "", { parent: `${P}/webarea:~0`, label: l, frame: [100, 100 + 30 * i, 200, 20] }));
  m.apply(snap([node(`${P}/webarea:~0`, "AXWebArea", { label: "Apply" }), ...fields], { at: 1000, windowId: "form", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:full name~0` }));
  return m;
}
const MEMORY = [{ id: "about-1", label: "Name", text: "Elena Vance", whose: "user" as const }];
const memory = { values: () => MEMORY };
const about = [{ id: "about-1", label: "Name", value: "Elena Vance", kind: "name" as const }];
const intentOf = (x: Partial<AskIntent>): AskIntent => ({ route: "fill", why: "none", scope: "list", section: "none", fields: [], sources: ["any"], whose: "user", literals: [], ...x });
const maker = (x: Partial<AskIntent>): IntentMaker => ({ name: "writer", async make() { return { intent: intentOf(x), use: { maker: "writer", model: "test", calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } }; } });

/** A code plan that fills each listed label with the value whose display starts with the text (test/codeplan.test.ts). */
const fillByText = (pairs: [string, string][]): string => `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const form = await caret.readWindow();
  const all = [form, await caret.readWindow("w2" as WindowRef)];
  const steps: StepRef[] = [];
  const pairs = ${JSON.stringify(pairs)};
  for (const [label, text] of pairs) {
    const t = form.targets.find((x) => x.label === label);
    let v = null;
    for (const w of all) for (const x of w.values) if (v === null && x.display.startsWith('"' + text + '"')) v = x;
    if (t !== undefined && v !== null) steps.push(caret.fill(t.ref, v.ref));
  }
  return caret.plan({ basedOn: form.snapshot, steps });
}`;

/** Every purpose a builder in src/ sends (request-builders.txt, 25 sites), and the writer's three kinds. */
const PURPOSES = [
  "codemode.choice", "executor.target", "fill.verify", "fill.whose", "fill.values", "draft.check", "savedFile.match", "event.card", "pattern.naming",
  "ask.confirm", "codeplan.asksAbout", "plan.verify", "ask.heads", "ask.scope", "intent.route", "intent.fields", "planner.window", "planner.fields",
  "route.judge", "route.task", "route.pick", "pending.change", "pending.look",
] as const;
const WRITER_KINDS = ["plan", "goal", "intent"] as const;

describe("T-P1: every wire string a builder sends is minted", () => {
  it("fill: whose and value questions on a corpus form, then the verifier", async () => {
    const d = deskOf("rental-application");
    const form = d.form;
    const trigger = [...form.nodes.values()].find((n) => n.editable === true)?.key ?? "";
    await swallow(proposeFill(d.model, ask, form.window.windowId, trigger, 5000));
    // The verifier, on a value the note shows, through the same client.
    const note = rentalDesk();
    const job = makeFieldContract({ windowId: "form", node: { key: "k:email", parent: null, role: "AXTextField", label: "Email" }, descriptor: "Email", name: "Email", labelWords: ["Email"], control: "text", kinds: fieldKinds(["Email"]), part: fieldPart("Email") });
    const p: Proposed = { field: job, text: "elena.vance@example.com", display: "elena.vance@example.com", owner: null, provenance: { kind: "window", windowId: "note", nodeKey: "te/note", app: "TextEdit", title: "Rental notes.txt", span: "elena.vance@example.com", label: "Email", line: "Email: elena.vance@example.com", partOf: null, context: "Email", lines: [], sentences: [] } };
    await swallow(checkValues([p], { askJev: ask, ledger: new Disclosure(note.windows.values()), now: 1, authority: { mint: () => { throw new Error("no mint in T-P1"); } } as never }));
  });

  it("Ask: heads, scope, confirm, the Jev intent maker, the writer intent maker, and a code plan", async () => {
    const d = deskOf("clinic-intake");
    await swallow(planAsk("use Ines for the emergency contact", d.model, { values: () => d.memory }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "tp1-heads", windowId: d.form.window.windowId, now: 2000 }));
    // ask.confirm: a writer's whole-form scope the instruction does not ask for is confirmed by Jev.
    await swallow(planAsk("Fill only Email; do not change Full name", rentalDesk(), memory, about, { askJev: ask, maker: maker({ scope: "all" }), writer: null, offerKey: "tp1-confirm", windowId: "form", now: 2000 }));
    const m = rentalDesk();
    const s = intentSnapshot("my email please, and Gary as the landlord", m, m.windows.get("form") as WindowState, MEMORY);
    await swallow(jevIntentMaker(ask, { rand: (n) => n - 1 }).make(s));
    await swallow(writerIntentMaker(writer(() => ({ program: null, reply: "{}", json: { route: "fill", why: "none", scope: "all", section: "none", fields: [], sources: ["any"], whose: "user", literals: [] } })), () => "tp1-intent").make(s));
    // A code plan: the writer's program, the asks-about question for an unnamed field, and the value check.
    await swallow(planWithCode("do the landlord part from my notes", rentalDesk(), memory, { writer: writer(() => { const p = fillByText([["Landlord name", "Gary Pruitt"], ["Email", "elena.vance@example.com"]]); return { program: p, reply: p }; }), askJev: ask, offerKey: "tp1-plan", windowId: "form", now: 2000 }));
    const v = rentalDesk();
    // As the code plan mints them: the field's name from the form's view, the value from the note's.
    const vd = new Disclosure(v.windows.values());
    const name = vd.descriptor(redactWindow(v.windows.get("form") as WindowState), "Email");
    const email = vd.candidate(redactWindow(v.windows.get("note") as WindowState), "elena.vance@example.com");
    expect(name !== null && email !== null).toBe(true);
    await swallow(verifyWrites("my email please", [{ key: "e", field: { name: name!, label: "Email" }, value: { display: vd.t`"${email!}"`, window: "note", owner: null }, askValue: true }], ask, vd));
  });

  it("intent.fields: a list scope both wordings settle", async () => {
    const m = rentalDesk();
    const s = intentSnapshot("my email please", m, m.windows.get("form") as WindowState, MEMORY);
    const listing: AskJev = async (req) => {
      if (req.purpose !== "intent.route") return ask(req);
      sent.push(req);
      await client(req);
      const answers = Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: id === "route" ? "fill" : id === "scope" ? "list" : id === "source" ? "any" : id === "whose" ? "user" : "none", confidence: 0.95 }]));
      return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    await swallow(jevIntentMaker(listing, { rand: (n) => n - 1 }).make(s));
  });

  it("planner: which window, then the fields", async () => {
    const m = new ScreenModel();
    m.apply(snap(executorWindow(), { at: 1000, windowId: EXEC_WIN, title: EXEC_TITLE }));
    m.apply(snap([text("dev.caret.mail/standard/statictext:dana~0", "Dana Whitfield")], { at: 500, windowId: "8181-1", title: "Reference", app: MAIL_APP }));
    m.apply(snap([{ key: "dev.caret.mail/standard/textfield:to~0", parent: null, role: "AXTextField", label: "To", editable: true }], { at: 1500, windowId: "6160-3", title: "Mail Fixture — Compose", app: MAIL_APP }));
    await swallow(planTask("Set Name to Dana Whitfield", m, { values: () => [] }, { askJev: ask, offerKey: "tp1-planner", now: 2000, rand: () => 0 }));
    await swallow(planTask("Set Name to Dana Whitfield", m, { values: () => [] }, { askJev: ask, offerKey: "tp1-planner-2", now: 2000, rand: () => 0, windowId: EXEC_WIN }));
  });

  it("routing: the outcome, the task, and Router 2 over two routes", async () => {
    const model = new ScreenModel();
    const sentence = "Lunch with Priya tomorrow at noon.";
    model.apply(snap([field("body", `Dear Dana. ${sentence}`, { label: "Body" })], { at: 1000, windowId: "mail", focused: true, focusedKey: "body", app: MAIL_APP, title: "New message" }));
    const w = model.windows.get("mail") as WindowState;
    const ctx = contextNow({ model, focus: null, host: null, readerSession: 1, memoryRevision: 0, settingsRevision: 0, hostBreaks: 0, candidates: ["event", "a", "b"] });
    expect(ctx).not.toBeNull();
    const base = { kind: "workflow" as const, relevance: 1, run: () => {} };
    const reg = freeze(1, [
      {
        ...base, id: "event", says: `Add "${sentence}" to the calendar`, plain: "Add an event", quotes: [{ window: w, kind: "candidate" as const, texts: [sentence] }], evidence: { task: "Add an event", sentence, found: "A time", offerWhen: "An upcoming meeting" },
        say: (d) => {
          const s = d.candidate(redactWindow(w), sentence);
          return { says: s === null ? null : d.t`Add "${s}" to the calendar`, plain: d.own("Add an event"), offer: s === null ? null : { task: d.own("Add an event"), sentence: s, found: d.own("A time"), offerWhen: d.own("An upcoming meeting") } };
        },
      },
      { ...base, id: "a", says: "Fill the form", plain: "Fill the form", quotes: [], say: (d) => ({ says: d.own("Fill the form"), plain: d.own("Fill the form") }) },
      { ...base, id: "b", says: "Fill the other form", plain: "Fill the other form", quotes: [], say: (d) => ({ says: d.own("Fill the other form"), plain: d.own("Fill the other form") }) },
    ], new Set());
    const built = router1Request(model, ctx!, ["abstain", "write", "act"], reg);
    if (built.outcome !== null) await swallow(ask(built.outcome.request));
    if (built.task !== null) await swallow(ask(built.task.built.request));
    await swallow(ask(router2Request(model, ctx!, reg).request));
  });

  it("pending: a changed job window and a first look", async () => {
    const model = new ScreenModel();
    const lines = ["Build #42", "Running tests… 12 of 48", "Done. 48 of 48 tests passed."];
    model.apply(snap(lines.map((l, i) => text(`job/statictext:${i}~0`, l)), { at: 1000, windowId: "job", title: "CI — Build #42" }));
    const w = model.windows.get("job") as WindowState;
    await swallow(ask(buildPendingRequest(w, model.windows.values(), lines.slice(0, 2), lines, [{ rule: "running", line: lines[1]! }] as never, [])));
    await swallow(ask(buildLookRequest(w, model.windows.values(), [{ rule: "running", line: lines[1]! }] as never).req));
  });

  it("event card, routine naming, the executor's target, a code-mode choice and a draft's claims", async () => {
    const model = new ScreenModel();
    const sentence = "Meet Robin Vale Friday at 3pm.";
    model.apply(snap([field("body", sentence, { label: "Body" })], { at: 1000, windowId: "form", title: "Notes", focused: true }));
    await swallow(askAttend(ask, model, model.windows.get("form") as WindowState, sentence));
    // Naming a routine from its destination's labels.
    const m = new ScreenModel();
    m.apply(snap([
      { key: "m/subject", parent: null, role: "AXTextField", label: "Subject", editable: true },
      { key: "m/to", parent: null, role: "AXTextField", label: "To", editable: true },
    ], { at: 1, windowId: "6160-1", app: MAIL_APP, title: "New message" }));
    const facts: RoutineFacts = { routineId: "r1", dstApp: "Mail Fixture", dstWindow: m.windows.get("6160-1") as WindowState, dstLabels: ["Subject", "To"], srcApps: ["Caret Fixture"], srcLabels: [], count: 3, values: ["Design review 4"] };
    await swallow(nameRoutine(facts, ask, () => m.windows.values(), () => 0));
    // An ambiguous target, asked by the elements' labels.
    const t = new ScreenModel();
    const city = (group: string): Node[] => [
      node(`g:${group}~0`, "AXGroup", { label: group }),
      node(`g:${group}/textfield:city~0`, "AXTextField", { label: "City", editable: true, parent: `g:${group}~0` }),
    ];
    t.apply(notesWindow(500) as Snapshot);
    t.apply(snap([...city("Shipping"), ...city("Billing")], { at: 1000, windowId: "5150-9", title: "Addresses" }));
    await swallow(resolveTarget(t.windows.get("5150-9") as WindowState, t.windows.values(), { role: "AXTextField", label: "City", describe: "the City field" }, "The shipping City field holds Austin", ask));
    const snaps = new Disclosure([]);
    for (const x of ["Which session time does the email confirm?", "Tue Oct 20, 3:00 PM", "Wed Oct 21, 10:00 AM"]) snaps.own(x as never);
    await swallow(jevChooser(ask, "sign me up", snaps)({ window: "win:form", question: { ref: "q", text: "Which session time does the email confirm?" }, options: [{ ref: "o1", label: "Tue Oct 20, 3:00 PM" }, { ref: "o2", label: "Wed Oct 21, 10:00 AM" }], signal: new AbortController().signal }));
    await swallow(confirmClaims("draft a reply that accepts", [{ text: "Hi Priya, I'm in! See you then.", basis: { instruction: "reply to Priya Raman", windows: [], memory: [] } as never }], ask, []));
  });

  it("a saved file matched to a page's upload field, and a goal plan", async () => {
    const store = new MemoryDocumentStore(join(dir, "Memory"));
    const file = join(dir, "Quill Resume.pdf");
    writeFileSync(file, "invented file body");
    saveFile(store, { question: "Resume/CV", normalized: normalizeQuestion("Resume/CV"), site: null, path: file, savedOn: "2026-10-05T10:00:00.000Z" });
    const model = new ScreenModel();
    model.apply(snap([node("frame-0", "AXWebArea", { label: "Apply: Larkspur Labs" }), node("in-1", "CaretFileInput", { label: "Resume/CV", frame: [10, 40, 300, 30] })], { at: 1000, windowId: "page-tab-3", title: "Apply: Larkspur Labs", kind: "page", app: { pid: 5200, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
    const w = model.windows.get("page-tab-3") as WindowState;
    let n = 0;
    const files = new SavedFiles({ model, documents: () => store, askJev: () => ask, publish: () => {}, pageContext: () => ({ site: "https://jobs.example.test/apply", headings: [] }), hostShowsFiles: () => true, now: () => 50_000, newId: () => `offer-${++n}`, count: () => {} });
    await files.offer(w, w.nodes.get("in-1") as Node, "Resume/CV");
    store.close();
    // The goal writer stops at its answer: no program, so the goal is refused after the request went out.
    await swallow(planGoal(rentalDesk(), { goalId: "tp1-goal", instruction: "do the landlord part from my notes", writer: writer(() => ({ program: null, reply: "" })), askJev: ask, windows: ["form"], memory: [], calendar: null, clock: macClock(new Date(2000)), now: 2000, readerSession: 0 }));
  });

  it("covers every builder's purpose, sent through the real client, and every writer kind", () => {
    const purposes = new Set(sent.map((r) => r.purpose));
    expect(PURPOSES.filter((p) => !purposes.has(p))).toEqual([]);
    expect(new Set(written.map((w) => w.kind))).toEqual(new Set(WRITER_KINDS));
    expect(fetched.length).toBeGreaterThan(0);
  });

  it("refuses each recorded request with one raw string inserted, before anything is fetched", async () => {
    const before = fetched.length;
    for (const req of sent) {
      const raw = "a raw screen line no Disclosure minted";
      // A raw string where a builder could have put one: the types refuse it (T-P2), so the test casts to reach the client.
      const state = (typeof req.state === "string" ? `${req.state} ${raw}` : { ...(req.state as object), raw }) as never;
      await expect(client({ ...req, state }), req.purpose).rejects.toBeInstanceOf(UnmintedText);
      const [qid, q] = Object.entries(req.questions)[0] ?? [];
      if (qid !== undefined && q !== undefined) await expect(client({ ...req, questions: { ...req.questions, [qid]: { ...q, instructions: raw as never } } }), req.purpose).rejects.toBeInstanceOf(UnmintedText);
    }
    for (const w of written) expect(() => verifyWriterInput({ ...w, input: { ...(w.input as object), raw: "a raw screen line no Disclosure minted" } })).toThrow(UnmintedText);
    expect(fetched.length).toBe(before);
  });

});
