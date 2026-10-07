// W1: W1's text-shape gate on whether a value may be written into a field. Since W2 it runs in one place, the write
// contract (fill/contract.ts textShapeRefusal, which every write path's checkValues calls with the value's carried
// field and provenance); the planner's offer of values to a field (planner/planner.ts) still uses it to choose what to
// offer, which admits nothing. Before W1 each path called kinds.ts misfit alone; live Jev then wrote values misfit
// passes (evidence/screen/lv1): a whole note line holding the right job title, a role at the right company, and an
// instruction to the user. AC1 (migration step 4) retires its families one at a time on verifier evidence.
import type { Node } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import { fieldKinds, fieldTerms, misfit, NAME_TERM } from "./kinds.ts";
import { fieldPart, splitName, splitPlace, type FillPart } from "./derive.ts";
import { describeField } from "./descriptor.ts";
import { instructionText, questionAnswer, severalValues } from "./line-values.ts";

/**
 * The field a value would go in: its label words (own label, nearest label, placeholder), and the part of a name or an
 * address it takes when the caller read one (fill.ts Field.part; partIn), which a label alone can not say: "Address" on
 * a form with a City field takes the street line.
 */
export interface WriteField {
  labelWords: readonly (string | null | undefined)[];
  part?: FillPart | null;
}

/** The part of a name or an address a field of a window takes, as fill reads it: "Address" is the street line beside a City field. */
export function partIn(w: WindowState, node: Node): FillPart | null {
  const label = describeField(w, node).label;
  const hasCity = [...w.nodes.values()].some((n) => n.editable === true && (n.role === "AXTextField" || n.role === "AXComboBox") && fieldPart(describeField(w, n).label, false) === "city");
  return fieldPart(label, hasCity);
}

/**
 * Where a value came from, as far as it says what the value is: the label of the "Label: value" line it was read from,
 * or of the memory entry; null when nothing labels it (a plain line, an instruction's literal, a value code joined).
 */
export interface WriteSource {
  label: string | null;
}

const clip = (v: string): string => (v.length <= 60 ? v : `${v.slice(0, 59)}…`);
const joined = (labelWords: readonly (string | null | undefined)[]): string => labelWords.filter((w): w is string => typeof w === "string").join(" ");
const ownLabel = (labelWords: readonly (string | null | undefined)[]): string | null => labelWords.find((w): w is string => typeof w === "string" && w.trim() !== "") ?? null;

/**
 * Whether a field takes one value: a kind its label names (an email, a phone, a date, an amount, an address, an ID), a
 * name, a company, a title or a role (kinds.ts NAME_TERM), or a part of a name or an address (derive.ts fieldPart). A
 * field for prose (a reason, a message, a description, delivery instructions) names none of these.
 */
export function takesOneValue(labelWords: readonly (string | null | undefined)[]): boolean {
  return fieldKinds(labelWords).size > 0 || fieldTerms(labelWords).has(NAME_TERM) || fieldPart(ownLabel(labelWords)) !== null;
}

/** A field that asks for instructions to someone else, which an imperative is: "Delivery instructions", "Directions". */
const ASKS_INSTRUCTIONS = /\b(?:instructions?|directions?|delivery|special requests?)\b/iu;
/** Source labels that name a part of a name, by the part. */
const PART_LABEL: Record<"first" | "middle" | "last", RegExp> = {
  first: /\b(?:first|given|forename)\b/iu,
  middle: /\bmiddle\b/iu,
  last: /\b(?:last|surname|family)\b/iu,
};
const PREFERRED = /\b(?:preferred|nickname|goes by|call (?:you|me))\b/iu;
/** A file's name: one word ending in a document's or an image's extension ("dmitri-halvorsen-firmware.pdf"). */
const FILE_NAME = /^[\w.-]+\.(?:pdf|docx?|txt|rtf|odt|pages|png|jpe?g|gif|heic|zip|csv|xlsx?|key|pptx?)$/iu;
const ASKS_FILE = /\b(?:file|resume|résumé|cv|attachment|document|upload|portfolio)\b/iu;

