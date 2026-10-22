// The journey's row table (journey-rows.ts): every row the brief names is defined once with an oracle and an owner, and
// the report lists every row with pass or fail and a cause, passing a row only on exact equality.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildReport, reportMarkdown, ROW_IDS, ROWS, type RowId } from "../journey-rows.ts";

test("every row id is defined once, in order, with an oracle, a brief number and an owner", () => {
  assert.deepEqual(ROWS.map((r) => r.id), [...ROW_IDS]);
  assert.deepEqual(ROWS.map((r) => r.number), ["1", "1b", "1c", "2", "3", "4", "5a", "5b", "6"]);
  for (const r of ROWS) {
    assert.ok(r.oracle.trim().length > 20, `${r.id} has no oracle`);
    assert.match(r.owner, /#\d+/, `${r.id} names no owning PR`);
  }
});

test("journey.ts records an observation for every row id", () => {
  const src = readFileSync(new URL("../journey.ts", import.meta.url), "utf8");
  for (const id of ROW_IDS) assert.ok(src.includes(`observe("${id}"`), `journey.ts never observes ${id}`);
});

test("a row passes only when observed equals expected exactly; every other row fails with a cause", () => {
  const r = buildReport("abc1234", "2026-10-11T00:00:00.000Z", {
    "mail-to-event": { driven: true, observed: { title: "Coffee with Theo" }, expected: { title: "Coffee with Theo" } },
    "mail-to-event-undo": { driven: true, observed: { events: 1 }, expected: { events: 0 }, cause: "the event stayed" },
    "ask-fill": { driven: true, observed: { email: "a@example.org " }, expected: { email: "a@example.org" } },
    "stop-mid-fill": { driven: false, observed: null, expected: { writesAfterStop: 0 }, cause: "no preview" },
    "deny-site-off": { driven: false, observed: { snapshots: 0 }, expected: { snapshots: 0 } },
  }, "the run stopped at row 3");
  assert.deepEqual(r.rows.map((x) => x.id), [...ROW_IDS]);
  const by = (id: RowId) => r.rows.find((x) => x.id === id);
  assert.deepEqual([by("mail-to-event")?.pass, by("mail-to-event")?.cause], [true, null]);
  assert.deepEqual([by("mail-to-event-undo")?.pass, by("mail-to-event-undo")?.cause], [false, "the event stayed"]);
  // Near is not equal: a trailing space fails, with a cause even though the run gave none.
  assert.equal(by("ask-fill")?.pass, false);
  assert.ok((by("ask-fill")?.cause ?? "").length > 0);
  // Not driven fails even when observed happens to equal expected.
  assert.equal(by("deny-site-off")?.pass, false);
  assert.match(by("slice2-milestone-a")?.cause ?? "", /^not reached: the run stopped at row 3$/);
  assert.equal(r.passed, 1);
  assert.equal(r.failed, ROW_IDS.length - 1);
  for (const x of r.rows) if (!x.pass) assert.ok(x.cause !== null && x.cause.trim() !== "", `${x.id} failed without a cause`);
  const md = reportMarkdown(r);
  for (const x of r.rows) assert.match(md, new RegExp(`\\| ${x.number} \\| ${x.id} \\| ${x.pass ? "pass" : "FAIL"} \\|`));
});

test("an observation for a row the journey does not define is refused", () => {
  assert.throws(() => buildReport("abc", "now", { "no-such-row": { driven: true, observed: 1, expected: 1 } } as never, "x"), /no-such-row/);
});
