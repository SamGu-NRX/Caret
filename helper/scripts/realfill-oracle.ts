// The scripted oracle the Ask scoreboard runs as its canned engine (realfill-asks.ts --engine canned), shared with the
// tests that replay B31 on the same desks (test/vs1-kit.ts). A3: its route head fills (a must-refuse ask's head refuses or
// plans by the ask's reason), its scope ask answers "asks" for exactly the expected fields and "not" for the rest, it
// confirms exactly the expected fields, and it answers each value question with the ask's expected value for that field,
// else the value corpus.json expects for a whole-form fill. So any field outside the ask's expected fields that the Ask
// still puts in scope gets a value and scores wrong: it measures what code does with a perfect scope answer, not how a
// real model scores.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import type { FillTrace } from "../src/fill/fill.ts";
import { cannedReply } from "../src/engines/decide/canned.ts";
import { normLabel, type Corpus, type CorpusAsk } from "./realfill-corpus.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** SCP1: the section each ask's instruction names, hand-labelled (ask-section-labels.json), for the oracle's section question. */
const SECTION_LABELS = (JSON.parse(readFileSync(join(here, "ask-section-labels.json"), "utf8")) as { labels: Record<string, string> }).labels;

type Question = JevRequest["questions"][string];
type Answer = { choice: string; confidence: number };

/** What the oracle reads of the run it answers for: the Ask in progress and fill's records of what it asked. */
export interface OracleContext {
  asks: readonly CorpusAsk[];
  corpus: Corpus;
  /** The Ask being answered ("b31-07", or "b31-07+pick" after a simulated pick). */
  current: () => string;
  /** Fill's record of each proposal the current Ask made (FillTrace). */
  traces: () => readonly FillTrace[];
  /** The current Ask's form: field keys to corpus labels. */
  corpusLabel: () => ReadonlyMap<string, string>;
}

const PROPOSED = /^Proposed value: "([\s\S]*?)"\. Source: /u;

/** Whether a criterion is value settlement's (it states an exact proposed output), not the base question's candidate. */
export const settlementCriterion = (criterion: unknown): boolean => typeof criterion === "string" && PROPOSED.test(criterion);

/** A value question's option as the oracle reads it: value settlement's exact proposed output, else the candidate's traced text. */
export function oracleOptionText(trace: FillTrace | undefined, fieldId: string, optionId: string, criterion: string): string {
  const quoted = PROPOSED.exec(criterion)?.[1] ?? /^"([^"]*)"/u.exec(criterion)?.[1] ?? criterion;
  if (trace === undefined) return quoted;
  const exact = settlementCriterion(criterion) ? trace.outputs?.get(fieldId)?.get(optionId) : undefined;
  return exact ?? trace.options.get(optionId)?.text ?? quoted;
}

/** Whether a candidate's text is the value: the same words, the same day, or the same clock time. */
export function sameValue(text: string, v: string): boolean {
  const flat = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (flat(text) === flat(v) && flat(v) !== "") return true;
  // A day as written in a source, its weekday and clock time dropped, in the value's year when it gives none.
  const day = (x: string, year: string | null): string | null => {
    const bare = x.replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s*/iu, "").replace(/\s+at\s+.*$|,?\s+\d{1,2}:\d{2}.*$/iu, "");
    const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/u.test(bare) ? `${bare}T00:00:00` : /\d{4}/u.test(bare) || year === null ? bare : `${bare}, ${year}`);
    return Number.isNaN(t) ? null : new Date(t).toDateString();
  };
  const clock = (x: string): string | null => {
    const m = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b\.?|^(\d{1,2}):(\d{2})$/iu.exec(x.trim());
    if (m === null) return null;
    if (m[4] !== undefined) return `${Number(m[4])}:${m[5]}`;
    return `${(Number(m[1]) % 12) + (m[3]?.toLowerCase() === "p" ? 12 : 0)}:${m[2] ?? "00"}`;
  };
  const year = /^(\d{4})-/u.exec(v)?.[1] ?? null;
  return (year !== null && day(text, year) !== null && day(text, year) === day(v, null)) || (/^\d{1,2}:\d{2}$/u.test(v) && clock(text) !== null && (clock(text) === clock(v) || (!/[ap]\.?m/iu.test(text) && clock(`${text} pm`) === clock(v))));
}

