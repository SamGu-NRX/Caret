// The privacy line, checked on every Jev request the producers and the first look make over the
// synthetic sessions. The onboarding copy promises: "To decide what to offer, Caret sends short snippets
// to a cloud model, such as a field's label and the values it might fill. Never whole windows."
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
// 3. No whole window. A window that is not a card of values (at most 24 lines, none over 80 characters)
//    keeps more than half its text out of every request. A card may go out whole: its lines are each a
//    value a fill might copy. That exemption is a decision, not a measurement, and the report says so.
// 4. Nothing from a window that is not a source. Text unique to a window the request does not name in
//    its snippets never appears, descriptors come from the one window the question is about, and the
//    sessions' bystander windows (paragraphs no fill can use) give nothing to any request.
//
// PRIVACY_REPORT=FILE writes the measured numbers as JSON.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import type { WindowState } from "../src/model.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { PROTOCOL_VERSION, type Node, type ReaderMessage, type ReaderVerb, type VerbResult } from "../src/protocol.ts";
import { resolveTarget } from "../src/executor/target.ts";
import { WINDOW_CHARS } from "../src/privacy.ts";
import { FIXTURE_APP, focus, node, snap, text } from "./builders.ts";
import { loadRecording } from "./socket-reader.ts";
import { largeScene } from "./large-scene.ts";
import { CODEX, T3, agentSnap, codexWindow, t3Window } from "./agent-fixtures.ts";

const CARD_LINES = 24;
const CARD_LINE_CHARS = 80;
const MIN_LINE = 8;
const PREFIX = 40;

interface WindowText {
  windowId: string;
  title: string;
  lines: string[];
  chars: number;
  card: boolean;
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
    card: lines.length <= CARD_LINES && lines.every((l) => l.length <= CARD_LINE_CHARS),
  };
}

/** Every string a request sends: the values in its state and questions (keys are fixed names and candidate ids). */
function bodyOf(req: JevRequest): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
  };
  walk(req.state);
  walk(req.questions);
  return out.join("\n");
}

interface Recorded {
  session: string;
  producer: string;
  req: JevRequest;
  windows: WindowText[];
}

interface WindowMeasure {
  windowId: string;
  covered: number;
  chars: number;
  card: boolean;
}

/**
 * Characters of each window's text the request carries: a line the request holds whole counts in full,
 * and each declared snippet of 3 or more characters marks where it stands in the first line that holds
 * it. A text sent once counts once, however many lines repeat it ("see you at 5" in a chat): the
 * request reveals it once.
 */
function measure(r: Recorded): WindowMeasure[] {
  const body = bodyOf(r.req);
  const texts = [...new Set(r.req.snippets.map((s) => s.text).filter((t) => t.length >= 3))];
  return r.windows.map((w) => {
    let covered = 0;
    const used = new Set<string>();
    for (const line of w.lines) {
      if (body.includes(line)) {
        covered += line.length;
        for (const t of texts) if (line.includes(t)) used.add(t);
        continue;
      }
      const marked = new Uint8Array(line.length);
      for (const t of texts) {
        if (used.has(t)) continue;
        const at = line.indexOf(t);
        if (at < 0) continue;
        marked.fill(1, at, at + t.length);
        used.add(t);
      }
      covered += marked.reduce((n, b) => n + b, 0);
    }
    return { windowId: w.windowId, covered, chars: w.chars, card: w.card };
  });
}

