// The two routers' questions to Jev and the checks on their answers. Each is one Choice over options code listed:
// Router 1 over the outcomes legal now, Router 2 over the registry's route ids. Every piece of screen text goes
// through a SnippetLedger (privacy.ts), so the request declares what it carries and each window keeps its budget.
// An answer counts only when it names a listed option with a finite confidence at or above ROUTE_FLOOR; anything
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
 * The confidence a router's choice needs. Provisional: plan section 3 sets 0.75 as a conservative start, not a
 * transferred calibration (fill's calibration answers another question). No routing calibration run exists; the
 * corpus run reports what this floor keeps and drops (evidence/screen/d2-02).
 */
export const ROUTE_FLOOR = 0.75;
/** Form labels Router 1 sees for the field the user is in, nearest first. Enough to tell a form; not measured. */
const FORM_LABELS = 6;

export type Refusal = "missing" | "forged" | "nonfinite" | "lowConfidence" | "failed";

export type Read<T extends string> = { ok: true; choice: T; confidence: number } | { ok: false; why: Refusal; choice: string | null; confidence: number | null };

/** Checks one Choice answer against the options code listed. A choice outside them is forged, whatever its confidence. */
export function readChoice<T extends string>(r: JevResult, question: string, options: readonly T[], floor = ROUTE_FLOOR): Read<T> {
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
/** Other windows Router 1 names, most recently used first. Enough to say where values could come from; not measured. */
const OTHER_WINDOWS = 5;

/** The screen text one request carries, taken through one ledger; null pieces did not fit their window's budget. */
interface Taken {
  ledger: SnippetLedger;
  state: Record<string, unknown>;
  says: Map<string, string>;
}

/** A router's request could not be built within the privacy budgets: the field the user is in did not fit. */
export class PrivacyRefusal extends Error {}

/** The moment as both routers describe it. Throws PrivacyRefusal when the focused field's own descriptor does not fit. */
function describe(model: ScreenModel, ctx: RoutingContext, candidates: readonly RouteCandidate[]): Taken {
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
    const labels = formLabels(w, ctx.field.key, ledger);
    if (labels !== null) state.form = labels;
  }
  const says = new Map<string, string>();
  for (const c of candidates) says.set(c.id, c.quotes.every((q) => ledger.take(q.window, q.kind, q.texts)) ? c.says : c.plain);
  return { ledger, state, says };
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

/** Router 1: one Choice over the outcomes legal now. */
export function router1Request(model: ScreenModel, ctx: RoutingContext, legal: readonly Outcome[], reg: Registry): Built<Outcome> {
  const acts = reg.routes.flatMap((r) => (r.candidate === null ? [] : [r.candidate]));
  const asking = legal.includes("ask") && reg.question !== null ? [reg.question] : [];
  const t = describe(model, ctx, [...acts, ...asking]);
  const criteria: Record<string, string> = {};
  for (const o of legal) {
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
  return { request, options: legal };
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

/** Sends one router request; a transport failure is a refusal, never retried. */
export async function sendRouter<T extends string>(askJev: AskJev, b: Built<T>, question: string): Promise<{ read: Read<T>; result: JevResult | null }> {
  let result: JevResult;
  try {
    result = await askJev(b.request);
  } catch {
    return { read: { ok: false, why: "failed", choice: null, confidence: null }, result: null };
  }
  return { read: readChoice(result, question, b.options), result };
}
