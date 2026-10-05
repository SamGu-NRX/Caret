// The two routers' questions to Jev and the checks on their answers. Each is one Choice over options code listed:
// Router 1 over the outcomes legal now, Router 2 over the registry's route ids. Every piece of screen text goes
// through a SnippetLedger (privacy.ts), so the request declares what it carries and each window keeps its budget.
// An answer counts only when it names a listed option with a finite confidence at or above its router's floor; anything
// else abstains, with the reason logged. Nothing here acts.
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import { SnippetLedger } from "../privacy.ts";
import { describeField } from "../fill/descriptor.ts";
import { isConversation } from "../conversation.ts";
import { formFields, FillError } from "../fill/fill.ts";
import type { RoutingContext } from "./context.ts";
import type { Outcome, Registry, RouteCandidate } from "./routes.ts";

/**
 * The confidence Router 1's choice needs. Jev's Choice `confidence` is the margin between its two most likely options
 * (an answer of 0.74 against 0.26 comes back as 0.49), so a floor of 0.75 asks for about 0.875 on the winner.
 *
 * 0.5, provisional until real use (lead decision, 2026-10-04). Evidence, all in ~/.caret-run/evidence/screen/d2-02:
 * - Held-out half of the blind routing corpus (even ids, not tuned on; corpus-run2/summary.md), ambient moments: at
 *   0.75 write was 100% precise with 40% recall and act 100% / 15%; at 0.5 write 64% / 70% and act 67% / 29%, with one
 *   act where writing help was expected (m18: a fill offered from a cover-letter box; its twin m19, the same field on a
 *   blank form, is labeled fill, and Jev gives both act 0.8 against write 0.13, so no rule on the field's role tells
 *   them apart). Every act is an offer behind Tab, and fill's own value gates still decide every value. m18's real
 *   cause was fill's evidence counting a URL the form already held; with that fixed (helper.ts fillEvidence), m18's
 *   act comes back at 0.32 and 0.42 in two live runs and abstains (m18-probe, corpus-run4), though a floor of 0.25
 *   would still act on it.
 * - The real-day replay (day-replay.md, a counterfactual over the shadow store's hashes): useful fill offers kept rise
 *   from 1.2-1.4 an hour at 0.75 to 2.5-2.8 at 0.5, against 5.5 findable, with no offers where the entry was not on
 *   screen and at most $0.0020 of Jev an active hour (about 20 times less than producers alone).
 */
export const ROUTER1_FLOOR = 0.5;
/** The confidence Router 2's choice of route needs. Plan section 3's provisional 0.75, not calibrated; the corpus never reached Router 2. */
export const ROUTER2_FLOOR = 0.75;
/** Form labels Router 1 sees for the field the user is in, nearest first. Enough to tell a form; not measured. */
const FORM_LABELS = 6;

export type Refusal = "missing" | "forged" | "nonfinite" | "lowConfidence" | "failed" | "timeout";

export type Read<T extends string> = { ok: true; choice: T; confidence: number } | { ok: false; why: Refusal; choice: string | null; confidence: number | null };

/** Checks one Choice answer against the options code listed. A choice outside them is forged, whatever its confidence. */
export function readChoice<T extends string>(r: JevResult, question: string, options: readonly T[], floor: number): Read<T> {
  const a = r.answers[question];
  if (a === undefined) return { ok: false, why: "missing", choice: null, confidence: null };
  if (!(options as readonly string[]).includes(a.choice)) return { ok: false, why: "forged", choice: a.choice, confidence: a.confidence };
  if (!Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) return { ok: false, why: "nonfinite", choice: a.choice, confidence: a.confidence };
  if (a.confidence < floor) return { ok: false, why: "lowConfidence", choice: a.choice, confidence: a.confidence };
  return { ok: true, choice: a.choice as T, confidence: a.confidence };
}

/** Router 1's options, each a description of the user's moment rather than of Caret's action. */
const OUTCOME_SAYS: Record<Outcome, string> = {
  abstain: "Nothing for Caret here: the user is reading, browsing, searching, typing a command, code or an address, or is in a field Caret has nothing to offer for.",
  write: "The user is writing sentences for a person to read in this field (a document, a mail or message body, a long free-text answer), and Caret can suggest how the text goes on.",
  ask: "Caret can help once the user answers one question:",
  act: "The user would want this done for them now:",
};
/**
 * Router 1's task question, about the one candidate whose producer checked evidence in code (routes.ts `evidence`). It is
 * asked on its own, after the outcome question, because the task is offered next to whatever else the moment gets. The
 * task, its sentence and what code found go in the request's state as `offer`; the producer's rule for when to offer it
 * goes in the instructions; the options are short.
 *
 * Measured (evidence/screen/r3): before R3 the event card was one more option of the outcome question. With writing
 * legal, Router 1 chose write for all of the D2-02 corpus's event moments (m26 0.61, m36 0.74, m37 0.87, m43 0.68) or
 * abstained under the floor (m06, m25). Beside a kept write session, where write is no option and abstain says the user
 * is reading, Jev split almost evenly: margins 0.02, 0.10, 0.00 and 0.16 over four calls in R2's latency session
 * (latency/router-requests-before.ndjson). A first task question with the sentence and facts inside the act option still
 * split (0.00, 0.01: router-requests-after.ndjson). In a live probe of 3 wanted and 4 unwanted sentences (cancelled,
 * declined, hypothetical, other people), 2 runs each (task-wording/probe.json), that wording was right 8 of 14 times at
 * the 0.5 floor, the offer as state with short options 10, and with the producer's rule in the instructions 14 (wanted
 * act 0.85 to 0.93; unwanted abstain 0.81 to 1.0, the hypothetical at abstain 0.09 and 0.26). The offer inside the
 * instructions instead of the state was right 12 times (probe-v4.json). An answer still only makes an offer the user
 * takes with Tab, after the producer's own checks (the event card's two attend asks).
 */
