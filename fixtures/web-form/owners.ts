// G2: the ground truth page-loop-eval.ts's canned Jev answers fill's ownership questions from (owners.json, whose `about`
// says how it is written). Before G2 canned Jev answered every one "user" at 0.95, so a canned run could not see fill's
// ownership stage: live Jev vetoed four right values on the forty page and excluded six more that canned runs wrote
// (evidence/screen/g1/REPORT.txt).
import { existsSync, readFileSync } from "node:fs";

export interface Owners {
  user: string[];
  other: string[];
  /** Fields that ask for someone else's details: a task page's data-oracle names, a corpus or W4 form's labels. */
  otherFields: string[];
}

/** What canned Jev answers wherever owners.json says nothing (G2 brief: where the fixture can't say). */
export const UNCLEAR = { choice: "unclear", confidence: 0.5 } as const;
/** What it answers where owners.json says. */
export const KNOWN_CONFIDENCE = 0.95;

/** Reads an owners file; a missing one is an error when `required`, else no pages. Any malformed entry is an error. */
export function loadOwners(path: string, required: boolean): Record<string, Owners> {
  if (!existsSync(path)) {
    if (required) throw new Error(`no ownership truth at ${path} (G2: canned Jev answers ownership questions from it)`);
    return {};
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as { pages?: unknown };
  if (typeof raw.pages !== "object" || raw.pages === null) throw new Error(`${path} has no "pages" object`);
  const out: Record<string, Owners> = {};
  for (const [id, v] of Object.entries(raw.pages as Record<string, unknown>)) {
    const o = v as Partial<Record<keyof Owners, unknown>>;
    const list = (k: keyof Owners): string[] => {
      const x = o[k];
      if (!Array.isArray(x) || !x.every((s) => typeof s === "string" && s.trim() !== "")) throw new Error(`${path}: page ${id}'s "${k}" is not a list of non-empty strings`);
      return x as string[];
    };
    const extra = Object.keys(o).filter((k) => !["user", "other", "otherFields"].includes(k));
    if (extra.length > 0) throw new Error(`${path}: page ${id} has unknown keys ${extra.join(", ")}`);
    out[id] = { user: list("user"), other: list("other"), otherFields: list("otherFields") };
  }
  return out;
}

/** A page's owners with its memory entries added to the user's (what the user told Caret is theirs), or null when the file has no entry. */
export function ownersOf(truth: Readonly<Record<string, Owners>>, id: string, memory: readonly string[]): Owners | null {
  const o = truth[id];
  return o === undefined ? null : { ...o, user: [...o.user, ...memory] };
}

/** A character that continues a value (helper fill/candidates.ts holdsWhole's): a match must not sit inside a longer word or address. */
const VALUE_CHAR = /[\p{L}\p{N}@._%+\-/:]/u;

/** Whether `text` holds `value` as a whole token run, both lower-cased with runs of space made one. */
export function holdsWhole(text: string, value: string): boolean {
  const t = text.toLowerCase().replace(/\s+/gu, " ");
  const v = value.toLowerCase().replace(/\s+/gu, " ").trim();
  if (v === "") return false;
  for (let at = t.indexOf(v); at >= 0; at = t.indexOf(v, at + 1)) {
    const before = t[at - 1];
    const after = t[at + v.length];
    if ((before === undefined || !VALUE_CHAR.test(before)) && (after === undefined || !VALUE_CHAR.test(after))) return true;
  }
  return false;
}

/**
 * Whether a value text and a listed value are the same value, or one holds the other whole. A text under three
 * characters ("Jo") matches only as the whole text: inside a longer one it says nothing about whose that is.
 */
export function sameValue(text: string, listed: string): boolean {
  const a = text.trim();
  const b = listed.trim();
  if (a.toLowerCase() === b.toLowerCase()) return true;
  return (b.length >= 3 && holdsWhole(a, b)) || (a.length >= 3 && holdsWhole(b, a));
}

/** Whose a value text is: one side's when it matches values of that side only, else unclear (none, or both). */
export function ownerOfText(text: string, o: Owners): "user" | "other" | "unclear" {
  const user = o.user.some((v) => sameValue(text, v));
  const other = o.other.some((v) => sameValue(text, v));
  return user && !other ? "user" : other && !user ? "other" : "unclear";
}

/** The value an owner question is about: the first quoted text of its description (helper fill.ts describeCandidate, OWNER_WORDINGS). */
export function ownerQuestionText(instructions: string): string | null {
  return /"(.*?)" \(/su.exec(instructions)?.[1] ?? null;
}

/** Whether a question's answers are fill's ownership answers (helper fill.ts WHOSE_CRITERIA, OWNER_CRITERIA, personOwnerCriteria). */
export function ownershipAnswers(criteria: Readonly<Record<string, string | null>>): boolean {
  return "user" in criteria && "other" in criteria && "unclear" in criteria;
}

/**
 * Canned Jev's answer to whose a value is. An Ask that names a person asks whether the value is that person's;
 * owners.json does not say who that is, so only the user's own is answered there.
 */
export function valueOwnerAnswer(instructions: string, criteria: Readonly<Record<string, string | null>>, o: Owners | null): { choice: string; confidence: number } {
  const text = ownerQuestionText(instructions);
  const whose = text === null || o === null ? "unclear" : ownerOfText(text, o);
  if (whose === "unclear" || ("person" in criteria && whose === "other")) return { ...UNCLEAR };
  return { choice: whose, confidence: KNOWN_CONFIDENCE };
}

/**
 * Canned Jev's answer to whose details a field asks for, by the field's key name (`field`; null when the harness found
 * none): someone else's when owners.json lists it, else the user's, since every page's form is its own person's.
 * `same` compares a listed field with the key's (a task page's names exactly, a form's labels as the corpus normalizes them).
 */
export function fieldWhoseAnswer(field: string | null, o: Owners | null, same: (listed: string, field: string) => boolean): { choice: string; confidence: number } {
  if (field === null || o === null) return { ...UNCLEAR };
  return { choice: o.otherFields.some((x) => same(x, field)) ? "other" : "user", confidence: KNOWN_CONFIDENCE };
}
