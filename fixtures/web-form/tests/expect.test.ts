// The task pages' expectations against the pages themselves, without a browser: every field has an expected
// value or explicit alternatives, the values are in the form the oracle reads, and the sources are synthetic.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FixtureSite } from "../server.ts";
import { EXPECT_DIR, PLACES, SCHOOLS, TASK_PAGES, loadExpectation, search } from "../tasks/site.ts";

const PUBLIC = fileURLToPath(new URL("../public/tasks/", import.meta.url));
const OPTIONS = readFileSync(`${PUBLIC}options.js`, "utf8");

/** data-oracle keys and kinds declared in a page's HTML files (templates included). */
function declared(files: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of files) {
    for (const m of readFileSync(`${PUBLIC}${file}`, "utf8").matchAll(/<[^>]*\sdata-oracle="([^"]+)"[^>]*>/g)) {
      const kind = /data-oracle-kind="([^"]+)"/.exec(m[0])?.[1];
      assert.ok(kind !== undefined, `${file}: field ${m[1]} has no data-oracle-kind`);
      assert.ok(!out.has(m[1] as string), `${file}: two fields named ${m[1]}`);
      out.set(m[1] as string, kind);
    }
  }
  return out;
}

for (const page of TASK_PAGES) {
  test(`${page.name}: one expectation per field, each in the form the oracle reads`, () => {
    const fields = declared(page.files);
    const e = loadExpectation(page.name);
    assert.deepEqual(Object.keys(e.expected).sort(), [...fields.keys()].sort());
    const valued = Object.entries(e.expected).filter(([, v]) => v !== "none");
    assert.deepEqual(Object.keys(e.basis).sort(), valued.map(([k]) => k).sort(), "a basis for exactly the fields with a value");
    for (const [k, accepted] of valued) {
      for (const v of typeof accepted === "string" ? [accepted] : accepted) {
        const kind = fields.get(k);
        assert.notEqual(v, "", `${k}: empty is written "none"`);
        if (kind === "checkbox") assert.equal(v, "true", `${k}: a checkbox expects "true" or "none"`);
        if (kind === "pressgroup") assert.ok(v === "Yes" || v === "No", `${k}: ${v}`);
        if (k === "school") assert.ok(SCHOOLS.includes(v), `${k}: ${v} is not a school the picker lists`);
        if (k === "location") assert.ok(PLACES.includes(v), `${k}: ${v} is not a place the picker lists`);
        if (kind === "react-select" && k !== "school" && k !== "location") assert.ok(OPTIONS.includes(`"${v}"`), `${k}: ${v} is not an option`);
      }
    }
    for (const k of Object.keys(e.expected).filter((x) => x.startsWith("eeo_"))) assert.equal(e.expected[k], "none", `${k}: self-identification is never filled`);
  });

  test(`${page.name}: sources are synthetic`, () => {
    const text = JSON.stringify(loadExpectation(page.name).sources);
    for (const m of text.matchAll(/[\w.+-]+@([\w-]+\.)+\w+/g)) assert.match(m[0], /@example\.(com|org|net)$/, `email ${m[0]}`);
    for (const m of text.matchAll(/\b\d{3}[-. ]\d{4}\b/g)) assert.match(m[0], /^555[-. ]01\d\d$/, `phone ${m[0]}`);
  });
}

test("the size-limit page has exactly 40 fields", () => {
  assert.equal(declared(["forty.html"]).size, 40);
});

test("search matches every query word against word starts", () => {
  assert.deepEqual(search(SCHOOLS, "northfield"), ["Northfield State University", "Northfield College"]);
  assert.deepEqual(search(SCHOOLS, "north tech"), ["North Coast Institute of Technology"]);
  assert.deepEqual(search(PLACES, "portland"), ["Portland, Oregon, United States", "Portland, Maine, United States"]);
  assert.deepEqual(search(SCHOOLS, "  "), []);
  assert.deepEqual(search(SCHOOLS, "orth"), [], "not inside a word");
});

test("the fixture server serves every task page and never the expectations", async () => {
  const site = new FixtureSite();
  await site.start();
  try {
    for (const p of TASK_PAGES) assert.equal((await fetch(`${site.mainOrigin}${p.path}`)).status, 200, p.path);
    assert.equal((await fetch(`${site.mainOrigin}/tasks/greenhouse/form`)).status, 200);
    assert.equal((await fetch(`${site.mainOrigin}/tasks/expect/wizard-1.json`)).status, 404);
    assert.equal((await fetch(`${site.mainOrigin}/form`)).status, 200, "the existing pages still serve");
  } finally {
    await site.stop();
  }
});

test("a malformed probe report is recorded as an error, not dropped or fatal", async () => {
  const site = new FixtureSite();
  await site.start();
  try {
    const r = await fetch(`${site.mainOrigin}/tasks/oracle/state`, { method: "POST", body: JSON.stringify({ page: "x" }) });
    assert.equal(r.status, 400);
    assert.match(site.tasks.oracle.probeErrors[0]?.error ?? "", /lacks frame, loadId, seq, reason, fields/);
  } finally {
    await site.stop();
  }
});

/** Exercise the real file loader without changing any development key. */
function withKey(expected: unknown, check: (page: string) => void): void {
  const page = `oracle-validation-${process.pid}`;
  const path = `${EXPECT_DIR}${page}.json`;
  writeFileSync(path, JSON.stringify({ page, expected: { name: expected } }), { flag: "wx" });
  try { check(page); } finally { unlinkSync(path); }
}

for (const [value, reason] of [
  [[], "non-empty"],
  [["", "Elif"], "blank"],
  [[" "], "blank"],
  [[" "], "blank"],
  [["\t\n "], "blank"],
  [["İ", "I\u0307"], "duplicate"],
  [["same", "same"], "duplicate"],
  [["none"], "none"],
  [["name", "none"], "none"],
  [["name", 1], "string"],
  [[null], "string"],
  [[["nested"]], "string"],
  [null, "string"],
  [true, "string"],
  [{ value: "name" }, "string"],
] as const) {
  test(`expectation loader rejects ${JSON.stringify(value)} with page and field`, () => {
    withKey(value, (page) => assert.throws(() => loadExpectation(page), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(page), error.message);
      assert.match(error.message, /name/);
      assert.ok(error.message.includes(reason), error.message);
      return true;
    }));
  });
}

for (const value of ["none", "Işık", ["Işık"], ["Işık", "İ"], ["123", "１２３"], ["Elif", "elif", " Elif "]]) {
  test(`expectation loader accepts ${JSON.stringify(value)} unchanged`, () => {
    withKey(value, (page) => assert.deepEqual(loadExpectation(page).expected.name, value));
  });
}
