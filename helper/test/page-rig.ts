// The page-goal rig of page-goals.test.ts (P2), shared with P3's tests: a Helper over one page tab (fake-page.ts) and
// the note the user just left, an Ask's intent from a canned writer maker, and canned Jev picks by field label. Every
// name and value is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { PROTOCOL_VERSION, type GoalAccept, type GoalProgress, type HelperMessage, type PageControl } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import { byLabel, chrome, FakePage, hello, mixedControls, NOTE, okReader, PICKS, TEXTEDIT, WIN } from "./fake-page.ts";

export type Segment = Extract<GoalProgress, { event: "segment" }>;
export type Finished = Extract<GoalProgress, { event: "finished" }>;
export type Stopped = Extract<GoalProgress, { event: "stopped" }>;

export interface Intent {
  scope: "all" | "list" | "section";
  fields?: string[];
  section?: string;
  literals?: { field: string; text: string }[];
}

/** The intent a writer maker gives: `scope` all, a section, or a list of field refs. */
export function intentWriter(intent: Intent): WriterPort {
  return {
    route: FAKE_WRITER_ROUTE,
    async write(req) {
      const base = { model: "canned", provider: "canned", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
      if (req.kind !== "intent") throw new Error(`asked to write a ${req.kind}`);
      const json = { route: "fill", why: "none", scope: intent.scope, section: intent.section ?? "none", fields: intent.fields ?? [], sources: ["any"], whose: "user", literals: intent.literals ?? [] };
      return { ...base, output: { program: null, reply: JSON.stringify(json), json } };
    },
  };
}

export interface Rig {
  page: FakePage;
  helper: Helper;
  host: PageHost;
  published: HelperMessage[];
  asked: JevRequest[];
  /** The note window's text now; setNote replaces it, as the user editing the note does. */
  setNote(text: string): Promise<void>;
  ask(instruction: string): Promise<GoalProgress>;
  accept(s: Segment, more?: Pick<GoalAccept, "confirmedFile">): ReturnType<Helper["handleGoalAccept"]>;
  /** The user's own Next: the tab shows another form as a new document, and the page engine walks it. */
  next(make: () => PageControl[], title: string, path: string): Promise<void>;
  close(): void;
}

const rigs: Rig[] = [];

/** Closes every rig made since the last call; each test file calls it in afterEach. */
export function closeRigs(): void {
  for (const r of rigs.splice(0)) r.close();
}

export interface RigOptions {
  controls?: () => PageControl[];
  title?: string;
  note?: string;
  picks?: Record<string, string>;
  intent?: Intent;
  /** P3: the in-process caller shows attach rows (HelperOptions.goalFiles). */
  goalFiles?: boolean;
  /** Wraps the canned Jev, for a test that fails or counts requests. */
  jev?: (inner: AskJev) => AskJev;
  /** The helper's clock (HelperOptions.now); the real one by default. */
  now?: () => number;
  /** I6: the offers an hour may show (HelperOptions.offersPerHour); the settings' own by default. */
  offersPerHour?: number;
}

/** A Helper over one page tab and the note the user just left, with canned picks by field label (fake-page.ts PICKS). */
export async function rig(o: RigOptions = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "caret-p3-"));
  const store = new Store(join(dir, "data"));
  const page = new FakePage(o.controls ?? mixedControls, o.title ?? "Apply: Mixed controls");
  const published: HelperMessage[] = [];
  const asked: JevRequest[] = [];
  const picks = o.picks ?? PICKS;
  const pick = jevPickingText((_, ins) => picks[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? (o.picks === undefined ? byLabel(_, ins) : null), 0.95);
  // Confirmation questions (planner/ask.ts confirmScope) answer yes, the scope ask asks; everything else is fill's.
  const canned: AskJev = async (req) => {
    asked.push(req);
    const r = await pick(req);
    for (const [id, q] of Object.entries(req.questions)) if ("yes" in q.criteria) r.answers[id] = { choice: "yes", confidence: 0.95 };
    // I2: Jev's scope ask, which settles a plan's, a next page's and a reveal's fields, says every field is asked for.
    // SCP1: and its section question names no one section, so no section veto applies.
    if (req.purpose === "ask.scope") for (const id of Object.keys(req.questions)) r.answers[id] = { choice: id === "section" ? "fields" : "asks", confidence: 0.95 };
    return r;
  };
  const jev = o.jev === undefined ? canned : o.jev(canned);
  let helper: Helper;
  const host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn: () => {} });
  helper = new Helper({
    store,
    askJev: jev,
    shadow: false,
    allowBackgroundFocus: false,
    readerLink: host.link,
    calendar: null,
    publish: (m) => void published.push(m),
    warn: () => {},
    ask: { maker: "writer", writer: intentWriter(o.intent ?? { scope: "all" }) },
    pageDocument: (id) => host.registry.documentOf(id),
    // As main.ts wires it: the page's address, headings and what its walk left out (a password field).
    pageContext: (id) => host.registry.contextOf(id),
    ...(o.goalFiles === true ? { goalFiles: true } : {}),
    ...(o.now === undefined ? {} : { now: o.now }),
    ...(o.offersPerHour === undefined ? {} : { offersPerHour: o.offersPerHour }),
  });
  wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
  host.registry.add(page.session);
  page.session.receive(hello);
  await new Promise((r) => setTimeout(r, 0));
  const note = async (text: string, at: number): Promise<void> => {
    await helper.handleReader(snap([field("te/note", text, { role: "AXTextArea" })], { at, windowId: "note", title: "Robin's details.txt", app: TEXTEDIT, focused: true }));
  };
  await note(o.note ?? NOTE, Date.now() - 5000);
  expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
  const r: Rig = {
    page,
    helper,
    host,
    published,
    asked,
    // A background walk of the note: the user's focus stays where it was.
    setNote: async (text) => {
      await helper.handleReader({ ...snap([field("te/note", text, { role: "AXTextArea" })], { at: Date.now(), windowId: "note", title: "Robin's details.txt", app: TEXTEDIT, focused: false }), reason: "background" });
    },
    ask: (instruction) => helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: Date.now(), instruction, windowId: WIN }, undefined, true, true) as Promise<GoalProgress>,
    accept: (s, more = {}) => helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: s.goalId, segment: s.segment, digest: s.digest, at: Date.now(), ...more }),
    next: async (make, title, path) => {
      page.goTo(make, title, path);
      expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
    },
    close: () => {
      helper.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  rigs.push(r);
  return r;
}

export const goalMessages = (r: Rig): GoalProgress[] => r.published.filter((m): m is GoalProgress => m.type === "goalProgress");
export const presses = (r: Rig): number => r.page.verbs.filter((v) => v.kind === "pagePress").length;

export { WIN };
