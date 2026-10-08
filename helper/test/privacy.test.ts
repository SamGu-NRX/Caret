// The privacy line, checked on every Jev request the producers and the first look make over the
// synthetic sessions, against what privacy.ts PRIVACY_PROMISE says: short pieces of what is on screen, and no request
// taking more than half of any one conversation.
//
// A recorder wraps the Jev client and keeps each request with the text of every window in the model at
// that moment. A window's text is its title and every line of its nodes' labels, values and placeholders,
// whitespace collapsed, each line counted once. For each request:
//
// 1. Only declared snippets. Every builder declares the screen text it sends, each piece a field
//    descriptor or a candidate value with its window (privacy.ts). Every declared piece is in the
//    request, and once they are taken out, no line of any window (8 characters or more, or the first 40
//    of a longer one) is left: the request carries no screen text it did not declare.
// 2. A bound per window. The characters of a window's lines the request covers are at most WINDOW_CHARS,
//    1,200. Why 1,200 is in privacy.ts: the pending question's 10 lines of 120 characters, and twice the
//    densest source window of the fill calibration recordings (589).
// 3. No conversation, whole or half. The sessions name their conversation windows themselves (chats,
//    a mail thread, agent threads), apart from conversation.ts. However short, and whether or not the user's Ask
//    names it, each keeps more than half its text out of every request and gives at most CONVERSATION_CHARS, 600.
//    The short-chat sessions run once more with the rule off to show they went out whole.
// 4. Nothing from a window that is not a source. Text unique to a window the request does not name in
//    its snippets never appears, descriptors come from the one window the question is about, and the
//    sessions' bystander windows (paragraphs no fill can use) give nothing to any request.
//
// PRIVACY_REPORT=FILE writes the measured numbers as JSON.
import { Disclosure, measureBytes } from "../src/privacy/disclosure.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import type { WindowState } from "../src/model.ts";
import { wireBody, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { PROTOCOL_VERSION, type Node, type ReaderMessage, type ReaderVerb, type VerbResult } from "../src/protocol.ts";
import { resolveTarget } from "../src/executor/target.ts";
import { CONVERSATION_CHARS, WINDOW_CHARS, setConversationCap } from "../src/privacy.ts";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { fieldTerms } from "../src/fill/kinds.ts";
import { FIXTURE_APP, focus, node, snap, text } from "./builders.ts";
import { loadRecording } from "./socket-reader.ts";
import { largeScene } from "./large-scene.ts";
import { CHAT, COMPOSER_CHAT, LONG_THREAD, MAIL_THREAD, MESSAGES_CHAT, NOTES, REF, SHORT_CHAT, agentThreads, chatWindow, messagesSources, notesWindow, shortChats } from "./desks.ts";
import { skillStream } from "./skill-stream.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { STAND_IN } from "./setup/verifier.ts";

// The generator's time budget reads a fixed clock here, so a loaded machine cannot stop it partway and
// change an answer these tests check (candidates.ts setGeneratorClock).
beforeAll(() => setGeneratorClock(() => 0));
afterAll(() => setGeneratorClock(null));

const MIN_LINE = 8;
const PREFIX = 40;

interface WindowText {
  windowId: string;
  title: string;
  lines: string[];
  chars: number;
}

/** The test's own reading of a window's text, written apart from privacy.ts so the two can disagree. */
function textOf(w: WindowState): WindowText {
  const seen = new Set<string>();
  for (const raw of [w.window.title, ...[...w.nodes.values()].flatMap((n) => [n.label, n.value, n.placeholder])]) {
    if (raw === undefined) continue;
    for (const l of raw.split("\n")) {
      const t = l.replace(/\s+/g, " ").trim();
      if (t !== "") seen.add(t);
    }
  }
  const lines = [...seen];
  return {
    windowId: w.window.windowId,
    title: w.window.title,
    lines,
    chars: lines.reduce((n, l) => n + l.length, 0),
  };
}

/** Every string a request sends: the values in its state and questions (keys are fixed names and candidate ids). */
function stringsOf(req: Omit<JevRequest, "disclosure" | "state"> & { state: unknown }): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk(req.state);
  walk(req.questions);
  return out;
}

/** The request with the charge its seal will declare: the output ledger's measure of the body the client posts. */
function sealCharged(req: JevRequest): JevRequest {
  return { ...req, charged: measureBytes(req, JSON.stringify(wireBody(req))).charged };
}

function bodyOf(req: Omit<JevRequest, "disclosure" | "state"> & { state: unknown }): string {
  return stringsOf(req).join("\n");
}

interface Recorded {
  session: string;
  producer: string;
  /** The request as recorded; the check's own synthetic requests have no Disclosure and unminted text, since none is ever sent. */
  req: Omit<JevRequest, "disclosure" | "state"> & { state: unknown };
  windows: WindowText[];
}

interface WindowMeasure {
  windowId: string;
  covered: number;
  chars: number;
}

/**
 * Characters of each window's text the request carries, measured here apart from the ledger and more loosely (exact
 * case, collapsed spaces): a line the request holds whole counts in full, and inside any other line each character in a
 * run of RUN (12) or more characters that the request also holds. The ledger, which folds case and compatibility forms,
 * must charge at least this much.
 */