/** Every way the request breaks the line, as sentences naming windows and lengths, never the text. */
function violations(r: Recorded, bystanders: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const body = bodyOf(r.req);
  const where = `${r.session} / ${r.producer}`;
  for (const s of r.req.snippets) if (!body.includes(s.text)) out.push(`${where}: declares ${s.text.length} characters from ${s.windowId} it does not send`);
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
    if (m.covered > WINDOW_CHARS) out.push(`${where}: ${m.covered} characters from ${m.windowId}, over ${WINDOW_CHARS}`);
    if (!m.card && m.covered * 2 >= m.chars && m.covered > 0) out.push(`${where}: ${m.covered} of ${m.chars} characters of ${m.windowId}, half or more of a window that is not a card`);
    if (bystanders.has(m.windowId) && m.covered > 0) out.push(`${where}: ${m.covered} characters from bystander ${m.windowId}`);
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
  const answers = Object.fromEntries(
    Object.entries(q).map(([id, question]) => {
      const label = /Label: '([^']+)'|Nearest label: '([^']+)'/.exec(String(question.instructions));
      const want = FILL_VALUES[label?.[1] ?? label?.[2] ?? ""];
      const hit = want === undefined ? undefined : Object.entries(question.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
      return [id, answer(hit?.[0] ?? "none")];
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

  constructor(name: string) {
    this.name = name;
    this.dir = mkdtempSync(join(tmpdir(), "caret-privacy-"));
    this.store = new Store(this.dir);
    this.ask = (req) => {
      this.recorded.push({ session: this.name, producer: this.producer, req, windows: [...this.helper.model.windows.values()].map(textOf) });
      return fakeJev(req);
    };
    this.helper = new Helper({ store: this.store, askJev: this.ask, shadow: false, allowBackgroundFocus: true, readerLink: okReader, publish: () => undefined });
  }

  async replay(messages: readonly ReaderMessage[], producer: string): Promise<void> {
    this.producer = producer;
    for (const m of messages) {
      await this.helper.handleReader(m);
      if ("at" in m) this.helper.tick(m.at);
    }
    await this.helper.pending.whenIdle();
  }

  async firstLook(): Promise<void> {
    this.producer = "first look";
    await this.helper.handleFirstLook({ type: "firstLook", v: PROTOCOL_VERSION, requestId: `${this.name}-look`, at: 1, families: ["fill", "pending", "loop", "routine"], level: "eager", deadlineMs: 8000 });
  }

  close(): void {
    this.helper.shutdown();
    this.helper.memory.close();
    this.store.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Long paragraphs: text no fill can use, since every line is over 80 characters. */
const NOTES = "7070-1";
function notesWindow(at: number): ReaderMessage {
  const para = (i: number): string =>
    `Paragraph ${i} of the private notes, which runs well past eighty characters so that no fill could ever take it as a value.`;
  return snap(
    Array.from({ length: 12 }, (_, i) => text(`dev.caret.notes/standard/statictext:p${i}~0`, para(i))),
    { at, windowId: NOTES, app: { pid: 7070, bundleId: "dev.caret.notes", name: "Notes" }, title: "Private notes" },
  );
}

/**
 * A chat of 40 short, different messages, each one a fill could take: not a card, so a request may carry
 * less than half of it. Without the budget the generator would take every line.
 */
const CHAT = "7171-1";
function chatWindow(at: number): ReaderMessage {
  const lines = Array.from({ length: 40 }, (_, i) => text(`dev.caret.chat/standard/statictext:m${i}~0`, `Message ${i}: table ${i} is set for the ${i + 4} guests`));
  return snap(lines, { at, windowId: CHAT, app: { pid: 7171, bundleId: "dev.caret.chat", name: "Chat" }, title: "Team chat" });
}

const all: Recorded[] = [];
const BYSTANDERS = new Set([NOTES]);

async function run(name: string, body: (s: Session) => Promise<void>): Promise<Recorded[]> {
  const s = new Session(name);
  try {
    await body(s);
  } finally {
    s.close();
  }
  all.push(...s.recorded);
  return s.recorded;
}

describe("the privacy line on every Jev request", () => {
  it("fill: a form beside a mail, a chat and private notes, then a first look", async () => {
    const rec = await run("fill desk", async (s) => {
      await s.replay([notesWindow(500), chatWindow(600), ...loadRecording("offers-fill.ndjson")], "fill on focus");
      await s.firstLook();
    });
    expect(rec.map((r) => r.producer)).toEqual(["fill on focus", "fill on focus", "first look", "first look"]);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
    // The chat window took part, and kept more than half of itself back.
    const chat = rec.flatMap(measure).filter((m) => m.windowId === CHAT && m.covered > 0);
    expect(chat.length).toBeGreaterThan(0);
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
    expect(rec.length).toBe(4);
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
      const threads = [{ title: "Venue shortlist", status: "Working" }, { title: "Badge printing" }];
      const t3 = (o: Parameters<typeof t3Window>[0], at: number, focused: boolean) => agentSnap(T3, t3Window(o), { at, windowId: "8101-1", title: "Seating chart", focused });
      await s.replay(
        [
          t3({ running: true, threads, transcriptLines: 450 }, 1000, true),
          agentSnap(CODEX, codexWindow({ running: true, threads, transcriptLines: 450, last: ["Allow this command? pnpm install --frozen-lockfile"] }), { at: 1100, windowId: "8202-1", title: "Badge export", focused: true }),
          t3({ running: false, threads, transcriptLines: 450, last: ["Updated all four seating files and ran the checks: 48 of 48 passed."] }, 1200, false),
        ],
        "pending watch",
      );
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
      await resolveTarget(w, { role: "AXTextField", label: "City", describe: "the City field" }, "The shipping City field holds Austin", s.ask);
    });
    expect(rec).toHaveLength(2);
    expect(rec.flatMap((r) => violations(r, BYSTANDERS))).toEqual([]);
  });

  it("catches what it is for: a request that pastes a window, or names text it did not declare", () => {
    const w: WindowText = { windowId: "x-1", title: "Big", lines: Array.from({ length: 60 }, (_, i) => `A line of the window, number ${i}`), chars: 0, card: false };
    w.chars = w.lines.reduce((n, l) => n + l.length, 0);
    const pasted: Recorded = { session: "s", producer: "p", windows: [w], req: { state: { now: w.lines.join("\n") }, questions: {}, snippets: w.lines.map((t) => ({ windowId: "x-1", kind: "candidate", text: t })) } };
    expect(violations(pasted, new Set())).toEqual([expect.stringContaining("over 1200"), expect.stringContaining("half or more")]);
    const sneaky: Recorded = { ...pasted, req: { state: { now: w.lines.slice(0, 2).join("\n") }, questions: {}, snippets: [] } };
    const found = violations(sneaky, new Set(["x-1"]));
    expect(found.filter((v) => v.includes("undeclared line"))).toHaveLength(2);
    expect(found.filter((v) => v.includes("a window it does not name"))).toHaveLength(2);
    expect(found.filter((v) => v.includes("from bystander x-1"))).toHaveLength(1);
  });

  afterAll(() => {
    const ms = all.map((r) => ({ r, m: measure(r) }));
    const bodies = all.map((r) => bodyOf(r.req).length);
    const largest = Math.max(...bodies);
    const top = ms.flatMap(({ r, m }) => m.map((x) => ({ ...x, session: r.session, producer: r.producer }))).sort((a, b) => b.covered - a.covered)[0];
    const nonCard = ms.flatMap(({ m }) => m.filter((x) => !x.card && x.covered > 0).map((x) => x.covered / x.chars));
    const card = ms.flatMap(({ m }) => m.filter((x) => x.card && x.covered > 0).map((x) => x.covered / x.chars));
    const report = {
      requests: all.length,
      byProducer: Object.fromEntries([...new Set(all.map((r) => r.producer))].map((p) => [p, all.filter((r) => r.producer === p).length])),
      bounds: { windowChars: WINDOW_CHARS, cardLines: CARD_LINES, cardLineChars: CARD_LINE_CHARS, nonCardShare: 0.5 },
      largestRequestChars: largest,
      largestRequest: all[bodies.indexOf(largest)] === undefined ? null : `${all[bodies.indexOf(largest)]?.session} / ${all[bodies.indexOf(largest)]?.producer}`,
      /** Of the largest request, the declared screen text, each piece once; the rest is the question's own wording and facts. */
      largestRequestScreenChars: [...new Set(all[bodies.indexOf(largest)]?.req.snippets.map((x) => x.text) ?? [])].reduce((n, t) => n + t.length, 0),
      cardsSentWhole: [...new Set(ms.flatMap(({ r, m }) => m.filter((x) => x.card && x.covered >= x.chars).map((x) => `${r.session}: ${r.windows.find((w) => w.windowId === x.windowId)?.title ?? x.windowId} (${x.chars} characters)`)))],
      mostFromOneWindow: top === undefined ? null : { covered: top.covered, ofChars: top.chars, card: top.card, session: top.session, producer: top.producer },
      highestShareOfANonCardWindow: nonCard.length === 0 ? 0 : Math.max(...nonCard),
      highestShareOfACard: card.length === 0 ? 0 : Math.max(...card),
    };
    if (process.env.PRIVACY_REPORT !== undefined) writeFileSync(process.env.PRIVACY_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  });
});
