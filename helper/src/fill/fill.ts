// Grounded fill: one Jev request per form, one Choice question per empty field, each offering
// the same candidate spans plus "none" (deep plan section 5, "Fill"). Jev picks a candidate id;
// code copies that candidate's text verbatim into the proposal. Nothing here writes to any app.
//
// Every form is asked twice in parallel. The second ask shuffles the candidates, renumbers them and
// rewords each field's question. A value is proposed only when both asks pick the same candidate
// and the lower confidence clears the cutoff. With a second person's details on screen, a single
// ask filled 12 of 60 fields wrongly at confidences up to 0.90
// (~/.caret-run/evidence/screen/fill-distractors/fill-eval.md), so agreement and the cutoff exist
// to turn those into blanks.
import { randomInt, randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type FillAsk, type FillField, type FillProposal, type Node, type ValueKind } from "../protocol.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import { candidateKinds, collectCandidates, cutKinds, describeCandidate, type Candidate } from "./candidates.ts";
import { fieldKinds, fieldTerms } from "./kinds.ts";
import { SnippetLedger, type Snippet } from "../privacy.ts";
import { describeField } from "./descriptor.ts";
import type { AskJev, JevRequest, JevResult } from "./jev.ts";

export const NONE = "none";
/** The proposal's model name when a cut withheld every field and Jev was not asked. */
export const NOT_ASKED = "not asked";
export const FILLABLE_ROLES: ReadonlySet<string> = new Set(["AXTextField", "AXTextArea", "AXComboBox"]);
/** A form question beyond this many fields is cut to the fields nearest the trigger. Assumed. */
export const MAX_FIELDS = 20;
/**
 * Lowest confidence, taken as the lower of the two asks, at which an agreed choice is proposed.
 * It is the lowest cutoff at which none of the five calibration sets (900 field judgments over four
 * prompt versions, ~/.caret-run/evidence/screen/fill-distractors-v2/calibration.md) has a wrong
 * agreed fill; the highest wrong agreed confidence seen was 0.70. On the final prompt it gives up
 * 2 of 156 answerable fields. One synthetic fixture is thin evidence; recheck on real windows.
 */
export const FILL_CUTOFF = 0.75;

export class FillError extends Error {}

/** The empty fillable fields of the trigger's window, nearest the trigger first. The trigger is always included. */
export function formFields(w: WindowState, triggerKey: string, max = MAX_FIELDS): Node[] {
  const trigger = w.nodes.get(triggerKey);
  if (trigger === undefined) throw new FillError(`field ${triggerKey} is not in window ${w.window.windowId}`);
  if (trigger.editable !== true) throw new FillError(`field ${triggerKey} is not editable`);
  const fields = [...w.nodes.values()].filter(
    (n) => n.key === triggerKey || (n.editable === true && FILLABLE_ROLES.has(n.role) && (n.value ?? "") === "" && !n.states?.includes("secure")),
  );
  const center = (n: Node): [number, number] => (n.frame === undefined ? [0, 0] : [n.frame[0] + n.frame[2] / 2, n.frame[1] + n.frame[3] / 2]);
  const [tx, ty] = center(trigger);
  const dist = (n: Node): number => (n.key === triggerKey ? -1 : Math.hypot(center(n)[0] - tx, center(n)[1] - ty));
  return fields.sort((a, b) => dist(a) - dist(b)).slice(0, max);
}

export interface AskField {
  id: string;
  descriptor: string;
  /** A short name for the field, used to list the form's other fields. */
  name: string;
}

/**
 * Ask 1 and ask 2 word the same question differently, so a choice that rests on wording alone is
 * less likely to repeat. The second wording is a plain paraphrase: an earlier one that added "for the
 * same person, order or event the form is about" made the second ask wrong on 43 of the 180 judgments
 * where the first was right (wording1-cal-* in the evidence folder).
 */
const WORDINGS = [
  (where: string, d: string): string =>
    `A form in the ${where} has this field: ${d} Which candidate is the value the user should enter in this field? The user usually copies from the window they just left. Choose none if no candidate fits.`,
  (where: string, d: string): string =>
    `Field to fill: ${d} It is in a form in the ${where}. Which value below should the user type into this field? Values usually come from the window the user just left. Answer none if no value below belongs in it.`,
] as const;

/**
 * One ask. `snippets` declares the screen text in it (privacy.ts); `title` is the form window's title as
 * declared there, or null when it did not fit the window's budget and the question names the app alone.
 */
