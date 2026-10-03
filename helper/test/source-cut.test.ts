// A conversation's privacy budget must never turn a blank into a wrong fill. B11's live replay put the
// calibration fixture's Reference window in Messages; the 600-character cap cut its meeting block and kept
// the order block, and Jev filled Meeting date with the order's Placed date
// (~/.caret-run/evidence/screen/b11/live/live-replay.md). These tests rebuild that window and stand in a
// Jev that picks a same-kind decoy whenever the right value is missing, as live Jev did there.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates, cutKinds } from "../src/fill/candidates.ts";
import { proposeFill, NOT_ASKED } from "../src/fill/fill.ts";
import { fieldKinds } from "../src/fill/kinds.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { SnippetLedger, windowBudget } from "../src/privacy.ts";
import type { AppRef, Node, TypedValue } from "../src/protocol.ts";
import { field, FIXTURE_APP, node, snap, text, value } from "./builders.ts";

const MESSAGES: AppRef = { pid: 8181, bundleId: "com.apple.MobileSMS", name: "Messages" };
const REF = "8181-1";
const FORM = "5150-7";
const R = "dev.caret.messages/standard";

/** The calibration fixture's Reference window, block by block, as a Messages window. */
function reference(at: number): ReturnType<typeof snap> {
  const nodes: Node[] = [];
  const values: TypedValue[] = [];
  const block = (name: string, lines: [string, ...([TypedValue["kind"], string] | [])][]): void => {
    const g = `${R}/group:${name}~0`;
    nodes.push(node(g, "AXGroup", { label: name }));
    lines.forEach(([line, kind, v], i) => {
      const key = `${g}/statictext:${i}~0`;
      nodes.push(text(key, line, undefined, g));
      if (kind !== undefined && v !== undefined) values.push(value(kind, v, key));
    });
    nodes.push(text(`${g}/statictext:title~0`, name, undefined, g));
  };
  block("Order confirmation", [
    ["Order number: ORD-2026-48213", "id", "ORD-2026-48213"],
    ["Placed: September 28, 2026", "date", "September 28, 2026"],
    ["Total: $1,315.50", "amount", "$1,315.50"],
    ["Ship to: 1200 Barton Springs Rd, Austin, TX 78704", "address", "1200 Barton Springs Rd, Austin, TX 78704"],
    ["Tracking: TRK-88213-55", "id", "TRK-88213-55"],
  ]);
  block("Email signature", [
    ["Dana Whitfield"],
    ["Senior Product Designer"],
    ["Lumen Labs"],
    ["dana.whitfield@lumenlabs.example", "email", "dana.whitfield@lumenlabs.example"],
    ["+1 (512) 555-0142", "phone", "+1 (512) 555-0142"],
    ["https://lumenlabs.example/dana", "url", "https://lumenlabs.example/dana"],
  ]);
  block("Meeting", [
    ["Design review with Priya Raman"],
    ["Thursday, October 8, 2026", "date", "Thursday, October 8, 2026"],
    ["3:00 PM to 3:45 PM", "time", "3:00 PM"],
    ["https://meet.example.com/xqp-rtz-kfa", "url", "https://meet.example.com/xqp-rtz-kfa"],
  ]);
  values.push(value("time", "3:45 PM", `${R}/group:Meeting~0/statictext:2~0`));
  return snap(nodes, { at, windowId: REF, title: "Reference", app: MESSAGES, focused: true, values });
}

const FORM_KEY = (label: string): string => `dev.caret.fixture/standard/textfield:${label.toLowerCase().replace(/ /g, "-")}~0`;
function scheduleForm(at: number, labels: readonly string[]): ReturnType<typeof snap> {
  return snap(
    labels.map((l, i) => field(FORM_KEY(l), "", { label: l, frame: [100, 40 + i * 40, 300, 24] })),
    { at, windowId: FORM, title: "Schedule follow-up", app: FIXTURE_APP, focused: true },
  );
}

