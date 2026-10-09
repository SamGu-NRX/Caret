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

/** W1's text-shape families, in the order AC1 section 6 retires them. */
export type ShapeFamily = "namePartSpace" | "preferredName" | "severalValues" | "instructionText" | "questionAnswer" | "fileName" | "streetCity" | "partIntoProse";
export const SHAPE_FAMILIES: readonly ShapeFamily[] = ["namePartSpace", "preferredName", "severalValues", "instructionText", "questionAnswer", "fileName", "streetCity", "partIntoProse"];

/**
 * Families no longer part of the gate (AC1 section 6, migration step 4). A family is retired only when the verifier
 * eval (scripts/verifier-eval.ts on fixtures/verify/dev.json, three live passes) minted none of the wrong cases the
 * family refuses; each entry names that evidence. Retired families' code stays where it generates candidates
 * (line-values.ts valueParts).
 */
export const RETIRED_FAMILIES: ReadonlySet<ShapeFamily> = new Set<ShapeFamily>([
  // Evidence for every family (evidence/screen/w2/verify-eval-3, three live passes on the 371-case dev set, the table
  // "W1's text-shape families"): of the wrong cases each family refuses (namePartSpace 25, preferredName 1, severalValues
  // 21, instructionText 4, questionAnswer 3, fileName 2, streetCity 10, partIntoProse 2), the verifier minted none in
  // any pass. The dev set's right cases they refuse (severalValues 2, instructionText 2: REVIEW-R2's "Senior Engineer at
  // Lumen Labs", "Use the side door", "García Márquez, Juan", "Use The Force Labs") the verifier also refused, so it
  // recovers none of them there.
  ...SHAPE_FAMILIES,
]);

/** What labels a value, for the families that read it: its "Label: value" label, and the labelled value it was cut from. */
export interface ShapeSource {
  label: string | null;
  partOf?: string | null;
}

/**
 * Why one family refuses `value` in this field, or null. Each family's rule, as W1 wrote it:
 *   - questionAnswer: a question and its answer on one line ("What are your salary expectations?: $185,000").
 *   - instructionText: an instruction to the user (line-values.ts instructionText), except in a field that asks for
 *     instructions to someone else.
 *   - severalValues: a field that takes one value takes no text whose own structure holds several (line-values.ts
 *     severalValues): a role and an employer, money beside a name, two people.
 *   - fileName: a field that takes one value takes no file's name ("dmitri-halvorsen-firmware.pdf" went into F1's First
 *     Name in the guard adversary's Ask run), unless it asks for a file.
 *   - streetCity: a street line holds no comma ("1907 Alameda de las Pulgas, apt 12" into an Address that reads as the
 *     street); a City field takes no place with its region ("Austin, Texas"), unless it asks where the user is.
 *   - namePartSpace: a first, middle or last name field takes a value with a space only when its source labels it as
 *     that part ("First name: Mary Ann"); 41 of the adversary's 51 wrong values at 8801642 were a name in one of its parts.
 *   - preferredName: a preferred name takes a whole name only when its source labels it preferred (F1's Preferred name
 *     took "Jo Abernathy-Cole" from a mail's header; its key is "Jo").
 *   - partIntoProse: a part of a labelled value (Candidate.partOf) goes only in a field that takes one value: in a prose
 *     field ("Delivery instructions") it is no complete answer ("ring twice" from "Reception Desk, ring twice").
 */
export function familyRefusal(family: ShapeFamily, value: string, field: WriteField, source: ShapeSource | null = null): string | null {
  const { labelWords } = field;
  const v = value.trim();
  const label = joined(labelWords);
  const one = takesOneValue(labelWords) || (field.part ?? null) !== null;
  const part = field.part === undefined ? fieldPart(ownLabel(labelWords)) : field.part;
  const from = source?.label ?? null;
  switch (family) {
    case "questionAnswer":
      return questionAnswer(v) ? `'${clip(v)}' is a question with its answer, not a value` : null;
    case "instructionText":
      return instructionText(v) && !ASKS_INSTRUCTIONS.test(label) ? `'${clip(v)}' tells the user what to do; it is not a value` : null;
    case "severalValues":
      return one && severalValues(v) !== null ? `'${clip(v)}' holds more than one value, and the field takes one` : null;
    case "fileName":
      return one && FILE_NAME.test(v) && !ASKS_FILE.test(label) ? `'${clip(v)}' is a file's name, and the field does not ask for a file` : null;
    case "streetCity":
      if (part === "street" && v.includes(",")) return `'${clip(v)}' is a street line with more after it, and the field takes the street line`;
      if (part === "city" && !/\b(?:location|where)\b/iu.test(label) && (splitPlace(v)?.state ?? null) !== null) return `'${clip(v)}' is a city with its region, and the field takes the city`;
      return null;
    case "namePartSpace":
      if ((part === "first" || part === "middle" || part === "last") && /\s/u.test(v)) {
        const named = from !== null && PART_LABEL[part].test(from);
        if (!named && (from !== null || splitName(v).kind === "split")) return `'${clip(v)}' is a whole name, and the field takes the ${part} name`;
      }
      return null;
    case "preferredName":
      return part === "full" && PREFERRED.test(label) && !/\b(?:full|legal)\b/iu.test(label) && splitName(v).kind === "split" && (from === null || !PREFERRED.test(from)) ? `'${clip(v)}' is a whole name, and the field takes the name the user goes by` : null;
    case "partIntoProse":
      return (source?.partOf ?? null) !== null && !takesOneValue(labelWords) ? `'${clip(v)}' is part of '${clip(source?.partOf ?? "")}', and the field asks for more than one value` : null;
  }
}

/**
 * Why `value` may not be written into a field with these label words, or null: kinds.ts misfit's checks of kind and
 * shape, then every family not retired (familyRefusal), in W1's order. `source` says what labels the value.
 */
export function writeMisfit(value: string, field: WriteField, source: ShapeSource | null = null): string | null {
  const kind = misfit(value, field.labelWords);
  if (kind !== null) return kind;
  for (const f of ["questionAnswer", "instructionText", "severalValues", "fileName", "streetCity", "namePartSpace", "preferredName", "partIntoProse"] as const) {
    if (RETIRED_FAMILIES.has(f)) continue;
    const why = familyRefusal(f, value, field, source);
    if (why !== null) return why;
  }
  return null;
}
