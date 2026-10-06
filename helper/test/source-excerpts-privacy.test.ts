// L1: a source excerpt is the user's own text. It goes to a host that asked for it on the local socket, and nowhere
// else: no warn line, no metric name, not the plan the run keeps, and no message but the preview it is built for.
// Every name and value is invented.
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeRigs, goalMessages, rig, type Segment } from "./page-rig.ts";

afterEach(() => closeRigs());

describe("a page goal's source excerpts (L1)", () => {
  it("appear only in the preview: never in a warn line, a metric name, the kept plan or another message", async () => {
    const warns: string[] = [];
    const r = await rig({ sourceExcerpts: true, warn: (l) => void warns.push(l) });
    const counted: string[] = [];
    const count = r.store.count.bind(r.store);
    vi.spyOn(r.store, "count").mockImplementation((metric: string, n?: number, at?: number) => {
      counted.push(metric);
      count(metric, n, at);
    });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.event).toBe("segment");
    const excerpts = (preview.page?.rows ?? []).flatMap((x) => ((x as { excerpt?: { text: string } }).excerpt === undefined ? [] : [(x as { excerpt: { text: string } }).excerpt.text]));
    expect(excerpts.length).toBeGreaterThan(0);
    await r.accept(preview);
    await r.helper.goals.idle();
    expect(goalMessages(r).some((m) => m.event === "finished")).toBe(true);

    // Each excerpt's whole text, and each line of it longer than any one value it marks.
    const texts = [...new Set(excerpts.flatMap((t) => [t, ...t.split("\n").filter((l) => l.includes(": "))]))];
    expect(texts.length).toBeGreaterThan(1);
    for (const t of texts) {
      for (const w of warns) expect(w).not.toContain(t);
      for (const m of counted) expect(m).not.toContain(t);
    }
    expect(counted.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.helper.goals.planOf(preview.goalId))).not.toContain("excerpt");
    // Only segment previews carry one; step receipts and the finish say nothing of it.
    for (const m of r.published) if (!(m.type === "goalProgress" && m.event === "segment")) expect(JSON.stringify(m)).not.toContain("excerpt");
  });

  it("are never built for an in-process caller, which has no hello to declare them (review L1-3)", async () => {
    const r = await rig({ inProcessExcerpts: true });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(JSON.stringify(preview)).not.toContain("excerpt");
    expect((preview.page?.rows[0] as { source?: unknown } | undefined)?.source).toEqual({ kind: "window", name: "TextEdit" });
  });
});
