// The first look: at the end of onboarding the host asks for the best real offer across the windows
// already open (the host's contract, CaretHostCore/FirstLook.swift on v2/host, and its fixture, copied
// to fixtures/golden/first-look.ndjson). The helper asks the reader to walk every window once, runs each
// requested family's generator once over the screen model, and answers with the best grounded offer as a
// pop-up spec, or nothing, or why it could not look, inside the request's deadline.
//
// A found offer is recorded in the host-offer registry under `<requestId>.0` without being published, so
// the host's offerAccept with that key runs it as the task with that id. Errors carry window ids, family
// names and outcome codes only: never a reader detail, a Jev error body or an element key, all of which
// can hold screen text.
import { performance } from "node:perf_hooks";
import { nodeText, type ScreenModel, type WindowState } from "../model.ts";
import { FirstLookReply, PROTOCOL_VERSION, type FillProposal, type FirstLook, type FirstLookFound, type OfferPopup, type PatternOffer, type VerbResult } from "../protocol.ts";
import type { PopupBlock, PopupRef, PopupSpecT } from "../popup.ts";
import type { AskJev } from "../fill/jev.ts";
import { FILLABLE_ROLES, FillError, proposeFill } from "../fill/fill.ts";
import { buildFillPopup, fieldLabel, fillPlan, fillPopupEligible, MAX_FILL_ROWS, recheckFill, type AboutNow, type GroundedProposal } from "./fill-popup.ts";
import type { AboutValue } from "../fill/about.ts";
import { allWatchLines, buildLookRequest, readPendingAnswer, stateFor, windowMarkers } from "../tasks/pending.ts";
import { statusNode } from "./open-app.ts";
import { offerField } from "./field.ts";
import { FAMILIES, LEVELS, type Family } from "./settings.ts";
import type { AcceptHandler, AcceptResult } from "./registry.ts";
import type { PatternEngine } from "../patterns/engine.ts";
import { eventCardSpec, type EventCards } from "./event-card.ts";
import type { TaskResult } from "../executor/executor.ts";
import type { Plan } from "../executor/schema.ts";

/** Forms asked about in one look, most recently used first; each costs two Jev asks. Assumed. */
export const MAX_FORMS = 3;
/** Windows with running work asked about in one look, most recent first; each costs one Jev ask. Assumed. */
export const MAX_WATCH_LOOKS = 3;
/** The walks of every window share this part of the deadline, and never more than WALK_MAX_MS. Assumed. */
export const WALK_SHARE = 0.25;
export const WALK_MAX_MS = 2000;
/** Time kept back from the deadline to build and send the reply. Assumed. */
export const REPLY_MARGIN_MS = 300;
/** Failed walks named in an error before the rest are counted. */
const MAX_NAMED = 8;

/**
 * Which kind of offer wins when several are found, lower first. Assumed, not measured: a window waiting
 * on the user cannot go on without them; a grounded fill and a routine save the most typing, and an event
 * card (B16) sits between them, since the moment it helps is now; a loop's remaining rows next; work that
 * already finished can wait.
 */
const RANK = { needsYou: 0, fill: 1, event: 2, routine: 3, loopFinish: 4, loopNext: 5, done: 6 } as const;

export interface FirstLookDeps {
  model: ScreenModel;
  askJev: AskJev | null;
  /** One reader walk of one window; the snapshot arrives before the answer. */
  walk: (pid: number, windowId: string) => Promise<VerbResult>;
  readerConnected: () => boolean;
  /** False in shadow mode, where the helper never calls Jev. */
  live: () => boolean;
  /** The user paused Caret: no offers, the first look's included. */
  paused: () => boolean;
  /** Watched windows that finished or wait on the user and still have an Open offer. */
  resolvedWatches: () => { windowId: string; status: string; state: "done" | "needsYou" }[];
  patterns: PatternEngine;
  /** The event card generator, whose first-look scan the `event` family runs. */
  events: EventCards;
  run: (taskId: string, plan: Plan, slots: Record<string, string>, expect?: Record<string, Record<string, string>>) => Promise<TaskResult>;
  /**
   * Records the found offer so an offerAccept with its key reaches `accept`. `underlying` is the id of the
   * engine's offer it reports, so that offer's withdrawal ends the first look's key too.
   */
  record: (msg: OfferPopup, family: Family, accept: AcceptHandler, underlying: string | null) => void;
  /** Ends the found offer: publishes offerWithdrawn for its key. */
  withdraw: (offerKey: string, reason: "taken" | "stale") => void;
  /** Values the user told Caret that a form's fields may take (fill/about.ts). */
  about: () => AboutValue[];
  /** What an About entry holds now, for the recheck before a fill from memory (fill-popup.ts). */
  aboutNow: AboutNow;
  now: () => number;
}

