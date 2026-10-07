// The alternate-field veto: an alternate, secondary, backup, other or additional email, phone or address field never
// takes the value of the same form's primary field of that kind, nor the user's own primary value of that kind when a
// primary field exists. Why: a held-out run wrote the user's primary email into "Alternate email"; ownership and the
// verifier both called it the user's exact email, which it was. Confirmation fields and forms with no primary field
// are exempt.
//
// One deterministic check (alternateVeto) serves every write path: fill's proposal across all of a page plan's parts
// (fill.ts, page-planner.ts PartPicks), goal lowering (goals/lower.ts), and the write contract's recheck at acceptance
// and right before each dispatch (contract.ts guardFor, offers/fill-popup.ts recheckField), which carries the field's
// alternate kinds in its FieldContract. It only withholds: a broader match can never admit a write.
import { describeField, fieldLabelText } from "./descriptor.ts";
import { fieldKinds } from "./kinds.ts";
import { PROMPT } from "./controls.ts";
import type { WindowState } from "../model.ts";
import type { FillField, Node } from "../protocol.ts";

export type AlternateKind = "email" | "phone" | "address";
const KINDS: readonly AlternateKind[] = ["email", "phone", "address"];

// Source: general language knowledge, not held-out pages or keys. The groups cover English, Spanish,
// French, German, Arabic, Hindi and Korean, then unspaced Chinese/Japanese compounds. No coverage study
// exists. Match whole words in spaced scripts, including combining marks, rather than English-only \b.
const SECONDARY = /(?<![\p{L}\p{M}\p{N}])(?:alternate|alternative|secondary|backup|other|additional|second|2nd|alternativ[oa]s?|secundari[oa]s?|otr[oa]s?|adicional|segund[oa]|de reserva|secondaire|alternatif|autre|supplémentaire|de secours|alternativ(?:e[rsnm]?)?|sekundär(?:e[rsnm]?)?|ersatz|weitere[rsnm]?|andere[rsnm]?|zweite[rsnm]?|احتياطي|الاحتياطي|بديل|البديل|آخر|الآخر|ثانوي|الثانوي|إضافي|الإضافي|ثاني|الثاني|वैकल्पिक|अन्य|दूसरा|दूसरी|अतिरिक्त|보조|대체|다른|추가|두 번째|예비|백업)(?![\p{L}\p{M}\p{N}])|备用|備用|其他|其它|第二|额外|額外|予備|代替|追加|別の|その他/iu;
const CONFIRM = /(?<![\p{L}\p{M}])(?:confirm(?:ation)?|re[ -]?enter|verify|again|confirmar|confirmación|verificar|repetir|de nuevo|confirmer|confirmation|vérifier|ressaisir|à nouveau|bestätigen|bestätigung|wiederholen|erneut|تأكيد|التأكيد|تحقق|التحقق|مرة أخرى|إعادة|पुष्टि|दोबारा|फिर से|확인|재입력|다시)(?![\p{L}\p{M}])|确认|確認|再次|重新输入|再入力|もう一度/iu;

export function alternateKind(label: string | null): AlternateKind | null {
  const cleaned = fieldLabelText(label)?.normalize("NFKC") ?? "";
  // Help text in parentheses does not rename a field: "Email (other people can see this)".
  const qualifier = new RegExp(`^(?:${SECONDARY.source})$`, "iu");
  const name = cleaned.replace(/\(([^)]*)\)|\[([^\]]*)\]/gu, (_all, round: string | undefined, square: string | undefined) => {
    const inside = (round ?? square ?? "").trim();
    return qualifier.test(inside) ? ` ${inside} ` : "";
  });
  if (CONFIRM.test(cleaned) || !SECONDARY.test(name)) return null;
  return primaryKind(name);
}

/** The kinds of an alternate field (alternateKind), as a list: what its FieldContract carries (contract.ts). */
export function alternateKinds(label: string | null): readonly AlternateKind[] {
  const k = alternateKind(label);
  return k === null ? [] : [k];
}

export function primaryKind(label: string | null): AlternateKind | null {
  const kinds = fieldKinds([label?.normalize("NFKC")]);
  return KINDS.find((k) => kinds.has(k)) ?? null;
}

/** The kinds a field that is no alternate stands as the primary of. */
function primaryKinds(label: string | null): readonly AlternateKind[] {
  if (alternateKinds(label).length > 0) return [];
  const k = primaryKind(label);
  return k === null ? [] : [k];
}

