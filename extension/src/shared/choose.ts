// Option matching for the combobox handler (memo section 2): an option is picked only when exactly one option's
// normalized name equals the normalized value. Normalized means Unicode NFKC, lower case, whitespace collapsed and
// trimmed; nothing else, so "United States" never equals "United States Minor Outlying Islands" or "USA".

export function normalizeName(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export interface OptionMatch<T> {
  /** Options whose normalized name equals the value. */
  exact: T[];
  /** Options whose normalized name contains it, exact ones included. */
  partial: T[];
}

export function matchOptions<T extends { name: string }>(options: readonly T[], value: string): OptionMatch<T> {
  const want = normalizeName(value);
  if (want === "") return { exact: [], partial: [] };
  const exact = options.filter((o) => normalizeName(o.name) === want);
  const partial = options.filter((o) => normalizeName(o.name).includes(want));
  return { exact, partial };
}

/** Why a match does not pick, for the receipt, or null when it picks exactly one option. */
export function whyNoPick<T extends { name: string }>(m: OptionMatch<T>, value: string): string | null {
  if (m.exact.length === 1) return null;
  const quote = (xs: readonly T[]): string => xs.slice(0, 5).map((o) => `'${o.name}'`).join(", ") + (xs.length > 5 ? ` and ${xs.length - 5} more` : "");
  if (m.exact.length > 1) return `${m.exact.length} options are named '${value}': ${quote(m.exact)}; Caret cannot tell them apart, so you choose`;
  if (m.partial.length > 1) return `'${value}' matches ${m.partial.length} options: ${quote(m.partial)}; Caret picks only an option named exactly that, so you choose`;
  if (m.partial.length === 1) return `no option is named exactly '${value}'; the list offers ${quote(m.partial)}, so you choose`;
  return `no option in the list matches '${value}'`;
}

/**
 * Whether the handler types the filter before any list shows, when a press opened none: a text field that filters as
 * you type (aria-autocomplete anything but "none"). F1's School picker and Ashby's location open their list only once
 * the field holds text, and fetch its options from the server for that text.
 */
export function typesToOpen(textField: boolean, autocomplete: string | null): boolean {
  return textField && autocomplete !== "none";
}

/** One reading of a list: its enabled options' names, and whether the page says its results are still loading. */
export interface ListReading {
  names: readonly string[];
  busy: boolean;
}

/**
 * Whether `now` settles a list that queries as you type: its results are in (not loading, not empty) and read the same
 * as `prev`, the reading a settle before, which was not loading either. While it loads, a list may still show the
 * results of an earlier query (react-select async does once it has loaded one).
 */
export function settles(prev: ListReading | null, now: ListReading): boolean {
  if (prev === null || prev.busy || now.busy || now.names.length === 0) return false;
  return prev.names.length === now.names.length && prev.names.every((n, i) => n === now.names[i]);
}

/** What the handler read after a pick and a blur, for pickProblems. */
export interface PickState {
  flavor: "aria" | "reactSelect";
  /** The picked option's name. */
  value: string;
  before: string;
  afterBlur: string;
  hiddenInput: "set" | "unchanged" | "none";
  expanded: boolean | null;
  /** Caret typed the value as the filter into the control's own text field, so for an ARIA combobox the text it shows proves nothing. */
  typedText: boolean;
  /** The list closed, or the control said aria-expanded=false, on the press of the option, before any Escape of Caret's. */
  closedOnPick: boolean;
}

/** Whitespace collapsed and trimmed, then cut to `max` characters, as content/names.ts clean() does. */
function clip(t: string, max: number): string {
  const c = t.replace(/\s+/g, " ").trim();
  return c.length <= max ? c : `${c.slice(0, max - 1)}…`;
}

/** Why a pick is not verified, each as a clause for the receipt; empty when it is. */
export function pickProblems(s: PickState): string[] {
  const out: string[] = [];
  if (normalizeName(s.afterBlur) !== normalizeName(s.value)) out.push(s.afterBlur === s.before ? "the control kept its old value" : `the control shows '${clip(s.afterBlur, 60)}'`);
  if (s.hiddenInput === "unchanged") out.push("react-select's form value did not change");
  if (s.expanded === true) out.push("the list is still open");
  // An ARIA combobox's text field shows the typed filter whether or not the page took the option: only the list
  // closing on the press shows it did. React-select's chip, and text Caret did not type, are set only by a pick.
  if (s.flavor === "aria" && s.typedText && !s.closedOnPick) out.push("the list stayed open after the option was pressed, so the text the control shows may be only the filter Caret typed");
  return out;
}

/**
 * React-select's hidden form input after a stop, against what it held before Caret touched the control: any change
 * reads as set, so a stop that moved the form value is never reported as put back.
 */
export function hiddenAfterStop(before: string | null, now: string | null): "set" | "unchanged" | "none" {
  if (now === null) return "none";
  return now === before ? "unchanged" : "set";
}
