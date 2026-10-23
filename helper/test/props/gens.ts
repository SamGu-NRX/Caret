// Generators for the fill write-contract properties (fast-check 4.10.2, exactly pinned in helper/package.json).
// Every name, number and address is invented; phones stay in the fictional 555-01xx range and domains in
// .example, as the repo's fixtures do. The properties run at one fixed seed (SEED) so a failing case
// reproduces; run counts live with each property.
import fc from "fast-check";
import { luhn } from "../../src/memory/sensitive.ts";

/** One seed for every property: the fixed test clock's date (test/setup/fixed-clock.ts). */
export const SEED = 20261008;
/** fast-check's parameters at the fixed seed, with a per-property run count. */
export const runs = (numRuns: number): fc.Parameters<unknown> => ({ seed: SEED, numRuns });

const FIRST = ["Dana", "Priya", "Marcus", "Elena", "Tamsin", "Jo", "Bo", "Simone", "Harper", "Kenji"] as const;
const LAST = ["Whitfield", "Raman", "Cole", "Varga", "Reyes", "Okafor", "Tanaka", "Marsh", "Ito", "Abernathy"] as const;
const DOMAIN = ["lumen.example", "gmail.example", "northwind.example", "post.example"] as const;
const CITY = ["Austin", "Boulder", "Riverside", "Portland", "Denver"] as const;
const JOB = ["lab technician", "field coordinator", "archivist", "dispatcher", "electrician"] as const;
const STREET = ["455 Congress Ave", "214 Mill Street", "8 Orchard Lane", "12 Cedar Road"] as const;

export interface Person {
  first: string;
  last: string;
  name: string;
  email: string;
  phone: string;
}

/** A synthetic person: one name, one email, one phone, all derived from the same identity. */
export const arbPerson: fc.Arbitrary<Person> = fc
  .record({ first: fc.constantFrom(...FIRST), last: fc.constantFrom(...LAST), domain: fc.constantFrom(...DOMAIN), tel: fc.nat({ max: 99 }).map((n) => String(n).padStart(2, "0")) })
  .map((p) => ({
    first: p.first,
    last: p.last,
    name: `${p.first} ${p.last}`,
    email: `${p.first.toLowerCase()}.${p.last.toLowerCase().replace(/-/gu, "")}@${p.domain}`,
    phone: `720 555 01${p.tel}`,
  }));

/** Two people whose details nowhere collide, so no decoy is the user's by accident. */
export const arbUserAndDecoy: fc.Arbitrary<[Person, Person]> = fc
  .tuple(arbPerson, arbPerson)
  .filter(([u, d]) => u.email !== d.email && u.phone !== d.phone && u.name !== d.name);

/** An ordinary value a form asks for: a name, a city, a job title, a street line, a plain sentence. */
export const arbPlainValue: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...CITY),
  fc.constantFrom(...JOB),
  fc.constantFrom(...STREET),
  arbPerson.map((p) => p.name),
  fc.constantFrom("I can start on Monday", "Two references attached", "Available after three", "Fluent in Spanish"),
);

/** Whole values of each kind the wrap and kind checks read (kinds.ts WHOLE). */
export const arbEmail = arbPerson.map((p) => p.email);
export const arbUrl = fc.record({ host: fc.constantFrom("github.com", "lumen.example", "site.example"), path: fc.option(fc.constantFrom("harperq-data", "docs/notes", "about"), { nil: undefined }) }).map((u) => `https://${u.host}/${u.path ?? "feed"}`);
export const arbPhone = arbPerson.map((p) => p.phone);
export const arbId = fc.nat({ max: 99999999 }).map((n) => String(n + 1000000));

/** The pairs kinds.ts PAIRS knows, as an open and a close bracket or quote around the whole value. */
export const arbPair = fc.record({
  open: fc.constantFrom('"', "'", "\u201c", "\u2018", "\u00ab", "<", "(", "["),
  close: fc.constantFrom('"', "'", "\u201d", "\u2019", "\u00bb", ">", ")", "]"),
})
  // A real pair only: the wrap checks read the open mark's own close (kinds.ts PAIRS).
  .filter(({ open, close }) => PAIRS_OF.some(([o, c]) => open === o && close === c));

const PAIRS_OF: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["\u201c", "\u201d"],
  ["\u2018", "\u2019"],
  ["\u00ab", "\u00bb"],
  ["<", ">"],
  ["(", ")"],
  ["[", "]"],
];

/** Sentence punctuation a sentence may leave on a value (kinds.ts TRAILING). */
export const arbTrailing = fc.constantFrom(".", ",", ";", ":", "!", "?", "\u3002");