const SCHEDULE = ["Meeting date", "Start time", "Video link", "Attendee email", "Attendee job title"] as const;
const GOLD: Record<string, string> = {
  "Meeting date": "Thursday, October 8, 2026",
  "Start time": "3:00 PM",
  "Video link": "https://meet.example.com/xqp-rtz-kfa",
  "Attendee email": "dana.whitfield@lumenlabs.example",
  "Attendee job title": "Senior Product Designer",
};
/** What a Jev short of the right value picks instead: another value of the same kind from the same window. */
const DECOYS: Record<string, string[]> = {
  "Meeting date": ["September 28, 2026"],
  "Start time": ["3:45 PM"],
  "Video link": ["https://lumenlabs.example/dana"],
  "Attendee email": [],
  "Attendee job title": ["Lumen Labs"],
};

/** Picks the right value when it is offered, else the first decoy offered, else none; both asks alike. */
const decoyProneJev = (asked: JevRequest[] = []): AskJev => async (req) => {
  asked.push(req);
  const answers: Record<string, { choice: string; confidence: number }> = {};
  for (const [id, q] of Object.entries(req.questions)) {
    const label = SCHEDULE.find((l) => String(q.instructions).includes(`'${l}'`)) ?? "";
    const offered = (t: string): string | undefined => Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${t}"`))?.[0];
    const choice = [GOLD[label], ...(DECOYS[label] ?? [])].map((t) => (t === undefined ? undefined : offered(t))).find((c) => c !== undefined);
    answers[id] = { choice: choice ?? "none", confidence: 0.9 };
  }
  return { model: "jev-test", answers, inputTokens: 1000, latencyMs: 5, costUsd: 0.000042 };
};

function model(labels: readonly string[] = SCHEDULE): ScreenModel {
  const m = new ScreenModel();
  m.apply(reference(1000));
  m.apply(scheduleForm(2000, labels));
  return m;
}

