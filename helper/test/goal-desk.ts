// A synthetic desk for goal plans (D2-06): native windows of invented apps, sent to a Helper as reader snapshots,
// answering the executor's verbs as caret-screen does (recheck the element, act, send a fresh snapshot), under the
// reader's act-grant rules and its press table. Buttons run handlers that change their window. Every name, number and
// address is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Helper, type HelperOptions } from "../src/helper.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { Store } from "../src/store.ts";
import { FakeCalendar } from "../src/executor/means.ts";
import { PROTOCOL_VERSION, isCalendarVerb, type GoalAccept, type GoalProgress, type HelperMessage, type ActGrant, type ActRevoke, type AppRef, type CalendarGrant, type Node, type ReaderMessage, type ReaderVerb, type TypedValue, type VerbResult } from "../src/protocol.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import type { PlanningSnapshot } from "../src/codemode/types.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterPort } from "../src/writer/port.ts";
import type { LocalModelPort } from "../src/writer/local-port.ts";
import { classifyPress } from "../src/executor/risk.ts";
import { snap } from "./builders.ts";
import { FakeGrants } from "./fake-grants.ts";
import { FakeMarks } from "./fake-marks.ts";

export const MAIL: AppRef = { pid: 6161, bundleId: "dev.caret.mailfixture", name: "Mail Fixture" };
export const SUPPORT: AppRef = { pid: 7171, bundleId: "dev.caret.supportfixture", name: "Support Fixture" };

export interface DeskWindow {
  windowId: string;
  app: AppRef;
  title: string;
  /** The window's kind from its subrole; "standard" when absent. */
  kind?: string;
  nodes: Node[];
  values?: TypedValue[];
  /** Handlers for button presses, by node key. */
  buttons?: Map<string, (w: DeskWindow, desk: GoalDesk) => void>;
}

export interface DeskSink {
  handleReader(m: ReaderMessage): unknown;
}

const k = (app: AppRef, s: string): string => `${app.bundleId}/standard/${s}`;
export const fieldKey = (app: AppRef, label: string, n = 0): string => k(app, `textfield:${label.toLowerCase()}~${n}`);
export const areaKey = (app: AppRef, label: string): string => k(app, `textarea:${label.toLowerCase()}~0`);
export const buttonKey = (app: AppRef, label: string): string => k(app, `button:${label.toLowerCase()}~0`);
export const textKey = (app: AppRef, n: number): string => k(app, `statictext:line ${n}~0`);

export function textField(app: AppRef, label: string, value = ""): Node {
  return { key: fieldKey(app, label), parent: null, role: "AXTextField", label, editable: true, ...(value === "" ? {} : { value }) };
}
export function textArea(app: AppRef, label: string, value = ""): Node {
  return { key: areaKey(app, label), parent: null, role: "AXTextArea", label, editable: true, ...(value === "" ? {} : { value }) };
}
export function button(app: AppRef, label: string): Node {
  return { key: buttonKey(app, label), parent: null, role: "AXButton", label };
}
export function line(app: AppRef, n: number, text: string): Node {
  return { key: textKey(app, n), parent: null, role: "AXStaticText", label: text };
}

export class GoalDesk implements ReaderLink {
  /** The desk's clock, near the real one: the executor's grants carry Date.now() times. */
  at = Date.now();
  sink: DeskSink | null = null;
  readonly windows = new Map<string, DeskWindow>();
  readonly verbs: ReaderVerb[] = [];
  readonly grants = new FakeGrants();
  readonly marks = new FakeMarks();
  /** Refuses write and press without a live act grant, as caret-screen without --act-pids does. */
  enforceGrants = true;
  /** Labels pressed, by window id. */
  readonly pressed: { windowId: string; label: string }[] = [];
  /** Value writes that landed (not undo restores), in order. */
  readonly writes: { windowId: string; key: string; value: string }[] = [];
  /** Called after each act lands and before its answer goes back. */
  afterAct: ((v: ReaderVerb) => void) | null = null;
  /** Keys whose value writes answer focusMoved and write nothing, as caret-screen does when a page moves focus away. */
  readonly focusMovesOn = new Set<string>();

  constructor() {
    this.grants.now = () => this.at;
  }

  attach(sink: DeskSink): this {
    this.sink = sink;
    return this;
  }

  grant(m: ActGrant | ActRevoke | CalendarGrant): void {
    this.grants.receive(m);
  }