/**
 * Why `value` may not be written into a field with these label words, or null. `source` says what labels the value.
 *   - misfit's checks of kind and shape (kinds.ts).
 *   - A question and its answer on one line ("What are your salary expectations?: $185,000") is a label and a value.
 *   - An instruction to the user (line-values.ts instructionText) is no value, except in a field that asks for
 *     instructions to someone else.
 *   - A field that takes one value (takesOneValue) takes no text whose own structure holds several (line-values.ts
 *     severalValues): a role and an employer, money beside a name, two people.
 *   - A field that takes one value takes no file's name ("dmitri-halvorsen-firmware.pdf" went into F1's First Name in
 *     the guard adversary's Ask run), unless it asks for a file.
 *   - A street line holds no comma: the Ask path wrote "1907 Alameda de las Pulgas, apt 12" into an Address field that
 *     reads as the street (the form has City and Apartment fields; key "1907 Alameda de las Pulgas").
 *   - A City field takes no place with its region ("Austin, Texas"), unless it asks where the user is ("Location
 *     (City)", whose options are "City, Region, Country"). The guard adversary wrote "Austin, Texas" into City.
 *   - A first, middle or last name field takes a value with a space in it only when its source labels it as that part
 *     ("First name: Mary Ann", "Last name: García Márquez"); a value its source labels as a whole name, or that nothing
 *     labels and that reads as a first and a last name, is a whole name. The guard adversary (scripts/guard-adversary.ts)
 *     wrote "Elena Marisol Vance" into First, Middle and Last name; 41 of its 51 wrong values at 8801642 were a name in
 *     one of its parts. An unlabelled "Mary Ann" in First name is refused too: a blank, never a wrong value.
 *   - A preferred name takes a whole name only when its source labels it preferred: F1's Preferred name took "Jo
 *     Abernathy-Cole" from a mail's header, and its key is "Jo".
 */
export function writeMisfit(value: string, field: WriteField, source: WriteSource | null = null): string | null {
  const { labelWords } = field;
  const kind = misfit(value, labelWords);
  if (kind !== null) return kind;
  const v = value.trim();
  if (questionAnswer(v)) return `'${clip(v)}' is a question with its answer, not a value`;
  const label = joined(labelWords);
  if (instructionText(v) && !ASKS_INSTRUCTIONS.test(label)) return `'${clip(v)}' tells the user what to do; it is not a value`;
  const one = takesOneValue(labelWords) || (field.part ?? null) !== null;
  if (one && severalValues(v) !== null) return `'${clip(v)}' holds more than one value, and the field takes one`;
  if (one && FILE_NAME.test(v) && !ASKS_FILE.test(label)) return `'${clip(v)}' is a file's name, and the field does not ask for a file`;
  const part = field.part === undefined ? fieldPart(ownLabel(labelWords)) : field.part;
  if (part === "street" && v.includes(",")) return `'${clip(v)}' is a street line with more after it, and the field takes the street line`;
  if (part === "city" && !/\b(?:location|where)\b/iu.test(label) && (splitPlace(v)?.state ?? null) !== null) return `'${clip(v)}' is a city with its region, and the field takes the city`;
  const from = source?.label ?? null;
  if ((part === "first" || part === "middle" || part === "last") && /\s/u.test(v)) {
    const named = from !== null && PART_LABEL[part].test(from);
    if (!named && (from !== null || splitName(v).kind === "split")) return `'${clip(v)}' is a whole name, and the field takes the ${part} name`;
  }
  if (part === "full" && PREFERRED.test(label) && !/\b(?:full|legal)\b/iu.test(label) && splitName(v).kind === "split" && (from === null || !PREFERRED.test(from))) return `'${clip(v)}' is a whole name, and the field takes the name the user goes by`;
  return null;
}
