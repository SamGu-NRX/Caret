// A structured store (privacy/send.ts storeJson and its writers) withholds inside string values, never inside the
// encoded text, so what it writes always parses. B31's live scoreboard on v2/int1 failed to parse because a raw-text
// store had withheld part of a number (~/.caret-run/evidence/screen/int1/live-b31/realfill-asks.json: `382.[withheld]`).
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { appendStoreJson, storeJson, StoreKeyCollision, writeStore, writeStoreJson, writeStoreNdjson } from "../src/privacy/send.ts";
import { withholdValues } from "../src/privacy/exclude.ts";

const dir = mkdtempSync(join(tmpdir(), "store-json-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Synthetic values: a phone and a ZIP, which Caret carries and a store keeps; a card number and an SSN, formats Caret
// never carries, which a store withholds. 382.8057290382888 is a latency whose fractional digits read as a card number
// once the record is encoded, the kind of number B31's scoreboard lost.
const PHONE = "+1 512 555 0142";
const ZIP = "78701-1234";
const CARD = "4111 1111 1111 1111";
const SSN = "123-45-6789";
const record = {
  requestMs: [191.5565419999998, 382.8057290382888, 4111111111111111, 5125550142, 78701, -0.0001, 1e21],
  rows: [
    { id: "phone", text: PHONE, right: true, n: 3, note: null },
    { id: "card", text: `card ${CARD} on file`, right: false, n: 0 },
    { id: "zip", text: ZIP, nested: { deeper: [ZIP, 78701.5, `ssn ${SSN}`] } },
  ],
  when: new Date(Date.UTC(2026, 9, 7)),
  skipped: undefined,
};

/** Every number and boolean in a value, in order. */
const scalars = (v: unknown): unknown[] => (Array.isArray(v) ? v.flatMap(scalars) : typeof v === "object" && v !== null ? Object.values(v).flatMap(scalars) : typeof v === "string" ? [] : [v]);
/** Every string in a value, in order. */
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(strings) : typeof v === "object" && v !== null ? Object.values(v).flatMap(strings) : typeof v === "string" ? [v] : []);

describe("structured stores", () => {
  it("the formats under test are ones a store withholds, and text-level withholding of the encoded record does not parse", () => {
    for (const v of [CARD, SSN]) expect(withholdValues(v)).toBe("[withheld]");
    for (const v of [PHONE, ZIP]) expect(withholdValues(v)).toBe(v);
    // The old path: withholding the encoded text reaches into the numbers.
    const p = join(dir, "raw.json");
    writeStore(p, `${JSON.stringify(record, null, 1)}\n`);
    let parsed = true;
    try {
      const back = JSON.parse(readFileSync(p, "utf8")) as unknown;
      parsed = JSON.stringify(scalars(back)) === JSON.stringify(scalars(JSON.parse(JSON.stringify(record))));
    } catch {
      parsed = false;
    }
    expect(parsed).toBe(false);
  });

  it("round-trips as valid JSON with every number intact and only the string values withheld", () => {
    const p = join(dir, "scores.json");
    writeStoreJson(p, record, 1);
    const text = readFileSync(p, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    const back = JSON.parse(text) as unknown;
    const plain = JSON.parse(JSON.stringify(record)) as unknown;
    expect(scalars(back)).toEqual(scalars(plain));
    expect(strings(back)).toEqual(strings(plain).map(withholdValues));
    expect(text).not.toContain(CARD);
    expect(text).not.toContain(SSN);
    expect(text).toContain(PHONE);
    expect(text).toContain(ZIP);
    expect(text).toContain("382.8057290382888");
    // The same shape: keys and structure untouched, undefined dropped and a Date written as JSON writes it.
    expect(Object.keys(back as object)).toEqual(["requestMs", "rows", "when"]);
    expect((back as { when: string }).when).toBe("2026-10-07T00:00:00.000Z");
  });

  it("writes and appends NDJSON a line per record, every line parsing", () => {
    const p = join(dir, "rows.ndjson");
    writeStoreNdjson(p, record.rows);
    appendStoreJson(p, { ask: "card", answer: CARD, ms: 382.8057290382888 });
    const lines = readFileSync(p, "utf8").split("\n");
    expect(lines.pop()).toBe("");
    expect(lines).toHaveLength(4);
    const back = lines.map((l) => JSON.parse(l) as unknown);
    expect(scalars(back)).toEqual(scalars([...record.rows, { ms: 382.8057290382888 }]));
    expect(lines.join("\n")).not.toContain(CARD);
    expect(lines.join("\n")).not.toContain(SSN);
    writeStoreNdjson(join(dir, "empty.ndjson"), []);
    expect(readFileSync(join(dir, "empty.ndjson"), "utf8")).toBe("");
  });

  it("withholds keys too, and refuses rather than merge two keys that withhold alike", () => {
    expect(storeJson({ [CARD]: 1 })).toBe('{"[withheld]":1}');
    const p = join(dir, "collide.json");
    expect(() => writeStoreJson(p, { [CARD]: 1, [SSN]: 2 })).toThrow(StoreKeyCollision);
    expect(existsSync(p)).toBe(false);
  });
});