const RUN = 12;
function measure(r: Recorded): WindowMeasure[] {
  // Each string of the request on its own: no run is read across two of them.
  const strings = stringsOf(r.req).map((x) => x.replace(/\s+/gu, " "));
  const holds = (t: string): boolean => strings.some((x) => x.includes(t));
  return r.windows.map((w) => {
    let covered = 0;
    for (const line of w.lines) {
      if (holds(line)) {
        covered += line.length;
        continue;
      }
      const marked = new Uint8Array(line.length);
      for (let a = 0; a + RUN <= line.length; a++) if (holds(line.slice(a, a + RUN))) marked.fill(1, a, a + RUN);
      covered += marked.reduce((n, x) => n + x, 0);
    }
    return { windowId: w.windowId, covered, chars: w.chars };
  });
}

/** Every way the request breaks the line, as sentences naming windows and lengths, never the text. */
/** Each fill producer's requests since B24: two stages (whose details, then values), each asked twice; since W2 the verifier's two wordings after them. */
const STAGED = (producers: readonly string[]): string[] => producers.flatMap((p) => [p, p, p, p, p, p]);

function violations(r: Recorded, bystanders: ReadonlySet<string>, conversations: ReadonlySet<string> = CONVERSATIONS): string[] {
  const out: string[] = [];
  const body = bodyOf(r.req);
  const where = `${r.session} / ${r.producer}`;
  // Case aside: the ledger folds case, so a line it declares may stand in the request in another case.
  const folded = body.toLowerCase();
  for (const s of r.req.snippets) if (!folded.includes(s.text.toLowerCase())) out.push(`${where}: declares ${s.text.length} characters from ${s.windowId} it does not send`);
  let stripped = body;
  for (const t of [...new Set(r.req.snippets.map((s) => s.text))].sort((a, b) => b.length - a.length)) stripped = stripped.split(t).join("\u0000");
  for (const w of r.windows) {
    for (const line of w.lines) {
      if (line.length < MIN_LINE) continue;
      if (stripped.includes(line) || (line.length > PREFIX && stripped.includes(line.slice(0, PREFIX)))) out.push(`${where}: sends an undeclared line of ${line.length} characters from ${w.windowId}`);
    }
  }
  const declared = new Set(r.req.snippets.map((s) => s.windowId));
  const declaredText = r.windows.filter((w) => declared.has(w.windowId)).flatMap((w) => w.lines);
  for (const w of r.windows) {
    if (declared.has(w.windowId)) continue;
    for (const line of w.lines) {
      if (line.length < MIN_LINE || !body.includes(line)) continue;
      if (!declaredText.some((d) => d.includes(line))) out.push(`${where}: sends ${line.length} characters only ${w.windowId} shows, a window it does not name`);
    }
  }
  const subjects = new Set(r.req.snippets.filter((s) => s.kind === "descriptor").map((s) => s.windowId));
  if (subjects.size > 1) out.push(`${where}: descriptors from ${subjects.size} windows`);
  for (const m of measure(r)) {
    const charged = r.req.charged[m.windowId] ?? 0;
    if (m.covered > charged) out.push(`${where}: covers ${m.covered} characters of ${m.windowId}, and its ledger charged ${charged}`);
    if (m.covered > WINDOW_CHARS) out.push(`${where}: ${m.covered} characters from ${m.windowId}, over ${WINDOW_CHARS}`);
    if (bystanders.has(m.windowId) && m.covered > 0) out.push(`${where}: ${m.covered} characters from bystander ${m.windowId}`);
    if (conversations.has(m.windowId) && m.covered > 0) {
      if (m.covered * 2 >= m.chars) out.push(`${where}: ${m.covered} of ${m.chars} characters of conversation ${m.windowId}, half or more`);
      if (m.covered > CONVERSATION_CHARS) out.push(`${where}: ${m.covered} characters from conversation ${m.windowId}, over ${CONVERSATION_CHARS}`);
    }
  }
  return out;
}

// MARK: - sessions

const FILL_VALUES: Record<string, string> = {
  Name: "Dana Whitfield",
  Email: "dana.whitfield@example.com",
  Phone: "+1 (512) 555-0142",
  "Full name": "Dana Whitfield",
};