/** Whitespace around a value, as a note's line carries it. */
export const arbSpaces = fc.constantFrom(" ", "  ", "\t", " \t");

/** A Luhn-valid card number, 13 to 19 digits, written compact, spaced or dashed. */
export const arbCard: fc.Arbitrary<string> = fc
  .record({ len: fc.nat({ max: 6 }), body: fc.nat({ max: 10 ** 14 }).map((n) => String(n).padStart(14, "1")), sep: fc.constantFrom("", " ", "-") })
  .map(({ len, body, sep }) => {
    const digits = (body + String(len).padStart(2, "7")).slice(0, 11 + len);
    const check = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find((c) => luhn(digits + String(c)));
    const full = digits + String(check);
    return sep === "" ? full : full.replace(/(.{4})/gu, `$1${sep}`).trim();
  });

/** A dashed US social security number, and an IBAN with its groups. */
export const arbSsn = fc.record({ a: fc.nat({ max: 899 }).map((n) => n + 100), b: fc.nat({ max: 89 }).map((n) => n + 10), c: fc.nat({ max: 8999 }).map((n) => n + 1000) }).map(({ a, b, c }) => `${a}-${b}-${c}`);
export const arbIban = fc
  .record({ cc: fc.constantFrom("DE", "GB", "FR", "NL", "CH"), groups: fc.nat({ max: 3 }), rest: fc.nat({ max: 99 }).map((n) => String(n).padStart(2, "0")), spaced: fc.boolean() })
  .map(({ cc, groups, rest, spaced }) => {
    const body = Array.from({ length: 2 + groups }, (_, i) => (i === 0 ? `${rest}04` : String(1000 + i * 137 + rest.charCodeAt(0) * 7).slice(0, 4))).join(spaced ? " " : "");
    return `${cc}12${spaced ? " " : ""}${body}`;
  });

const KEY_BODY = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const body = (min: number, max: number): fc.Arbitrary<string> => fc.array(fc.constantFrom(...KEY_BODY.split("")), { minLength: min, maxLength: max }).map((a) => a.join(""));

/** A value shaped like a known API key, token, JWT or private key fence (sensitive.ts API_KEY_SHAPES). */
export const arbApiKey = fc.oneof(
  body(24, 30).map((b) => `sk-${b}`),
  body(16, 24).map((b) => `sk_live_${b}`),
  body(36, 36).map((b) => `ghp_${b}`),
  body(30, 30).map((b) => `github_pat_${b}`),
  body(14, 20).map((b) => `xoxb-${b}`),
  fc.array(fc.constantFrom(..."0123456789ABCDEF".split("")), { minLength: 16, maxLength: 16 }).map((a) => `AKIA${a.join("")}`),
  body(35, 35).map((b) => `AIza${b}`),
  body(24, 24).map((b) => `gsk_${b}`),
  fc.constant("-----BEGIN PRIVATE KEY-----"),
  body(30, 34).map((b) => `eyJhbGciOiJIUzI1Ni${b}.${b}xwRJSmeKKF2QT4fwpMeJ${b.slice(0, 12)}`),
);

/** Any value the write contract must never type (memory/sensitive.ts valueKind). */
export const arbSecret = fc.oneof(arbCard, arbSsn, arbIban, arbApiKey);

/** A label that names a secret kind (memory/sensitive.ts LABEL_PHRASES), and one that does not. */
export const arbSecretLabel = fc.constantFrom("Card number", "Credit card", "CVV", "Security code", "Password", "Passphrase", "PIN", "Account number", "Routing number", "IBAN", "SSN", "Passport number", "Driver's license number", "API key", "Access token", "Client secret", "One-time code", "Verification code");
export const arbPlainLabel = fc.constantFrom("Reference", "First name", "City", "Notes", "Company", "Start date", "Preferred language", "Emergency contact");

/** A token a person states as their secret: a passphrase, or a card number. */
export const arbSecretToken: fc.Arbitrary<string> = fc.oneof(body(6, 14), arbCard);

/** A prose sentence that states a secret the way statedSecret reads one (sensitive.ts statedSecret), with the token it states. */
export const arbSecretSentence: fc.Arbitrary<[string, string]> = fc
  .record({ value: arbSecretToken, style: fc.nat({ max: 4 }) })
  .map(({ value, style }) => {
    const digits = value.replace(/\D/gu, "") || "7319";
    switch (style) {
      case 0:
        return [`put my password ${value} in Notes`, value];
      case 1:
        return [`my password for the portal is ${value}`, value];
      case 2:
        return [`Password: ${value}`, value];
      case 3:
        return [`my PIN is ${digits}`, digits];
      default:
        return [`our api key is ${value}`, value];
    }
  });
