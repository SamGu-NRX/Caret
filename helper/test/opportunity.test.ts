// The opportunity report on synthetic shadow rows and a synthetic power log.
import { describe, expect, it } from "vitest";
import { humanActiveSpans, opportunityReport, renderOpportunity } from "../src/opportunity.ts";
import type { ShadowRow, TransferRow } from "../src/store.ts";

const T = (hhmm: string): number => Date.parse(`2026-03-04T${hhmm}:00-06:00`);
const KERNEL = 'UserIsActive "com.apple.powermanagement.kernel.useractive AppleHIDTransportHIDDevice:kIOHIDSystemActivityTickle nxEvent: 0"';
const pm = (hhmmss: string, owner: string, event: string, desc: string, since: string): string =>
  `2026-03-04 ${hhmmss} -0600 Assertions          \tPID 346(${owner}) ${event} ${desc} ${since}  id:0x0x1 [System: kCPU]`;

describe("human activity spans", () => {
  const log = [
    "2026-03-04 08:00:00 -0600 Sleep  \tEntering Sleep state",
    pm("09:00:00", "powerd", "Created", KERNEL, "00:00:00"),
    pm("09:15:26", "powerd", "Summary", KERNEL, "00:00:26"), // last input 09:15:00
    pm("09:30:00", "powerd", "TimedOut", KERNEL, "00:10:00"), // last input 09:20:00
    // Posted events raise WindowServer's own assertion, which is not a person.
    pm("09:40:00", "WindowServer", "Created", 'UserIsActive "com.apple.iohideventsystem.queue.tickle.nxevent service:IOHIDSystem pid:42 process:fixture-keys"', "00:00:00"),
    pm("10:00:00", "powerd", "Created", KERNEL, "00:00:00"),
    pm("10:15:26", "powerd", "Summary", KERNEL, "00:05:26"), // last input 10:10:00, still raised
  ].join("\n");

  it("runs each powerd assertion from its creation to its last input and ignores posted events", () => {
    expect(humanActiveSpans(log, T("10:30"))).toEqual([
      { from: T("09:00"), to: T("09:20") },
      // Still raised when the log ends: input within its ten-minute timeout, capped at that.
      { from: T("10:00"), to: T("10:20") },
    ]);
  });

  it("does not extend an open span past now", () => {
    expect(humanActiveSpans(log, T("10:12")).at(-1)).toEqual({ from: T("10:00"), to: T("10:12") });
  });
});

const row = (at: number, existed: ShadowRow["existed"], extra: Partial<ShadowRow> = {}): ShadowRow => ({
  at,
  trigger: "focus",
  dstBundle: "dev.caret.form",
  dstKeyHash: "k",
  enteredLength: 12,
  enteredHash: "h",
  existed,
  srcBundle: existed === "no" ? null : "dev.caret.mail",
  srcKeyHash: existed === "no" ? null : "s",
  srcAgeMs: existed === "no" ? null : 60_000,
  kind: null,
  ...extra,
});

const transfer = (at: number): TransferRow => ({
  at,
  valueHash: "v",
  kind: "email",
  length: 20,
  match: "exact",
  srcBundle: "dev.caret.mail",
  srcWindowKind: "standard",
  srcKeyHash: "s",
  dstBundle: "dev.caret.form",
  dstWindowKind: "standard",
  dstKeyHash: "d",
  ageMs: 30_000,
  attribution: "user",
});

describe("opportunity report", () => {
  const report = opportunityReport({
    episodes: [
      row(T("09:05"), "exact", { kind: "email", srcAgeMs: 20_000 }),
      row(T("09:10"), "normalized", { kind: "phone", srcAgeMs: 300_000, srcBundle: "dev.caret.notes" }),
      row(T("09:12"), "no", { kind: "email" }),
      row(T("09:50"), "exact", { srcAgeMs: 100_000 }), // outside the active span
      row(T("07:00"), "exact"), // before the coverage starts
    ],
    transfers: [transfer(T("09:06")), transfer(T("07:00"))],
    counts: { "shadow.field_focus": 9, "shadow.app_switch": 4, "shadow.entry_short": 2 },
    coverage: { from: T("09:00"), to: T("11:00") },
    activeSpans: [{ from: T("08:30"), to: T("09:30") }],
  });

  it("counts entries and findable ones overall, during activity, and per hour", () => {
    expect(report.all).toEqual({ entries: 4, findable: 3, exact: 2, normalized: 1 });
    expect(report.active).toEqual({ entries: 3, findable: 2, exact: 1, normalized: 1 });
    expect(report.coverage).toMatchObject({ wallHours: 2, activeHours: 0.5, activeSpans: 1 });
    expect(report.perActiveHour).toBe(4); // 2 findable in half an active hour
    expect(report.perWallHour).toBe(1.5);
  });

  it("splits by kind, destination and app pair, and summarizes the source age", () => {
    expect(report.byKind.email).toEqual({ entries: 2, findable: 1, exact: 1, normalized: 0 });
    expect(report.byKind.text).toEqual({ entries: 1, findable: 1, exact: 1, normalized: 0 });
    expect(report.byPair).toEqual({ "dev.caret.mail -> dev.caret.form": 2, "dev.caret.notes -> dev.caret.form": 1 });
    expect(report.gap).toEqual({ n: 3, minMs: 20_000, medianMs: 100_000, maxMs: 300_000 });
    expect(report.transfers).toMatchObject({ n: 1, byKind: { email: 1 }, byAttribution: { user: 1 } });
  });

  it("renders counts and bundle ids only", () => {
    const md = renderOpportunity(report);
    expect(md).toContain("| email | 2 | 1 | 1 | 0 | 50% |");
    expect(md).toContain("| dev.caret.mail -> dev.caret.form | 2 |");
    expect(md).toContain("Opportunities per active hour: 4.00");
  });

  it("reports active hours as unknown without activity spans", () => {
    const r = opportunityReport({ episodes: [], transfers: [], counts: {}, coverage: { from: T("09:00"), to: T("10:00") }, activeSpans: null });
    expect(r.perActiveHour).toBeNull();
    expect(renderOpportunity(r)).toContain("Active hours: unknown");
  });
});
