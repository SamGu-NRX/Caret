// Preferences from reactions (plan section 4). When the user edits a value Caret filled, the edit
// becomes a typed memory entry, and every later fill applies the entries before it offers a value:
//
//   - the same phone number in another format: a format rule for phone numbers
//   - the filled name extended ("Dana" to "Dana Reyes"): a People entry
//   - anything else: an About-you entry holding the new value, and a rule that fields of this shape
//     which would get the old value get that entry instead. Editing the About-you entry changes the
//     next fill.
import { normalizeValue } from "../normalize.ts";
import type { ValueKind } from "../protocol.ts";
import { formatDigits, type MemoryStore } from "./memory.ts";
import type { Hash } from "./routines.ts";

export interface FilledField {
  /** The source text the fill started from, before memory rules changed it. Rules are keyed on it. */
  source: string;
  /** What Caret wrote. */
  written: string;
  /** What the field holds after the user's edit settled. */
  edited: string;
  kind: ValueKind | null;
  /** Keyed hash of the destination's app, window kind and template. */
  dstShapeHash: string;
  /** The field's label, for the sentence; "Field" when it has none. */
  fieldLabel: string;
  app: string;
}

export type Captured = { entry: "format" | "people" | "useInstead"; ids: string[] } | null;

/** Turns one settled edit of a filled value into memory. Returns what it wrote, or null for no rule. */
export function captureEdit(memory: MemoryStore, hash: Hash, f: FilledField, at: number): Captured {
  const written = f.written.trim();
  const edited = f.edited.trim();
  // A cleared field is an undo or a rejection, not a preference; "Don't offer this here" covers it.
  if (edited === "" || edited === written) return null;

  if (f.kind === "phone" && normalizeValue(written, "phone") === normalizeValue(edited, "phone")) {
    const template = edited.replace(/\d/g, "#");
    if (formatDigits(template, written) === null) return null;
    const id = memory.upsert("preference", "format:phone", { rule: "format", valueKind: "phone", template }, at, f.app);
    return { entry: "format", ids: [id] };
  }

  const source = f.source.trim();
  if (isName(source) && edited.toLowerCase().startsWith(`${source.toLowerCase()} `) && isName(edited)) {
    const id = memory.upsert("people", hash(`people\u0000${source.toLowerCase()}`), { alias: source, name: edited }, at, f.app);
    return { entry: "people", ids: [id] };
  }

  const aboutId = memory.upsert(
    "about",
    hash(`about\u0000${f.fieldLabel.toLowerCase()}\u0000${normalizeValue(edited, f.kind)}`),
    { label: f.fieldLabel, value: edited, source: "edit" },
    at,
    f.app,
  );
  // Keyed on the source text, so a second correction replaces the first instead of adding a rule that never matches.
  const prefId = memory.upsert("preference", useInsteadMatch(hash, f.dstShapeHash, source, f.kind), { rule: "useInstead", field: f.fieldLabel, aboutId }, at, f.app);
  return { entry: "useInstead", ids: [aboutId, prefId] };
}

/** Applies memory to a value about to be offered: people, then use-instead rules, then the phone format. */
export function applyMemory(memory: MemoryStore, hash: Hash, value: string, kind: ValueKind | null, dstShapeHash: string): { value: string; used: string[] } {
  const used: string[] = [];
  let v = value;

  const lower = v.trim().toLowerCase();
  const person = memory.active("people").find((p) => p.fields.alias.toLowerCase() === lower);
  if (person !== undefined) {
    v = person.fields.name;
    used.push(person.id);
  }

  const match = useInsteadMatch(hash, dstShapeHash, value, kind);
  for (const p of memory.active("preference")) {
    if (p.match !== match || p.fields.rule !== "useInstead") continue;
    const about = memory.about(p.fields.aboutId);
    if (about === null) continue;
    v = about.value;
    used.push(p.id, p.fields.aboutId);
    break;
  }

  if (kind === "phone") {
    const rule = memory.active("preference").find((p) => p.fields.rule === "format" && p.fields.valueKind === "phone");
    if (rule !== undefined && rule.fields.rule === "format") {
      const formatted = formatDigits(rule.fields.template, v);
      if (formatted !== null && formatted !== v) {
        v = formatted;
        used.push(rule.id);
      }
    }
  }
  return { value: v, used };
}

function useInsteadMatch(hash: Hash, dstShapeHash: string, from: string, kind: ValueKind | null): string {
  return hash(`useInstead\u0000${dstShapeHash}\u0000${normalizeValue(from.trim(), kind)}`);
}

/** One to four words of letters, as a person's name is. */
function isName(s: string): boolean {
  return /^[\p{L}][\p{L}'.-]*(?: [\p{L}][\p{L}'.-]*){0,3}$/u.test(s);
}