export const TASK_QUESTION = {
  abstain: "No: do not offer it now.",
  act: "Yes: offer it now.",
} as const;
const taskInstructions = (offerWhen: string): string =>
  `Caret found the task in \`offer\` in what the user is doing. Should Caret offer it now, beside anything else it does here? ${offerWhen} It is only an offer: nothing happens unless the user accepts it.`;
export const TASK_OPTIONS = ["abstain", "act"] as const;
export type TaskChoice = (typeof TASK_OPTIONS)[number];

/** Other windows Router 1 names, most recently used first. Enough to say where values could come from; not measured. */
const OTHER_WINDOWS = 5;

/** The screen text one request carries, taken through one ledger; null pieces did not fit their window's budget. */
interface Taken {
  ledger: SnippetLedger;
  state: Record<string, unknown>;
  says: Map<string, string>;
  /** Candidates whose quotes fit their windows' budgets. */
  quoted: Set<string>;
}

/** A router's request could not be built within the privacy budgets: the field the user is in did not fit. */
export class PrivacyRefusal extends Error {}

/**
 * The moment as both routers describe it. Throws PrivacyRefusal when the focused field's own descriptor does not fit.
 * `form`: the other fields' labels, which the task question leaves out so its sentence fits the window's budget first.
 */
function describe(model: ScreenModel, ctx: RoutingContext, candidates: readonly RouteCandidate[], form = true): Taken {
  const w = model.windows.get(ctx.windowId);
  if (w === undefined) throw new PrivacyRefusal(`window ${ctx.windowId} left the model`);
  const ledger = new SnippetLedger(model.windows.values());
  const state: Record<string, unknown> = {
    task: "Caret is a helper on this Mac. It is deciding, once for this moment, what to do for the person using it.",
    app: ctx.app,
  };
  if (ledger.take(w, "descriptor", [w.window.title])) state.window = w.window.title;
  state.conversation = isConversation(w);
  const others = [...model.windows.values()].filter((o) => o.window.windowId !== w.window.windowId).sort((x, y) => y.lastFocusedAt - x.lastFocusedAt || y.updatedAt - x.updatedAt);
  state.otherWindows = others.slice(0, OTHER_WINDOWS).map((o) => (ledger.take(o, "descriptor", [o.window.title]) ? `${o.app.name}: ${o.window.title}` : o.app.name));
  const node = ctx.field === null ? undefined : w.nodes.get(ctx.field.key);
  if (ctx.field === null || node === undefined) state.field = "none: the cursor is not in a text field";
  else {
    const d = describeField(w, node);
    if (!ledger.take(w, "descriptor", [d.label, d.nearest, d.placeholder, d.section])) throw new PrivacyRefusal("the focused field's descriptor does not fit its window's budget");
    state.field = { describe: d.text, empty: ctx.field.empty, finishedSentences: ctx.sentences };
    const labels = form ? formLabels(w, ctx.field.key, ledger) : null;
    if (labels !== null) state.form = labels;
  }
  const says = new Map<string, string>();
  const quoted = new Set<string>();
  for (const c of candidates) {
    const fits = c.quotes.every((q) => ledger.take(q.window, q.kind, q.texts));
    if (fits) quoted.add(c.id);
    says.set(c.id, fits ? c.says : c.plain);
  }
  return { ledger, state, says, quoted };
}

/** The other empty fields around the focused one, as a count and the first labels that fit; null when it is no form. */
function formLabels(w: WindowState, key: string, ledger: SnippetLedger): { emptyFields: number; labels: string[] } | null {
  if (w.nodes.get(key)?.editable !== true) return null;
  let fields;
  try {
    fields = formFields(w, key);
  } catch (e) {
    if (e instanceof FillError) return null;
    throw e;
  }
  if (fields.length < 2) return null;
  const labels: string[] = [];
  for (const n of fields.slice(0, FORM_LABELS)) {
    const d = describeField(w, n);
    const name = d.label ?? d.nearest ?? d.placeholder;
    if (name !== null && ledger.take(w, "descriptor", [name])) labels.push(name);
  }
  return { emptyFields: fields.length, labels };
}

