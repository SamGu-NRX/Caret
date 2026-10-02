// Value normalization for matching a value seen in one window against text in another.
// People reformat values as they copy them, so exact matching undercounts; each kind gets
// the narrowest normalization that still treats two spellings of the same value as equal.
import type { ValueKind } from "./protocol.ts";

export type MatchKind = "exact" | "normalized";

const collapse = (s: string): string => s.normalize("NFKC").replace(/\s+/g, " ").trim();

export function normalizeValue(text: string, kind: ValueKind | null): string {
  const base = collapse(text);
  switch (kind) {
    case "phone": {
      const digits = base.replace(/\D/g, "");
      // Compare national numbers: "+1 512 555 0142" and "(512) 555-0142" are the same phone.
      return digits.length > 10 ? digits.slice(-10) : digits;
    }
    case "email":
      return base.toLowerCase().replace(/^mailto:/, "");
    case "url":
      return base
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/+$/, "");
    case "amount":
      return base.replace(/[^\d.]/g, "").replace(/\.0+$/, "");
    default:
      return base
        .toLowerCase()
        .replace(/^[\s"'“”‘’([{<]+|[\s"'“”‘’)\]}>.,;:!?]+$/g, "")
        .replace(/\s*([,.-])\s*/g, "$1");
  }
}

const isWordChar = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/**
 * True when `needle` occurs in `haystack` with no letter or digit directly before or after it,
 * so "Dana W" does not match inside "Dana Whitfield" while "ORD-48213" matches in "Order ORD-48213 placed".
 */
export function containsBounded(haystack: string, needle: string): boolean {
  if (needle.length === 0) return false;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    if (!isWordChar(haystack[i - 1]) && !isWordChar(haystack[i + needle.length])) return true;
    from = i + 1;
  }
}

/** Inserted text between two versions of a field value, by common prefix and suffix. */
export function insertedText(before: string, after: string): string {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return after.slice(p, after.length - s);
}
