// SC1 section 2a: what Caret never carries, decided when a window is read in (ScreenModel.apply), so no reader of the
// model, raw or redacted, ever sees it. Exclusions act on nodes and values, never on lines of prose:
// - a node whose declared purpose is secret (a secure field, a page control the walker marks, an editable control whose
//   own label, placeholder or containing group names a sensitive kind) keeps its role, key, frame and label, gains
//   `excluded`, and loses its value;
// - a value in a known secret format, wherever it stands (a key pasted in a note, a card number in a table cell), is
//   replaced by WITHHELD in that text, and a typed value holding one is dropped.
// Secrets written as prose ("my password is …") are not structural; fill/redact.ts handles them as best effort.
import type { Node, NodeExclusion, PageExclusion, TypedValue } from "../protocol.ts";
import type { WindowState } from "../model.ts";
import { API_KEY_SHAPES, labelKind, luhn } from "../memory/sensitive.ts";

/** Why a node's content (protocol.ts NodeExclusion) or a value in a known format is never carried. */
export type Exclusion = NodeExclusion | "privateKey" | "highEntropy";

/** What stands in a text where a value Caret never carries was. */
export const WITHHELD = "[withheld]";

/** How Caret says it will not keep or type a text that held such a value, whose kind the model no longer knows. */
export const WITHHELD_SAYS = "Caret doesn't keep keys, card numbers, account numbers or ID numbers";

/** US social security number written with its dashes. */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/gu;
/** An IBAN's shape: country, check digits, then 11 to 30 letters and digits, spaces allowed every four (mod-97 checked). */
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/gu;
/** Runs of digits with spaces or dashes between, as a card number is written (Luhn checked, 13 to 19 digits). */
const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/gu;
/** A private key's fence, BEGIN through END, as one unit; an unclosed block runs to the end of the text. */
const PEM_BLOCK = /-{3,}\s*BEGIN\b[^-\n]*PRIVATE KEY\s*-{3,}[\s\S]*?(?:-{3,}\s*END\b[^-\n]*PRIVATE KEY\s*-{3,}|$)/gu;
/** A run of the characters keys and tokens are written in (base64, base64url, hex, dashes). */
const TOKEN = /[A-Za-z0-9+/=_-]{24,}/gu;

/**
 * The high-entropy rule's thresholds: a token of at least HIGH_ENTROPY_CHARS characters that mixes all
 * HIGH_ENTROPY_CLASSES classes of lower case, upper case and digits, with Shannon entropy of at least HIGH_ENTROPY_BITS
 * bits per character. The numbers are SC1's and assumed, not measured (risk 4). The classes are not SC1's four (lower,
 * upper, digits, symbols): with symbols counted, the corpus's page addresses were flagged ("127.0.0.1:51310/forms/
 * greenhouse-apply.html" holds "51310/forms/greenhouse-apply": lower case, digits, "/" and "-", 4.2 bits), the ledger
 * refused texts holding them, and B25 held-16's Ask no longer set Degree (test/v4-options.test.ts). Keys and tokens mix
 * both cases with digits; slugs, URLs, UUIDs and hex
 * digests do not. The near-miss corpus in test/sc1-exclusions.test.ts checks what survives.
 */
export const HIGH_ENTROPY_CHARS = 24;
export const HIGH_ENTROPY_CLASSES = 3;
export const HIGH_ENTROPY_BITS = 4.0;

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function highEntropy(token: string): boolean {
  if (token.length < HIGH_ENTROPY_CHARS) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u].filter((re) => re.test(token)).length;
  return classes >= HIGH_ENTROPY_CLASSES && entropy(token) >= HIGH_ENTROPY_BITS;
}

/** ISO 13616's check: the country and check digits moved to the end, letters as numbers, the whole mod 97 is 1. */
function ibanValid(raw: string): boolean {
  const s = raw.replace(/ /gu, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const c of moved) {
    const v = c >= "A" && c <= "Z" ? String(c.charCodeAt(0) - 55) : c;
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

interface Span {
  at: number;
  end: number;
  kind: Exclusion;
}

/** Every span of `text` holding a value in a format Caret never carries, in text order, overlaps merged. */
function spans(text: string): Span[] {
  const out: Span[] = [];
  const add = (re: RegExp, kind: Exclusion, ok: (m: string) => boolean = () => true): void => {
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))) if (ok(m[0])) out.push({ at: m.index, end: m.index + m[0].length, kind });
  };
  add(PEM_BLOCK, "privateKey");
  for (const re of API_KEY_SHAPES) add(re, "apiKey");
  add(SSN, "governmentId");
  add(IBAN, "accountNumber", ibanValid);
  add(DIGIT_RUN, "cardNumber", (m) => {
    const d = m.replace(/\D/gu, "");
    return d.length >= 13 && d.length <= 19 && luhn(d);
  });
  add(TOKEN, "highEntropy", highEntropy);
  if (out.length < 2) return out;
  out.sort((a, b) => a.at - b.at || b.end - a.end);
  const merged: Span[] = [out[0] as Span];
  for (const s of out.slice(1)) {
    const last = merged[merged.length - 1] as Span;
    if (s.at < last.end) last.end = Math.max(last.end, s.end);
    else merged.push(s);
  }
  return merged;
}