/**
 * The first digits of an E.164 country calling code decide its length (ITU-T E.164 assignments; the codes are
 * prefix-free): 1 and 7 are one digit, the two-digit codes below are two, every other code is three.
 */
const TWO_DIGIT_CODES: ReadonlySet<string> = new Set(["20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49", "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98"]);
function countryCodeLength(digits: string): number {
  return digits.startsWith("1") || digits.startsWith("7") ? 1 : TWO_DIGIT_CODES.has(digits.slice(0, 2)) ? 2 : 3;
}

/** A phone number's digits, and its national number when it is written with an explicit country code ("+" or "00"). */
function phoneForms(v: string): { all: string; national: string | null; trunkless: string | null } | null {
  const t = v.normalize("NFKC").trim();
  const digits = t.replace(/[^0-9]/gu, "");
  if (digits === "") return null;
  if (t.startsWith("+") || /^00[1-9]/u.test(digits)) {
    const all = t.startsWith("+") ? digits : digits.slice(2);
    const national = all.slice(countryCodeLength(all));
    return { all, national: national === "" ? null : national, trunkless: null };
  }
  // A number written nationally may carry its trunk prefix 0 ("07700 900123" is +44 7700 900123). Compared only with
  // the national number of one written with its country code, never with another national number.
  return { all: digits, national: null, trunkless: digits.startsWith("0") && digits.length > 1 ? digits.slice(1) : null };
}

/**
 * Whether two values of a kind are the same value. Lead ruling (V6): phones compare national numbers when one side
 * has an explicit country code and the other has none, so "+1 (512) 555-0147" equals "5125550147"; only an explicit
 * leading country code is stripped, and nothing is matched by suffix. Emails ignore case and spacing.
 * Addresses compare field by field, as written but for case and spacing (lead ruling): this can only withhold too
 * much, so an alternate address in the same city loses its City. Follow-up: compare whole addresses once the page
 * walk groups an address's parts.
 */
export function sameValue(kind: AlternateKind, a: string, b: string): boolean {
  if (kind === "phone") {
    const x = phoneForms(a);
    const y = phoneForms(b);
    if (x === null || y === null) return false;
    if (x.all === y.all) return true;
    const national = (p: typeof x, q: typeof x): boolean => p.national !== null && q.national === null && (p.national === q.all || p.national === q.trunkless);
    return national(x, y) || national(y, x);
  }
  const norm = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  return norm(a) !== "" && norm(a) === norm(b);
}

/** A field of the form as Caret reads it, whether or not Caret could write it: a read-only one and a dropdown count. */
export interface ReadableField {
  key: string;
  name: string;
  /** What it holds now; "" when empty or showing a dropdown's prompt. */
  value: string;
}

const TEXT_ROLES: ReadonlySet<string> = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);

/**
 * Every field of a window that names what it holds, with its value (V6 B4): text fields whether editable or not, a
 * dropdown's chosen option, a radio group's checked choice. Separate from what Caret may write (fill.ts FILLABLE_ROLES):
 * a primary Caret cannot write still decides what an alternate may hold. Secure fields are never read.
 */
export function readableFields(w: WindowState): ReadableField[] {
  const out: ReadableField[] = [];
  const named = (n: Node, value: string): void => {
    const d = describeField(w, n);
    out.push({ key: n.key, name: d.label ?? d.nearest ?? d.placeholder ?? "unnamed field", value });
  };
  for (const n of w.nodes.values()) {
    if (n.states?.includes("secure") === true) continue;
    const parent = n.parent === null ? undefined : w.nodes.get(n.parent);
    if (TEXT_ROLES.has(n.role)) named(n, n.value ?? "");
    else if (n.role === "AXPopUpButton" && parent?.role !== "AXDateField" && parent?.role !== "AXTimeField") {
      const v = (n.value ?? "").trim();
      named(n, PROMPT.test(v) ? "" : v);
    } else if (n.role === "AXRadioButton" && n.states?.includes("checked") === true && parent !== undefined) named(parent, (n.label ?? "").trim());
  }
  return out;
}

/** A value some path proposes to write into a field of the form. */
export interface AlternateWrite {
  key: string;
  /** The field's name, as fill names it (label, else nearest label, else placeholder). */
  name: string;
  text: string;
}

/** A value the user told Caret (fill/about.ts AboutValue, or a goal's memory value with its kind). */
export interface SavedValue {
  label: string;
  value: string;
  kind: string;
}