export function buildFillRequest(
  w: WindowState,
  fields: AskField[],
  candidates: Candidate[],
  wording: 0 | 1 = 0,
  snippets: readonly Snippet[] = [],
  title: string | null = w.window.title,
): JevRequest {
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.id] = describeCandidate(c);
  criteria[NONE] = "No candidate is the value this field asks for.";
  const where = title === null ? `${w.app.name} window` : `${w.app.name} window '${title}'`;
  const questions: JevRequest["questions"] = {};
  for (const f of fields) {
    questions[f.id] = { type: "choice", instructions: WORDINGS[wording](where, f.descriptor), criteria };
  }
  return {
    state: {
      destination_window: where,
      form_fields: fields.map((f) => f.name).join("; "),
      task:
        "The user is filling in this form. The candidates are values visible in the user's other open windows. " +
        "Users most often copy from the window they were in just before the form.",
    },
    questions,
    snippets,
  };
}

/** Fisher-Yates with an injectable source of randomness, so tests can fix the order. */
export function shuffled<T>(xs: readonly T[], rand: (n: number) => number = randomInt): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** Shuffles candidates within each source window, keeping the windows in their original order. */
export function shuffledWithinWindows(cands: readonly Candidate[], rand?: (n: number) => number): Candidate[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of cands) {
    const g = groups.get(c.source.windowId);
    if (g === undefined) groups.set(c.source.windowId, [c]);
    else g.push(c);
  }
  const windowOrder = [...new Set(cands.map((c) => c.source.windowId))];
  return windowOrder.flatMap((id) => shuffled(groups.get(id) ?? [], rand));
}

export interface FillOptions {
  cutoff?: number;
  rand?: (n: number) => number;
  /** Makes the proposal id; tests pass a counter. */
  newId?: () => string;
  /** Windows that give no candidates. */
  exclude?: ReadonlySet<string>;
  /**
   * False turns off the source-cut rule, for the live replay's measure of what it costs and saves
   * (scripts/live-replay.ts). The helper never sets it.
   */
  cutRule?: boolean;
  /** False spends a conversation's budget in screen order, as before B12, for the same replay. The helper never sets it. */
  relevance?: boolean;
}

