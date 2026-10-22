// The one equivalence rule both sides use (values/equivalent.ts): the page judges its own field with it, the helper a
// native field. extension/test/equivalent.test.ts runs the same golden rows against the same module.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { equivalentValue } from "../src/values/equivalent.ts";

interface Row { held: string; wrote: string; equivalent: boolean }
const golden = JSON.parse(readFileSync(new URL("../fixtures/golden/equivalent.json", import.meta.url), "utf8")) as { numeric: Row[]; text: Row[] };

describe("equivalentValue against the shared golden rows", () => {
  it.each(golden.numeric.map((r) => [r.held, r.wrote, r.equivalent] as const))("in a numeric field, %j against %j is %s", (held, wrote, same) => {
    expect(equivalentValue(true, held, wrote)).toBe(same);
  });
  it.each(golden.text.map((r) => [r.held, r.wrote, r.equivalent] as const))("in a text field, %j against %j is %s", (held, wrote, same) => {
    expect(equivalentValue(false, held, wrote)).toBe(same);
  });
});