/** Answers fill questions by field label, pending ones by the words in the lines shown, and target ones with the first element. */
const fakeJev: AskJev = async (req) => {
  const q = req.questions;
  const answer = (choice: string) => ({ choice, confidence: 0.9 });
  // W2: the write contract's verifier (fill/contract.ts), whose requests this file checks like any other's.
  if (req.purpose === "fill.verify") return { model: "jev-test", answers: Object.fromEntries(Object.keys(q).map((id) => [id, answer("exact")])), inputTokens: 1, latencyMs: 1, costUsd: 0 };
  if (q.finished !== undefined) {
    const s = req.state as Record<string, string>;
    const shown = `${s.lines_that_changed ?? ""}\n${s.last_lines ?? ""}`;
    return {
      model: "jev-test",
      answers: { finished: answer(/passed|done|updated/i.test(shown) ? "yes" : "no"), waiting: answer(/approve|allow/i.test(shown) ? "yes" : "no") },
      inputTokens: 1,
      latencyMs: 1,
      costUsd: 0,
    };
  }
  if (q.target !== undefined) return { model: "jev-test", answers: { target: answer(Object.keys(q.target.criteria)[0] ?? "none") }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  // An event card asks whether the user will attend; say yes, so the card goes on to be offered.
  if (q.attend !== undefined) return { model: "jev-test", answers: { attend: answer("yes") }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  // A routine's name (B19): the first of code's names.
  if (q.name !== undefined) return { model: "jev-test", answers: { name: answer(Object.keys(q.name.criteria).find((k) => k !== "none") ?? "none") }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  const answers = Object.fromEntries(
    Object.entries(q).map(([id, question]) => {
      const label = /Label: '([^']+)'|Nearest label: '([^']+)'/.exec(String(question.instructions));
      const want = FILL_VALUES[label?.[1] ?? label?.[2] ?? ""];
      const hit = want === undefined ? undefined : Object.entries(question.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
      // A planner field question says "keep" where a fill question says "none".
      return [id, answer(hit?.[0] ?? ("keep" in question.criteria ? "keep" : "none"))];
    }),
  );
  return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
};

const okReader = { run: async (v: ReaderVerb): Promise<VerbResult> => ({ type: "verbResult", v: PROTOCOL_VERSION, id: v.kind, at: 0, outcome: "ok", detail: null }) };

class Session {
  readonly recorded: Recorded[] = [];
  readonly helper: Helper;
  /** The recording Jev client, for producers driven directly. */
  readonly ask: AskJev;
  producer = "";
  private readonly dir: string;
  private readonly store: Store;

  readonly name: string;

  constructor(name: string, now?: () => number) {
    this.name = name;
    this.dir = mkdtempSync(join(tmpdir(), "caret-privacy-"));
    this.store = new Store(this.dir);
    this.ask = (req) => {
      this.recorded.push({ session: this.name, producer: this.producer, req: sealCharged(req), windows: [...this.helper.model.windows.values()].map(textOf) });
      return fakeJev(req);
    };
    this.helper = new Helper({ store: this.store, askJev: this.ask, shadow: false, allowBackgroundFocus: true, readerLink: okReader, publish: () => undefined, ...(now === undefined ? {} : { now }) });
  }

  async replay(messages: readonly ReaderMessage[], producer: string): Promise<void> {
    this.producer = producer;
    for (const m of messages) {
      await this.helper.handleReader(m);
      if ("at" in m) this.helper.tick(m.at);
    }
    await this.helper.pending.whenIdle();
  }

  async firstLook(families: string[] = ["fill", "pending", "loop", "routine"]): Promise<void> {
    this.producer = "first look";
    await this.helper.handleFirstLook({ type: "firstLook", v: PROTOCOL_VERSION, requestId: `${this.name}-look`, at: 1, families, level: "eager", deadlineMs: 8000 });
  }

  /** Plans an instruction as the host's "do this" asks (B16), recorded as the planner's requests. */
  async plan(instruction: string): Promise<void> {
    this.producer = "planner";
    await this.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: `${this.name}-plan-${instruction.length}`, at: 1, instruction });
  }

  close(): void {
    this.helper.shutdown();
    this.helper.memory.close();
    this.store.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

const all: Recorded[] = [];
const BYSTANDERS = new Set([NOTES]);
/** The sessions' conversation windows, named here rather than found by conversation.ts. */
const CONVERSATIONS = new Set([CHAT, SHORT_CHAT, MESSAGES_CHAT, COMPOSER_CHAT, MAIL_THREAD, "8101-1", "8202-1", REF, LONG_THREAD]);

async function run(name: string, body: (s: Session) => Promise<void>, keep = true, now?: () => number): Promise<Recorded[]> {
  const s = new Session(name, now);
  try {
    await body(s);
  } finally {
    s.close();
  }
  if (keep) all.push(...s.recorded);
  return s.recorded;
}

/** Requests recorded with the conversation rule off, for the report's before-and-after; checked apart from `all`. */
const capOff: Recorded[] = [];

describe("the privacy line on every Jev request", () => {
  // W2: the verifier's requests go through the recorder too, not the suite's stand-in (test/setup/verifier.ts).
  beforeAll(() => setTestVerifier(null));
  afterAll(() => setTestVerifier(STAND_IN));
  it("fill: a form beside a mail, a chat and private notes, then a first look", async () => {
    const rec = await run("fill desk", async (s) => {
      await s.replay([notesWindow(500), chatWindow(600), ...loadRecording("offers-fill.ndjson")], "fill on focus");
      await s.firstLook();
    });
    expect(rec.map((r) => r.producer)).toEqual(STAGED(["fill on focus", "first look"]));
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
  });

  it("fill: the claim-form session of five focuses", async () => {
    const rec = await run("transfer session", (s) => s.replay(loadRecording("transfer-session.ndjson"), "fill on focus"));
    expect(rec.length).toBeGreaterThan(0);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
  });

  it("fill: a large screen of mail, a table, a chat, a web page, contacts, an agent thread and files", async () => {
    const rec = await run("large scene", async (s) => {
      const scene = largeScene();
      await s.replay([...scene.snapshots, focus(scene.formWindowId, "dev.caret.form/standard/textfield:email~0", 2_000_000)], "fill on focus");
      await s.firstLook();
    });
    // Two stages of two asks for each fill (B24: whose details first, then values).
    expect(rec.length).toBe(8);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
    // Windows of thousands of characters each gave at most WINDOW_CHARS.
    expect(Math.max(...rec.flatMap(measure).map((m) => m.covered))).toBeLessThanOrEqual(WINDOW_CHARS);
  });

  it("pending: a job window watched to the end, then a first look", async () => {
    const rec = await run("pending desk", async (s) => {
      await s.replay([notesWindow(500), ...loadRecording("offers-pending.ndjson")], "pending watch");
      await s.firstLook();
    });
    expect(rec.map((r) => r.producer)).toContain("pending watch");
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
  });

  it("pending: agent threads behind 450-line transcripts, watched and looked at once", async () => {
    const rec = await run("agent threads", async (s) => {
      await s.replay(agentThreads(), "pending watch");
      await s.firstLook();
    });
    expect(rec.map((r) => r.producer)).toEqual(["pending watch", "first look"]);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
    // Both windows hold far more than 2,400 characters; neither question came near them.
    expect(rec.flatMap(measure).filter((m) => m.covered > 0).every((m) => m.chars > 2 * WINDOW_CHARS)).toBe(true);
  });

  it("loop: a list copied into a grid, then a first look over the grid's empty rows", async () => {
    const rec = await run("loop desk", async (s) => {
      await s.replay(loadRecording("offers-loop.ndjson"), "loop");
      await s.firstLook();
    });
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
  });

  it("executor: an ambiguous target asked about by the elements' labels", async () => {
    const rec = await run("executor target", async (s) => {
      const city = (group: string): Node[] => [
        node(`dev.caret.fixture/standard/group:${group}~0`, "AXGroup", { label: group }),
        node(`dev.caret.fixture/standard/group:${group}/textfield:city~0`, "AXTextField", { label: "City", editable: true, parent: `dev.caret.fixture/standard/group:${group}~0` }),
      ];
      await s.replay([notesWindow(500), snap([...city("Shipping"), ...city("Billing")], { at: 1000, windowId: "5150-9", title: "Addresses", app: FIXTURE_APP })], "executor target");
      const w = s.helper.model.windows.get("5150-9") as WindowState;
      s.producer = "executor target";
      await resolveTarget(w, s.helper.model, { role: "AXTextField", label: "City", describe: "the City field" }, "The shipping City field holds Austin", s.ask);
      // A plan's value can be any text a window shows; here a whole page of the private notes. It goes out cut short.
      const page = [...(s.helper.model.windows.get(NOTES)?.nodes.values() ?? [])].map((n) => n.label ?? "").join(" ");
      await resolveTarget(w, s.helper.model, { role: "AXTextField", label: "City", describe: "the City field" }, `The shipping City field holds ${page}`, s.ask);
      // The same value with the plan saying where it was copied from (Plan.sources): the part the cut goal shows is charged to the notes.
      const notes = s.helper.model.windows.get(NOTES);
      await resolveTarget(w, s.helper.model, { role: "AXTextField", label: "City", describe: "the City field" }, `The shipping City field holds ${page}`, s.ask, undefined, undefined, [{ text: page, window: notes }]);
    });
    expect(rec).toHaveLength(6);
    expect(rec.slice(4).every((r) => r.req.snippets.some((x) => x.windowId === NOTES && x.kind === "candidate"))).toBe(true);
    // The notes are a bystander for every other producer; here the plan quoted them, and the cut kept the request under the bound.
    expect(rec.flatMap((r) => violations(r, new Set()))).toEqual([]);
    // The cut goal quotes 120 characters of the first paragraph, and every paragraph repeats most of that phrase: each
    // occurrence counts (section 4), so the notes are charged several times 120, within their WINDOW_CHARS.
    const notesCovered = Math.max(...rec.flatMap(measure).filter((m) => m.windowId === NOTES).map((m) => m.covered));
    expect(notesCovered).toBeGreaterThan(120);
    expect(notesCovered).toBeLessThanOrEqual(WINDOW_CHARS);
  });

  it("short chats: a ten-line chat, a Messages thread, a help chat with a composer and a mail thread beside a form", async () => {
    const rec = await run("short chats", async (s) => {
      await s.replay(shortChats(), "fill on focus");
      await s.firstLook();
    });
    expect(rec.map((r) => r.producer)).toEqual(STAGED(["fill on focus", "first look"]));
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
    // The address Dana sent in the chat is also in the mail thread, a conversation of 113 characters (limit 56): sending
    // it reveals that occurrence too, and after the thread's other lines it does not fit, so it is not sent.
    expect(rec.some((r) => bodyOf(r.req).includes('"dana.whitfield@example.com"'))).toBe(false);
    // Each chat gave something (its seal charged it), and none gave half (violations).
    const took = new Set(rec.flatMap((r) => Object.keys(r.req.charged)));
    for (const id of [SHORT_CHAT, MESSAGES_CHAT, MAIL_THREAD]) expect(took, id).toContain(id);
  });

  it("Messages sources: the B11 Reference thread and a long thread, spent nearest the fields and a kind at a time", async () => {
    const rec = await run("messages sources", async (s) => {
      await s.replay(messagesSources(), "fill on focus");
      await s.firstLook();
    });
    expect(rec.filter((r) => r.producer === "fill on focus").length).toBeGreaterThan(0);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
    // Both threads gave something, under half and under 600 characters (violations checks both).
    const took = new Set(rec.flatMap(measure).filter((m) => m.covered > 0).map((m) => m.windowId));
    for (const id of [REF, LONG_THREAD]) expect(took, id).toContain(id);
  });

  it("planner: instructions planned against the fill desk, one quoting a line of the private notes", async () => {
    const rec = await run("planner desk", async (s) => {
      await s.replay([notesWindow(500), chatWindow(600), ...loadRecording("offers-fill.ndjson")], "fill on focus");
      await s.plan("Copy Dana's email into Email and her phone into Phone");
      // An instruction may quote any window; the ledger holds the quoted window to its budget.
      const line = [...(s.helper.model.windows.get(NOTES)?.nodes.values() ?? [])].map((n) => n.label ?? "").find((l) => l.length > 40) ?? "";
      await s.plan(`Write '${line}' in Name`);
    });
    expect(rec.filter((r) => r.producer === "planner").length).toBeGreaterThanOrEqual(2);
    expect(rec.flatMap((r) => violations(r, new Set()))).toEqual([]);
    // Every planner request declares the instruction as plan text.
    expect(rec.filter((r) => r.producer === "planner").every((r) => r.req.snippets.some((x) => x.windowId === "plan"))).toBe(true);
  });

  it("event card: a sentence typed into a mail beside a chat and private notes, then a first look over events", async () => {
    const MAIL = { pid: 6160, bundleId: "dev.caret.mail", name: "Mail Fixture" };
    const BODY = "dev.caret.mail/standard/textarea:body~0";
    // Typing is judged on its last finished sentence.
    // A stated end and PM, so the card has one time (D2-03: "Thu 3:00" alone now asks AM or PM and how long, too many choices for a card).
    const body = "Hi Priya, the draft is attached. Coffee with Dana Thu 3:00 to 3:30 PM?";
    const rec = await run(
      "event desk",
      async (s) => {
        await s.replay(
          [
            notesWindow(500),
            chatWindow(600),
            { type: "appSwitch", v: PROTOCOL_VERSION, at: 900, from: null, to: MAIL },
            // The card follows what the user types: an empty body, then the sentence.
            snap([{ key: BODY, parent: null, role: "AXTextArea", label: "Body", editable: true }], { at: 950, windowId: "6160-4", app: MAIL, title: "New message", focused: true, focusedKey: BODY }),
            snap([{ key: BODY, parent: null, role: "AXTextArea", label: "Body", editable: true, value: body }], { at: 1000, windowId: "6160-4", app: MAIL, title: "New message", focused: true, focusedKey: BODY, values: [{ kind: "date", text: "Thu 3:00 to 3:30 PM", nodeKey: BODY }] }),
          ],
          "event card",
        );
        await s.helper.eventsSettled;
        await s.firstLook(["event"]);
      },
      true,
      () => Date.parse("2026-10-05T10:00:00-05:00"),
    );
    expect(rec.filter((r) => r.producer === "event card").length).toBeGreaterThan(0);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
  });

  it("fill from memory: the user's typed name and email beside a chat that quotes the name", async () => {
    const rec = await run("about desk", async (s) => {
      const add = (label: string, value: string) => s.helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: label, op: "add", kind: "about", fields: { label, value, source: "typed" } });
      add("Name", "Dana Whitfield");
      add("Email", "dana.whitfield@example.com");
      // No window shows either value, so they can only come from memory (about-fill.test.ts covers a window that does).
      await s.replay([notesWindow(500), chatWindow(600), ...shortChats().slice(-2)], "fill on focus");
    });
    const fills = rec.filter((r) => r.producer === "fill on focus");
    expect(fills.length).toBeGreaterThan(0);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
    expect(fills.some((r) => r.req.snippets.some((x) => x.windowId === "memory"))).toBe(true);
  });

  it("routine names: three routines named from their labels while a chat and private notes are open (B19)", async () => {
    const stream = skillStream({ days: 3, caretFrom: null });
    const rec = await run("routine names", async (s) => {
      s.helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: 1, roles: ["fill", "repeat", "watch", "calendar", "words"], level: "eager", paused: false });
      await s.replay([notesWindow(500), chatWindow(600), ...stream.messages], "routine name");
      await s.helper.patterns.skills.namesSettled();
    });
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
    const naming = rec.filter((r) => r.req.questions.name !== undefined);
    expect(naming).toHaveLength(3);
    // No value any routine copied is in any naming request.
    const copied = stream.plants.flatMap((p) => p.opens.flatMap((o) => o.values));
    for (const r of naming) for (const v of copied) expect(bodyOf(r.req).includes(v), v).toBe(false);
    // The ledger, pinned: the destination's field labels as its descriptors, the source's section label as
    // its candidate, the app names, the question and code's names as plan text, and nothing else. Each window is charged what
    // the request reveals of it: a whole line, or a run of 12 characters or more. A label inside a longer title ("Invoice" in
    // the Invoices window's) is under 12 characters and charges that window nothing.
    const pinned = naming.map((r) => ({ snippets: r.req.snippets.map((x) => `${x.windowId} ${x.kind} ${x.text}`), charged: r.req.charged }));
    expect(pinned).toEqual([
      { snippets: ["6160-103 descriptor Subject", "6160-103 descriptor To", "6160-103 descriptor Link", "5150-4 candidate Today", "plan candidate Mail Fixture", "plan candidate Caret Fixture", "plan candidate Someone copied values from Caret Fixture into Mail Fixture the same way 3 times. Which short name would they recognize this routine by?", "plan candidate Subject and To into Mail Fixture", "plan candidate Today to Mail Fixture", "plan candidate Caret Fixture to Mail Fixture", "plan candidate Fill Mail Fixture from Caret Fixture", "plan candidate Copy Subject into Mail Fixture", "plan candidate Log Subject in Mail Fixture"], charged: { "6160-103": 13, "5150-4": 5 } },
      { snippets: ["7170-103 descriptor Vendor", "7170-103 descriptor Amount", "7170-103 descriptor Invoice", "5150-5 candidate Latest invoice", "plan candidate Sheet Fixture", "plan candidate Caret Fixture", "plan candidate Someone copied values from Caret Fixture into Sheet Fixture the same way 3 times. Which short name would they recognize this routine by?", "plan candidate Vendor and Amount into Sheet Fixture", "plan candidate Latest invoice to Sheet Fixture", "plan candidate Caret Fixture to Sheet Fixture", "plan candidate Fill Sheet Fixture from Caret Fixture", "plan candidate Copy Vendor into Sheet Fixture", "plan candidate Log Vendor in Sheet Fixture"], charged: { "7170-103": 19, "5150-5": 14 } },
      { snippets: ["7270-103 descriptor Order", "7270-103 descriptor Carrier", "7270-103 descriptor Tracking number", "5150-7 candidate Ready to ship", "plan candidate Tracker Fixture", "plan candidate Caret Fixture", "plan candidate Someone copied values from Caret Fixture into Tracker Fixture the same way 3 times. Which short name would they recognize this routine by?", "plan candidate Order and Carrier into Tracker Fixture", "plan candidate Ready to ship to Tracker Fixture", "plan candidate Caret Fixture to Tracker Fixture", "plan candidate Fill Tracker Fixture from Caret Fixture", "plan candidate Copy Order into Tracker Fixture", "plan candidate Log Order in Tracker Fixture"], charged: { "7270-103": 27, "5150-7": 13 } },
    ]);
  });

  it("the same short chats went out whole with the conversation rule off, and the check catches that", async () => {
    setConversationCap(false);
    let rec: Recorded[];
    try {
      rec = await run("short chats, rule off", (s) => s.replay(shortChats(), "fill on focus"), false);
    } finally {
      setConversationCap(true);
    }
    capOff.push(...rec);
    const whole = new Set(rec.flatMap(measure).filter((m) => m.covered >= m.chars).map((m) => m.windowId));
    expect(whole).toContain(SHORT_CHAT);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS)).some((v) => v.includes(`conversation ${SHORT_CHAT}, half or more`))).toBe(true);
  });

  it("catches what it is for: a request that pastes a window, or names text it did not declare", () => {
    const w: WindowText = { windowId: "x-1", title: "Big", lines: Array.from({ length: 60 }, (_, i) => `A line of the window, number ${i}`), chars: 0 };
    w.chars = w.lines.reduce((n, l) => n + l.length, 0);
    const pasted: Recorded = { session: "s", producer: "p", windows: [w], req: { state: { now: w.lines.join("\n") }, questions: {}, snippets: w.lines.map((t) => ({ windowId: "x-1", kind: "candidate", text: t })), charged: { "x-1": w.chars } } };
    // Over the per-window bound is what is wrong.
    expect(violations(pasted, new Set())).toEqual([expect.stringContaining("over 1200")]);
    // A short chat: a window may go out whole under the per-window bound; a conversation may not.
    const chat: WindowText = { windowId: "c-1", title: "Chat", lines: ["Dana", "3:41 PM", "see you at five", "Kofi", "3:42 PM", "on my way"], chars: 0 };
    chat.chars = chat.lines.reduce((n, l) => n + l.length, 0);
    const chatWhole: Recorded = { session: "s", producer: "p", windows: [chat], req: { state: { now: chat.lines.join("\n") }, questions: {}, snippets: chat.lines.map((t) => ({ windowId: "c-1", kind: "candidate", text: t })), charged: { "c-1": chat.chars } } };
    expect(violations(chatWhole, new Set(), new Set())).toEqual([]);
    expect(violations(chatWhole, new Set(), new Set(["c-1"]))).toEqual([expect.stringContaining("conversation c-1, half or more")]);
    const sneaky: Recorded = { ...pasted, req: { state: { now: w.lines.slice(0, 2).join("\n") }, questions: {}, snippets: [], charged: {} } };
    const found = violations(sneaky, new Set(["x-1"]));
    expect(found.filter((v) => v.includes("undeclared line"))).toHaveLength(2);
    expect(found.filter((v) => v.includes("a window it does not name"))).toHaveLength(2);
    expect(found.filter((v) => v.includes("from bystander x-1"))).toHaveLength(1);
    // A ledger that charged a window less than the request shows of it.
    const under: Recorded = { ...chatWhole, req: { ...chatWhole.req, charged: { "c-1": chat.chars - 1 } } };
    expect(violations(under, new Set(), new Set())).toEqual([expect.stringContaining(`its ledger charged ${chat.chars - 1}`)]);
  });

  /** For each session's window that any request took from: the most one request took, and its share of the window. */
  const perWindow = (recs: readonly Recorded[]) => {
    const best = new Map<string, { session: string; title: string; windowId: string; conversation: boolean; chars: number; covered: number; share: number }>();
    for (const r of recs) {
      for (const m of measure(r)) {
        if (m.covered === 0) continue;
        const k = `${r.session}\u0000${m.windowId}`;
        const share = m.covered / m.chars;
        if ((best.get(k)?.share ?? -1) >= share) continue;
        const title = r.windows.find((w) => w.windowId === m.windowId)?.title ?? m.windowId;
        best.set(k, { session: r.session, title, windowId: m.windowId, conversation: CONVERSATIONS.has(m.windowId), chars: m.chars, covered: m.covered, share: Math.round(share * 1000) / 1000 });
      }
    }
    return [...best.values()].sort((a, b) => b.share - a.share);
  };

  const ledgerVsTest = (recs: readonly Recorded[]) => {
    const rows = recs.map((r) => ({
      session: r.session,
      producer: r.producer,
      windows: measure(r)
        .filter((m) => m.covered > 0 || (r.req.charged[m.windowId] ?? 0) > 0)
        .map((m) => ({ windowId: m.windowId, title: r.windows.find((w) => w.windowId === m.windowId)?.title ?? m.windowId, conversation: CONVERSATIONS.has(m.windowId), test: m.covered, ledger: r.req.charged[m.windowId] ?? 0 })),
    }));
    const pairs = rows.flatMap((r) => r.windows);
    return {
      requests: rows.length,
      windowsCounted: pairs.length,
      ledgerBelowTest: pairs.filter((p) => p.ledger < p.test).length,
      equal: pairs.filter((p) => p.ledger === p.test).length,
      ledgerAboveTest: pairs.filter((p) => p.ledger > p.test).length,
      requestsAgreeing: rows.filter((r) => r.windows.every((p) => p.ledger >= p.test)).length,
      rows,
    };
  };

  afterAll(() => {
    // The report asserts nothing and is only written when asked for; building it measures every request again, which
    // passed the 10-second hook limit under the full suite.
    const out = process.env.PRIVACY_REPORT;
    if (out === undefined) return;
    const ms = all.map((r) => ({ r, m: measure(r) }));
    const bodies = all.map((r) => bodyOf(r.req).length);
    const largest = Math.max(...bodies);
    const top = ms.flatMap(({ r, m }) => m.map((x) => ({ ...x, session: r.session, producer: r.producer }))).sort((a, b) => b.covered - a.covered)[0];

    const report = {
      requests: all.length,
      byProducer: Object.fromEntries([...new Set(all.map((r) => r.producer))].map((p) => [p, all.filter((r) => r.producer === p).length])),
      bounds: { windowChars: WINDOW_CHARS, conversationChars: CONVERSATION_CHARS },
      largestRequestChars: largest,
      largestRequest: all[bodies.indexOf(largest)] === undefined ? null : `${all[bodies.indexOf(largest)]?.session} / ${all[bodies.indexOf(largest)]?.producer}`,
      /** Of the largest request, the declared screen text, each piece once; the rest is the question's own wording and facts. */
      largestRequestScreenChars: [...new Set(all[bodies.indexOf(largest)]?.req.snippets.map((x) => x.text) ?? [])].reduce((n, t) => n + t.length, 0),
      mostFromOneWindow: top === undefined ? null : { covered: top.covered, ofChars: top.chars, session: top.session, producer: top.producer },
      conversationsSeen: [...CONVERSATIONS].filter((id) => all.some((r) => r.windows.some((w) => w.windowId === id))).length,
      conversationsSentWhole: perWindow(all).filter((x) => x.conversation && x.covered >= x.chars).map((x) => `${x.session}: ${x.title}`),
      highestShareOfAConversation: Math.max(0, ...perWindow(all).filter((x) => x.conversation).map((x) => x.share)),
      mostFromAConversation: Math.max(0, ...perWindow(all).filter((x) => x.conversation).map((x) => x.covered)),
      /** Every window a request took from, with the most any one request took and the share of the window that was. */
      largestPerWindow: perWindow(all),
      /** The short-chat session again with the conversation rule off, as the helper behaved before B11. */
      ruleOff: perWindow(capOff),
      /**
       * The ledger against this test, request by request: for each window either one counts, the characters
       * the test measures the request covers and the characters the ledger charged it. The ledger never
       * charging less is what lets it hold the caps at runtime (violations checks it on every request).
       */
      ledgerVsTest: ledgerVsTest(all),
    };
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  });
});