export interface AlternateVeto {
  /** Completes "Caret left <field>: …" without its period; never quotes the value. */
  says: string;
  /** What the value repeats: a field of the form, by its key, or the user's saved value of a kind. */
  repeats: { field: string } | { saved: AlternateKind };
}

/** What the form holds: its readable fields, every value proposed into it (all of a page plan's parts), the user's saved values. */
export interface AlternateForm {
  fields: readonly ReadableField[];
  writes: readonly AlternateWrite[];
  saved: readonly SavedValue[];
}

const KIND_SAYS: Record<AlternateKind, string> = { email: "email address", phone: "phone number", address: "address" };

/**
 * Why `write` may not go in its field, or null. `kinds` are the field's alternate kinds, read from its name by default;
 * the write contract passes the ones its FieldContract carried.
 */
export function alternateVeto(write: AlternateWrite, form: AlternateForm, kinds: readonly AlternateKind[] = alternateKinds(write.name)): AlternateVeto | null {
  for (const kind of kinds) {
    const fields = form.fields.filter((f) => f.key !== write.key && primaryKinds(f.name).includes(kind));
    const writes = form.writes.filter((x) => x.key !== write.key && primaryKinds(x.name).includes(kind));
    // A form with no primary field of the kind is exempt: the only email field may be labelled alternate.
    if (fields.length === 0 && writes.length === 0) continue;
    const field = [...fields.map((f) => ({ key: f.key, name: f.name, value: f.value })), ...writes.map((x) => ({ key: x.key, name: x.name, value: x.text }))].find((p) => p.value.trim() !== "" && sameValue(kind, p.value, write.text));
    if (field !== undefined) return { says: `it would repeat your ${field.name}`, repeats: { field: field.key } };
    if (form.saved.some((s) => s.kind === kind && sameValue(kind, s.value, write.text))) return { says: `it would repeat your saved ${KIND_SAYS[kind]}`, repeats: { saved: kind } };
  }
  return null;
}

/** Each of the form's proposed writes the veto refuses, by field key. */
export function alternateVetoes(form: AlternateForm): Map<string, AlternateVeto> {
  const out = new Map<string, AlternateVeto>();
  for (const w of form.writes) {
    const v = alternateVeto(w, form);
    if (v !== null) out.set(w.key, v);
  }
  return out;
}

/**
 * V6 B1: a page plan asks its parts' fills together (page-planner.ts), and each part's veto must see every part's
 * proposals before any verifier runs. Each part arrives once with its proposals, then waits for the rest. A part that
 * ends before it arrives (a FillError, nothing to copy) is arrived for by the planner with none, so no part waits on one
 * that will never come.
 */
export class PartPicks {
  private readonly got = new Map<number, readonly AlternateWrite[]>();
  private release: () => void = () => {};
  private readonly ready: Promise<void>;
  private readonly parts: number;
  constructor(parts: number) {
    this.parts = parts;
    this.ready = new Promise((r) => (this.release = r));
    if (parts <= 0) this.release();
  }
  arrive(part: number, writes: readonly AlternateWrite[]): void {
    if (this.got.has(part)) return;
    this.got.set(part, writes);
    if (this.got.size >= this.parts) this.release();
  }
  async all(): Promise<AlternateWrite[]> {
    await this.ready;
    return [...this.got.values()].flat();
  }
}

/**
 * V6 B3: the write contract's dependency on the primary, rechecked at acceptance and right before each dispatch: why
 * a checked value may no longer go in its alternate field, read from the form `w` as it is now, or null. `kinds` are
 * the alternate kinds its FieldContract carried. With no form to read, an alternate value is refused.
 */
export function alternateStale(w: WindowState | undefined, c: { text: string; field: { key: string; name: string; alternate: readonly AlternateKind[] } }): string | null {
  if (c.field.alternate.length === 0) return null;
  if (w === undefined) return "Caret can't see the form to check this value against its primary field";
  const v = alternateVeto({ key: c.field.key, name: c.field.name, text: c.text }, { fields: readableFields(w), writes: [], saved: [] }, c.field.alternate);
  return v === null ? null : v.says;
}

// Helper-local metadata, like fill's write mints. No new field on the host's wire contract.
const reasons = new WeakMap<FillField, string>();
export function setAlternateReason(field: FillField, reason: string): void { reasons.set(field, reason); }
export function alternateReason(field: FillField): string | null { return reasons.get(field) ?? null; }