/** Answers by text: a window's nodes repeat from snapshot to snapshot. Bounded; the bound is not measured. */
const MEMO = new Map<string, { kind: Exclusion | null; kept: string }>();
const MEMO_MAX = 8000;

function scan(text: string): { kind: Exclusion | null; kept: string } {
  const hit = MEMO.get(text);
  if (hit !== undefined) return hit;
  const found = spans(text);
  let kept = text;
  for (let i = found.length - 1; i >= 0; i--) {
    const s = found[i] as Span;
    kept = kept.slice(0, s.at) + WITHHELD + kept.slice(s.end);
  }
  const r = { kind: found[0]?.kind ?? null, kept };
  if (MEMO.size >= MEMO_MAX) MEMO.clear();
  MEMO.set(text, r);
  return r;
}

/** A value Caret never carries, whatever node or window it is in: formats only, never words. Null when `text` holds none. */
export function excludedValue(text: string | null | undefined): Exclusion | null {
  return text === null || text === undefined || text === "" ? null : scan(text).kind;
}

/** `text` with every value excludedValue finds replaced by WITHHELD; the same string when it holds none. */
export function withholdValues(text: string): string {
  return text === "" ? text : scan(text).kept;
}

/**
 * Page exclusions the walker sends as marked controls (extension walker.ts): visible fields whose value would be a
 * secret. A hidden input, an invisible or aria-hidden control and a self-identification question are still dropped
 * in the frame: the user sees none of them as a field Caret could fill.
 */
const MARKED: ReadonlySet<string> = new Set(["password", "payment", "oneTimeCode"]);

/** Roles whose label is their text, not a name: never a group whose name a field inherits. */
const TEXT_ROLES: ReadonlySet<string> = new Set(["AXStaticText", "AXCell", "AXHeading", "AXLink"]);
/** Containers too wide to name the fields in them: a window, a page, a scroll view, an app. */
const NOT_A_GROUP: ReadonlySet<string> = new Set(["AXWindow", "AXWebArea", "AXScrollArea", "AXApplication", "AXSplitGroup", "AXBrowser", "AXSheet", "AXDrawer"]);

/** What a field takes from the groups around it: the nearest group's name, and an exclusion any of them carries. */
export interface Inherited {
  label?: string;
  excluded?: NodeExclusion;
}

/**
 * What a node takes from its ancestors, by two rules kept apart (PV2 re-review): an excluded ancestor's exclusion, from
 * any ancestor at all (excludedAncestor), and the nearest group's name a field's kind is read from, which stops at a
 * window, page or scroll view (groupLabel).
 */
export function inherited(nodes: ReadonlyMap<string, Node>, n: Node): Inherited {
  const excluded = excludedAncestor(nodes, n);
  const label = groupLabel(nodes, n);
  return { ...(excluded === null ? {} : { excluded }), ...(label === null ? {} : { label }) };
}

/**
 * Rule (i): the exclusion of the nearest ancestor that is excluded (its own `excluded`, or a secure state or role), with no
 * stop of any kind: everything inside an excluded node is its content, whatever lies between. Only a cycle ends the walk.
 */
export function excludedAncestor(nodes: ReadonlyMap<string, Node>, n: Node): NodeExclusion | null {
  const seen = new Set<string>([n.key]);
  for (let p = n.parent === null ? undefined : nodes.get(n.parent); p !== undefined && !seen.has(p.key); p = p.parent === null ? undefined : nodes.get(p.parent)) {
    seen.add(p.key);
    if (p.excluded !== undefined) return p.excluded;
    if (p.states?.includes("secure") === true || p.role === "AXSecureTextField") return "secure";
    // A container labelled for a secret (a group named "Password") holds what it names. Its own label is a name, an
    // attribute: not a text's content (TEXT_ROLES), nor a window's, page's or scroll view's title (NOT_A_GROUP), which
    // names no field.
    if (!TEXT_ROLES.has(p.role) && !NOT_A_GROUP.has(p.role) && p.editable !== true) {
      const kind = labelKind(p.label);
      if (kind !== null) return kind;
    }
  }
  return null;
}

/**
 * Rule (ii): the name of the nearest ancestor that groups a field (a fieldset, a group, a list), as an attribute, never a
 * static text's content, read for a sensitive kind (excludedNode). It stops at a window, page or scroll view, whose own
 * title names no field.
 */
function groupLabel(nodes: ReadonlyMap<string, Node>, n: Node): string | null {
  let p = n.parent === null ? undefined : nodes.get(n.parent);
  for (let depth = 0; p !== undefined && depth < 64; depth++, p = p.parent === null ? undefined : nodes.get(p.parent)) {
    if (NOT_A_GROUP.has(p.role)) return null;
    if (!TEXT_ROLES.has(p.role) && p.editable !== true && p.label !== undefined && p.label.trim() !== "") return p.label;
  }
  return null;
}

