// The value gates every goal write passes before its preview (G2), the same gates an Ask's written plan passes
// (planner/codeplan.ts, planner/validate.ts):
//   - a field or value of a kind Caret never types (memory/sensitive.ts: card and account numbers, passwords, codes,
//     government IDs, API keys) is never written;
//   - the value's kind fits the field (fill/kinds.ts misfit, its number-field rule included);
//   - W2: a page write meets the write contract (fill/contract.ts checkValues, from lower.ts): code's checks and the
//     categorical verifier; jevGate then asks only fill's owner veto for a field that takes a person's details, and,
//     for a calendar event (no page write), whether it belongs there, both wordings agreeing at PLAN_CUTOFF.
// A write that fails is dropped from the plan, and the preview says why in one sentence (lower.ts). Text Caret
// composed is checked by goals/drafts.ts instead of Jev's field question; its never-typed check is here.
//
// D2-06 lowered goal writes with misfit alone, which leaves every ID field unchecked, and never asked Jev, so M2's live
// qwen3.8 plan put the sender's email in Order number and the goal said "Done".
//
// G3 (lead decision 1): a value the helper derived itself, with nothing left to choose, skips Jev's value question and
// keeps the code checks (see markDerived). G2's live probes had Jev under the 0.75 floor on exactly these values.
//
// P2 (plans/fast-browser.md, gate "fill"): a page plan's values were chosen by proposeFill itself, both wordings
// agreeing at FILL_CUTOFF with the owner veto, and minted by the write contract there (W2: the mint replaced the
// markFilled identity mark), so lowering passes the mint through and asks nothing again.
import type { Disclosure } from "../privacy/disclosure.ts";
import type { AskJev } from "../fill/jev.ts";
import { fieldKinds, NUMBER_FIELD } from "../fill/kinds.ts";
import { labelKind, SENSITIVE_SAYS } from "../memory/sensitive.ts";
import { verifyWrites } from "../planner/codeplan.ts";
import { secretIn } from "../planner/trace.ts";
import type { GoalStep, TargetBinding, ValueBinding } from "./plan.ts";

