// When a field's text counts as the value Caret wrote (B29). One module, imported by the helper's executor and by the
// extension's content script (content/actions.ts), because a text control's value never leaves the page: the page
// answers "landed" and "equivalent" itself, and the helper judges native fields with the same rule. Both test suites
// run helper/fixtures/golden/equivalent.json against it, so the two sides cannot drift.
//
// The page decides which rule applies from the element itself (a number input, or a text input whose inputmode is
// numeric or decimal), so the helper cannot ask for a numeric comparison on a text field. No imports: the extension
// bundles this file into the content script.

/**
 * Whether `held` holds the value Caret wrote, `wrote`. Exactly, except in a numeric field, where both are compared as
 * plain decimal numbers, since a page may show "1" as "1.00". Never in a text field, and never across grouping
 * separators, signs of locale or units. The comparison is exact on the digits (canonicalDecimal), not through
 * Number(): review 1 found 9007199254740992 equal to 9007199254740993, 1e309 to 2e309 and 1e-999 to 0 that way, so
 * undo restored over the user's number.
 */
export function equivalentValue(numeric: boolean, held: string, wrote: string): boolean {
  if (held === wrote) return true;
  if (!numeric) return false;
  const a = canonicalDecimal(held);
  return a !== null && a === canonicalDecimal(wrote);
}

/** A decimal number as an input of type number holds one: optional sign, digits with at most one point, optional exponent. */
const PLAIN_NUMBER = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,6}))?$/;

/**
 * One spelling per number: "-123e-2" for -1.23, "0" for any zero. Digits keep every place, so two spellings match only
 * when they are the same number exactly. Null for anything PLAIN_NUMBER does not take, or one with no digit.
 */
export function canonicalDecimal(s: string): string | null {
  const m = PLAIN_NUMBER.exec(s);
  if (m === null) return null;
  const whole = m[2] ?? "";
  const frac = m[3] ?? "";
  if (whole === "" && frac === "") return null;
  let digits = (whole + frac).replace(/^0+/, "");
  if (digits === "") return "0";
  let exp = Number(m[4] ?? "0") - frac.length;
  const trailing = /0+$/.exec(digits)?.[0].length ?? 0;
  digits = digits.slice(0, digits.length - trailing);
  exp += trailing;
  return `${m[1] === "-" ? "-" : ""}${digits}e${exp}`;
}
