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
import { fieldKinds, fieldTerms, isNameLike, NAME_TERM, overlap } from "./kinds.ts";
import { SnippetLedger, type Declared } from "../privacy.ts";
import { describeField } from "./descriptor.ts";
import { ABOUT_SAYS, fieldAsksFor, type AboutValue } from "./about.ts";
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

/** A value the user told Caret, under this ask's id for it (m1, m2... in the first ask, n1... in the second). */
export interface AskAbout {
  id: string;
  about: AboutValue;
}

/** The criterion for a value the user told Caret: what it is, and that it is the user's own. */
export function describeAbout(a: AboutValue): string {
  return `"${a.value}" (${a.kind === "email" ? "email" : "a name"}; the user's own ${a.label}, which the user told Caret)`;
}

/**
 * One ask. `declared` holds the screen text in it and what each window was charged (privacy.ts); `title` is the form window's title as
 * declared there, or null when it did not fit the window's budget and the question names the app alone. `about` lists, by field id,
 * the values the user told Caret that the field asks for (about.ts); only that field's question offers them.
 */
export function buildFillRequest(
  w: WindowState,
  fields: AskField[],
  candidates: Candidate[],
  wording: 0 | 1 = 0,
  declared: Declared = { snippets: [], charged: {} },
  title: string | null = w.window.title,
  about: ReadonlyMap<string, readonly AskAbout[]> = new Map(),
): JevRequest {
  const shared: Record<string, string> = {};
  for (const c of candidates) shared[c.id] = describeCandidate(c);
  const where = title === null ? `${w.app.name} window` : `${w.app.name} window '${title}'`;
  const questions: JevRequest["questions"] = {};
  for (const f of fields) {
    const criteria: Record<string, string> = { ...shared };
    for (const a of about.get(f.id) ?? []) criteria[a.id] = describeAbout(a.about);
    criteria[NONE] = "No candidate is the value this field asks for.";
    questions[f.id] = { type: "choice", instructions: WORDINGS[wording](where, f.descriptor), criteria };
  }
  const anyAbout = fields.some((f) => (about.get(f.id)?.length ?? 0) > 0);
  return {
    state: {
      destination_window: where,
      form_fields: fields.map((f) => f.name).join("; "),
      task:
        "The user is filling in this form. The candidates are values visible in the user's other open windows. " +
        "Users most often copy from the window they were in just before the form." +
        (anyAbout ? " A few candidates are the user's own details, which the user told Caret; one fits a field only when the form asks for the user's own details there." : ""),
    },
    questions,
    snippets: declared.snippets,
    charged: declared.charged,
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
  /** False asks a field whose label names no kind despite a cut, as B12 did, for the same replay. The helper never sets it. */
  unknownKindRule?: boolean;
  /** False takes a conversation's kinds in the order the fields want them, as B12 did (candidates.ts kindsByCost). The helper never sets it. */
  kindsByCost?: boolean;
  /** False leaves a conversation's names ungrouped and their cut unchecked, as B13 did (candidates.ts nameGroup). The helper never sets it. */
  nameGroup?: boolean;
  /**
   * Values the user told Caret (typed About entries, about.ts), each offered only to the fields that ask
   * for it. A form can then be filled with no other window open. Without it, nothing from memory is offered.
   */
  about?: readonly AboutValue[];
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
  const ledger = new SnippetLedger(model.windows.values());
  const title = ledger.take(w, "descriptor", [w.window.title]) ? w.window.title : null;
  const fields: { id: string; node: Node; descriptor: string; name: string; kinds: Set<ValueKind>; terms: Set<string>; texts: (string | null)[]; about: AboutValue[] }[] = [];
  for (const n of formFields(w, triggerKey)) {
    const d = describeField(w, n);
    const texts = [d.label, d.nearest, d.placeholder, d.section];
    if (!ledger.take(w, "descriptor", texts)) {
      if (n.key === triggerKey) throw new FillError(`the descriptor of the focused field in window ${windowId} is longer than the window's share of a question`);
      continue;
    }
    const labelWords = [d.label, d.nearest, d.placeholder];
    const name = d.label ?? d.nearest ?? d.placeholder;
    const about = (opts.about ?? []).filter((a) => fieldAsksFor(a, name));
    fields.push({ id: `f${fields.length + 1}`, node: n, descriptor: d.text, name: name ?? "unnamed field", kinds: fieldKinds(labelWords), terms: fieldTerms(labelWords), texts, about });
  }
  const { candidates, cut, cutTerms, cutAll, namesCut } = collectCandidates(model, windowId, {
    now,
    ledger,
    ...(opts.exclude === undefined ? {} : { exclude: opts.exclude }),
    ...(opts.relevance === false ? {} : { fields: fields.map((f) => f.terms) }),
    ...(opts.kindsByCost === false ? { kindsByCost: false } : {}),
    ...(opts.nameGroup === false ? { nameGroup: false } : {}),
  });
  // A value a window shows is offered as that window's candidate, which names where it is; the same text
  // from memory would only repeat it.
  for (const f of fields) f.about = f.about.filter((a) => !candidates.some((c) => c.text === a.value));
  if (candidates.length === 0 && cut.length === 0 && fields.every((f) => f.about.length === 0)) throw new FillError(`no candidate values in any window other than ${windowId}`);

  // A window's budget can cut the value a field wants and keep another of the same kind: with the
  // calibration sources as Messages windows, the cap cut the meeting block and Jev filled Meeting date
  // with the order's Placed date (~/.caret-run/evidence/screen/b11/live/live-replay.md). So a field
  // whose kind lost a value to a cut is not asked, since its candidates of that kind are a partial set,
  // and an asked field's pick of such a kind is not proposed. A blank costs the user a paste; a wrong
  // fill costs their trust.
  const removed = opts.cutRule === false ? new Set<ValueKind>() : cutKinds(model, cut, candidates);
  const isCut = (kinds: ReadonlySet<ValueKind>): boolean => [...kinds].some((k) => removed.has(k));
  // A field whose label names no kind (kinds.ts) could want a value of any kind or plain text. It is not
  // asked when a cut took a value of any kind: a "When" field was asked after a cut took the dates, and
  // filled with a note's untyped "Design review". Nor when a cut conversation left out a line sharing a
  // word with the field's label: a "Name" field was asked after a cut took a chat's only line, "Name: Dana
  // Whitfield", and filled with another window's name (B13 reviews). Withholding it on any cut instead
  // blanked Name on the fill desk, where an unrelated team chat is cut, and lost the desk's first-look
  // offer (~/.caret-run/evidence/screen/b13/live-final). A bare cut name ("Dana Whitfield") shares no
  // word with "Name", so names are handled as a kind (kinds.ts NAME_TERM): a conversation's name-like
  // lines go in whole or not at all, and namesCut says whether a name may have been kept out (candidates.ts).
  // Then a field that takes a name is not asked, and no field's name-like pick is proposed, as with a cut
  // kind (test/name-decoy.test.ts). Like a field of a kind, a field that takes a name is not withheld for
  // another kind's cut: withholding it then spent the chat's budget on names no field could be asked
  // about (the calibration chat's links gave way to its names and Attendee job title was still blanked).
  const nameCut = opts.cutRule !== false && opts.nameGroup !== false && namesCut;
  const takesName = (f: { terms: ReadonlySet<string> }): boolean => opts.nameGroup !== false && f.terms.has(NAME_TERM);
  const unknownCut = (f: { terms: ReadonlySet<string> }): boolean => (removed.size > 0 && !takesName(f)) || (nameCut && takesName(f)) || cutAll || overlap(f.terms, cutTerms) > 0;
  const fieldCut = (f: { kinds: ReadonlySet<ValueKind>; terms: ReadonlySet<string> }): boolean => (f.kinds.size === 0 && opts.unknownKindRule !== false ? unknownCut(f) : isCut(f.kinds));
  // A field is asked when a window gave candidates, or when something the user told Caret fits it; with
  // every window candidate cut away and nothing from memory, there is nothing to ask about. Values from
  // memory go through the ledger too (privacy.ts memory), and when one cannot, none is offered.
  const uncut = fields.filter((f) => !fieldCut(f));
  const aboutSent = [...new Map(uncut.flatMap((f) => f.about).map((a) => [a.id, a])).values()];
  if (aboutSent.length > 0 && !ledger.memory(aboutSent.map((a) => a.value))) for (const f of fields) f.about = [];
  const asked = uncut.filter((f) => candidates.length > 0 || f.about.length > 0);
  // The asks carry only the asked fields' descriptors, so a withheld field's are not declared; its
  // window was still charged for them, which errs on the side of saying less.
  const sent = new Set(asked.flatMap((f) => f.texts));
  const unsent = new Set(fields.filter((f) => !asked.includes(f)).flatMap((f) => f.texts).filter((t) => t !== null && !sent.has(t) && t !== title));
  const declared: Declared = { snippets: ledger.snippets.filter((x) => !(x.kind === "descriptor" && x.windowId === windowId && unsent.has(x.text))), charged: ledger.charges() };

  // The second ask sees the same candidates in another order under other ids, so neither position
  // nor id can carry a choice from one ask to the other. Windows keep their recency order and only
  // the candidates inside each window are shuffled: with a full shuffle the second ask was wrong on
  // 30 of 180 judgments the first ask got right, mostly picking the other person's details or none
  // (wording2-cal-* in the evidence folder), so window order is context worth keeping, not noise.
  const order = shuffledWithinWindows(candidates, opts.rand);
  const second = order.map((c, i) => ({ ...c, id: `v${i + 1}` }));
  const back = new Map(second.map((c, i) => [c.id, order[i]?.id ?? ""]));
  // Values from memory are numbered m1... in the first ask and n1..., shuffled, in the second, the same way.
  const aboutIds = new Map(aboutSent.map((a, i) => [a.id, `m${i + 1}`]));
  const aboutOrder = shuffled(aboutSent, opts.rand);
  const aboutSecond = new Map(aboutOrder.map((a, i) => [a.id, `n${i + 1}`]));
  for (const [aid, nid] of aboutSecond) back.set(nid, aboutIds.get(aid) ?? "");
  const askAbout = (ids: ReadonlyMap<string, string>): Map<string, AskAbout[]> =>
    new Map(asked.map((f) => [f.id, f.about.map((a) => ({ id: ids.get(a.id) ?? "", about: a })).sort((x, y) => x.id.localeCompare(y.id, "en", { numeric: true }))]));
  const [r1, r2] =
    asked.length === 0
      ? [null, null]
      : await Promise.all([
          askJev(buildFillRequest(w, asked, candidates, 0, declared, title, askAbout(aboutIds))),
          askJev(buildFillRequest(w, asked, second, 1, declared, title, askAbout(aboutSecond))),
        ]);

  type Pick = { from: "window"; c: Candidate } | { from: "memory"; a: AboutValue };
  const byId = new Map<string, Pick>([...candidates.map((c): [string, Pick] => [c.id, { from: "window", c }]), ...aboutSent.map((a): [string, Pick] => [aboutIds.get(a.id) ?? "", { from: "memory", a }])]);
  const pickText = (p: Pick): string => (p.from === "window" ? p.c.text : p.a.value);
  const readAsk = (r: JevResult, f: { id: string; about: readonly AboutValue[] }, mapId: (id: string) => string | undefined): FillAsk => {
    const a = r.answers[f.id];
    if (a === undefined) throw new FillError(`Jev returned no answer for ${f.id}`);
    if (a.choice === NONE) return { choice: NONE, confidence: a.confidence, value: null };
    const id = mapId(a.choice);
    const p = id === undefined ? undefined : byId.get(id);
    // A value from memory is a choice only in the questions of the fields it was offered to.
    if (p === undefined || (p.from === "memory" && !f.about.includes(p.a))) throw new FillError(`Jev chose ${a.choice}, which is not a candidate id for ${f.id}`);
    return { choice: id as string, confidence: a.confidence, value: pickText(p) };
  };

  // Picks of a kind a cut took are withheld (see above); a value from memory is of its own kind.
  const pickCut = (p: Pick): boolean =>
    p.from === "window" ? isCut(candidateKinds(model, p.c)) || (nameCut && isNameLike(p.c.text, p.c.context)) : p.a.kind === "email" ? isCut(new Set(["email"])) : nameCut;
  const out: FillField[] = fields.map((f) => {
    if (r1 === null || r2 === null || !asked.includes(f)) {
      // Not asked: a cut took its kind (or every candidate), or, with no cut, nothing could be offered for it.
      const nothing = !fieldCut(f) && candidates.length === 0 && cut.length === 0;
      return { key: f.node.key, frame: f.node.frame ?? null, descriptor: f.descriptor, choice: NONE, confidence: 0, value: null, source: null, memory: null, withheld: nothing ? null : "sourceCut", asks: [] };
    }
    const a1 = readAsk(r1, f, (id) => id);
    const a2 = readAsk(r2, f, (id) => back.get(id));
    const agree = a1.choice === a2.choice;
    const confidence = agree ? Math.min(a1.confidence, a2.confidence) : 0;
    const picked = agree && a1.choice !== NONE ? byId.get(a1.choice) : undefined;
    const withheld =
      a1.choice === NONE && a2.choice === NONE
        ? null
        : !agree
          ? "disagree"
          : picked !== undefined && pickCut(picked)
            ? "sourceCut"
            : confidence < cutoff
              ? "lowConfidence"
              : null;
    const p = withheld === null ? picked : undefined;
    return {
      key: f.node.key,
      frame: f.node.frame ?? null,
      descriptor: f.descriptor,
      choice: p === undefined ? NONE : a1.choice,
      confidence,
      value: p === undefined ? null : pickText(p),
      source: p?.from === "window" ? p.c.source : null,
      memory: p?.from === "memory" ? { id: p.a.id, label: p.a.label, says: ABOUT_SAYS } : null,
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
