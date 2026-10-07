// G2: the ownership truth canned Jev answers from (owners.json, owners.ts). Each listed value must be one a page's own
// sources show, each listed field one the page has, and no value is on both sides; then the matching rules, case by case.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TASK_PAGES, loadExpectation } from "../tasks/site.ts";
import { loadCorpus } from "../../../helper/scripts/realfill-corpus.ts";
import { fieldWhoseAnswer, loadOwners, ownerOfText, ownersOf, ownerQuestionText, sameValue, valueOwnerAnswer } from "../owners.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REALFILL = join(HERE, "..", "..", "realfill");
const truth = loadOwners(join(HERE, "..", "owners.json"), true);
const corpus = loadCorpus(REALFILL);

/** A corpus source's text as its window shows it: a note's file, a mail's headers and body, or memory's values. */
function sourceText(s: (typeof corpus.forms)[number]["source"]): string {
  if (s.kind === "memory") return s.about.map((a) => a.value).join("\n");
  const raw = readFileSync(join(REALFILL, s.file), "utf8");
  if (s.kind === "note") return raw;
  const m = JSON.parse(raw) as Record<string, string>;
  return [m.from, m.to, m.subject, m.body].join("\n");
}
const shows = (text: string, value: string): boolean => text.toLowerCase().includes(value.toLowerCase());

test("every task page and corpus form has an entry, and nothing else does", () => {
  const ids = [...TASK_PAGES.map((t) => t.name), ...corpus.forms.map((f) => f.id)].sort();
  assert.deepEqual(Object.keys(truth).sort(), ids);
});

test("each task page's listed values are in its own note, mail or memory, and its listed fields are its own", () => {
  for (const t of TASK_PAGES) {
    const e = loadExpectation(t.name);
    const o = truth[t.name];
    assert.ok(o !== undefined, t.name);
    const text = [e.sources.note, e.sources.email.from, e.sources.email.to, e.sources.email.body, ...e.sources.memory.map((m) => m.value)].join("\n");
    for (const v of [...o.user, ...o.other]) assert.ok(shows(text, v), `${t.name}: '${v}' is in none of its sources`);
    for (const f of o.otherFields) assert.ok(f in e.expected, `${t.name}: '${f}' is not one of its fields`);
    for (const v of o.user) assert.ok(!o.other.some((x) => x.toLowerCase() === v.toLowerCase()), `${t.name}: '${v}' is on both sides`);
  }
});

test("each corpus form's listed values are in its source or the shared decoys, and its listed fields are its own labels", () => {
  const decoys = corpus.decoys.map(sourceText).join("\n");
  for (const f of corpus.forms) {
    const o = truth[f.id];
    assert.ok(o !== undefined, f.id);
    const text = `${sourceText(f.source)}\n${decoys}`;
    for (const v of [...o.user, ...o.other]) assert.ok(shows(text, v), `${f.id}: '${v}' is in none of its sources`);
    for (const x of o.otherFields) assert.ok(f.fields.some((y) => y.label === x), `${f.id}: '${x}' is not one of its labels`);
  }
});

test("a value is matched whole, never inside a longer word or address, and two letters only as the whole text", () => {
  assert.equal(sameValue("Portland", "2210 Willow Bend Drive, Apt 5B, Portland, Oregon 97214"), true);
  assert.equal(sameValue("Jo Abernathy-Cole <jo.abernathycole@example.com>", "jo.abernathycole@example.com"), true);
  assert.equal(sameValue("Bea", "bea.sutherland@example.com"), false);
  assert.equal(sameValue("June", "Jun"), false);
  assert.equal(sameValue("Jo", "Jo"), true);
  assert.equal(sameValue("Jo Abernathy-Cole", "Jo"), false);
  assert.equal(sameValue("JO.ABERNATHYCOLE@EXAMPLE.COM", "jo.abernathycole@example.com"), true);
});

test("forty: whose each value is, by the page's truth and its memory", () => {
  const e = loadExpectation("forty");
  const o = ownersOf(truth, "forty", e.sources.memory.map((m) => m.value));
  assert.ok(o !== null);
  const cases: [string, "user" | "other" | "unclear"][] = [
    ["jo.abernathycole@example.com", "user"],
    ["Jo Abernathy-Cole <jo.abernathycole@example.com>", "user"],
    ["2210 Willow Bend Drive, Apt 5B, Portland, Oregon 97214", "user"],
    ["Apt 5B", "user"],
    ["555-0164", "user"],
    ["Marcus Cole", "other"],
    ["my husband Marcus Cole, 555-0171, marcus.cole@example.net", "other"],
    ["Elena Varga <elena.varga@example.org>", "other"],
    // Memory: the user's own.
    ["https://www.linkedin.com/in/example-jo-abernathy-cole", "user"],
    // A text naming both sides, and one naming neither.
    ["Jo Abernathy-Cole, meet Elena Varga", "unclear"],
    ["Riverside Food Bank", "unclear"],
  ];
  for (const [text, want] of cases) assert.equal(ownerOfText(text, o), want, text);
});

test("an owner question is answered from its value's quoted text; a named person's question gets the user's only", () => {
  const o = ownersOf(truth, "forty", []);
  const ask = (t: string): string => `A value on the user's screen: "${t}" (email; labelled 'To'; in Mail window 'Re: Reference'). Whose details is it?`;
  const owner = { user: "u", other: "o", unclear: "?" };
  assert.deepEqual(valueOwnerAnswer(ask("jo.abernathycole@example.com"), owner, o), { choice: "user", confidence: 0.95 });
  assert.deepEqual(valueOwnerAnswer(ask("marcus.cole@example.net"), owner, o), { choice: "other", confidence: 0.95 });
  assert.deepEqual(valueOwnerAnswer(ask("Riverside Food Bank"), owner, o), { choice: "unclear", confidence: 0.5 });
  assert.deepEqual(valueOwnerAnswer(ask("marcus.cole@example.net"), { ...owner, person: "p" }, o), { choice: "unclear", confidence: 0.5 });
  assert.deepEqual(valueOwnerAnswer(ask("jo.abernathycole@example.com"), { ...owner, person: "p" }, o), { choice: "user", confidence: 0.95 });
  assert.deepEqual(valueOwnerAnswer(ask("jo.abernathycole@example.com"), owner, null), { choice: "unclear", confidence: 0.5 });
  assert.equal(ownerQuestionText(`Whose details is this value, the user's or someone else's? "Dima (legal name Dmitri Halvorsen)." (labelled 'Preferred first name')`), "Dima (legal name Dmitri Halvorsen).");
});

test("a field question is answered from the page's other fields; a field the harness found no key for is unclear", () => {
  const o = ownersOf(truth, "forty", []);
  const same = (a: string, b: string): boolean => a === b;
  assert.deepEqual(fieldWhoseAnswer("em_phone", o, same), { choice: "other", confidence: 0.95 });
  assert.deepEqual(fieldWhoseAnswer("phone", o, same), { choice: "user", confidence: 0.95 });
  assert.deepEqual(fieldWhoseAnswer(null, o, same), { choice: "unclear", confidence: 0.5 });
  assert.deepEqual(fieldWhoseAnswer("phone", null, same), { choice: "unclear", confidence: 0.5 });
});
