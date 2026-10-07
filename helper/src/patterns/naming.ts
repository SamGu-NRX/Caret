import { Disclosure, type ModelText } from "../privacy/disclosure.ts";
import { redactWindow } from "../fill/redact.ts";
// Naming a routine (B19, plan section 4: "When a routine crosses the threshold, a language model names it
// in the background. The name is a label only."). Jev answers only choice questions, so the house rule
// holds here too: code proposes, Jev chooses, code checks.
//   1. Code reads the routine's structure: the source and destination apps, the destination's field
//      labels, the source's section or field labels, and how many times it was seen. Values never go:
//      a label that holds, or is held by, a value seen in the routine is dropped before anything is built.
//   2. Code composes short candidate names from those words, each already passing the check below.
//   3. Jev picks one, in one request with one question. The pick is checked again (checkName): at most
//      NAME_MAX_WORDS words, it names the destination app or a destination field label, and it holds no
//      value seen in the routine and no word of one that the structure does not also use. A failed ask
//      (no answer, "none", an unknown choice, low confidence, or a failed check) is retried once with
//      the question reworded and the names shuffled; then code's own name is used (fallbackName).
// The request's screen text goes through a SnippetLedger like every other request (privacy.ts): the
// destination's labels as descriptors of that window, the source's labels as candidates of theirs.
import { randomInt } from "node:crypto";
import type { WindowState } from "../model.ts";
import type { AskJev, JevRequest } from "../fill/jev.ts";

/** Words a name may have. The brief's rule; no measurement behind it. */
export const NAME_MAX_WORDS = 6;
/** Lowest confidence at which Jev's pick is used. Assumed: no naming question has been calibrated. */
export const NAME_CUTOFF = 0.5;
/** Candidate names one question lists. Assumed. */
export const MAX_NAME_CANDIDATES = 6;
/** A value shorter than this is not looked for inside a name: one or two characters are in most words. */
const MIN_VALUE_CHARS = 3;
/** Labels longer than this many words describe more than a field, so they are not used. Assumed. */
const MAX_LABEL_WORDS = 4;
const NONE = "none";

/** What naming may know about a routine. Values are here only to be kept out. */
export interface RoutineFacts {
  routineId: string;
  dstApp: string;
  dstWindow: WindowState | null;
  /** The destination fields' labels, in step order, each once. */
  dstLabels: string[];
  srcApps: string[];
  /** The source elements' own labels, or their section's, each with its window. */
  srcLabels: { window: WindowState; text: string }[];
  /** Completed occurrences, the count Jev is told. */
  count: number;
  /** Every value the routine was seen copying in this session. Never sent. */
  values: string[];
}

export interface NameResult {
  name: string | null;
  by: "jev" | "code" | null;
  /** Jev requests made: 0 with Jev off, else 1 or 2. */
  asks: number;
  costUsd: number;
  /** Why each failed ask failed, in order. */
  failures: string[];
  /** The requests sent, for the privacy test and evaluations. */
  requests: JevRequest[];
}

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();
const words = (s: string): string[] => s.trim().split(/\s+/).filter((w) => w !== "");
/** Letters and digits of a text, lower-cased, as tokens. */
const tokens = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t !== "");

/** Whether `phrase` stands in `text` as whole words, case aside, or with its own case when `exactCase`. */
function hasPhrase(text: string, phrase: string, exactCase = false): boolean {
  const p = phrase.replace(/\s+/g, " ").trim();
  if (p === "") return false;
  const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, exactCase ? "u" : "iu").test(text);
}

/**
 * Whether a name names this field label. A label that is also a word names join with ("To", "From")
 * counts only with its own capitals, so "Mail to Notes" does not name a "To" field.
 */
function namesLabel(name: string, label: string): boolean {
  return hasPhrase(name, label, (CONNECTIVES as readonly string[]).includes(norm(label)));
}

/**
 * Whether a text holds a value, or a value holds the text: such a label or app name is screen content, not
 * structure. A value of one or two characters ("42", "B") is looked for as whole words only, since a
 * letter or two is inside most words.
 */