  show(w: DeskWindow, focused = false): void {
    this.windows.set(w.windowId, w);
    this.at += 10;
    void this.sink?.handleReader(snap(structuredClone(w.nodes), { at: this.at, windowId: w.windowId, title: w.title, app: w.app, focused, kind: w.kind ?? "standard", reason: "request", values: w.values ?? [] }));
  }

  close(windowId: string): void {
    this.windows.delete(windowId);
    void this.sink?.handleReader({ type: "windowClosed", v: PROTOCOL_VERSION, at: (this.at += 10), windowId });
  }

  node(windowId: string, key: string): Node | undefined {
    return this.windows.get(windowId)?.nodes.find((n) => n.key === key);
  }

  /** The user (or the app) sets a field's value. */
  set(windowId: string, key: string, value: string): void {
    const n = this.node(windowId, key);
    if (n === undefined) throw new Error(`no node ${key} in ${windowId}`);
    if (value === "") delete n.value;
    else n.value = value;
    const w = this.windows.get(windowId);
    if (w !== undefined) this.show(w);
  }

  async run(verb: ReaderVerb): Promise<VerbResult> {
    this.verbs.push(verb);
    const answer = (outcome: VerbResult["outcome"], detail: string | null = null): VerbResult => ({ type: "verbResult", v: PROTOCOL_VERSION, id: "goal-desk", at: this.at, outcome, detail });
    if (verb.kind === "watchInput" || verb.kind === "watchWindows" || verb.kind === "watchPresses") return answer("ok");
    if (isCalendarVerb(verb)) return answer("notAllowed", "the desk has no calendar");
    const refused = this.enforceGrants ? this.grants.refusal(verb) : null;
    if (refused !== null) return answer("notAllowed", refused);
    const w = this.windows.get(verb.windowId);
    if (w === undefined) return answer("noWindow");
    if (verb.pid !== w.app.pid) return answer("notAllowed", `window ${w.windowId} is not process ${verb.pid}'s`);
    if (verb.kind === "walk") {
      this.show(w);
      return answer("ok");
    }
    if (verb.kind === "raise") return answer("notAllowed", "the desk does not raise windows");
    const n = w.nodes.find((x) => x.key === verb.key);
    if (n === undefined) return answer("noElement", verb.key);
    if (n.role !== verb.role) return answer("changed", `role is ${n.role}`);
    if (verb.kind === "press") {
      // The reader's own table, asked right before the press with the label read from the element (RiskTable.swift).
      const label = (n.label ?? "").trim();
      if (label !== verb.label) return answer("changed", `label is '${label}'`);
      if (classifyPress({ label, windowKind: w.kind ?? "standard", bundleId: w.app.bundleId }) !== "safe") return answer("notAllowed", `'${label}' is not a press the reader knows to be safe`);
      this.pressed.push({ windowId: w.windowId, label });
      w.buttons?.get(n.key)?.(w, this);
      const now = this.windows.get(w.windowId);
      if (now !== undefined) this.show(now);
      this.afterAct?.(verb);
      return answer("ok");
    }
    const notSame = this.marks.check(verb);
    if (notSame !== null) return answer("notSameElement", notSame);
    if (verb.attribute !== "value") return answer("ok");
    if (this.focusMovesOn.has(verb.key)) return answer("focusMoved", "focus is on another field of the window");
    if ((n.value ?? "") !== verb.expect) return answer("changed", `value is '${n.value ?? ""}'`);
    if (verb.value === "") delete n.value;
    else n.value = verb.value;
    if (verb.sameAs === undefined) this.writes.push({ windowId: w.windowId, key: verb.key, value: verb.value });
    this.show(w);
    this.afterAct?.(verb);
    return answer("ok");
  }
}

// MARK: - the scenes' windows

/** An email about a broken order: the order number, the problem, and a meeting proposal with a resolvable time. */
export function mailWindow(): DeskWindow {
  const lines = [
    "From: Priya Raman <priya.raman@northwind.example>",
    "Subject: Order ORD-2026-48213 arrived damaged",
    "Order number: ORD-2026-48213",
    "Problem: The desk lamp arrived with a cracked base and does not switch on.",
    "Can we meet with Priya on Thursday, October 8, 2026 from 3:00 PM to 3:45 PM PT to sort it out?",
  ];
  const nodes = lines.map((l, i) => line(MAIL, i, l));
  return {
    windowId: "6161-1",
    app: MAIL,
    title: "Order ORD-2026-48213 arrived damaged",
    nodes,
    values: [
      { kind: "email", text: "priya.raman@northwind.example", nodeKey: textKey(MAIL, 0) },
      { kind: "id", text: "ORD-2026-48213", nodeKey: textKey(MAIL, 2) },
      { kind: "date", text: "Thursday, October 8, 2026", nodeKey: textKey(MAIL, 4) },
      { kind: "time", text: "3:00 PM to 3:45 PM PT", nodeKey: textKey(MAIL, 4) },
    ],
  };
}

