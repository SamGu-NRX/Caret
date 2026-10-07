// I3 (V3's open gap): a writer goal's date or time is minted under the resolverFormat exemption only when the resolver
// reads its source as exactly the written value with no assumption, as fill's controlValue requires. A reading that
// assumed a year, an order or a locale, a provenance that states a choice, and a source that no longer reads as the
// written value all go to the verifier with what Caret assumed said; a refusing verifier leaves the field to the user.
import { afterEach, describe, expect, it } from "vitest";
import type { DraftPlan } from "../src/codemode/types.ts";
import { lowerGoal } from "../src/goals/lower.ts";
import type { GoalInventory, TargetBinding, ValueBinding } from "../src/goals/plan.ts";
import { SnippetLedger } from "../src/privacy.ts";
import { setTestVerifier, type Provenance } from "../src/fill/contract.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { standInJev } from "./goal-desk.ts";
import { targetField } from "./mint.ts";

const page = { kind: "window" as const, windowId: "page:e1:3", pid: 10, bundleId: "com.google.Chrome", appName: "Chrome", title: "Apply", number: null, windowKind: "page", page: true };
const tgt = (ref: string, over: Partial<TargetBinding> = {}): TargetBinding => {
  const t: TargetBinding = { ref, domain: page, key: `f0/date:${ref}~0`, role: "AXDateField", label: `Date ${ref}`, own: `Date ${ref}`, placeholder: null, control: "date", value: "", options: null, ...over };
  const field = targetField(t);
  return field === undefined ? t : { ...t, field };
};
const window = (span: string): Provenance => ({ kind: "window", windowId: "w-src", nodeKey: "src", app: "Mail", title: "Venue", span, label: null, line: null, partOf: null, context: null, lines: [], sentences: [] });
const val = (ref: string, text: string, provenance: Provenance): ValueBinding => ({
  ref,
  text,
  display: `"${text}"`,
  origin: { kind: "derived", inputs: [], resolver: "fill/when", version: "values/1", parametersDigest: "p" },
  source: null,
  memory: null,
  event: null,
  draft: null,
  owner: null,
  provenance,
});
const inventory = (targets: TargetBinding[], values: ValueBinding[]): GoalInventory => ({ readerSession: 1, targets: new Map(targets.map((t) => [t.ref, t])), values: new Map(values.map((v) => [v.ref, v])), revisions: new Map(), documents: new Map(), windowRefs: new Map(), texts: new Map(), owed: new Map() });
const draft = (steps: DraftPlan["steps"]): DraftPlan => ({ basedOn: "s1", window: "w1", steps, choices: [], drafts: [], programDigest: "b".repeat(64) });

/** A verifier that records what it was asked and answers `choice` to every value. */
function recording(choice: "exact" | "other"): AskJev & { asked: string[] } {
  const f = Object.assign(
    async (req: Parameters<AskJev>[0]) => {
      for (const q of Object.values(req.questions)) f.asked.push(typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions));
      return { model: "verify-recorder", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice, confidence: 0.95 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 };
    },
    { asked: [] as string[] },
  );
  return f;
}

afterEach(() => setTestVerifier(STAND_IN));

/** Lowers a plan writing `v` into t1, beside a plain date into t2 so a dropped t1 leaves a plan to show. */
async function lowerOne(v: ValueBinding, verifier: AskJev) {
  setTestVerifier(verifier);
  const plain = val("v2", "2026-10-20", window("October 20, 2026"));
  const inv = inventory([tgt("t1"), tgt("t2")], [v, plain]);
  return lowerGoal("g", "put the dates in", draft([{ ref: "a", kind: "fill", target: "t1", value: v.ref }, { ref: "b", kind: "fill", target: "t2", value: "v2" }]), inv, { askJev: standInJev(), ledger: new SnippetLedger([]) });
}
const stepFor = (g: Awaited<ReturnType<typeof lowerOne>>, ref: string) => g.segments.flatMap((s) => s.steps).find((s) => s.target.ref === ref && s.kind === "write");

describe("a writer goal's resolved date", () => {
  it("is exempt when the resolver reads its source as the written date with no assumption", async () => {
    const g = await lowerOne(val("v1", "2026-10-20", window("October 20, 2026")), recording("exact"));
    expect(stepFor(g, "t1")?.checked?.verdict).toEqual({ by: "exempt", rule: "resolverFormat" });
  });

  it.each([
    ["a year the reading assumed", "2026-10-17", window("October 17")],
    ["a day and month order the locale gave", "2026-10-11", window("10/11/2026")],
    ["a source that does not read as the written date", "2026-10-21", window("October 20, 2026")],
    ["a choice its provenance states", "2026-10-17", { kind: "derived", how: "resolved", base: window("Saturday, October 17"), also: null, says: "Caret assumed: year 2026" } as Provenance],
  ])("goes to the verifier, said, for %s", async (_, text, provenance) => {
    const verifier = recording("exact");
    const g = await lowerOne(val("v1", text, provenance), verifier);
    const checked = stepFor(g, "t1")?.checked;
    expect(checked?.verdict.by).toBe("verifier");
    expect(checked?.provenance.kind === "derived" && checked.provenance.says).toMatch(/\S/u);
    expect(verifier.asked.some((q) => q.includes(text))).toBe(true);
  });

  it("is left to the user, never written, when the verifier refuses a date the reading assumed", async () => {
    const g = await lowerOne(val("v1", "2026-10-17", window("October 17")), recording("other"));
    expect(stepFor(g, "t1")).toBeUndefined();
    expect(stepFor(g, "t2")?.checked?.verdict).toEqual({ by: "exempt", rule: "resolverFormat" });
    expect(g.left.map((l) => [l.label, l.why])).toEqual([["Date t1", "dropped"]]);
  });
});
