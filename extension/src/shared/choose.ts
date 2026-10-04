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