/** The support app's new-case window: the order number only, with Send (which only a person presses). */
export function caseWindow(): DeskWindow {
  return { windowId: "7171-1", app: SUPPORT, title: "Support — New case", nodes: [textField(SUPPORT, "Order number"), button(SUPPORT, "Send")] };
}

/** The support app's separate description window. */
export function detailsWindow(): DeskWindow {
  return { windowId: "7171-2", app: SUPPORT, title: "Support — Case details", nodes: [textArea(SUPPORT, "Description"), button(SUPPORT, "Submit")] };
}

/** A reply in the mail app, with Save draft and Send. */
export function replyWindow(): DeskWindow {
  return { windowId: "6161-2", app: MAIL, title: "Re: Order ORD-2026-48213 arrived damaged", nodes: [textField(MAIL, "To"), textArea(MAIL, "Message"), button(MAIL, "Save draft"), button(MAIL, "Send")] };
}

/**
 * A form behind a Next step: the order number first; Next shows Description and Contact email under it, in the same
 * window, and changes nothing else. `reveal` false makes Next do nothing (a predicate timeout).
 */
export function wizardWindow(reveal = true): DeskWindow {
  const nodes = [textField(SUPPORT, "Order number"), button(SUPPORT, "Next"), button(SUPPORT, "Continue")];
  const buttons = new Map<string, (w: DeskWindow) => void>([
    [
      buttonKey(SUPPORT, "Next"),
      (w) => {
        if (!reveal || w.nodes.some((n) => n.label === "Description")) return;
        w.nodes.push(textArea(SUPPORT, "Description"), textField(SUPPORT, "Contact email"));
      },
    ],
  ]);
  return { windowId: "7171-3", app: SUPPORT, title: "Support — Report a problem", nodes, buttons };
}

// MARK: - a canned goal writer

/** One step of a canned program, named by what the inventory shows rather than by ref. */
export type CannedStep =
  | { fill: { window: string; target: string; value: string } }
  | { press: { window: string; target: string; effect: string } }
  /** B30: text the program drafts and fills into a target, naming as its basis the windows titled exactly `from` (or, as "value:<text>", a value). */
  | { draft: { window: string; target: string; text: string; from: string[] } }
  | { ask: true };

/**
 * The program a writer would return for these steps over these snapshots: it reads every window, then makes each step
 * with the literal refs the inventory gave (a target by its window's title and its label, a value by a piece of its
 * display), and plans them on the first window's snapshot. Throws when the inventory lacks one, so a test fails loudly.
 */
export function cannedProgram(snapshots: readonly PlanningSnapshot[], steps: readonly CannedStep[]): string {
  const reads = snapshots.map((s, i) => (i === 0 ? "  await caret.readWindow();" : `  await caret.readWindow(${JSON.stringify(s.window)} as WindowRef);`));
  const target = (window: string, label: string): string => {
    const t = snapshots.find((s) => s.title.includes(window))?.targets.find((x) => x.label === label || x.label.startsWith(`${label} (`));
    if (t === undefined) throw new Error(`no target '${label}' in a window titled like '${window}': ${JSON.stringify(snapshots.map((s) => [s.title, s.targets.map((x) => x.label)]))}`);
    return t.ref;
  };
  const value = (has: string): string => {
    // A value's own text is its display's quoted head; an event's display starts "the event '...'".
    const own = (d: string): string => /^"([^"]*)"/.exec(d)?.[1] ?? /^the event '([^']*)'/.exec(d)?.[0] ?? d;
    const v = snapshots.flatMap((s) => s.values).find((x) => own(x.display).includes(has));
    if (v === undefined) throw new Error(`no value showing '${has}': ${JSON.stringify(snapshots.flatMap((s) => s.values.map((x) => x.display)))}`);
    return v.ref;
  };
  const made = steps.map((s, i) => {
    if ("fill" in s) return `  const s${i} = caret.fill(${JSON.stringify(target(s.fill.window, s.fill.target))} as TargetRef, ${JSON.stringify(value(s.fill.value))} as ValueRef);`;
    if ("press" in s) return `  const s${i} = caret.press(${JSON.stringify(target(s.press.window, s.press.target))} as TargetRef, ${JSON.stringify(s.press.effect)} as EffectRef);`;
    if ("draft" in s) {
      const from = s.draft.from.map((t) => {
        if (t.startsWith("value:")) return value(t.slice("value:".length));
        const w = snapshots.find((x) => x.title === t);
        if (w === undefined) throw new Error(`no window titled '${t}'`);
        return w.window;
      });
      return `  const d${i} = caret.draft(${JSON.stringify(s.draft.text)}, ${JSON.stringify(from)} as (WindowRef | ValueRef)[]);
  const s${i} = caret.fill(${JSON.stringify(target(s.draft.window, s.draft.target))} as TargetRef, d${i});`;
    }
    return `  const s${i} = caret.ask("q1" as QuestionRef);`;
  });
  return `async function main(caret: CaretPlanAPI): Promise<PlanRef> {\n${reads.join("\n")}\n${made.join("\n")}\n  return caret.plan({ basedOn: ${JSON.stringify(snapshots[0]?.snapshot ?? "s1")} as SnapshotRef, steps: [${steps.map((_, i) => `s${i}`).join(", ")}] });\n}`;
}

