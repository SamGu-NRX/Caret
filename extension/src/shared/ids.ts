// Strong keys (memo section 1, identity layer 2): an identifier the page author chose survives a re-render that
// replaces the node, so it may rebind a target when exactly one connected element carries it with the same kind,
// name and expected value. A machine-generated identifier is no identity at all, so it never makes a strong key.

/**
 * Identifiers frameworks generate. React useId (":r1:", "«r1»" in React 19), MUI, react-select, Radix, Headless UI
 * and Ember come from the memo; the last two catch long hex or digit runs, which read as hashes or counters.
 */
const GENERATED: readonly RegExp[] = [
  /:r[0-9a-z]+:/i,
  /«r[0-9a-z]+»/i,
  /^mui-\d+/i,
  /^react-select-\d+-/i,
  /^radix-/i,
  /^headlessui-/i,
  /^ember\d+$/i,
  /[0-9a-f]{12,}/i,
  /\d{6,}/,
];

export function isGeneratedId(id: string): boolean {
  return id.trim() === "" || GENERATED.some((re) => re.test(id));
}

/** The first author-chosen identifier of name, id and data-automation-id, as `attr=value`, or null. */
export function authorIdentifier(attrs: { name?: string | null; id?: string | null; automationId?: string | null }): string | null {
  for (const [attr, value] of [["name", attrs.name], ["id", attrs.id], ["data-automation-id", attrs.automationId]] as const) {
    if (value !== null && value !== undefined && !isGeneratedId(value)) return `${attr}=${value}`;
  }
  return null;
}

/**
 * (origin, form, identifier, kind) as a JSON array, or null without an author-chosen identifier. JSON, not a joined
 * string: the parts are page-controlled, and "a|b" + "c" must not equal "a" + "b|c" (W1 review #7).
 */
export function strongKey(origin: string, form: string | null, ident: string | null, kind: string): string | null {
  return ident === null ? null : JSON.stringify([origin, form, ident, kind]);
}