function touchesValue(text: string, values: readonly string[]): boolean {
  const l = norm(text);
  return values.some((v) => {
    const x = norm(v);
    if (x === "") return false;
    if (x.length < MIN_VALUE_CHARS) return holdsShortValue(text, x);
    return l.includes(x) || (l.length >= MIN_VALUE_CHARS && x.includes(l));
  });
}

/** Whether every word of a short value stands as a word of `text`; a value with no letters or digits ("-") is looked for as it is. */
function holdsShortValue(text: string, value: string): boolean {
  const v = tokens(value);
  if (v.length === 0) return norm(text).includes(value);
  const t = new Set(tokens(text));
  return v.every((w) => t.has(w));
}

/** The facts with every label that touches a value, or is too long to be a label, left out. */
export function safeFacts(f: RoutineFacts): RoutineFacts {
  const ok = (t: string): boolean => t.trim() !== "" && words(t).length <= MAX_LABEL_WORDS && !touchesValue(t, f.values);
  const seen = new Set<string>();
  const once = (t: string): boolean => {
    const k = norm(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };
  return {
    ...f,
    dstLabels: f.dstLabels.map((t) => t.trim()).filter((t) => ok(t) && once(t)),
    srcLabels: f.srcLabels.map((x) => ({ ...x, text: x.text.trim() })).filter((x) => ok(x.text) && once(x.text)),
    srcApps: f.srcApps.filter((a) => !touchesValue(a, f.values)),
    // An app named like a value it received ("Airtable" copied into Airtable) is not sent, and no name uses it.
    dstApp: touchesValue(f.dstApp, f.values) ? "" : f.dstApp,
  };
}

/**
 * Why `name` fails the naming rule, or null when it passes: at most NAME_MAX_WORDS words; it names the
 * destination app or one of the destination's field labels; it holds no value seen in the routine, and
 * no word of one (three characters or more) that the app names and labels do not also use.
 */
export function checkName(name: string, f: RoutineFacts): string | null {
  const n = name.trim();
  if (n === "") return "the name is blank";
  if (/[\p{Cc}\u2028\u2029]/u.test(n)) return "the name is not one line";
  const count = words(n).length;
  if (count > NAME_MAX_WORDS) return `the name has ${count} words, over ${NAME_MAX_WORDS}`;
  if (!hasPhrase(n, f.dstApp) && !f.dstLabels.some((l) => namesLabel(n, l))) return "the name names neither the destination app nor one of its fields";
  const lower = norm(n);
  for (const v of f.values) {
    const x = norm(v);
    if (x === "") continue;
    if (x.length >= MIN_VALUE_CHARS ? lower.includes(x) : holdsShortValue(n, x)) return "the name holds a value the routine copied";
  }
  const structure = new Set([f.dstApp, ...f.srcApps, ...f.dstLabels, ...f.srcLabels.map((x) => x.text), ...CONNECTIVES].flatMap(tokens));
  const valueWords = new Set(f.values.flatMap(tokens).filter((t) => t.length >= MIN_VALUE_CHARS && !structure.has(t)));
  if (tokens(n).some((t) => valueWords.has(t))) return "the name holds a word of a value the routine copied";
  return null;
}

/** The words candidate names add to labels and app names. */
const CONNECTIVES = ["and", "into", "to", "from", "in", "fill", "copy", "log"] as const;

/** "A", "A and B", or "A, B and C". */
export function list(xs: readonly string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/**
 * Short names code composes from the routine's structure, each passing checkName, most specific first,
 * at most MAX_NAME_CANDIDATES. Facts must have been through safeFacts.
 */
export function nameCandidates(f: RoutineFacts): string[] {
  const app = f.dstApp;
  const src = f.srcApps[0] ?? "";
  const [l0, l1] = f.dstLabels;
  const s0 = f.srcLabels[0]?.text;
  // With no app name to use (safeFacts left it out), only the field labels can name the routine.
  const a = app !== "";
  const raw = [
    a && f.dstLabels.length >= 2 ? `${list(f.dstLabels.slice(0, 3))} into ${app}` : null,
    a && l0 !== undefined && l1 !== undefined ? `${l0} and ${l1} into ${app}` : null,
    a && s0 !== undefined ? `${s0} to ${app}` : null,
    a && src !== "" && src !== app ? `${src} to ${app}` : null,
    a && src !== "" && src !== app ? `Fill ${app} from ${src}` : null,
    l0 !== undefined ? (a ? `Copy ${l0} into ${app}` : `Copy ${l0}`) : null,
    a && l0 !== undefined ? `Log ${l0} in ${app}` : null,
    f.dstLabels.length >= 2 ? list(f.dstLabels.slice(0, 3)) : null,
    a ? `Fill ${app}` : null,
  ];
  const out: string[] = [];
  for (const c of raw) {
    if (c === null || checkName(c, f) !== null) continue;
    if (out.some((x) => norm(x) === norm(c))) continue;
    out.push(c);
    if (out.length >= MAX_NAME_CANDIDATES) break;
  }
  return out;
}

/** Code's own name, used when Jev is off or both asks failed: the first candidate, else a label alone. Null only when nothing passes. */
export function fallbackName(f: RoutineFacts): string | null {
  const c = nameCandidates(f)[0];
  if (c !== undefined) return c;
  for (const l of f.dstLabels) if (checkName(`Fill ${l}`, f) === null) return `Fill ${l}`;
  return null;
}

/** The two wordings of the naming question, over the request's minted app names (null: none to name) and count. */
const WORDINGS = [
  (d: Disclosure, src: ModelText | null, dst: ModelText | null, count: ModelText): ModelText =>
    d.t`Someone copied values from ${src ?? d.own("one app")} into ${dst ?? d.own("another")} the same way ${count} times. Which short name would they recognize this routine by?`,
  (d: Disclosure, src: ModelText | null, dst: ModelText | null, count: ModelText): ModelText =>
    d.t`A repeated task: fields of a ${dst ?? d.own("form")} window filled from ${src ?? d.own("another window")}, seen ${count} times. Pick the clearest label for it in a list of saved tasks.`,
] as const;

/**
 * One naming request, built through a Disclosure over `windows` (normally the screen model's): the destination's labels
 * as its descriptors and the source labels as candidates, each minted from its window's redacted view; the app names as
 * the reader gives them, or as the routine's record keeps them when no window of the app is open (memory); and then the
 * composed names and question as plan text too, since a name built from two labels can be a line some other window
 * shows. A text the ledger refuses is left out, and so are the names that use it; null when no name or the question
 * itself cannot go.
 */
export function namingRequest(f: RoutineFacts, windows: Iterable<WindowState>, wording: number, rand: (n: number) => number): { req: JevRequest; ids: Map<string, string> } | null {
  const d = new Disclosure(windows);
  const dstView = f.dstWindow === null ? null : redactWindow(f.dstWindow);
  const dst = dstView === null ? [] : f.dstLabels.flatMap((l) => {
    const m = d.descriptor(dstView, l);
    return m === null ? [] : [{ text: l, m }];
  });
  const src = f.srcLabels.flatMap((x) => {
    const m = d.candidate(redactWindow(x.window), x.text);
    return m === null ? [] : [{ x, m }];
  });
  const appText = (name: string): ModelText | null => d.appNamed(name) ?? d.memoryText(null, name);
  // App names are declared as plan text, as the ledger always took them: a name can be a line some window shows.
  if (!d.plan([...new Set([f.dstApp, ...f.srcApps])].filter((x) => x !== ""))) return null;
  const apps = new Map<string, ModelText>();
  for (const a of new Set([f.dstApp, ...f.srcApps])) {
    if (a === "") continue;
    const m = appText(a);
    if (m === null) return null;
    apps.set(a, m);
  }
  const facts: RoutineFacts = { ...f, dstLabels: dst.map((x) => x.text), srcLabels: src.map((x) => x.x) };
  const srcApps = facts.srcApps.flatMap((a) => apps.get(a) ?? []);
  const instructions = WORDINGS[wording % WORDINGS.length]!(d, srcApps.length === 0 ? null : listMinted(d, srcApps), apps.get(facts.dstApp) ?? null, d.count(facts.count));
  if (!d.plan([instructions])) return null;
  // Each name is code's composition of the minted labels and app names with its own connectives.
  const parts = [...dst.map((x) => x.m), ...src.map((x) => x.m), ...apps.values()];
  const names = nameCandidates(facts).filter((n) => d.plan([n])).flatMap((n) => {
    const m = d.derived(parts, n, CONNECTIVES);
    return m === null ? [] : [m];
  });
  if (names.length === 0) return null;
  const order = shuffle(names, rand);
  const ids = new Map<string, string>();
  const criteria: Record<string, ModelText> = {};
  order.forEach((n, i) => {
    const id = `n${i + 1}`;
    ids.set(id, n);
    criteria[id] = n;
  });
  criteria[NONE] = d.own("None of these names fits.");
  return {
    req: d.seal({
      purpose: "pattern.naming",
      state: { into: apps.get(facts.dstApp) ?? d.own(""), intoFields: dst.map((x) => x.m), from: srcApps, fromSections: src.map((x) => x.m), timesSeen: facts.count },
      questions: { name: { type: "choice", instructions, criteria } },
      ...d.declared(),
    }),
    ids,
  };
}

/** "A", "A and B", or "A, B and C", of minted texts. */
function listMinted(d: Disclosure, xs: readonly ModelText[]): ModelText {
  if (xs.length <= 1) return xs[0] ?? d.own("");
  return d.t`${d.join(xs.slice(0, -1), ", ")} and ${xs[xs.length - 1] as ModelText}`;
}

/**
 * Names a routine: Jev's pick of code's candidates, asked at most twice, else code's own name. With Jev
 * off it is code's name at once. Never throws for a failed request; the failure is in `failures`.
 */
export async function nameRoutine(facts: RoutineFacts, ask: AskJev | null, windows: () => Iterable<WindowState>, rand: (n: number) => number = randomInt): Promise<NameResult> {
  const f = safeFacts(facts);
  const out: NameResult = { name: null, by: null, asks: 0, costUsd: 0, failures: [], requests: [] };
  for (let attempt = 0; ask !== null && attempt < 2; attempt++) {
    const built = namingRequest(f, windows(), attempt, rand);
    if (built === null) {
      out.failures.push("no candidate name could be sent");
      break;
    }
    out.requests.push(built.req);
    out.asks++;
    let answer: { choice: string; confidence: number } | undefined;
    try {
      const r = await ask(built.req);
      out.costUsd += r.costUsd;
      answer = r.answers.name;
    } catch (e) {
      out.failures.push(`Jev failed: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
      continue;
    }
    if (answer === undefined) {
      out.failures.push("Jev gave no answer to the name question");
      continue;
    }
    if (answer.choice === NONE) {
      out.failures.push("Jev chose none");
      continue;
    }
    const name = built.ids.get(answer.choice);
    if (name === undefined) {
      out.failures.push(`Jev chose ${answer.choice.slice(0, 20)}, which is not a candidate`);
      continue;
    }
    if (answer.confidence < NAME_CUTOFF) {
      out.failures.push(`Jev's pick has confidence ${answer.confidence.toFixed(2)}, under ${NAME_CUTOFF}`);
      continue;
    }
    const why = checkName(name, f);
    if (why !== null) {
      out.failures.push(why);
      continue;
    }
    return { ...out, name, by: "jev" };
  }
  const name = fallbackName(f);
  return { ...out, name, by: name === null ? null : "code" };
}

function shuffle<T>(xs: readonly T[], rand: (n: number) => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