/** A generator's offer before it has a key: how good it is, and how to build and take it under a key. */
interface Candidate {
  family: Family;
  kind: FirstLookFound["kind"];
  rank: number;
  /** Larger wins among equal ranks: fields filled, then recency. */
  weight: number;
  window: WindowState;
  /** The element the offer is recorded against: a fill's trigger field, a report's status line, a pattern's first destination. */
  key: string;
  spec: (offerKey: string) => PopupSpecT;
  /** A fill's source apps, each once, in field order. */
  sourceApps?: string[];
  accept: (offerKey: string) => AcceptHandler;
  /** The engine offer a loop or routine candidate reports, and what to do once it is chosen. */
  underlying?: string;
  chosen?: () => void;
}

/** Why a family could not finish its look; a short phrase with no screen text. */
class LookError extends Error {}

type Settled = { family: Family; ok: true; found: Candidate[] } | { family: Family; ok: false; reason: string };

export class FirstLookRunner {
  private readonly deps: FirstLookDeps;

  constructor(deps: FirstLookDeps) {
    this.deps = deps;
  }

  async run(req: FirstLook): Promise<FirstLookReply> {
    const t0 = performance.now();
    const deadlineAt = t0 + Math.max(0, req.deadlineMs - Math.min(REPLY_MARGIN_MS, req.deadlineMs / 10));
    const model = this.deps.model;
    const scanned = (): FirstLookReply["scanned"] => ({
      windows: model.windows.size,
      apps: new Set([...model.windows.values()].map((w) => w.app.pid)).size,
      ms: Math.round(performance.now() - t0),
    });
    const reply = (outcome: FirstLookReply["outcome"], found: FirstLookFound | null, error: string | null, withScan = true): FirstLookReply => ({
      type: "firstLookReply",
      v: PROTOCOL_VERSION,
      requestId: req.requestId,
      at: this.deps.now(),
      outcome,
      found,
      scanned: withScan ? scanned() : null,
      error,
    });

    const unknown = req.families.filter((f) => !(FAMILIES as readonly string[]).includes(f));
    if (unknown.length > 0) return reply("error", null, `unknown families: ${unknown.join(", ")}`, false);
    if (new Set(req.families).size !== req.families.length) return reply("error", null, "a family is named twice", false);
    if (!this.deps.live()) return reply("error", null, "the helper is in shadow mode", false);
    if (this.deps.paused()) return reply("error", null, "Caret is paused", false);
    if (!this.deps.readerConnected()) return reply("error", null, "reader not connected", false);

    const walked = await this.walkAll(Math.min(WALK_MAX_MS, req.deadlineMs * WALK_SHARE));
    if (typeof walked === "string") return reply("error", null, walked);
    // The generators race deadlineAt, which keeps REPLY_MARGIN_MS back; a reply still has to leave before
    // the deadline itself, with a little time to be written.
    const sendBy = t0 + req.deadlineMs - Math.min(50, req.deadlineMs / 20);
    const late = (): boolean => performance.now() >= sendBy;
    if (late()) return reply("error", null, "the walks did not finish before the deadline");

    // A family the level keeps quiet is not looked at, as the helper's gate would hold its offers.
    const families = (req.families as Family[]).filter((f) => LEVELS[req.level].families[f]);
    const looks: Promise<Settled>[] = families.map((family) =>
      this.look(family, req, walked)
        .then((found): Settled => ({ family, ok: true, found }))
        .catch((e: unknown): Settled => ({ family, ok: false, reason: e instanceof LookError ? e.message : "failed" })),
    );
    const settled = await Promise.all(looks.map((p, i) => byDeadline(p, deadlineAt, { family: families[i] as Family, ok: false as const, reason: "did not finish before the deadline" })));

    // Whatever the generators found, a reply past the deadline is one the host ignores, and the user may
    // have paused Caret or the helper left live mode while Jev answered: nothing is recorded then.
    if (late()) return reply("error", null, "the look did not finish before the deadline");
    if (!this.deps.live()) return reply("error", null, "the helper is in shadow mode");
    if (this.deps.paused()) return reply("error", null, "Caret is paused");
    const all = settled.flatMap((s) => (s.ok ? s.found : []));
    const best = all.sort((a, b) => a.rank - b.rank || b.weight - a.weight)[0];
    if (best === undefined) {
      const problems = settled.flatMap((s) => (s.ok ? [] : [`${s.family}: ${s.reason}`]));
      return problems.length > 0 ? reply("error", null, problems.join("; ")) : reply("nothing", null, null);
    }
    const offerKey = `${req.requestId}.0`;
    const spec = best.spec(offerKey);
    const found: FirstLookFound = {
      kind: best.kind,
      family: best.family,
      offerKey,
      window: { pid: best.window.app.pid, windowId: best.window.window.windowId, appName: best.window.app.name, title: best.window.window.title },
      spec,
      ...(best.sourceApps === undefined ? {} : { sourceApps: best.sourceApps }),
    };
    const out = reply("found", found, null);
    const checked = FirstLookReply.safeParse(out);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      return reply("error", null, `the found offer failed the protocol check: ${issue?.message ?? "invalid"} at ${(issue?.path ?? []).join(".")}`);
    }
    if (late()) return reply("error", null, "the look did not finish before the deadline");
    best.chosen?.();
    const msg: OfferPopup = { type: "popup", v: PROTOCOL_VERSION, offerKey, at: out.at, field: offerField(best.window, best.key), spec };
    this.deps.record(msg, best.family, best.accept(offerKey), best.underlying ?? null);
    return out;
  }

  /**
   * Walks every window once, each within `ms`, so the generators read the screen as it is now. Returns
   * the windows whose walk did not succeed, which the generators then leave out as destinations and as
   * sources, since what the model holds of them may be stale; or why the look cannot go on, when no
   * window the reader still has could be walked. A window the reader no longer has is gone, not a failure.
   */
  private async walkAll(ms: number): Promise<ReadonlySet<string> | string> {
    const windows = [...this.deps.model.windows.values()];
    if (windows.length === 0) return new Set();
    const outcomes = await Promise.all(
      windows.map(async (w) => {
        const r = await byDeadline(this.deps.walk(w.app.pid, w.window.windowId).then((v) => v.outcome), performance.now() + ms, "timeout" as const);
        return { windowId: w.window.windowId, outcome: r };
      }),
    );
    const excluded = new Set(outcomes.filter((o) => o.outcome !== "ok").map((o) => o.windowId));
    const bad = outcomes.filter((o) => o.outcome !== "ok" && o.outcome !== "noWindow");
    if (bad.length === 0 || bad.length < outcomes.filter((o) => o.outcome !== "noWindow").length) return excluded;
    const named = bad.slice(0, MAX_NAMED).map((o) => `${o.windowId} ${o.outcome}`);
    const more = bad.length > MAX_NAMED ? ` and ${bad.length - MAX_NAMED} more` : "";
    return `reader walks failed: ${named.join(", ")}${more}`;
  }

  private look(family: Family, req: FirstLook, exclude: ReadonlySet<string>): Promise<Candidate[]> {
    switch (family) {
      case "fill":
        return this.fills(req.requestId, exclude);
      case "pending":
        return this.pendings(exclude);
      case "loop":
      case "routine":
        return Promise.resolve(this.patternOffers(family, LEVELS[req.level].routineSightings, exclude));
      case "event":
        return this.eventOffers(exclude);
    }
  }

  // MARK: - event cards

  private async eventOffers(exclude: ReadonlySet<string>): Promise<Candidate[]> {
    const events = this.deps.events;
    if (this.deps.askJev === null) throw new LookError("Jev is off");
    let found: Awaited<ReturnType<EventCards["firstLook"]>>;
    try {
      found = await events.firstLook(exclude);
    } catch {
      throw new LookError("Jev request failed");
    }
    return found.map(({ w, key, candidate }) => ({
      family: "event" as const,
      kind: "action" as const,
      rank: RANK.event,
      weight: w.lastFocusedAt,
      window: w,
      key,
      spec: (offerKey: string) => eventCardSpec(offerKey, candidate, events.calendar, w.window.windowId, key),
      accept: (offerKey: string) => () => {
        this.deps.withdraw(offerKey, "taken");
        return events.acceptFound(offerKey, w.window.windowId, key, candidate, (t, p, s) => this.deps.run(t, p, s));
      },
    }));
  }

  // MARK: - fill

  /** Every window with two or more empty fillable fields is a form; the most recent few are asked about, two asks each. */
  private async fills(requestId: string, exclude: ReadonlySet<string>): Promise<Candidate[]> {
    const model = this.deps.model;
    const forms = [...model.windows.values()]
      .filter((w) => !exclude.has(w.window.windowId))
      .map((w) => ({ w, empty: emptyFields(w) }))
      .filter((f) => f.empty.length >= 2)
      .sort((a, b) => b.w.lastFocusedAt - a.w.lastFocusedAt || b.w.updatedAt - a.w.updatedAt)
      .slice(0, MAX_FORMS);
    if (forms.length === 0) return [];
    const ask = this.deps.askJev;
    if (ask === null) throw new LookError("Jev is off");
    const now = this.deps.now();
    const results = await Promise.allSettled(
      forms.map(({ w, empty }, i) => {
        const trigger = w.focusedKey !== null && empty.includes(w.focusedKey) ? w.focusedKey : (empty[0] as string);
        return proposeFill(model, ask, w.window.windowId, trigger, now, { newId: () => `${requestId}.form${i}`, exclude, about: this.deps.about() });
      }),
    );
    const out: Candidate[] = [];
    let asked = 0;
    for (const r of results) {
      if (r.status === "rejected") {
        // No candidate in any other window is a form with nothing to offer, not a failed look.
        if (r.reason instanceof FillError && /no candidate values/.test(r.reason.message)) asked++;
        continue;
      }
      asked++;
      const p = stillGrounded(model, r.value, this.deps.aboutNow);
      if (p === null) continue;
      const w = model.windows.get(p.windowId);
      if (w === undefined) continue;
      const popup = buildFillPopup(model, p);
      out.push({
        ...(popup.sourceApps === undefined ? {} : { sourceApps: popup.sourceApps }),
        family: "fill",
        kind: "fill",
        rank: RANK.fill,
        weight: p.fields.length * 1e13 + w.lastFocusedAt,
        window: w,
        key: p.triggerKey,
        spec: (offerKey) => ({ ...popup.spec, id: offerKey }),
        accept: (offerKey) => () => this.acceptFill(offerKey, p),
      });
    }
    if (asked === 0) throw new LookError("Jev request failed");
    return out;
  }

  private async acceptFill(offerKey: string, p: GroundedProposal): Promise<AcceptResult> {
    const stale = recheckFill(this.deps.model, p, this.deps.aboutNow);
    this.deps.withdraw(offerKey, stale === null ? "taken" : "stale");
    if (stale !== null) return { refused: `${stale}; nothing was written` };
    const { plan, slots } = fillPlan(this.deps.model, p);
    // The destinations were empty just now; one the user fills before the run's first read stops it.
    return this.deps.run(offerKey, plan, slots, { [p.windowId]: Object.fromEntries(p.fields.map((f) => [f.key, ""])) });
  }

  // MARK: - pending

  /**
   * Watched windows that already finished or wait on the user, then the most recent windows that show
   * running work, each asked once whether it finished or waits on the user. A window still running is
   * no offer.
   */
  private async pendings(exclude: ReadonlySet<string>): Promise<Candidate[]> {
    const model = this.deps.model;
    const out: Candidate[] = [];
    const seen = new Set<string>(exclude);
    for (const r of this.deps.resolvedWatches()) {
      const w = model.windows.get(r.windowId);
      if (w === undefined || seen.has(r.windowId)) continue;
      seen.add(r.windowId);
      out.push(this.report(w, r.state, r.status));
    }
    const marked = [...model.windows.values()]
      .filter((w) => !seen.has(w.window.windowId))
      .map((w) => ({ w, markers: windowMarkers(w) }))
      .filter((x) => x.markers.length > 0)
      .sort((a, b) => b.w.lastFocusedAt - a.w.lastFocusedAt || b.w.updatedAt - a.w.updatedAt)
      .slice(0, MAX_WATCH_LOOKS);
    const ask = this.deps.askJev;
    if (marked.length === 0) return out;
    if (ask === null) {
      if (out.length > 0) return out;
      throw new LookError("Jev is off");
    }
    const answers = await Promise.allSettled(
      marked.map(async ({ w, markers }) => {
        const { req, lines } = buildLookRequest(w, this.deps.model.windows.values(), markers);
        const a = readPendingAnswer(await ask(req));
        return { asked: w, lines, state: stateFor(a.finished.choice, a.waiting.choice) };
      }),
    );
    if (out.length === 0 && answers.every((a) => a.status === "rejected")) throw new LookError("Jev request failed");
    for (const a of answers) {
      if (a.status === "rejected") continue;
      const { asked, lines, state } = a.value;
      if (state !== "done" && state !== "needsYou") continue;
      // The answer is about the window as it was asked; a window that closed, or whose end changed while
      // Jev answered, is not reported on it.
      const w = model.windows.get(asked.window.windowId);
      if (w === undefined || tailOf(w) !== tailOf(asked)) continue;
      // The line the report quotes: the last plain text line of the window's end that a node shows.
      const status = [...lines].reverse().find((l) => !l.startsWith("[") && statusNode(w, l) !== null) ?? null;
      out.push(this.report(w, state, status));
    }
    return out;
  }

  private report(w: WindowState, state: "done" | "needsYou", status: string | null): Candidate {
    const windowId = w.window.windowId;
    const statusKey = status === null ? null : statusNode(w, status);
    const statusRef: PopupRef | null = status === null || statusKey === null ? null : { node: `${windowId}/${statusKey}`, quote: status };
    const windowRef: PopupRef = { node: windowId };
    const name = w.window.title.trim() === "" ? w.app.name : `'${w.window.title.trim()}'`;
    const blocks: PopupBlock[] = [
      { type: "header", title: { text: state === "needsYou" ? `${name} needs you` : `${name} finished`, ref: { rule: state === "needsYou" ? "pendingWaiting" : "pendingDone", derived: [statusRef ?? windowRef] } } },
      ...(statusRef === null || status === null ? [] : [{ type: "facts" as const, rows: [{ value: { text: status, ref: statusRef } }] }]),
      { type: "source", value: { text: sourceText(w.app.name, w.window.title), ref: windowRef } },
      { type: "actions", items: [{ id: "open", label: `Open ${w.app.name}`, key: "tab" }] },
    ];
    return {
      family: "pending",
      kind: "report",
      rank: state === "needsYou" ? RANK.needsYou : RANK.done,
      weight: w.lastFocusedAt,
      window: w,
      key: statusKey ?? firstKey(w),
      spec: (offerKey) => ({ v: 1, id: offerKey, figure: "offering", blocks }),
      accept: (offerKey) => () => this.acceptOpen(offerKey, windowId),
    };
  }

  /** Brings the window to the front as the task `offerKey`, as the Open line does. */
  private async acceptOpen(offerKey: string, windowId: string): Promise<AcceptResult> {
    const w = this.deps.model.windows.get(windowId);
    this.deps.withdraw(offerKey, w === undefined ? "stale" : "taken");
    if (w === undefined) return { refused: "the window closed" };
    const plan: Plan = {
      id: offerKey,
      title: `Open ${w.app.name}`,
      slots: { title: "the window's title", app: "the window's app" },
      steps: [{ says: "'{{title}}' in {{app}} is in front", end: { kind: "windowFocused", window: { bundleId: w.app.bundleId, title: "{{title}}" } } }],
    };
    return this.deps.run(offerKey, plan, { title: w.window.title, app: w.app.name });
  }

  // MARK: - loops and routines

  private patternOffers(family: "loop" | "routine", sightings: number | null, exclude: ReadonlySet<string>): Candidate[] {
    const model = this.deps.model;
    return this.deps.patterns.firstLook([family], sightings, exclude).flatMap((msg): Candidate[] => {
      const w = model.windows.get(msg.windowId);
      const first = msg.cells[0];
      if (w === undefined || first === undefined) return [];
      return [
        {
          family,
          kind: "fill",
          rank: RANK[msg.kind],
          weight: msg.cells.length * 1e13 + msg.at,
          window: w,
          key: first.key,
          spec: (offerKey) => patternSpec(model, msg, offerKey),
          ...sourceAppsOf(msg),
          underlying: msg.id,
          chosen: () => this.deps.patterns.adoptFirstLook(msg.id),
          accept: (offerKey) => () => {
            this.deps.withdraw(offerKey, "taken");
            return this.deps.patterns.take(msg.id, offerKey);
          },
        },
      ];
    });
  }
}

