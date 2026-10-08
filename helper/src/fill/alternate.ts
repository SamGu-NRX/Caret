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
import { redactWindow } from "./redact.ts";
import { aboutKind } from "./about.ts";
import { secretText } from "../memory/sensitive.ts";
import type { WindowState } from "../model.ts";
import type { FillField, Node } from "../protocol.ts";

export type AlternateKind = "email" | "phone" | "address";
const KINDS: readonly AlternateKind[] = ["email", "phone", "address"];

// Source: general language knowledge, not held-out pages or keys. The groups cover English, Spanish, French, German,
// Arabic and Hindi as whole words (boundaries include combining marks, unlike English-only \b), then Korean, Chinese
// and Japanese with no boundary: their compounds are written without spaces ("보조이메일"). No coverage study exists.
const SECONDARY = /(?<![\p{L}\p{M}\p{N}])(?:alternate|alternative|secondary|backup|other|additional|second|2nd|alternativ[oa]s?|secundari[oa]s?|otr[oa]s?|adicional|segund[oa]|de reserva|secondaire|alternatif|autre|supplémentaire|de secours|alternativ(?:e[rsnm]?)?|sekundär(?:e[rsnm]?)?|ersatz|weitere[rsnm]?|andere[rsnm]?|zweite[rsnm]?|احتياطي|الاحتياطي|بديل|البديل|آخر|الآخر|ثانوي|الثانوي|إضافي|الإضافي|ثاني|الثاني|वैकल्पिक|अन्य|दूसरा|दूसरी|अतिरिक्त|बैकअप|द्वितीयक)(?![\p{L}\p{M}\p{N}])|보조|대체|다른|추가|두 번째|예비|백업|备用|備用|其他|其它|第二|额外|額外|予備|代替|追加|別の|その他/iu;
const CONFIRM = /(?<![\p{L}\p{M}])(?:confirm(?:ation)?|re[ -]?enter|verify|again|confirmar|confirmación|verificar|repetir|de nuevo|confirmer|confirmation|vérifier|ressaisir|à nouveau|bestätigen|bestätigung|wiederholen|erneut|تأكيد|التأكيد|تحقق|التحقق|مرة أخرى|إعادة|पुष्टि|दोबारा|फिर से|확인|재입력|다시)(?![\p{L}\p{M}])|确认|確認|再次|重新输入|再入力|もう一度/iu;
/** The ordinal secondary words, which a confirmation field uses for "a second time" ("Second email confirmation"). */
const ORDINAL = /(?<![\p{L}\p{M}\p{N}])(?:second|2nd|segund[oa]|zweite[rsnm]?|ثاني|الثاني|दूसरा|दूसरी)(?![\p{L}\p{M}\p{N}])|두 번째|第二/giu;
/** Words a bracketed qualifier may hold beside a marker and still be the field's own name: "(secondary, optional)". */
const PLAIN = /^(?:optional|required|if any|if applicable|opcional|obligatorio|facultatif|facultative|obligatoire|freiwillig|erforderlich|pflichtfeld|اختياري|مطلوب|आवश्यक|선택|필수|选填|必填|任意|必須)$/iu;

const whole = (re: RegExp, t: string): boolean => new RegExp(`^(?:${re.source})$`, "iu").test(t);

/**
 * A field's name without its help text. A bracketed part stays only when every item in it is a marker (secondary or
 * confirmation) or a plain qualifier ("optional"): "Email (secondary, optional)" keeps both; "Email (other people can
 * see this)" and "Alternate email (we will verify this address)" are help text, whose words name nothing.
 */
function ownName(label: string | null): string {
  const cleaned = fieldLabelText(label)?.normalize("NFKC") ?? "";
  return cleaned.replace(/\(([^)]*)\)|\[([^\]]*)\]/gu, (_all, round: string | undefined, square: string | undefined) => {
    const items = (round ?? square ?? "").split(/\s*(?:[,;/、，]|\s(?:and|or|y|o|et|ou|und|oder)\s)\s*/iu).map((x) => x.trim()).filter((x) => x !== "");
    const marker = (x: string): boolean => whole(SECONDARY, x) || whole(CONFIRM, x);
    return items.length > 0 && items.some(marker) && items.every((x) => marker(x) || PLAIN.test(x)) ? ` ${items.join(" ")} ` : " ";
  });
}

/** The kinds a name asks for, every one of them: "Secondary email or phone" is both. */
function kindsIn(name: string): AlternateKind[] {
  const kinds = fieldKinds([name]);
  return KINDS.filter((k) => kinds.has(k));
}

/**
 * The kinds a field is an alternate of: a secondary marker in its own name, unless the name confirms. Lead ruling (V6
 * re-review): a confirmation field follows the rule of the field it confirms. "Confirm email" and "Second email
 * confirmation" (an ordinal used for "a second time") confirm the primary, so they are exempt and take its value;
 * "Confirm alternate email", "Re-enter backup email", "Confirmar correo alternativo" and "보조 이메일 확인" confirm an
 * alternate, so they are held to the alternate rule and never take the primary's value.
 */
export function alternateKinds(label: string | null): readonly AlternateKind[] {
  return secondaryName(label) ? kindsIn(ownName(label)) : [];
}

/** Whether a field's or a saved entry's own name marks it secondary (alternateKinds), whatever kind it names. */
function secondaryName(label: string | null): boolean {
  const name = ownName(label);
  return SECONDARY.test(name) && !(CONFIRM.test(name) && !SECONDARY.test(name.replace(ORDINAL, " ")));
}