/**
 * A control whose content Caret never carries, because its declared purpose says so: a secure field, a page control the
 * walker marked, any node inside an excluded one, or an editable control whose own label, placeholder, or
 * nearest group's name ends in a sensitive kind (memory/sensitive.ts labelKind: "Card number", "SSN"; not "Password
 * hint"). Null for every other node.
 */
export function excludedNode(n: Node, from: Inherited = {}, typed = false): NodeExclusion | null {
  if (n.excluded !== undefined) return n.excluded;
  if (n.states?.includes("secure") === true || n.role === "AXSecureTextField") return "secure";
  // Everything inside an excluded node is its content, editable or not (PV2 re-review).
  if (from.excluded !== undefined) return from.excluded;
  // A node that holds a value (its own value, a typed value, a placeholder), whatever its role, is excluded when its own
  // label or placeholder names a sensitive kind: that label is the value's declared purpose (the coordinator's ruling
  // after SC1 step 3's evidence: a cell labelled "Password" holding a value). A label that holds nothing is only a label.
  const holds = (n.value ?? "") !== "" || (n.placeholder ?? "") !== "" || typed;
  if (n.editable !== true) return holds ? (labelKind(n.label) ?? labelKind(n.placeholder)) : null;
  return labelKind(n.label) ?? labelKind(n.placeholder) ?? labelKind(from.label);
}

/** Whether a page exclusion is one the walker sends as a marked control; it drops the rest before they leave the frame. */
export function markedPageExclusion(why: PageExclusion): why is "password" | "payment" | "oneTimeCode" {
  return MARKED.has(why);
}

/**
 * INT1 (SCP1's section texts, Node.headings and Node.outline): a page web area's heading and section texts with every
 * excluded value withheld, as its label's are, so the exclusion acts before any reader of the model sees them. Null
 * when nothing changes.
 */
function admitSections(n: Node): Pick<Node, "headings" | "outline"> | null {
  const headings = n.headings?.map(withholdValues);
  const outline = n.outline?.map((o) => (o.text === undefined ? o : { ...o, text: withholdValues(o.text) }));
  const same = (headings ?? []).every((h, i) => h === n.headings?.[i]) && (outline ?? []).every((o, i) => o.text === n.outline?.[i]?.text);
  return same ? null : { ...(headings === undefined ? {} : { headings }), ...(outline === undefined ? {} : { outline }) };
}

/**
 * A node as the model keeps it: excluded (its value gone, `excluded` set), or with every excluded value in its label,
 * value, placeholder and section texts withheld. The same object when nothing changes.
 */
export function admitNode(n: Node, from: Inherited = {}, typed = false): Node {
  const why = excludedNode(n, from, typed);
  const sections = admitSections(n);
  if (why !== null) {
    const { value: _value, ...rest } = n;
    const label = rest.label === undefined ? undefined : withholdValues(rest.label);
    const placeholder = rest.placeholder === undefined ? undefined : withholdValues(rest.placeholder);
    if (n.excluded === why && n.value === undefined && label === n.label && placeholder === n.placeholder && sections === null) return n;
    return { ...rest, ...(label === undefined ? {} : { label }), ...(placeholder === undefined ? {} : { placeholder }), ...(sections ?? {}), excluded: why };
  }
  const label = n.label === undefined ? undefined : withholdValues(n.label);
  const value = n.value === undefined ? undefined : withholdValues(n.value);
  const placeholder = n.placeholder === undefined ? undefined : withholdValues(n.placeholder);
  if (label === n.label && value === n.value && placeholder === n.placeholder && sections === null) return n;
  return { ...n, ...(label === undefined ? {} : { label }), ...(value === undefined ? {} : { value }), ...(placeholder === undefined ? {} : { placeholder }), ...(sections ?? {}) };
}

/** The typed values the model keeps: none of an excluded node, none holding an excluded value, each still in its node's text. */
export function admitValues(values: readonly TypedValue[], nodes: ReadonlyMap<string, Node>): TypedValue[] {
  return values.filter((v) => {
    const n = nodes.get(v.nodeKey);
    if (n === undefined) return true;
    if (n.excluded !== undefined || excludedValue(v.text) !== null) return false;
    // A value beside a withheld one stays only where it still stands whole; otherwise the node is as the reader sent it.
    const texts = [n.value, n.label, n.placeholder];
    if (!texts.some((t) => t?.includes(WITHHELD) === true)) return true;
    return texts.some((t) => t !== undefined && t.replace(/\r\n/gu, "\n").includes(v.text.replace(/\r\n/gu, "\n")));
  });
}

/** A window's title as the model keeps it. */
export function admitTitle(w: WindowState["window"]): WindowState["window"] {
  const title = withholdValues(w.title);
  return title === w.title ? w : { ...w, title };
}