/** A pattern offer's source apps, each once, in cell order; none when no cell names its app. */
function sourceAppsOf(msg: PatternOffer): { sourceApps?: string[] } {
  const apps = [...new Set(msg.cells.map((c) => c.source.appName).filter((a) => a !== ""))];
  return apps.length === 0 ? {} : { sourceApps: apps };
}

/** A window's last few lines, as the first look's pending question reads them, to tell whether they changed. */
function tailOf(w: WindowState): string {
  return allWatchLines(w).slice(-LOOK_TAIL).join("\n");
}
const LOOK_TAIL = 6;

/** The empty fillable fields of a window, in document order: what a fill would ask about. */
function emptyFields(w: WindowState): string[] {
  const out: string[] = [];
  for (const n of w.nodes.values()) {
    if (n.editable === true && FILLABLE_ROLES.has(n.role) && (n.value ?? "") === "" && n.states?.includes("secure") !== true) out.push(n.key);
  }
  return out;
}

/** The proposal with only fields still empty whose source is still open, when that leaves a pop-up's worth; else null. */
function stillGrounded(model: ScreenModel, p: FillProposal, aboutNow: AboutNow): GroundedProposal | null {
  const w = model.windows.get(p.windowId);
  if (w === undefined) return null;
  const fields = p.fields.filter((f) => {
    const n = w.nodes.get(f.key);
    return n !== undefined && (n.value ?? "") === "" && (f.source === null || model.windows.has(f.source.windowId));
  });
  const q = { ...p, fields };
  return fillPopupEligible(q) && recheckFill(model, q, aboutNow) === null ? q : null;
}

