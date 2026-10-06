// L1: the source excerpts golden (fixtures/golden/source-excerpts.ndjson), the contract the host's page task panel
// decodes: a host hello that declares sourceExcerpts, and a page preview whose rows say where each value came from (a
// native window, a tab, what the user told Caret, the request) with a crop of that source, and whose `left` names a field
// left on purpose (a hatch) and one Caret found nothing for (a dotted blank). Every name and value is invented.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConsumerMessage, HelperMessage, type GoalProgress } from "../src/protocol.ts";

type Segment = Extract<GoalProgress, { event: "segment" }>;
interface Excerpt {
  text: string;
  start: number;
  end: number;
  name: string;
  edited: number | null;
  tab?: { title: string; host: string };
}
type Row = Segment extends { page?: infer P } ? NonNullable<P> extends { rows: (infer R)[] } ? R & { source?: { kind: string; name: string }; excerpt?: Excerpt } : never : never;

const lines = readFileSync(new URL("../fixtures/golden/source-excerpts.ndjson", import.meta.url), "utf8").trim().split("\n");
const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const CONSUMER = new Set(["hello", "planRequest", "goalAccept", "taskControl"]);

describe("the source excerpts golden (fixtures/golden/source-excerpts.ndjson)", () => {
  it("parses every line and writes it back byte for byte", () => {
    for (const [i, l] of lines.entries()) {
      const m = parsed[i] as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), `line ${i + 1}`).toBe(l);
    }
  });

  it("is a host that declared sourceExcerpts, one preview, its acceptance, a receipt per step and the finish", () => {
    expect(parsed[0]).toMatchObject({ type: "hello", host: true });
    expect(parsed[0]?.capabilities).toEqual(expect.arrayContaining(["goalPlans", "sourceExcerpts"]));
    expect(parsed.map((m) => (m.type === "goalProgress" ? `goalProgress:${String(m.event)}` : m.type))).toEqual(["hello", "planRequest", "goalProgress:segment", "goalAccept", "goalProgress:step", "goalProgress:step", "goalProgress:step", "goalProgress:step", "goalProgress:finished"]);
    const preview = parsed[2] as Segment;
    const accept = parsed[3] as { goalId: string; segment: number; digest: string };
    expect(accept).toMatchObject({ goalId: preview.goalId, segment: preview.segment, digest: preview.digest });
  });

  it("gives each row its source, and each excerpt's offsets mark the value's span in its text", () => {
    const preview = parsed[2] as Segment;
    const rows = (preview.page?.rows ?? []) as Row[];
    for (const r of rows) expect(preview.steps.find((x) => x.index === r.step)?.kind).toBe("write");
    expect(rows.map((r) => r.source?.kind)).toEqual(["window", "tab", "memory", "request"]);
    expect(rows.map((r) => r.excerpt?.name ?? null)).toEqual(["Robin's details.txt", "Robin Vale - Profile", "Phone", null]);
    for (const r of rows) {
      const x = r.excerpt;
      if (x === undefined) continue;
      expect(x.text.slice(x.start, x.end)).toBe(r.value);
      expect(x.edited).toBeNull();
    }
    expect(rows[1]?.excerpt?.tab).toEqual({ title: "Robin Vale - Profile", host: "people.example.test" });
  });

  it("names a hatch and a dotted blank in `left`, each with the sentence it adds to the warnings", () => {
    const preview = parsed[2] as Segment;
    const left = (preview.page as { left?: { label: string; why: string; says: string }[] }).left ?? [];
    expect(left.map((x) => x.why)).toEqual(["answer", "notFound"]);
    for (const x of left) expect(preview.warnings).toContain(x.says);
    const finished = parsed.at(-1) as { left: string[] };
    expect(finished.left.map((s) => `${s}.`)).toEqual(left.map((x) => x.says));
  });

  it("refuses an excerpt the contract rules out", () => {
    const preview = parsed[2] as Segment;
    const page = preview.page as unknown as { rows: Record<string, unknown>[] };
    const withExcerpt = (excerpt: unknown): boolean => HelperMessage.safeParse({ ...preview, page: { ...page, rows: [{ ...page.rows[0], excerpt }] } }).success;
    const x = page.rows[0]?.excerpt as Excerpt;
    expect(withExcerpt(x)).toBe(true);
    expect(withExcerpt({ ...x, end: x.text.length + 1 })).toBe(false);
    expect(withExcerpt({ ...x, start: x.end })).toBe(false);
    expect(withExcerpt({ ...x, pdf: { path: "/a.pdf", page: 0 }, tab: { title: "t", host: "h.test" } })).toBe(false);
  });
});