/**
 * A WriterPort that answers each goal request with the next script's program over the snapshots it was sent, and
 * records each request's snapshots. An empty queue answers with no program.
 */
export function cannedGoalWriter(scripts: CannedStep[][]): WriterPort & { requests: PlanningSnapshot[][] } {
  const requests: PlanningSnapshot[][] = [];
  return {
    route: FAKE_WRITER_ROUTE,
    requests,
    async write(req) {
      const input = req.input as { snapshots: PlanningSnapshot[] };
      requests.push(input.snapshots);
      const script = scripts.shift();
      const program = script === undefined ? null : cannedProgram(input.snapshots, script);
      return { model: "canned", provider: "canned", output: { program, reply: program ?? "" }, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
    },
  };
}

// MARK: - what the measurement runners count

/**
 * Goal plans the scene refused for `code` (lower.ts GoalRefusal; "draft" is any of drafts.ts's checks, Jev's claim
 * check included), read from the helper's counts. B30's runner matched warnings against /draft|recipient|add people/,
 * which missed "Caret couldn't confirm you asked to say ..." and counted recipient refusals as drafts'.
 */
export function goalRefusals(sc: Pick<GoalScene, "store">, code: string): number {
  sc.store.flush();
  return sc.store.counts()[`goal.refused_${code}`] ?? 0;
}
export const draftRefusals = (sc: Pick<GoalScene, "store">): number => goalRefusals(sc, "draft");

// MARK: - a stand-in for Jev

/**
 * A stand-in for Jev, for desk runs that are not about Jev's judgment. Every choice question whose options include
 * "yes" is answered `belongs(question)` (true by default) at `p`; a question about whose details a field or value is
 * gets "unclear", which vetoes nothing; every yes/no question gets `noul`. `calls` counts requests, `claimCalls` those
 * with yes/no questions (drafts.ts confirmClaims), `asked` keeps each choice question's instructions.
 */
export function standInJev(o: { p?: number; noul?: number; belongs?: (instructions: string) => boolean } = {}): AskJev & { calls: number; claimCalls: number; asked: string[] } {
  const f = Object.assign(
    async (req: Parameters<AskJev>[0]) => {
      f.calls++;
      if (Object.keys(req.nouls ?? {}).length > 0) f.claimCalls++;
      const answers: Record<string, { choice: string; confidence: number }> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        const text = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
        f.asked.push(text);
        if ("yes" in q.criteria) answers[id] = { choice: (o.belongs ?? (() => true))(text) ? "yes" : "no", confidence: o.p ?? 0.95 };
        else answers[id] = { choice: "unclear" in q.criteria ? "unclear" : (Object.keys(q.criteria)[0] ?? ""), confidence: o.p ?? 0.95 };
      }
      return { model: "jev-stand-in", answers, nouls: Object.fromEntries(Object.keys(req.nouls ?? {}).map((id) => [id, o.noul ?? 0.99])), inputTokens: 10, latencyMs: 1, costUsd: 0 };
    },
    { calls: 0, claimCalls: 0, asked: [] as string[] },
  );
  return f;
}

// MARK: - a helper on the desk

