// I3 (N1's rule): when an Ask names a person, both wordings of the owner question show each value's whole source line,
// so Jev reads "landlord - Gary Pruitt, (512) 555-0193, gpruitt@example.net" for Gary's email, not the fragment
// "555-0193, gpruitt@example.net" (line-values.ts partAround). Being on that person's line is evidence for Jev, never
// proof: code reads no owner from it, and an owner Jev leaves unsettled still keeps the value out. Synthetic corpus only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { Snapshot } from "../src/protocol.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { planAsk, type AskDraft } from "../src/planner/ask.ts";
import { buildDesk, loadCorpus, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { field, snap } from "./builders.ts";

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const desk = (): Desk => buildDesk(corpus, snaps, corpus.forms.find((f) => f.id === "rental-application") ?? (() => { throw new Error("no form"); })());
const LINE = "landlord - Gary Pruitt, (512) 555-0193, gpruitt@example.net";
const LANDLORD = ["Landlord or property manager name", "Landlord phone"];

/**
 * Heads at 0.9; the scope ask chooses the landlord fields; each owner question answers `owner` for Gary's values and
 * "user" for the rest; the value questions pick Gary's name and phone.
 */
function jev(owner: { choice: string; confidence: number }) {
  const seen: JevRequest[] = [];
  const ask: AskJev = async (req) => {
    seen.push(req);
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        if (id === "route") return [id, { choice: "some", confidence: 0.9 }];
        if (id === "source") return [id, { choice: "any", confidence: 0.9 }];
        if (id === "why") return [id, { choice: "nothingToFill", confidence: 0.9 }];
        if (id === "whose") return [id, { choice: "user", confidence: 0.9 }];
        if (id.startsWith("s_")) return [id, { choice: LANDLORD.some((l) => ins.includes(`'${l}'`)) ? "asks" : "not", confidence: 0.99 }];
        if (id.endsWith("_owner")) return [id, /Gary|gpruitt|555-0193/u.test(ins) ? owner : { choice: "user", confidence: 0.9 }];
        if (id.endsWith("_whose")) return [id, { choice: "other" in q.criteria ? "other" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 }];
        if ("yes" in q.criteria) return [id, { choice: "yes", confidence: 0.9 }];
        const want = /Landlord phone/u.test(ins) ? "(512) 555-0193" : /Landlord or property manager name/u.test(ins) ? "Gary Pruitt" : null;
        const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
        return [id, { choice: hit?.[0] ?? "none", confidence: 0.95 }];
      }),
    );
    return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
  };
  /** Every owner question asked about a value, by its text, across requests. */
  const ownerQuestions = (value: string): string[] =>
    seen.flatMap((r) => Object.entries(r.questions).filter(([id]) => id.endsWith("_owner") && r.subjects?.[id] === value).map(([, q]) => String(q.instructions)));
  return { ask, seen, ownerQuestions };
}
const run = (instruction: string, j: ReturnType<typeof jev>, more?: (d: Desk) => void) => {
  const d = desk();
  more?.(d);
  return planAsk(instruction, d.model, { values: () => d.memory }, d.about, { askJev: j.ask, maker: headsIntentMaker(j.ask), writer: null, offerKey: "i3o", windowId: d.form.window.windowId, now: 2000 });
};

describe("the owner question of an Ask that names a person", () => {
  it("shows the whole line around Gary's email and phone in both wordings", async () => {
    const j = jev({ choice: "person", confidence: 0.95 });
    const d = (await run("use Gary's info for the landlord part", j)) as AskDraft;
    expect(d.checked.writes.map((w) => w.value)).toEqual(["Gary Pruitt", "(512) 555-0193"]);
    for (const value of ["gpruitt@example.net", "(512) 555-0193"]) {
      const asked = j.ownerQuestions(value);
      expect(asked, value).toHaveLength(2);
      for (const q of asked) expect(q, value).toContain(`in the line '${LINE}'`);
    }
  });

  it("writes nothing of Gary's when Jev leaves the owner unsettled, though his line names him", async () => {
    const j = jev({ choice: "unclear", confidence: 0.9 });
    const d = await run("use Gary's info for the landlord part", j).catch((e: unknown) => e);
    const writes = d instanceof Error ? [] : (d as AskDraft).checked.writes.map((w) => w.value);
    expect(writes).not.toContain("(512) 555-0193");
    expect(j.ownerQuestions("(512) 555-0193").every((q) => q.includes(LINE))).toBe(true);
  });
});

describe("the owner line's disclosure", () => {
  it("declares a whole line that no clause had sent, in every request that quotes it (review R1)", async () => {
    // A labelled line offers its parts, not itself, and the email's clause stops at the semicolon (line-values.ts
    // clauseAround, partAround): only the whole line names Gary beside the email, and no span or clause sends it.
    const long = "Landlord: Gary Pruitt; gpruitt.cedar@example.net, (512) 555-0177";
    const j = jev({ choice: "person", confidence: 0.95 });
    await run("use Gary's info for the landlord part", j, (d) =>
      d.model.apply(snap([field("te/gary", long, { role: "AXTextArea" })], { at: T0 - 20_000, windowId: "gary-note", title: "Gary.txt", app: { pid: 7998, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true })),
    ).catch(() => undefined);
    const quoting = j.seen.filter((r) => Object.values(r.questions).some((q) => String(q.instructions).includes(`in the line '${long}'`)));
    expect(quoting.length).toBeGreaterThan(0);
    for (const r of quoting) expect(r.snippets.map((x) => x.text)).toContain(long);
  });
});

describe("the owner question of an Ask that names no one", () => {
  it("keeps the clause it had, not the whole line", async () => {
    const j = jev({ choice: "other", confidence: 0.95 });
    await run("fill in the landlord part from my notes", j).catch(() => undefined);
    const asked = j.ownerQuestions("gpruitt@example.net");
    expect(asked.length).toBeGreaterThan(0);
    for (const q of asked) expect(q).not.toContain(LINE);
  });
});
