// Unit conversion over a finite table. Every factor is an exact rational (the inch is 0.0254 m and the
// pound 0.45359237 kg by definition; the US gallon is 231 cubic inches, 3.785411784 L), so arithmetic is
// done in BigInt fractions and nothing is rounded unless the caller names a precision. Temperature is
// affine and converts through kelvin. A unit outside the table, a currency, or two units of different
// dimensions are refused: no inferred units and no currency conversion.
import { decimalString, numberStyle, readDecimal, type Decimal } from "./decimal.ts";
import { resolved, unsupported, type Resolution, type ValueRef } from "./resolve.ts";

/** n/d with d > 0, kept reduced. */
interface Rational {
  n: bigint;
  d: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function rat(n: bigint, d: bigint = 1n): Rational {
  if (d === 0n) throw new Error("zero denominator");
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d) || 1n;
  return { n: (sign * n) / g, d: (sign * d) / g };
}

/** "0.0254" as an exact fraction. */
function dec(s: string): Rational {
  const [i = "0", f = ""] = s.split(".");
  return rat(BigInt(i + f), 10n ** BigInt(f.length));
}

const add = (a: Rational, b: Rational): Rational => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a: Rational, b: Rational): Rational => rat(a.n * b.n, a.d * b.d);
const div = (a: Rational, b: Rational): Rational => rat(a.n * b.d, a.d * b.n);

type Dimension = "length" | "mass" | "volume" | "time" | "speed" | "temperature";

/** value in the dimension's base unit = value × scale + offset. Offset is zero except for temperature. */
interface Unit {
  symbol: string;
  dimension: Dimension;
  scale: Rational;
  offset: Rational;
}

const ZERO = rat(0n);
const linear = (symbol: string, dimension: Dimension, scale: Rational): Unit => ({ symbol, dimension, scale, offset: ZERO });

const INCH = dec("0.0254");
const POUND = dec("0.45359237");
const GALLON = dec("3.785411784");
const MILE = dec("1609.344");

/** Bases: metre, kilogram, litre, second, metre per second, kelvin. */
const UNITS: readonly Unit[] = [
  linear("mm", "length", dec("0.001")),
  linear("cm", "length", dec("0.01")),
  linear("m", "length", rat(1n)),
  linear("km", "length", rat(1000n)),
  linear("in", "length", INCH),
  linear("ft", "length", mul(INCH, rat(12n))),
  linear("yd", "length", mul(INCH, rat(36n))),
  linear("mi", "length", MILE),
  linear("mg", "mass", dec("0.000001")),
  linear("g", "mass", dec("0.001")),
  linear("kg", "mass", rat(1n)),
  linear("oz", "mass", div(POUND, rat(16n))),
  linear("lb", "mass", POUND),
  linear("mL", "volume", dec("0.001")),
  linear("L", "volume", rat(1n)),
  linear("fl oz", "volume", div(GALLON, rat(128n))),
  linear("gal", "volume", GALLON),
  linear("s", "time", rat(1n)),
  linear("min", "time", rat(60n)),
  linear("h", "time", rat(3600n)),
  linear("m/s", "speed", rat(1n)),
  linear("km/h", "speed", rat(1000n, 3600n)),
  linear("mph", "speed", div(MILE, rat(3600n))),
  // K = °C + 273.15; K = (°F + 459.67) × 5/9.
  { symbol: "°C", dimension: "temperature", scale: rat(1n), offset: dec("273.15") },
  { symbol: "°F", dimension: "temperature", scale: rat(5n, 9n), offset: mul(dec("459.67"), rat(5n, 9n)) },
  { symbol: "K", dimension: "temperature", scale: rat(1n), offset: ZERO },
];

/** Other spellings of the table's symbols. Case matters: "m" is a metre, never a minute. */
const ALIASES: Record<string, string> = {
  metre: "m", metres: "m", meter: "m", meters: "m", kilometre: "km", kilometres: "km", kilometer: "km", kilometers: "km",
  centimetre: "cm", centimetres: "cm", centimeter: "cm", centimeters: "cm", millimetre: "mm", millimetres: "mm", millimeter: "mm", millimeters: "mm",
  inch: "in", inches: "in", foot: "ft", feet: "ft", yard: "yd", yards: "yd", mile: "mi", miles: "mi",
  gram: "g", grams: "g", kilogram: "kg", kilograms: "kg", milligram: "mg", milligrams: "mg", lbs: "lb", pound: "lb", pounds: "lb", ounce: "oz", ounces: "oz",
  l: "L", litre: "L", litres: "L", liter: "L", liters: "L", ml: "mL", millilitre: "mL", millilitres: "mL", milliliter: "mL", milliliters: "mL",
  "fl. oz": "fl oz", "fl.oz": "fl oz", floz: "fl oz", gallon: "gal", gallons: "gal",
  sec: "s", secs: "s", second: "s", seconds: "s", mins: "min", minute: "min", minutes: "min", hr: "h", hrs: "h", hour: "h", hours: "h",
  kph: "km/h", "km/hr": "km/h",
  "℃": "°C", "℉": "°F", "° C": "°C", "° F": "°F", degC: "°C", degF: "°F", celsius: "°C", fahrenheit: "°F", kelvin: "K",
};

