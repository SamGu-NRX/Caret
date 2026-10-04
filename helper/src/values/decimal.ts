// Numbers as written in a locale, read exactly: a BigInt coefficient and a scale, so "1.50" stays 150
// with scale 2 and a sixteen-digit number keeps every digit. Separators come from a short table of
// locales; a locale outside it, or no source locale at all for text with separators, is refused rather
// than guessed. Grouping must be regular for the locale: "1,2345.6" and "12,34,567" in en-US are refused.
import { resolved, unsupported, type Resolution, type ValueRef } from "./resolve.ts";

/** value = coefficient × 10^-scale. `scale` counts the digits written after the decimal separator. */
export interface Decimal {
  coefficient: bigint;
  scale: number;
}

interface NumberStyle {
  /** Characters accepted as a group separator. */
  group: readonly string[];
  decimal: string;
  /** "indian": the last group has three digits and those before it two ("1,23,45,678"). */
  grouping: "thousands" | "indian";
}

const SPACES = [" ", " ", " "];
const COMMA_POINT: NumberStyle = { group: [","], decimal: ".", grouping: "thousands" };
const POINT_COMMA: NumberStyle = { group: ["."], decimal: ",", grouping: "thousands" };
const SPACE_COMMA: NumberStyle = { group: SPACES, decimal: ",", grouping: "thousands" };
const APOSTROPHE_POINT: NumberStyle = { group: ["'", "’"], decimal: ".", grouping: "thousands" };
const INDIAN: NumberStyle = { group: [","], decimal: ".", grouping: "indian" };

/**
 * Separators by exact locale tag, then by language when every region of that language in common use
 * agrees. From CLDR's number symbols as commonly published; French and Russian group with spaces, and the
 * three space characters (plain, no-break, narrow no-break) are all accepted because text copied from
 * different apps carries different ones.
 */
const BY_TAG: Record<string, NumberStyle> = {
  "en-IN": INDIAN,
  "hi-IN": INDIAN,
  "de-CH": APOSTROPHE_POINT,
  "fr-CH": APOSTROPHE_POINT,
  "it-CH": APOSTROPHE_POINT,
  "pt-PT": SPACE_COMMA,
  "pt-BR": POINT_COMMA,
};
const BY_LANGUAGE: Record<string, NumberStyle> = {
  en: COMMA_POINT,
  ja: COMMA_POINT,
  zh: COMMA_POINT,
  ko: COMMA_POINT,
  de: POINT_COMMA,
  es: POINT_COMMA,
  it: POINT_COMMA,
  nl: POINT_COMMA,
  id: POINT_COMMA,
  tr: POINT_COMMA,
  da: POINT_COMMA,
  fr: SPACE_COMMA,
  ru: SPACE_COMMA,
  uk: SPACE_COMMA,
  pl: SPACE_COMMA,
  cs: SPACE_COMMA,
  sv: SPACE_COMMA,
  nb: SPACE_COMMA,
  fi: SPACE_COMMA,
};

export function numberStyle(locale: string): NumberStyle | null {
  const exact = BY_TAG[locale];
  if (exact !== undefined) return exact;
  const lang = locale.split("-")[0]?.toLowerCase() ?? "";
  return BY_LANGUAGE[lang] ?? null;
}

const SIGNS = /^[-−+]/;

/** The groups' sizes are regular for the style: the first 1 to 3 (1 to 2 for Indian), the rest exact. */
function groupsRegular(groups: readonly string[], style: NumberStyle): boolean {
  if (groups.length < 2) return true;
  const last = groups.at(-1) as string;
  if (last.length !== 3) return false;
  const middle = style.grouping === "indian" ? 2 : 3;
  const first = groups[0] as string;
  if (first.length < 1 || first.length > middle) return false;
  return groups.slice(1, -1).every((g) => g.length === middle);
}

/** The digits of an integer part as written in `style`, or null when its grouping is malformed. */
function integerDigits(text: string, style: NumberStyle): string | null {
  if (/^\d+$/.test(text)) return text;
  const sep = style.group.find((g) => text.includes(g));
  if (sep === undefined) return null;
  // Mixing two different space characters inside one number happens when text is copied between apps;
  // any one of the style's group characters may separate any group.
  const groups = text.split(new RegExp(`[${style.group.map((g) => `\\${g}`).join("")}]`));
  if (!groups.every((g) => /^\d+$/.test(g))) return null;
  return groupsRegular(groups, style) ? groups.join("") : null;
}

/** Reads `text` as one number in `style`, or says why it cannot. */
export function readDecimal(text: string, style: NumberStyle): Decimal | string {
  let t = text.trim();
  if (t === "") return "no number";
  if (/[$€£¥₹%]|\b(?:USD|EUR|GBP|JPY|INR)\b/i.test(t)) return "a currency or percentage is not a plain number";
  if (/[eE]/.test(t)) return "exponent notation is not read";
  let negative = false;
  const sign = SIGNS.exec(t);
  if (sign !== null) {
    negative = sign[0] !== "+";
    t = t.slice(1);
  }
  const parts = t.split(style.decimal);
  if (parts.length > 2) return `more than one decimal separator "${style.decimal}"`;
  const [intText = "", fracText] = parts;
  if (fracText !== undefined && !/^\d+$/.test(fracText)) return "the digits after the decimal separator are malformed";
  if (intText === "" && fracText === undefined) return "no digits";
  const digits = intText === "" ? "0" : integerDigits(intText, style);
  if (digits === null) return `the grouping of "${intText}" is not regular for this locale`;
  if (digits.length > 1 && digits.startsWith("0")) return "leading zeros: read it as an ID, not a number";
  const scale = fracText?.length ?? 0;
  const coefficient = BigInt(digits + (fracText ?? ""));
  return { coefficient: negative ? -coefficient : coefficient, scale };
}

/** "1234.50", with "-" for a negative value; the scale's digits are all kept. */
export function decimalString(d: Decimal): string {
  const negative = d.coefficient < 0n;
  const digits = (negative ? -d.coefficient : d.coefficient).toString().padStart(d.scale + 1, "0");
  const int = digits.slice(0, digits.length - d.scale);
  const frac = digits.slice(digits.length - d.scale);
  return `${negative ? "-" : ""}${int}${d.scale > 0 ? `.${frac}` : ""}`;
}

export function parseNumber(span: ValueRef, sourceLocale: string | undefined): Resolution<Decimal> {
  const text = span.quote.trim();
  if (sourceLocale === undefined) {
    // Section 4: reject an ambiguous source locale. Digits alone read the same everywhere.
    if (/^[-−+]?\d+$/.test(text)) {
      const d = readDecimal(text, COMMA_POINT);
      return typeof d === "string" ? unsupported(d) : resolved(d, decimalString(d), [span]);
    }
    return unsupported(`"${text}" has separators, and the source's locale is unknown`);
  }
  const style = numberStyle(sourceLocale);
  if (style === null) return unsupported(`no number rules for locale ${sourceLocale}`);
  const d = readDecimal(text, style);
  return typeof d === "string" ? unsupported(d) : resolved(d, decimalString(d), [span]);
}