/** The kinds a field that is no alternate stands as the primary of. */
function primaryKinds(label: string | null): readonly AlternateKind[] {
  return secondaryName(label) ? [] : kindsIn(ownName(label));
}

/** Whether a value could be of a kind: an email has an @, a phone at least seven digits and no @. */
function fits(kind: AlternateKind, v: string): boolean {
  if (kind === "email") return v.includes("@");
  if (v.includes("@")) return false;
  return kind === "address" || v.replace(/[^0-9]/gu, "").length >= 7;
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
  /** Its name in the raw window, for comparison only: it may hold what the redacted view hides, so it is never said. */
  name: string;
  /**
   * Its name as the redacted view shows it (fill/redact.ts), the only name a reason may say; null when that view drops
   * the field or its name reads as a secret. V6 re-review: a primary labelled "Email API key: …" reached the preview.
   */
  shown: string | null;
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
  const view = redactWindow(w);
  const nameIn = (x: WindowState, n: Node): string | null => {
    const d = describeField(x, n);
    return d.label ?? d.nearest ?? d.placeholder;
  };
  const named = (n: Node, value: string): void => {
    const seen = view.nodes.get(n.key);
    out.push({ key: n.key, name: nameIn(w, n) ?? "unnamed field", shown: seen === undefined ? null : sayable(nameIn(view, seen)), value });
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

/** The user's saved values as they are now: the write contract's dependency on them, read again at acceptance and dispatch. */
export type SavedReader = () => readonly SavedValue[];

/**
 * The saved values the veto compares with, from planner or goal memory: the user's own entries, by About's kind
 * (about.ts aboutKind), never a person's. The goal inventory and the native planner both classify through here.
 */
export function savedValuesOf(memory: readonly { label: string; text: string; whose?: "user" | "other" }[]): SavedValue[] {
  return memory.flatMap((m) => {
    const kind = m.whose === "other" ? null : aboutKind(m.label, m.text);
    return kind === null ? [] : [{ label: m.label, value: m.text, kind }];
  });
}

/** A name a reason may say: one with text that does not read as a secret (memory/sensitive.ts secretText). */
function sayable(name: string | null): string | null {
  return name === null || name.trim() === "" || secretText(name) ? null : name;
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
const MAIN_SAYS: Record<AlternateKind, string> = { email: "email", phone: "phone number", address: "address" };

/**
 * Why `write` may not go in its field, or null. `kinds` are the field's alternate kinds, read from its name by default;
 * the write contract passes the ones its FieldContract carried.
 */
export function alternateVeto(write: AlternateWrite, form: AlternateForm, kinds: readonly AlternateKind[] = alternateKinds(write.name)): AlternateVeto | null {
  for (const kind of kinds) {
    // Every kind a mixed field takes that the value could be (V6: "Secondary email or phone" given the primary phone).
    if (!fits(kind, write.text)) continue;
    const fields = form.fields.filter((f) => f.key !== write.key && primaryKinds(f.name).includes(kind));
    const writes = form.writes.filter((x) => x.key !== write.key && primaryKinds(x.name).includes(kind));
    // A form with no primary field of the kind is exempt: the only email field may be labelled alternate.
    if (fields.length === 0 && writes.length === 0) continue;
    const field = [...fields.map((f) => ({ key: f.key, shown: f.shown, value: f.value })), ...writes.map((x) => ({ key: x.key, shown: sayable(x.name), value: x.text }))].find((p) => p.value.trim() !== "" && sameValue(kind, p.value, write.text));
    // Named only by what the redacted view shows; otherwise by its kind, so raw comparison data never becomes text.
    if (field !== undefined) return { says: field.shown === null ? `it would repeat the form's main ${MAIN_SAYS[kind]}` : `it would repeat your ${field.shown}`, repeats: { field: field.key } };
    // Only the user's primary values: an entry the user labelled as a backup ("Backup email") is the alternate's to take.
    if (form.saved.some((s) => s.kind === kind && !secondaryName(s.label) && sameValue(kind, s.value, write.text))) return { says: `it would repeat your saved ${KIND_SAYS[kind]}`, repeats: { saved: kind } };
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
 * V6 B3: the write contract's dependency on the primary and on the user's saved values, rechecked at acceptance and
 * right before each dispatch: why a checked value may no longer go in its alternate field, read from the form `w` and
 * from `saved` as they are now, or null. The kinds are the ones its FieldContract carried. With no form or no saved
 * values to read, an alternate value is refused.
 */
export function alternateStale(w: WindowState | undefined, c: { text: string; field: { key: string; name: string; alternate: readonly AlternateKind[] } }, saved: SavedReader | null): string | null {
  if (c.field.alternate.length === 0) return null;
  if (w === undefined) return "Caret can't see the form to check this value against its primary field";
  // V6 re-review: the user's saved values as they are now (an edit, a new entry, a relabelled backup), not at the proposal.
  if (saved === null) return "Caret can't read your saved details to check this value against them";
  const v = alternateVeto({ key: c.field.key, name: c.field.name, text: c.text }, { fields: readableFields(w), writes: [], saved: saved() }, c.field.alternate);
  return v === null ? null : v.says;
}

// Helper-local metadata, like fill's write mints. No new field on the host's wire contract.
const reasons = new WeakMap<FillField, string>();
export function setAlternateReason(field: FillField, reason: string): void { reasons.set(field, reason); }
export function alternateReason(field: FillField): string | null { return reasons.get(field) ?? null; }