/** The oracle as an AskJev. */
export function realfillOracle(ctx: OracleContext): AskJev {
  return async (req) => {
    const current = ctx.current();
    const ask = ctx.asks.find((x) => x.id === current.replace(/\+pick$/u, ""));
    const form = ctx.corpus.forms.find((f) => f.id === ask?.form);
    const want = ask === undefined || ask.expected === "refuse" ? {} : ask.expected;
    const valueOf = (label: string): string | null => {
      const n = normLabel(label);
      const own = Object.entries(want).find(([l]) => normLabel(l) === n)?.[1];
      if (own !== undefined) return own;
      return form?.fields.find((f) => normLabel(f.label) === n)?.expected ?? null;
    };
    const wholeForm = new Set((form?.fields ?? []).map((f) => f.expected));
    const theirs = new Set(Object.entries(want).filter(([l, v]) => form?.fields.find((f) => normLabel(f.label) === normLabel(l))?.expected !== v).map(([, v]) => v));
    const wanted = (label: string): boolean => Object.keys(want).some((l) => normLabel(l) === normLabel(label) && want[l] !== "none");
    // A question fill sent names its field and its options in fill's own record (FillTrace), never parsed from its text
    // (I2: "Guest's full name" was cut at its apostrophe, so held-12's value question answered none). Other questions (the
    // planner's, Ask's confirmations) name a field as 'label' followed by punctuation, a space or the end, so a label may
    // hold an apostrophe.
    const trace = ctx.traces().find((t) => t.owns(req));
    const labelIn = (ins: string): string | null => /(?:Label|field): '(.+?)'(?=[.,;:?)]|\s|$)|[Tt]he field '(.+?)'(?=[.,;:?)]|\s|$)|fill or change '(.+?)'(?=[.,;:?)]|\s|$)/u.exec(ins)?.slice(1).find((x) => x !== undefined) ?? null;
    /** The corpus label of the field a fill question (`f3`, `f3_whose`, `f3_answer`) is about, from the trace; else from the text. */
    const labelOf = (id: string, ins: string): string | null => {
      // A saved-answer question (fill.values `f3_answer`) is only ever fill's: one with no trace is a request the oracle
      // cannot map, said loudly rather than answered none.
      if (trace === undefined && id.endsWith("_answer")) throw new Error(`the oracle got saved-answer question ${id} in a request fill's trace does not own`);
      if (trace === undefined) return labelIn(ins);
      const f = trace.fields.find((x) => x.id === id.replace(/_(?:whose|answer)$/u, ""));
      if (f === undefined) throw new Error(`the oracle got fill question ${id}, which fill's trace does not list`);
      return ctx.corpusLabel().get(f.key) ?? f.name;
    };
    const answers: Record<string, Answer> = {};
    const answer = (id: string, q: Question): Answer => {
      const keys = Object.keys(q.criteria);
      const ins = String(q.instructions);
      const pick = (k: string): void => {
        answers[id] = { choice: keys.includes(k) ? k : (keys.at(-1) ?? "none"), confidence: 0.99 };
      };
      // A must-refuse ask's head refuses with its reason, or plans a press, as a model that recognises refusals would.
      // A fill route is the whole form when the ask expects a value for every field of it.
      if (id === "route") pick(ask?.reason === "submit" || ask?.reason === "send" ? "plan" : ask?.expected === "refuse" && ask.reason !== undefined ? "refuse" : form !== undefined && form.fields.every((f) => wanted(f.label)) ? "all" : "some");
      // SCP1: the section question, by the hand label of the section the instruction names (ask-section-labels.json): that
      // heading's option, else the whole form when the ask expects every field of it, else particular fields.
      else if (id === "section") {
        const label = SECTION_LABELS[ask?.id ?? ""];
        // The reader shows some headings in capitals ("EMERGENCY CONTACT"), so the label is matched without case.
        const named = label === undefined ? undefined : Object.entries(q.criteria).find(([k, d]) => k.startsWith("sec") && d?.toLowerCase().includes(`'${label.toLowerCase()}'`) === true)?.[0];
        pick(named ?? (form !== undefined && form.fields.every((f) => wanted(f.label)) ? "whole" : "fields"));
      }
      // The scope ask's label, which may hold an apostrophe ("Guest's full name"), ends where the wording goes on.
      else if (id.startsWith("s_") && "asks" in q.criteria) pick(wanted(/Field: "(.*?)"\. Control: "/u.exec(ins)?.[1] ?? "") ? "asks" : "not");
      else if (id === "why") pick(ask?.reason === "payment" ? "payment" : ask?.reason === "neverTyped" ? "neverTyped" : ask?.reason === "noSuchField" ? "noSuchField" : "nothingToFill");
      else if (id === "source") pick("any");
      else if (id === "whose") pick("user");
      else if (id.endsWith("_whose")) {
        // A field the ask fills with someone else's value (not the whole-form one) wants that person's details.
        const label = labelOf(id, ins);
        const v = label === null ? null : valueOf(label);
        pick((v !== null && theirs.has(v)) || /\b(?:landlord|reference|emergency|guest|referr|relationship|recipient)/iu.test(label ?? "") ? "other" : "user");
      } else if (id.endsWith("_owner")) {
        const text = trace?.options.get(id.replace(/_owner$/u, ""))?.text ?? /"([^"]*)"/u.exec(ins)?.[1] ?? "";
        // A value the ask expects for someone else's field is that person's; any other whole-form value is the user's.
        const forOther = Object.entries(want).some(([l, v]) => sameValue(text, v) && (theirs.has(v) || /\b(?:landlord|reference|emergency|guest|referr|relationship|recipient)/iu.test(l)));
        const mine = forOther ? (keys.includes("person") ? "person" : "other") : [...wholeForm].some((v) => sameValue(text, v)) ? "user" : "unclear";
        pick(mine);
      } else if ("yes" in q.criteria) pick(id === "all" ? "no" : wanted(labelIn(ins) ?? "") ? "yes" : "no");
      else {
        const label = labelOf(id, ins);
        const v = label === null ? null : valueOf(label);
        const hit = v === null || v === "none" ? undefined : Object.entries(q.criteria).find(([k, d]) => typeof d === "string" && (sameValue(oracleOptionText(trace, id, k, d), v) || d === v));
        // The planner's target questions (an Ask that asks for a press): the press the must-refuse ask names.
        const press = ask?.reason === "submit" || ask?.reason === "send" ? Object.entries(q.criteria).find(([, d]) => typeof d === "string" && new RegExp(`\\b${ask.reason}\\b`, "iu").test(d)) : undefined;
        pick(hit?.[0] ?? press?.[0] ?? "none");
      }
      return answers[id] as Answer;
    };
    // W1: every kind of question the oracle answers, each by the rule above for its id; any other kind throws
    // (engines/decide/canned.ts), so a question a later batch adds is never answered by silence. A3: the heads ask route,
    // why, source and whose, and the scope ask (ask.scope) settles fields; the writer maker's field yes/no heads say no.
    const kinds = [
      ...["route", "why", "source", "whose"].map((h) => `ask.heads:${h}`),
      "ask.scope:field", "ask.scope:section",
      ...["route", "why", "scope", "source", "whose", "literal"].map((h) => `intent.route:${h}`),
      "ask.confirm:all", "ask.confirm:field", "codeplan.asksAbout:field",
      "fill.whose:whose", "fill.whose:owner", "fill.values:whose", "fill.values:owner", "fill.values:value", "fill.values:answer",
      "plan.verify:value", "plan.verify:whose", "plan.verify:owner", "planner.window:window", "planner.fields:field", "planner.fields:press",
    ];
    const r = await cannedReply(req, {
      model: "oracle",
      confidence: 0.99,
      // W2: the write contract's verifier calls every oracle pick, the key's value, exact.
      choice: { ...Object.fromEntries(kinds.map((k) => [k, (q: Question, id: string) => answer(id, q)])), "fill.verify:verdict": () => "exact" },
      noul: Object.fromEntries(["intent.fields:field", "intent.fields:tie"].map((k) => [k, () => 0.01])),
    });
    return { ...r, nouls: r.nouls ?? {} };
  };
}