const clip = (s: string): string => {
  const t = s.replace(/\s+/gu, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 59)}…`;
};

/**
 * Objects the helper's own code built as derived values (G3): an event value inventory.ts eventsIn made from a
 * sentence's person and resolved time, and the To step lower.ts adds with the answered message's sender. Membership is
 * by object identity, so nothing that crosses the sandbox (a program's steps, drafts and refs are plain data, checked
 * by codemode/types.ts DoneMessage) and nothing copied (structuredClone, JSON) can carry the mark. A field such as
 * `origin.kind === "derived"` or a step ref would be data a value of the same shape could repeat.
 *
 * Evidence for the exemption: live Jev with fill's question confirmed b30-01's verified sender in To at 0.37 and the
 * D2-06 scene 2 event under the floor (evidence/screen/g2 jev-to-probe.txt, jev-scenes-probe.txt), though code had
 * already settled both values; lead decision 1 of G3.
 */
const derived = new WeakSet<object>();

/** Marks an object the helper built as a derived value, and returns it. Only helper code calls this. */
export function markDerived<T extends ValueBinding | GoalStep>(x: T): T {
  derived.add(x);
  return x;
}

/** Whether the helper itself built this value or step as derived (markDerived); a copy never is. */
export function isDerived(x: ValueBinding | GoalStep): boolean {
  return derived.has(x);
}

const WEEKDAY_OR_MONTH = /^(?:mon|tues?|wed|thu(?:rs)?|fri|sat|sun)(?:day|nesday|urday)?$|^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/u;
/** Days and times said relative to now, which only the value resolver could match to an event. */
const RELATIVE_TIME = /^(?:today|tonight|tomorrow|yesterday|week|weekend|month|morning|afternoon|evening|noon|midnight)$/u;
const I_FORMS = new Set(["i", "i'm", "i’m", "i've", "i’ve", "i'll", "i’ll", "i'd", "i’d"]);

/**
 * Whether the instruction picks out this event by nothing the event's own sentence lacks (G3 re-check): every name it
 * capitalizes inside a sentence ("Dana's", "Priya"), weekday or month, and number must be a word of the event's sentence
 * or title, and it may say no relative time ("tomorrow"). Quoted text is what to write, not which event, and is left
 * out; so are `ignore`, the words of the labels the goal's targets showed ("To", the calendar's name). Anything else
 * leaves the event to Jev's value question, as before G3. Written for the D2-06 and B30 instructions, not measured: a
 * name written in lower case ("add dana's meeting") is not seen, and the preview still names the event.
 */
export function eventAsAsked(instruction: string, event: { title: string; sentence: string }, ignore: ReadonlySet<string>): boolean {
  const has = new Set(`${event.sentence} ${event.title}`.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w !== ""));
  const unquoted = instruction.replace(/"[^"]*"|“[^”]*”/gu, " ");
  for (const sentence of unquoted.split(/[.!?;:]+\s+|\n+/u)) {
    const words = sentence.split(/\s+/u).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’]+$/gu, "")).filter((w) => w !== "");
    for (const [i, raw] of words.entries()) {
      const w = raw.replace(/['’]s$/u, "");
      const low = w.toLowerCase();
      if (RELATIVE_TIME.test(low)) return false;
      const named = (i > 0 && /^\p{Lu}/u.test(w) && !I_FORMS.has(raw.toLowerCase())) || WEEKDAY_OR_MONTH.test(low);
      if (named && !ignore.has(low) && !has.has(low)) return false;
      for (const n of w.match(/\d+/gu) ?? []) if (!has.has(n) && ![...has].some((h) => h.startsWith(n) && /^\d+[ap]m$/u.test(h))) return false;
    }
  }
  return true;
}

/**
 * Label words of a single-line field that takes free words. A draft goes in a text area whose own label names no shape
 * (an email, a link, a phone, a date, a time, an amount, an address), or in a text field whose own label has one of
 * these words and names no kind, number or name at all. The field's own label decides, never its section ("Contact
 * information" over Email). Written for common form labels, not measured: a field missed here only loses the draft
 * (dropped, and said in the preview).
 */
const PROSE_FIELD = /\b(?:message|body|description|describe|details|note|notes|comment|comments|reply|response|explanation|explain|problem|issue|reason|feedback|summary|question|questions|instructions|information|info|about|text)\b/iu;

/**
 * Why code drops a write before asking Jev, or null. `written` is what the control will hold: a text field's text, a
 * select's option label, a date, a draft, or an event's title. `as` says what kind of value it is.
 *   - Every write: a field Caret never types, and a value that is one (by its shape, or by its label in the instruction).
 *   - A copied value in a text field: misfit, whose number-field rule (fill/kinds.ts numberFieldMisfit) every fill shares.
 *   - A draft: only a field that takes free words, never one that names a shape, a name or a number.
 */
export function codeGate(t: TargetBinding, written: string, source: string, as: "copy" | "draft" | "event", instruction: string): string | null {
  const field = labelKind(t.label);
  if (field !== null) return `Caret never types ${SENSITIVE_SAYS[field]}; that is yours to enter`;
  // Both what is written and what it came from: a select's option can differ from its source in case, and either
  // may be the one the instruction labels ("my password hunter2" written as the option HUNTER2).
  const value = secretIn(written, instruction) ?? secretIn(source, instruction);
  if (value !== null) return `Caret never types ${SENSITIVE_SAYS[value]}; that is yours to enter`;
  if (as === "draft") {
    const kinds = fieldKinds([t.own]);
    const prose = t.role === "AXTextArea" ? ![...kinds].some((k) => k !== "id") : PROSE_FIELD.test(t.own) && kinds.size === 0 && !NUMBER_FIELD.test(t.own.toLowerCase()) && !/\bname\b/iu.test(t.own);
    return t.control === "text" && prose ? null : "Caret writes drafts only in a field for a message or a description";
  }
  // W2: a copied value's kind and shape are the write contract's (fill/contract.ts checkValues, from lower.ts), with the
  // field and provenance it carries; options, dates and events are minted under their named exemptions there.
  return null;
}

export interface JevWrite {
  /** The step's ref. */
  ref: string;
  target: TargetBinding;
  /** What the control will hold, and the value it came from: Jev is asked about the first, with the second as context. */
  written: string;
  value: ValueBinding;
  /**
   * For a To value code verified as the From address of the message the reply answers (lower.ts recipientCheck), that
   * message's title: Jev reads the value as that sender. Live Jev confirmed B30 case b30-01's sender for To at 0.37
   * from its plain display ("labelled 'From'") and at 0.93 and 0.96 when told it is the answered message's sender
   * (evidence/screen/g2/jev-to-probe.txt, one probe; fill's floor is 0.75).
   */
  senderOf?: string;
}

/** The value as Jev reads it: its display, or what is written with the display it came from when they differ. */
function shown(w: JevWrite): string {
  if (w.target.control === "calendar") return w.value.display;
  if (w.senderOf !== undefined) return `"${w.written}" (the sender of the message this reply answers: the From line of '${w.senderOf}')`;
  return w.written === w.value.text ? w.value.display : `"${w.written}" (written for ${w.value.display})`;
}

/**
 * The writes Jev does not confirm, by step ref, each with the sentence the preview shows. With no Jev, every write is
 * unconfirmed. Throws JevUnavailable when the request fails: code does not guess on Jev's behalf.
 */
export async function jevGate(instruction: string, writes: readonly JevWrite[], askJev: AskJev | null, ledger: Disclosure): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (writes.length === 0) return out;
  if (askJev === null) {
    for (const w of writes) out.set(w.ref, `Caret couldn't ask Jev whether '${clip(w.written)}' belongs there`);
    return out;
  }
  let dropped: Set<string>;
  try {
    dropped = await verifyWrites(
      instruction,
      writes.map((w) => {
        const name = w.target.control === "calendar" ? `the ${w.target.label} calendar` : w.target.label;
        // W2: a page write's exactness is the write contract's (lower.ts checkValues); only an event asks its value here.
        return { key: w.ref, field: { name, label: name }, value: { display: shown(w), window: w.value.source?.windowId ?? null, owner: w.value.owner }, askValue: w.target.control === "calendar" };
      }),
      askJev,
      ledger,
    );
  } catch (e) {
    throw new JevUnavailable(e instanceof Error ? e.message.slice(0, 200) : String(e));
  }
  for (const w of writes) if (dropped.has(w.ref)) out.set(w.ref, `Jev didn't confirm '${clip(w.written)}' belongs there`);
  return out;
}

export class JevUnavailable extends Error {}