export async function proposeFill(
  model: ScreenModel,
  askJev: AskJev,
  windowId: string,
  triggerKey: string,
  now = Date.now(),
  opts: FillOptions = {},
): Promise<FillProposal> {
  const cutoff = opts.cutoff ?? FILL_CUTOFF;
  const w = model.windows.get(windowId);
  if (w === undefined) throw new FillError(`unknown window ${windowId}`);
  // Every piece of screen text the asks carry goes through one ledger, which holds each window to its
  // budget (privacy.ts): the form's title and each field's descriptor, nearest field first, then the
  // candidates. A field whose descriptor does not fit is left out of the question; the trigger must fit.
  const ledger = new SnippetLedger();
  const title = ledger.take(w, "descriptor", [w.window.title]) ? w.window.title : null;
  const fields: { id: string; node: Node; descriptor: string; name: string; kinds: Set<ValueKind>; terms: Set<string>; texts: (string | null)[] }[] = [];
  for (const n of formFields(w, triggerKey)) {
    const d = describeField(w, n);
    const texts = [d.label, d.nearest, d.placeholder, d.section];
    if (!ledger.take(w, "descriptor", texts)) {
      if (n.key === triggerKey) throw new FillError(`the descriptor of the focused field in window ${windowId} is longer than the window's share of a question`);
      continue;
    }
    const labelWords = [d.label, d.nearest, d.placeholder];
    fields.push({ id: `f${fields.length + 1}`, node: n, descriptor: d.text, name: d.label ?? d.nearest ?? d.placeholder ?? "unnamed field", kinds: fieldKinds(labelWords), terms: fieldTerms(labelWords), texts });
  }
  const { candidates, cut } = collectCandidates(model, windowId, {
    now,
    ledger,
    ...(opts.exclude === undefined ? {} : { exclude: opts.exclude }),
    ...(opts.relevance === false ? {} : { fields: fields.map((f) => f.terms) }),
  });
  if (candidates.length === 0 && cut.length === 0) throw new FillError(`no candidate values in any window other than ${windowId}`);

  // A window's budget can cut the value a field wants and keep another of the same kind: with the
  // calibration sources as Messages windows, the cap cut the meeting block and Jev filled Meeting date
  // with the order's Placed date (~/.caret-run/evidence/screen/b11/live/live-replay.md). So a field
  // whose kind lost a value to a cut is not asked, since its candidates of that kind are a partial set,
  // and an asked field's pick of such a kind is not proposed. A blank costs the user a paste; a wrong
  // fill costs their trust.
  const removed = opts.cutRule === false ? new Set<ValueKind>() : cutKinds(model, cut, ledger);
  const isCut = (kinds: ReadonlySet<ValueKind>): boolean => [...kinds].some((k) => removed.has(k));
  // With every candidate cut away there is nothing to ask about.
  const asked = candidates.length === 0 ? [] : fields.filter((f) => !isCut(f.kinds));
  // The asks carry only the asked fields' descriptors, so a withheld field's are not declared; its
  // window was still charged for them, which errs on the side of saying less.
  const sent = new Set(asked.flatMap((f) => f.texts));
  const unsent = new Set(fields.filter((f) => !asked.includes(f)).flatMap((f) => f.texts).filter((t) => t !== null && !sent.has(t) && t !== title));
  const snippets = ledger.snippets.filter((x) => !(x.kind === "descriptor" && x.windowId === windowId && unsent.has(x.text)));

  // The second ask sees the same candidates in another order under other ids, so neither position
  // nor id can carry a choice from one ask to the other. Windows keep their recency order and only
  // the candidates inside each window are shuffled: with a full shuffle the second ask was wrong on
  // 30 of 180 judgments the first ask got right, mostly picking the other person's details or none
  // (wording2-cal-* in the evidence folder), so window order is context worth keeping, not noise.
  const order = shuffledWithinWindows(candidates, opts.rand);
  const second = order.map((c, i) => ({ ...c, id: `v${i + 1}` }));
  const back = new Map(second.map((c, i) => [c.id, order[i]?.id ?? ""]));
  const [r1, r2] =
    asked.length === 0
      ? [null, null]
      : await Promise.all([askJev(buildFillRequest(w, asked, candidates, 0, snippets, title)), askJev(buildFillRequest(w, asked, second, 1, snippets, title))]);

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const readAsk = (r: JevResult, fieldId: string, mapId: (id: string) => string | undefined): FillAsk => {
    const a = r.answers[fieldId];
    if (a === undefined) throw new FillError(`Jev returned no answer for ${fieldId}`);
    if (a.choice === NONE) return { choice: NONE, confidence: a.confidence, value: null };
    const id = mapId(a.choice);
    const c = id === undefined ? undefined : byId.get(id);
    if (c === undefined) throw new FillError(`Jev chose ${a.choice}, which is not a candidate id`);
    return { choice: c.id, confidence: a.confidence, value: c.text };
  };

  const out: FillField[] = fields.map((f) => {
    if (r1 === null || r2 === null || !asked.includes(f)) {
      return { key: f.node.key, frame: f.node.frame ?? null, descriptor: f.descriptor, choice: NONE, confidence: 0, value: null, source: null, withheld: "sourceCut", asks: [] };
    }
    const a1 = readAsk(r1, f.id, (id) => id);
    const a2 = readAsk(r2, f.id, (id) => back.get(id));
    const agree = a1.choice === a2.choice;
    const confidence = agree ? Math.min(a1.confidence, a2.confidence) : 0;
    const picked = agree && a1.choice !== NONE ? byId.get(a1.choice) : undefined;
    const withheld =
      a1.choice === NONE && a2.choice === NONE
        ? null
        : !agree
          ? "disagree"
          : picked !== undefined && isCut(candidateKinds(model, picked))
            ? "sourceCut"
            : confidence < cutoff
              ? "lowConfidence"
              : null;
    const c = withheld === null ? picked : undefined;
    return {
      key: f.node.key,
      frame: f.node.frame ?? null,
      descriptor: f.descriptor,
      choice: c?.id ?? NONE,
      confidence,
      value: c?.text ?? null,
      source: c?.source ?? null,
      withheld,
      asks: [a1, a2],
    };
  });

  return {
    type: "fillProposal",
    v: PROTOCOL_VERSION,
    id: opts.newId?.() ?? randomUUID(),
    at: now,
    pid: w.app.pid,
    windowId,
    bundleId: w.app.bundleId,
    triggerKey,
    fields: out,
    candidates: candidates.length,
    jev:
      r1 === null || r2 === null
        ? { model: NOT_ASKED, latencyMs: 0, inputTokens: 0, costUsd: 0 }
        : { model: r1.model, latencyMs: Math.max(r1.latencyMs, r2.latencyMs), inputTokens: r1.inputTokens + r2.inputTokens, costUsd: r1.costUsd + r2.costUsd },
    cutoff,
  };
}