const CURRENCY = /[$€£¥₹]|\b(?:USD|EUR|GBP|JPY|INR|CAD|AUD|CHF)\b/i;

export function unitFor(text: string): Unit | null {
  const t = text.trim().replace(/\s+/g, " ");
  const symbol = UNITS.some((u) => u.symbol === t) ? t : ALIASES[t] ?? ALIASES[t.toLowerCase()];
  return UNITS.find((u) => u.symbol === symbol) ?? null;
}

export interface Quantity {
  value: Decimal;
  unit: string;
  /** True when the value was rounded to the requested precision. */
  rounded: boolean;
}

const toRational = (d: Decimal): Rational => rat(d.coefficient, 10n ** BigInt(d.scale));

/** The exact decimal of `r`, or null when it does not terminate (its denominator has a factor other than 2 and 5). */
function exactDecimal(r: Rational): Decimal | null {
  let d = r.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) [d, twos] = [d / 2n, twos + 1];
  while (d % 5n === 0n) [d, fives] = [d / 5n, fives + 1];
  if (d !== 1n) return null;
  const scale = Math.max(twos, fives);
  return { coefficient: (r.n * 10n ** BigInt(scale)) / r.d, scale };
}

/** `r` rounded half away from zero to `places` digits after the point. */
function roundTo(r: Rational, places: number): Decimal {
  const scaled = r.n * 10n ** BigInt(places);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  let q = abs / r.d;
  if ((abs % r.d) * 2n >= r.d) q += 1n;
  return { coefficient: negative ? -q : q, scale: places };
}

/** Splits "5 km", "5km", "-40 °F" or "98.6°F" into its number and unit text. */
function splitQuantity(text: string): { number: string; unit: string } | null {
  const m = /^\s*([-−+]?[\d.,'’   ]*\d)\s*([^\d\s.,+\-−].*?)\s*$/.exec(text);
  if (m === null) return null;
  return { number: m[1] as string, unit: m[2] as string };
}

export function convertQuantity(span: ValueRef, to: string, sourceLocale: string | undefined, precision?: number): Resolution<Quantity> {
  const text = span.quote;
  if (CURRENCY.test(text) || CURRENCY.test(to)) return unsupported("currency conversion is not done");
  if (precision !== undefined && (!Number.isInteger(precision) || precision < 0 || precision > 12)) return unsupported(`precision ${precision} is not a whole number of places from 0 to 12`);
  const parts = splitQuantity(text);
  if (parts === null) return unsupported(`"${text.trim()}" is not a number followed by a unit`);
  const from = unitFor(parts.unit);
  if (from === null) return unsupported(`"${parts.unit}" is not a unit Caret converts`);
  const target = unitFor(to);
  if (target === null) return unsupported(`"${to}" is not a unit Caret converts`);
  if (from.dimension !== target.dimension) return unsupported(`${from.symbol} is a ${from.dimension} and ${target.symbol} a ${target.dimension}; they do not convert`);
  let amount: Decimal | string;
  if (/^[-−+]?\d+$/.test(parts.number)) amount = readDecimal(parts.number, numberStyle("en") as NonNullable<ReturnType<typeof numberStyle>>);
  else if (sourceLocale === undefined) return unsupported(`"${parts.number}" has separators, and the source's locale is unknown`);
  else {
    const style = numberStyle(sourceLocale);
    if (style === null) return unsupported(`no number rules for locale ${sourceLocale}`);
    amount = readDecimal(parts.number, style);
  }
  if (typeof amount === "string") return unsupported(amount);
  const base = add(mul(toRational(amount), from.scale), from.offset);
  const out = div(add(base, rat(-target.offset.n, target.offset.d)), target.scale);
  const exact = exactDecimal(out);
  if (precision === undefined) {
    if (exact === null) return unsupported(`${decimalString(amount)} ${from.symbol} in ${target.symbol} does not end; give a precision`);
    return resolved({ value: exact, unit: target.symbol, rounded: false }, `${decimalString(exact)} ${target.symbol}`, [span]);
  }
  const value = roundTo(out, precision);
  const rounded = exact === null || exact.scale > precision;
  const display = rounded ? `≈ ${decimalString(value)} ${target.symbol}, rounded to ${precision} place${precision === 1 ? "" : "s"}` : `${decimalString(value)} ${target.symbol}`;
  return resolved({ value, unit: target.symbol, rounded }, display, [span], rounded ? [`rounded half away from zero to ${precision} places`] : []);
}