describe("a conversation the Ask names", () => {
  const MAIL = "9003-1";
  const FORM = "9004-1";
  const F = "com.google.Chrome/standard";
  // The filler's short lines share the fields' words (guest, meal, arrival, phone), so without the named person first
  // they win the budget over Bea's lines, which come last.
  const body = (n: number): string[] => [
    "From: Beatrice Sutherland <bea.sutherland@example.com>",
    "To: Avery Kim <avery.kim@example.com>",
    "Date: Wed, Oct 14, 2026, 12:06 PM",
    ...Array.from({ length: n }, (_, i) => `Guest ${i} arrival, meal notes and phone for table ${i}`),
    "Yes, I'd love to be your plus-one on the 24th, thank you for asking. Put me down as Beatrice Sutherland.",
    "Food: I'll have the vegetarian one. You said you wanted the short rib, so get that for yourself.",
    "My shift ends at 7, so we'd get there around 7:45 pm. See you soon, Bea",
    "(503) 555-0157",
  ];
  const desk = (n: number): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap(body(n).map((l, i) => text(`mail/l${i}`, l)), { at: 100, windowId: MAIL, title: "Re: plus-one", app: { pid: 9003, bundleId: "com.apple.mail", name: "Mail" }, focused: true }));
    const fields = ["Guest's full name", "Guest phone", "Guest email", "Arrival time", "Meal notes"].map((label, i) => node(`${F}/textfield:f${i}~0`, "AXTextField", { label, editable: true, value: "", parent: `${F}/webarea:~0`, frame: [100, 100 + 30 * i, 200, 20] }));
    m.apply(snap([node(`${F}/webarea:~0`, "AXWebArea", { label: "RSVP" }), ...fields], { at: 200, windowId: FORM, title: "RSVP", app: { pid: 9004, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${F}/textfield:f0~0` }));
    return m;
  };
  const fill = async (m: ScreenModel, named: boolean): Promise<Recorded[]> => {
    const rec: Recorded[] = [];
    const ask: AskJev = async (req) => {
      rec.push({ session: "named mail", producer: named ? "ask naming the mail" : "ask naming nothing", req: sealCharged(req), windows: [...m.windows.values()].map(textOf) });
      return fakeJev(req);
    };
    const keys = [0, 1, 2, 3, 4].map((i) => `${F}/textfield:f${i}~0`);
    await proposeFill(m, ask, FORM, keys[0] as string, 1000, { scope: { fields: keys, windows: null, memory: false, instruction: "put Bea down as my guest", person: "Bea", literals: new Map(), ...(named ? { consented: new Set([MAIL]), first: ["Bea", "Beatrice Sutherland"] } : {}) } });
    return rec;
  };
  const mailMeasure = (rec: Recorded[]) => rec.flatMap(measure).filter((x) => x.windowId === MAIL);

  it("keeps more than half of a short mail back, whether the Ask names it or not", async () => {
    for (const named of [true, false]) {
      const rec = await fill(desk(0), named);
      expect(rec.length).toBeGreaterThan(0);
      expect(rec.flatMap((r) => violations(r, new Set(), new Set([MAIL])))).toEqual([]);
      for (const x of mailMeasure(rec)) expect(x.covered * 2).toBeLessThan(x.chars);
    }
  });

  it("gives at most CONVERSATION_CHARS of a long named mail, the named person's lines first", async () => {
    const named = await fill(desk(50), true);
    expect(named.flatMap((r) => violations(r, new Set(), new Set([MAIL])))).toEqual([]);
    for (const x of mailMeasure(named)) expect(x.covered).toBeLessThanOrEqual(CONVERSATION_CHARS);
    // In the generator, Bea's lines go in only when they go first.
    const offered = (first: boolean): string[] => {
      const m = desk(50);
      const terms = ["Guest's full name", "Guest phone", "Guest email", "Arrival time", "Meal notes"].map((l) => fieldTerms([l]));
      return collectCandidates(m, FORM, { now: 1000, ledger: new Disclosure(m), fields: terms, ...(first ? { first: { windows: new Set([MAIL]), names: ["Bea", "Beatrice Sutherland"] } } : {}) }).candidates.map((c) => c.text);
    };
    expect(offered(true)).toContain("My shift ends at 7, so we'd get there around 7:45 pm. See you soon, Bea");
    expect(offered(false)).not.toContain("My shift ends at 7, so we'd get there around 7:45 pm. See you soon, Bea");
  });

  it("checks every window against rule 2, the WINDOW_CHARS bound", () => {
    const w = { windowId: MAIL, title: "x", lines: ["a".repeat(1300)], chars: 1300 };
    const r: Recorded = { session: "s", producer: "p", windows: [w], req: { state: { now: "a".repeat(1300) }, questions: {}, snippets: [{ windowId: MAIL, kind: "candidate", text: "a".repeat(1300) }], charged: { [MAIL]: 1300 } } };
    expect(violations(r, new Set(), new Set())).toEqual([expect.stringContaining(`over ${WINDOW_CHARS}`)]);
  });
});