describe("a cut conversation never leaves a decoy", () => {
  it("the B11 case: the Reference window as Messages gives no wrong value on the Schedule follow-up form", async () => {
    const m = model();
    // The window is a conversation, held under half its text.
    expect(windowBudget(m.windows.get(REF)!)).toBeLessThan(300);
    const p = await proposeFill(m, decoyProneJev(), FORM, FORM_KEY("Meeting date"), 3000);
    const byLabel = new Map(p.fields.map((f) => [SCHEDULE.find((l) => f.descriptor.includes(`'${l}'`)), f]));
    for (const l of SCHEDULE) {
      const f = byLabel.get(l)!;
      expect(f.value === null || f.value === GOLD[l], `${l} filled with ${f.value}`).toBe(true);
    }
    expect(byLabel.get("Meeting date")?.value).not.toBe("September 28, 2026");
  });

  it("does not ask a field whose kind lost a value to the cut, and marks it sourceCut", async () => {
    // A form asking only for a date, labelled with words no line of the window shares, so no ordering
    // can tell the meeting date from the order date: only the cut rule stands between them.
    const m = model(["Date", "Notes"]);
    const asked: JevRequest[] = [];
    const ledger = new SnippetLedger();
    const { cut } = collectCandidates(m, FORM, { now: 3000, ledger });
    // Under the window's budget, one of the two dates is left out.
    expect(cut).toEqual([REF]);
    expect(cutKinds(m, cut, ledger).has("date")).toBe(true);
    const p = await proposeFill(m, decoyPicksAnyDate(asked), FORM, FORM_KEY("Date"), 3000);
    const date = p.fields.find((f) => f.key === FORM_KEY("Date"))!;
    expect(date).toMatchObject({ value: null, withheld: "sourceCut", asks: [], choice: "none" });
    // The date field was in no question.
    for (const r of asked) expect(Object.values(r.questions).some((q) => String(q.instructions).includes("'Date'"))).toBe(false);
  });

  it("withholds a pick of a cut kind for a field whose label names no kind", async () => {
    const m = model(["When", "Notes"]);
    expect(fieldKinds(["When"]).size).toBe(0);
    const p = await proposeFill(m, decoyPicksAnyDate(), FORM, FORM_KEY("When"), 3000);
    const when = p.fields.find((f) => f.key === FORM_KEY("When"))!;
    expect(when.value).toBeNull();
    expect(when.withheld).toBe("sourceCut");
    expect(when.asks).toHaveLength(2);
  });

  it("asks nothing when the cut withholds every field", async () => {
    const m = model(["Date"]);
    let calls = 0;
    const p = await proposeFill(m, async (r) => (calls++, decoyPicksAnyDate()(r)), FORM, FORM_KEY("Date"), 3000);
    expect(calls).toBe(0);
    expect(p.jev).toEqual({ model: NOT_ASKED, latencyMs: 0, inputTokens: 0, costUsd: 0 });
    expect(p.fields.map((f) => f.withheld)).toEqual(["sourceCut"]);
  });

  it("asks as before when nothing of the field's kind was cut", async () => {
    // The same window, not a conversation and so not cut: the date field is asked and filled.
    const m = new ScreenModel();
    m.apply({ ...reference(1000), app: { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" } });
    m.apply(scheduleForm(2000, SCHEDULE));
    const p = await proposeFill(m, decoyProneJev(), FORM, FORM_KEY("Meeting date"), 3000);
    expect(p.fields.find((f) => f.key === FORM_KEY("Meeting date"))).toMatchObject({ value: GOLD["Meeting date"], withheld: null });
    expect(p.fields.every((f) => f.withheld !== "sourceCut")).toBe(true);
  });
});

/** A Jev that answers every question with the first date it sees offered, the gold one or not. */
function decoyPicksAnyDate(asked: JevRequest[] = []): AskJev {
  return async (req) => {
    asked.push(req);
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const hit = Object.entries(q.criteria).find(([, d]) => d !== null && /^"(?:Thursday, October 8|September 28), 2026"/.test(d));
      answers[id] = { choice: hit?.[0] ?? "none", confidence: 0.95 };
    }
    return { model: "jev-test", answers, inputTokens: 1000, latencyMs: 5, costUsd: 0.000042 };
  };
}

describe("cut kinds", () => {
  it("counts a cut window's typed values that no taken text holds, and nothing from an uncut window", () => {
    const m = model();
    const ledger = new SnippetLedger();
    const { cut, candidates } = collectCandidates(m, FORM, { now: 3000, ledger });
    const kinds = cutKinds(m, cut, ledger);
    const offered = new Set(candidates.map((c) => c.text));
    const w = m.windows.get(REF)!;
    for (const v of w.values) if (!offered.has(v.text) && ![...offered].some((t) => t.includes(v.text))) expect(kinds.has(v.kind), v.text).toBe(true);
    expect(cutKinds(m, [], ledger).size).toBe(0);
  });

  it("does not count a value taken inside a longer line", () => {
    const m = new ScreenModel();
    const filler = ["See you there", "Bring the deck", "Room is booked"].map((t, i) => text(`f${i}`, t));
    m.apply(snap([text("a", "3:00 PM to 3:45 PM"), ...filler], { at: 1, windowId: REF, app: MESSAGES, values: [value("time", "3:45 PM", "a")] }));
    const ledger = new SnippetLedger();
    expect(ledger.take(m.windows.get(REF)!, "candidate", ["3:00 PM to 3:45 PM"])).toBe(true);
    expect(cutKinds(m, [REF], ledger).size).toBe(0);
  });
});

describe("field kinds", () => {
  it.each([
    ["Meeting date", ["date"]],
    ["Start time", ["time"]],
    ["Email address", ["email"]],
    ["Web address", ["url"]],
    ["Video link", ["url"]],
    ["Phone number", ["phone"]],
    ["Order number", ["id"]],
    ["Order total", ["amount"]],
    ["Shipping address", ["address"]],
    ["Full name", []],
    ["Company", []],
  ])("%s takes %j", (label, kinds) => {
    expect([...fieldKinds([label])].sort()).toEqual([...kinds].sort());
  });
});