export interface GoalScene {
  helper: Helper;
  desk: GoalDesk;
  calendar: FakeCalendar;
  writer: ReturnType<typeof cannedGoalWriter>;
  /** Everything the helper published. */
  published: HelperMessage[];
  /** The goalProgress messages published, the replies to requests included (handleGoalRequest's are pushed here too). */
  goals: GoalProgress[];
  /** What the helper warned about (a refused goal's detail goes here). */
  warnings: string[];
  session: string;
  /** The helper's store: its counts say why goals were refused (goal.refused_<code>). */
  store: Store;
  /** Plans a goal and returns its reply, recorded in `goals`. */
  request(instruction: string, requestId?: string): Promise<GoalProgress>;
  /** Accepts the latest preview of `goalId` (its segment and digest) from `from` (the scene's host by default), with `over` replacing any field. */
  accept(goalId: string, over?: Partial<GoalAccept>, from?: string): Promise<Awaited<ReturnType<Helper["handleGoalAccept"]>>>;
  /** Waits for the helper's goal work, then closes it. */
  close(): Promise<void>;
}

export function goalScene(o: {
  scripts: CannedStep[][];
  windows: DeskWindow[];
  pageDocument?: (windowId: string) => string | null;
  userWindow?: string;
  /** A real writer in place of the canned one (scripts/goal-scenes-eval.ts --writer live); null for none, as the helper starts by default (L1). */
  writer?: WriterPort | null;
  /** Jev, for drafts' claim checks and Ask (B30); none by default. */
  askJev?: AskJev;
  /** How an Ask makes its intent (HelperOptions.ask); none by default. */
  ask?: HelperOptions["ask"];
  /** Whether the helper has a calendar to add events to; true by default. */
  calendar?: boolean;
  /** L1: the local model that writes drafts' words; the program's text by default. */
  drafter?: LocalModelPort;
}): GoalScene {
  const dir = mkdtempSync(join(tmpdir(), "caret-goal-"));
  const store = new Store(join(dir, "data"));
  const desk = new GoalDesk();
  const calendar = new FakeCalendar();
  const writer = cannedGoalWriter(o.scripts);
  const published: HelperMessage[] = [];
  const goals: GoalProgress[] = [];
  const warnings: string[] = [];
  const helper = new Helper({
    warn: (l) => void warnings.push(l),
    store,
    askJev: o.askJev ?? null,
    ...(o.ask === undefined ? {} : { ask: o.ask }),
    shadow: false,
    allowBackgroundFocus: false,
    readerLink: desk,
    ...(o.calendar === false ? {} : { calendar }),
    writer: o.writer === null ? null : (o.writer ?? writer),
    ...(o.drafter === undefined ? {} : { drafter: o.drafter }),
    now: () => desk.at,
    publish: (m) => {
      published.push(m);
      if (m.type === "goalProgress") goals.push(m);
    },
    ...(o.pageDocument === undefined ? {} : { pageDocument: o.pageDocument }),
  });
  desk.attach(helper);
  void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "goal-desk", session: "goal-desk-reader-1" });
  const session = "goal-host-1";
  helper.hostConnected(session);
  for (const w of o.windows) desk.show(w, w.windowId === o.userWindow);
  if (o.userWindow !== undefined) {
    const w = desk.windows.get(o.userWindow);
    if (w !== undefined) void helper.handleReader({ type: "focus", v: PROTOCOL_VERSION, at: (desk.at += 10), app: w.app, windowId: w.windowId, key: null, role: "AXWindow", editable: false, empty: false, frontmost: true });
  }
  return {
    helper,
    desk,
    calendar,
    writer,
    published,
    goals,
    warnings,
    session,
    store,
    async request(instruction, requestId = `r${goals.length + 1}`) {
      const r = await helper.handleGoalRequest({ type: "goalRequest", v: PROTOCOL_VERSION, requestId, instruction, at: desk.at }, session);
      goals.push(r);
      return r;
    },
    async accept(goalId, over = {}, from = session) {
      const last = [...goals].reverse().find((g): g is Extract<GoalProgress, { event: "segment" }> => g.goalId === goalId && g.event === "segment");
      if (last === undefined && (over.segment === undefined || over.digest === undefined)) throw new Error(`no preview of goal ${goalId}`);
      const r = await helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId, segment: last?.segment ?? 0, digest: last?.digest ?? "", at: desk.at, ...over }, from);
      await helper.goals.idle();
      return r;
    },
    async close() {
      await helper.goals.idle();
      helper.shutdown();
      helper.memory.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