function sourceText(app: string, title: string): string {
  const t = title.trim();
  return t === "" || t === app ? app : `${app}, ${t}`;
}

function firstKey(w: WindowState): string {
  for (const n of w.nodes.values()) if (nodeText(n) !== "") return n.key;
  return w.nodes.keys().next().value ?? w.window.windowId;
}

/** A loop or routine offer as a pop-up: what it would write where, each value quoting its source. */
function patternSpec(model: ScreenModel, msg: PatternOffer, offerKey: string): PopupSpecT {
  const cellRef = (c: PatternOffer["cells"][number]): PopupRef => {
    const node = `${c.source.windowId}/${c.source.nodeKey}`;
    return c.memory.length === 0 ? { node, quote: c.value } : { rule: "memory", derived: [{ node }, ...c.memory.map((id) => ({ memory: id }))] };
  };
  const sources = [...new Map(msg.cells.map((c) => [c.source.windowId, c.source])).values()];
  const nodes = [...new Set(msg.cells.map((c) => `${c.source.windowId}/${c.source.nodeKey}`))].map((node) => ({ node }));
  const sourceRef: PopupRef = sources.length === 1 ? (nodes[0] as PopupRef) : { rule: "sources", derived: nodes };
  const rows = msg.cells.slice(0, MAX_FILL_ROWS).map((c) => ({
    destination: { text: fieldLabel(model, c.windowId, c.key), ref: { rule: "fieldLabel", derived: [{ node: `${c.windowId}/${c.key}` }] } },
    value: { text: c.value, ref: cellRef(c) },
    state: "ready" as const,
  }));
  const more = msg.cells.length - rows.length;
  const finish = msg.kind === "loopFinish";
  return {
    v: 1,
    id: offerKey,
    figure: "offering",
    blocks: [
      { type: "header", title: { text: msg.says, ref: { rule: msg.kind, derived: msg.cells.map(cellRef) } } },
      { type: "source", value: { text: sources.map((s) => sourceText(s.appName, s.windowTitle)).join(" and "), ref: sourceRef } },
      { type: "fields", rows, ...(more > 0 ? { more } : {}) },
      { type: "actions", items: [{ id: finish ? "finish" : "fill", label: finish ? "Finish" : "Fill", key: "tab" }] },
    ],
  };
}

/** The promise's value, or `late` once real time passes `at` (performance.now() milliseconds); `late` at once when it has passed. */
function byDeadline<T, L>(p: Promise<T>, at: number, late: L): Promise<T | L> {
  const wait = at - performance.now();
  if (wait <= 0) return Promise.resolve(late);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<L>((r) => (timer = setTimeout(() => r(late), wait)))]).finally(() => clearTimeout(timer));
}