export interface Built<T extends string> {
  request: JevRequest;
  options: readonly T[];
}

/**
 * Router 1's requests: the outcome question over the outcomes legal now, and the task question when the registry has a
 * task. Act is an option of the outcome question only for the other routes; `outcome` is null when nothing but abstain
 * is left there. The task question is its own request, sent after the outcome's: its state carries the offer, and in one
 * request with the outcome question that state moved the outcome's answers (corpus m34, a hypothetical dinner, went from
 * write 0.75 to 0.32, under the floor; m26 from 0.61 to 0.31: evidence/screen/r3/corpus, router-requests.ndjson).
 *
 * The task question is not asked when its sentence does not fit the window's budget (`taskPrivacy`): with only code's
 * facts Router 1 cannot tell a cancelled call from a planned one (corpus m28, "We cancelled the call with Rafael",
 * answered act 0.44 on the facts alone in a Mail window: evidence/screen/r3/corpus-split).
 */
export interface Built1 {
  outcome: Built<Outcome> | null;
  task: { cand: RouteCandidate; built: Built<TaskChoice> } | null;
  taskPrivacy: boolean;
}

export function router1Request(model: ScreenModel, ctx: RoutingContext, legal: readonly Outcome[], reg: Registry): Built1 {
  const acts = reg.routes.flatMap((r) => (r.candidate === null ? [] : [r.candidate]));
  const asking = legal.includes("ask") && reg.question !== null ? [reg.question] : [];
  const options = legal.filter((o) => o !== "act" || acts.length > 0);
  let outcome: Built<Outcome> | null = null;
  if (options.length > 1) {
    const t = describe(model, ctx, [...acts, ...asking]);
    const criteria: Record<string, string> = {};
    for (const o of options) {
      if (o === "act") criteria.act = `${OUTCOME_SAYS.act} ${acts.map((c) => t.says.get(c.id)).join("; or ")}.`;
      else if (o === "ask") criteria.ask = `${OUTCOME_SAYS.ask} ${reg.question?.question?.says ?? ""}; then: ${t.says.get(reg.question?.id ?? "") ?? ""}.`;
      else criteria[o] = OUTCOME_SAYS[o];
    }
    const request: JevRequest = {
      state: t.state,
      questions: {
        outcome: {
          type: "choice",
          instructions: "Which one describes the user's moment? When a task fits what they are doing, it comes before writing help.",
          criteria,
        },
      },
      ...t.ledger.declared(),
      retry429: false,
    };
    outcome = { request, options };
  }
  const cand = legal.includes("act") ? reg.task : null;
  const ev = cand?.evidence;
  if (cand === null || cand === undefined || ev === undefined) return { outcome, task: null, taskPrivacy: false };
  const t = describe(model, ctx, [cand], false);
  if (!t.quoted.has(cand.id)) return { outcome, task: null, taskPrivacy: true };
  const request: JevRequest = {
    state: { ...t.state, offer: { task: ev.task, sentence: ev.sentence, found: ev.found } },
    questions: { task: { type: "choice", instructions: taskInstructions(ev.offerWhen), criteria: { abstain: TASK_QUESTION.abstain, act: TASK_QUESTION.act } } },
    ...t.ledger.declared(),
    retry429: false,
  };
  return { outcome, task: { cand, built: { request, options: TASK_OPTIONS } }, taskPrivacy: false };
}

/** Router 2: one Choice over the registry's routes, after Router 1 chose act. */
export function router2Request(model: ScreenModel, ctx: RoutingContext, reg: Registry): Built<string> {
  const cands = reg.routes.flatMap((r) => (r.candidate === null ? [] : [r.candidate]));
  const t = describe(model, ctx, cands);
  const criteria: Record<string, string> = {};
  for (const r of reg.routes) criteria[r.option] = r.candidate === null ? `None of these: ${r.reason ?? ""}. Offer nothing.` : (t.says.get(r.candidate.id) ?? r.candidate.plain);
  const request: JevRequest = {
    state: { ...t.state, decided: "Caret will offer to do one task now." },
    questions: { route: { type: "choice", instructions: "Which one task fits what the user is doing now?", criteria } },
    ...t.ledger.declared(),
    retry429: false,
  };
  return { request, options: reg.routes.map((r) => r.option) };
}

/**
 * Sends one router request; a transport failure is a refusal, never retried. The Jev client aborts a call after its own
 * timeout (makeJevClient, 10 s) with a TimeoutError, which is told apart so the decision can say so.
 */
export async function sendRouter<T extends string>(askJev: AskJev, b: Built<T>, question: string, floor: number): Promise<{ read: Read<T>; result: JevResult | null }> {
  let result: JevResult;
  try {
    result = await askJev(b.request);
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "failed";
    return { read: { ok: false, why, choice: null, confidence: null }, result: null };
  }
  return { read: readChoice(result, question, b.options, floor), result };
}
