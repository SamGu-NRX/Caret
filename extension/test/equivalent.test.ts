// The content script answers "equivalent" with the helper's own module (helper/src/values/equivalent.ts), so the page
// and the helper cannot judge a reformatted number differently. Same golden rows as helper/test/equivalent.test.ts.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { equivalentValue } from "../../helper/src/values/equivalent.ts";
import { equivalentFor } from "../src/content/revs.ts";

interface Row { held: string; wrote: string; equivalent: boolean }
const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../../helper/fixtures/golden/equivalent.json", import.meta.url)), "utf8")) as { numeric: Row[]; text: Row[] };

describe("the page's equivalence rule is the helper's", () => {
  it.each(golden.numeric.map((r) => [r.held, r.wrote, r.equivalent] as const))("numeric: %j against %j is %s", (held, wrote, same) => {
    expect(equivalentValue(true, held, wrote)).toBe(same);
    expect(equivalentFor({ numeric: true }, held, wrote)).toBe(same);
  });
  it.each(golden.text.map((r) => [r.held, r.wrote, r.equivalent] as const))("text: %j against %j is %s", (held, wrote, same) => {
    expect(equivalentValue(false, held, wrote)).toBe(same);
    expect(equivalentFor({ numeric: false }, held, wrote)).toBe(same);
  });
});
