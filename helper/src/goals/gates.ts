// The value gates every goal write passes before its preview (G2), the same gates an Ask's written plan passes
// (planner/codeplan.ts, planner/validate.ts):
//   - a field or value of a kind Caret never types (memory/sensitive.ts: card and account numbers, passwords, codes,
//     government IDs, API keys) is never written;
//   - the value's kind fits the field (fill/kinds.ts misfit, and numberFieldMisfit below);
//   - Jev confirms the value belongs in the field: Ask's question in both its wordings, both answers agreeing at
//     PLAN_CUTOFF, which is fill's FILL_CUTOFF, with fill's owner veto for a field that takes a person's details.
// A write that fails is dropped from the plan, and the preview says why in one sentence (lower.ts). Text Caret
// composed is checked by goals/drafts.ts instead of Jev's field question; its never-typed check is here.
//
// D2-06 lowered goal writes with misfit alone, which leaves every ID field unchecked, and never asked Jev, so M2's live
// qwen3.8 plan put the sender's email in Order number and the goal said "Done".
import type { AskJev } from "../fill/jev.ts";
import { fieldKinds, misfit, textKind } from "../fill/kinds.ts";
import { labelKind, SENSITIVE_SAYS } from "../memory/sensitive.ts";
import { verifyWrites } from "../planner/codeplan.ts";
import { secretIn } from "../planner/trace.ts";
import type { SnippetLedger } from "../privacy.ts";
import type { TargetBinding, ValueBinding } from "./plan.ts";

const clip = (s: string): string => {
  const t = s.replace(/\s+/gu, " ").trim();
  return t.length <= 60 ? t : `${t.slice(0, 59)}…`;
};

/**
 * A label that asks for a number or code by name ("Order number", "Invoice no.", "Ticket #", "Confirmation code").
 * misfit leaves ID words unchecked on purpose (B16 and B17 put links and order numbers in one "Reference" field), so
 * "Reference" alone is not one of these.
 */
const NUMBER_FIELD = /\b(?:number|no|num|nr|code)\b|#/u;

/**
 * Why a value does not fit a field that names a number or code and no other shape code can check, or null: an email
 * address or a web link is never a number or code. Written for M2's scene 1 ("Order number" took
 * priya.raman@northwind.example), not measured on real forms.
 */
export function numberFieldMisfit(value: string, label: string): string | null {
  // A label that also names a shape misfit checks ("Phone number", "Street number") is misfit's.
  if (!NUMBER_FIELD.test(label.toLowerCase()) || ![...fieldKinds([label])].every((k) => k === "id")) return null;
  const k = textKind(value);
  if (k !== "email" && k !== "url") return null;
  return `'${clip(value)}' is ${k === "email" ? "an email address" : "a web link"}, and the field takes a number or code`;
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
 *   - A copied value in a text field: misfit, and numberFieldMisfit.
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
  if (as === "event" || t.control !== "text") return null;
  return misfit(written, [t.label]) ?? numberFieldMisfit(written, t.label);
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
export async function jevGate(instruction: string, writes: readonly JevWrite[], askJev: AskJev | null, ledger: SnippetLedger): Promise<Map<string, string>> {
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
        return { key: w.ref, field: { name, label: name }, value: { display: shown(w), window: w.value.source?.windowId ?? null, owner: w.value.owner } };
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
