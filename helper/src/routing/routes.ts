// The routers' vocabulary (action engine v2, section 3). Router 1 chooses an outcome; Router 2, only after `act`,
// chooses a route from a registry code froze for the same context. Producers supply candidates in this vocabulary
// and run only when chosen; the user's Ask maps B25's intent routes onto the same words (ASK_ROUTES), so every
// decision is logged one way. A route grants no authority: a chosen route makes an offer through its producer's own
// checks, and acting still needs the user's acceptance and the executor's grant.
import type { AskRoute } from "../planner/intent.ts";
import type { WindowState } from "../model.ts";
import type { Disclosure, ModelText } from "../privacy/disclosure.ts";

export const OUTCOMES = ["abstain", "write", "ask", "act"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * - workflow: a known skill or workflow: a kept skill or a routine or loop the recognizers predict (patterns), the
 *   event card, or "Open <app>" for a watched window.
 * - fillAll: the form the user is in, from open windows and memory (fill).
 * - goalPlan: a bounded goal's plan, prepared only (the planner and code-mode writer). Only an Ask supplies a goal.
 * - handoff: Caret names what it leaves to the user, with a reason code wrote.
 */
export const ROUTE_KINDS = ["workflow", "fillAll", "goalPlan", "handoff"] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

/** Known skills and workflows Router 2 lists, best first by code relevance. From the plan's section 3. */
export const MAX_WORKFLOWS = 8;
/** Real routes Router 2 lists at most: the workflows, fillAll, goalPlan and handoff. */
export const MAX_ROUTES = 11;

/** Text a candidate's summary quotes from a window, which the router's request takes through that window's ledger. */
export interface Quoted {
  window: WindowState;
  kind: "descriptor" | "candidate";
  texts: readonly string[];
}

/** A task's evidence as Router 1's task question carries it (judge.ts). The event card is the one producer with it. */
export interface TaskEvidence {
  /** What doing it would be, with no screen text: "Add an event to the user's calendar". */
  task: string;
  /**
   * The sentence it rests on, screen text taken through the candidate's `quotes`. Router 1 is not asked about the task
   * without it: the producer's rule (`offerWhen`) is about what the sentence says.
   */
  sentence: string;
  /** What the producer's code found in the sentence, in code's words. */
  found: string;
  /** When the user wants it offered and when not, the producer's own rule. */
  offerWhen: string;
}

/**
 * SC1 2b: a candidate's sentences as one router request's Disclosure mints them. `says` is null when its screen text does
 * not mint (the view no longer shows it, or its window's budget is spent); `plain` names no screen text but app names and
 * numbers; `question` is the fact's sentence; `offer` the task evidence, minted, or null when its sentence does not mint.
 */
export interface MintedSay {
  says: ModelText | null;
  plain: ModelText;
  question?: ModelText;
  offer?: { task: ModelText; sentence: ModelText; found: ModelText; offerWhen: ModelText } | null;
}

/**
 * One thing a producer could do at this moment, listed by code before any model call. Its `run` is the producer's
 * own path (its asks, checks and offer); its `says` is code-written and quotes screen text only through `quotes`.
 */
export interface RouteCandidate {
  /** Stable for the moment, so the same candidate keeps the same id across observations: "fillAll", "event:<n>". */
  id: string;
  kind: Exclude<RouteKind, "handoff">;
  /** For a workflow: which producer. */
  workflow?: "event" | "openApp" | "loop" | "routine" | "skill";
  /** What doing it would be, for the routers and the logs, written by code. */
  says: string;
  /** The same without screen text, used when a window's budget will not take the quote. */
  plain: string;
  quotes: readonly Quoted[];
  /** Larger first among workflows. */
  relevance: number;
  /** The one fact this candidate needs from the user before it can be offered; set only when code can name it. */
  question?: { fact: string; says: string };
  /**
   * What the producer's own code checked before listing it. A ready candidate with evidence is Router 1's task question
   * (judge.ts), asked beside the outcome question rather than as one of its options, because such a task is offered next
   * to whatever else the moment gets (writing help included) and asking it inside the outcome question lost it every
   * time (brief R3: R2's latency session, and the D2-02 corpus's event moments).
   */
  evidence?: TaskEvidence;
  /** What `says`, `plain`, `question` and `evidence` say, minted by the router request's Disclosure (judge.ts). */
  say: (d: Disclosure) => MintedSay;
  /** Makes the offer (or asks the question) through the producer. */
  run: () => void;
  /** The context's decision did not choose it. Producers that held an offer for this moment let it go. */
  drop?: () => void;
}

/** A route as Router 2 lists it: a code-assigned option id and what it is. */
export interface Route {
  option: string;
  kind: RouteKind;
  candidate: RouteCandidate | null;
  /** For handoff: why, in code's words. */
  reason: string | null;
}

/** The routes frozen for one context. */
export interface Registry {
  gen: number;
  /** Real routes, then handoff last. Empty when nothing can be done. */
  routes: readonly Route[];
  /** The candidate whose one missing fact Caret may ask, or null. */
  question: RouteCandidate | null;
  /** The ready candidate with code-checked evidence that Router 1's task question is about, or null. */
  task: RouteCandidate | null;
  /** Workflows code could not list (more than MAX_WORKFLOWS); when any, the act routes become one handoff. */
  overflow: number;
}

export const HANDOFF_NONE = "none of the listed tasks fits what you are doing";
export const HANDOFF_OVERFLOW = "more known tasks fit here than Caret can list at once";
/** A handoff's reason in a router's request, as Caret's own wording: one of the two above, and nothing else. */
export function mintReason(d: Disclosure, reason: string | null): ModelText {
  if (reason === HANDOFF_NONE) return d.own(HANDOFF_NONE);
  if (reason === HANDOFF_OVERFLOW) return d.own(HANDOFF_OVERFLOW);
  throw new Error("a handoff route's reason is HANDOFF_NONE or HANDOFF_OVERFLOW");
}

/**
 * Freezes the candidates of one context into Router 2's registry. A candidate that needs a fact is not an act route;
 * the first one not yet asked is the context's question. The ready candidate with evidence that ranks first is the task
 * question's, and is no route; `tasksAsked` (the task ids a write session already put to Router 1) leaves those out
 * altogether. Any further candidate with evidence stays a route, as before R3. Workflows beyond MAX_WORKFLOWS are not
 * silently dropped: the act routes become one handoff that says so.
 */
export function freeze(gen: number, candidates: readonly RouteCandidate[], asked: ReadonlySet<string>, tasksAsked: ReadonlySet<string> = new Set()): Registry {
  const fresh = candidates.filter((c) => c.evidence === undefined || !tasksAsked.has(c.id));
  const task = fresh.filter((c) => c.question === undefined && c.evidence !== undefined).sort((a, b) => b.relevance - a.relevance)[0] ?? null;
  const ready = fresh.filter((c) => c.question === undefined && c !== task);
  const question = fresh.find((c) => c.question !== undefined && !asked.has(c.id)) ?? null;
  const workflows = ready.filter((c) => c.kind === "workflow").sort((a, b) => b.relevance - a.relevance);
  const overflow = Math.max(0, workflows.length - MAX_WORKFLOWS);
  if (overflow > 0) return { gen, routes: [{ option: "handoff", kind: "handoff", candidate: null, reason: HANDOFF_OVERFLOW }], question, task, overflow };
  const others = ready.filter((c) => c.kind !== "workflow");
  const real = [...workflows, ...others];
  if (real.length > MAX_ROUTES - 1) throw new Error(`routing: ${real.length} real routes for one context; the registry lists at most ${MAX_ROUTES - 1} beside handoff`);
  if (real.length === 0) return { gen, routes: [], question, task, overflow: 0 };
  const routes: Route[] = real.map((c, i) => ({ option: `r${i + 1}`, kind: c.kind, candidate: c, reason: null }));
  routes.push({ option: "handoff", kind: "handoff", candidate: null, reason: HANDOFF_NONE });
  return { gen, routes, question, task, overflow: 0 };
}

/** The real routes of a registry, handoff left out. */
export const realRoutes = (r: Registry): Route[] => r.routes.filter((x) => x.kind !== "handoff");

/**
 * B25's Ask intent routes in Router 2's words. An Ask skips Router 1 (the user asked, so it is `act`), and B25's intent
 * maker is its Router 2: fill is the scoped fillAll, plan the goal plan, refuse a handoff with the sentence code
 * wrote, and ask the one missing fact (which fields, source or person).
 */
export const ASK_ROUTES: Record<AskRoute, { outcome: "act"; kind: Exclude<RouteKind, "workflow"> } | { outcome: "ask" }> = {
  fill: { outcome: "act", kind: "fillAll" },
  plan: { outcome: "act", kind: "goalPlan" },
  refuse: { outcome: "act", kind: "handoff" },
  ask: { outcome: "ask" },
};
