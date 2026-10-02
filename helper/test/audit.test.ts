// The read-only audit on synthetic windows: marker rules by id, simulated watches and the
// clear-then-return episode, fill readiness on focus, and that its summary holds no screen text.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { PROTOCOL_VERSION, type AppRef, type ReaderVerb, type VerbResult } from "../src/protocol.ts";
import { markerRule, pendingMarkers } from "../src/tasks/pending.ts";
import { renderFillReadiness, renderMarkerAudit } from "../src/audit-report.ts";
import { field, focus, MAIL_APP, node, snap, text, value } from "./builders.ts";

describe("marker rule ids", () => {
  it.each([
    ["[progress bar]", "progressBar"],
    ["[busy indicator]", "busyIndicator"],
    ["Running tests… 12 of 48", "verbEllipsis"],
    ["● Building", "statusWord"],
    ["Exporting 40%", "verbCount"],
    ["Status: queued", "labelledStatus"],
  ])("names the rule for %s", (line, id) => expect(markerRule(line)).toBe(id));

  it.each(["[button] Building…", "Loading…", "Room 4B, Building C", "constructor", "toString", "__proto__"])("names none for %s", (line) => {
    expect(markerRule(line)).toBeNull();
    expect(pendingMarkers([line])).toEqual([]);
  });
});

const JOBS: AppRef = { pid: 7170, bundleId: "dev.caret.jobs", name: "Jobs Fixture" };
const FORMS: AppRef = { pid: 5150, bundleId: "dev.caret.fixture", name: "Caret Fixture" };
const JOB = "7170-1";
const MAIL = "6160-1";
const FORM = "5150-1";
const J = (s: string): string => `dev.caret.jobs/standard/${s}`;
const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
const M = (s: string): string => `dev.caret.mail/standard/${s}`;

class Reader implements ReaderLink {
  readonly verbs: ReaderVerb[] = [];
  run(verb: ReaderVerb): Promise<VerbResult> {
    this.verbs.push(verb);
    return Promise.resolve({ type: "verbResult", v: PROTOCOL_VERSION, id: "x", at: 0, outcome: "ok", detail: null });
  }
}

describe("audit", () => {
  let dir: string;
  let store: Store;
  let reader: Reader;
  let helper: Helper;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-audit-test-"));
    store = new Store(dir);
    reader = new Reader();
    helper = new Helper({ store, askJev: null, shadow: true, audit: true, allowBackgroundFocus: false, readerLink: reader, publish: () => undefined });
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const job = (at: number, status: string, focused: boolean, bar: boolean) =>
    snap(
      [text(J("statictext:status~0"), status), ...(bar ? [node(J("progressindicator~0"), "AXProgressIndicator")] : [])],
      { at, windowId: JOB, app: JOBS, focused, title: "Export queue" },
    );
  const mail = (at: number, focused: boolean) =>
    snap(
      [text(M("statictext:a~0"), "Signed, Priya Raman"), text(M("statictext:b~0"), "priya.raman@example.org")],
      { at, windowId: MAIL, app: MAIL_APP, focused, title: "Re: venue deposit", values: [value("email", "priya.raman@example.org", M("statictext:b~0"))] },
    );

  it("refuses to run outside shadow mode or with Jev on", () => {
    expect(() => new Helper({ store, askJev: null, shadow: false, audit: true, allowBackgroundFocus: false, publish: () => undefined })).toThrow(/shadow mode/);
  });

  it("counts the rules that fired when the user left, registers a watch, and times the clear and the return", () => {
    void helper.handleReader(job(1000, "Exporting 40%", true, true));
    void helper.handleReader(mail(2000, true)); // focus moves: the job window is left
    void helper.handleReader(job(9000, "Export finished", false, false)); // markers clear 7 s after the leave
    void helper.handleReader(mail(30_000, false));
    void helper.handleReader(job(80_000, "Export finished", true, false)); // the user comes back 78 s after the leave

    const s = helper.audit?.summary();
    expect(s?.markers.b5.byApp["dev.caret.jobs"]).toMatchObject({ checks: 1, withMarkers: 1, windowsWithMarkers: 1, watches: 1 });
    expect(s?.markers.b5.byApp["dev.caret.jobs"]?.checksByRule).toMatchObject({ progressBar: 1, verbCount: 1, verbEllipsis: 0 });
    expect(s?.markers.b5.byApp["dev.caret.mail"]).toMatchObject({ checks: 1, withMarkers: 0, watches: 0 });
    expect(s?.markers.b5.watches).toEqual({ registered: 1, overLimit: 0, maxConcurrent: 1 });
    expect(s?.markers.b5.episodes).toEqual([
      { bundleId: "dev.caret.jobs", rule: "verbCount", end: "returned", clearedAfterMs: 7000, returnedAfterMs: 78_000, returnsWhileRunning: 0 },
    ]);
    // The reader was asked to watch the window, then to stop once the markers cleared.
    expect(reader.verbs).toEqual([
      { kind: "watchWindows", windows: [{ pid: 7170, windowId: JOB }] },
      { kind: "watchWindows", windows: [] },
    ]);
  });

  it("keeps the watch when the user comes back before the work clears, as B4 does", () => {
    void helper.handleReader(job(1000, "Exporting 40%", true, true));
    void helper.handleReader(mail(2000, true));
    void helper.handleReader(job(3000, "Exporting 40%", true, true)); // back while it still runs
    void helper.handleReader(mail(4000, true)); // and away again: a second leave, no second watch
    let s = helper.audit?.summary();
    expect(s?.markers.b5.byApp["dev.caret.jobs"]).toMatchObject({ checks: 2, withMarkers: 2, windowsWithMarkers: 1, watches: 1 });
    expect(s?.markers.b5.episodes).toEqual([]);
    helper.audit?.stop(5000);
    s = helper.audit?.summary();
    expect(s?.markers.b5.episodes).toEqual([
      { bundleId: "dev.caret.jobs", rule: "verbCount", end: "auditEnded", clearedAfterMs: null, returnedAfterMs: null, returnsWhileRunning: 1 },
    ]);
  });

  it("counts one leave once though the helper reports it three times", () => {
    void helper.handleReader(job(1000, "Running", true, false));
    void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: 1500, from: JOBS, to: MAIL_APP });
    void helper.handleReader({ ...job(1600, "Running", false, false), reason: "leave" });
    void helper.handleReader(mail(1700, true));
    expect(helper.audit?.summary().markers.b5.byApp["dev.caret.jobs"]).toMatchObject({ checks: 1, withMarkers: 1, watches: 1 });
    expect(helper.audit?.summary().markers.b5.byApp["dev.caret.jobs"]?.linesByRule.statusWord).toBe(1);
  });

  it("sees a return through an app it cannot read", () => {
    void helper.handleReader(job(1000, "Running", true, false));
    const other: AppRef = { pid: 9190, bundleId: "dev.caret.unread", name: "Unread" };
    void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: 2000, from: JOBS, to: other });
    void helper.handleReader(job(9000, "Done", false, false));
    void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: 90_000, from: other, to: JOBS });
    void helper.handleReader({ ...job(90_100, "Done", true, false), reason: "focus" });
    expect(helper.audit?.summary().markers.b5.episodes).toEqual([
      { bundleId: "dev.caret.jobs", rule: "statusWord", end: "returned", clearedAfterMs: 7000, returnedAfterMs: 88_100, returnsWhileRunning: 0 },
    ]);
  });

  it("does not take a truncated walk as the markers clearing", () => {
    void helper.handleReader(job(1000, "Running", true, false));
    void helper.handleReader(mail(2000, true));
    void helper.handleReader({ ...snap([], { at: 5000, windowId: JOB, app: JOBS, title: "Export queue" }), stats: { walkMs: 900, visited: 4000, truncated: true } });
    helper.audit?.stop(6000);
    expect(helper.audit?.summary().markers.b5.episodes[0]).toMatchObject({ end: "auditEnded", clearedAfterMs: null });
  });

  it("ends a watch whose window closes", () => {
    void helper.handleReader(job(1000, "Running", true, false));
    void helper.handleReader(mail(2000, true));
    void helper.handleReader({ type: "windowClosed", v: PROTOCOL_VERSION, at: 5000, windowId: JOB });
    expect(helper.audit?.summary().markers.b5.episodes).toEqual([
      { bundleId: "dev.caret.jobs", rule: "statusWord", end: "closed", clearedAfterMs: null, returnedAfterMs: null, returnsWhileRunning: 0 },
    ]);
  });

  describe("fill readiness", () => {
    const form = (at: number) =>
      snap(
        [
          field(F("textfield:email~0"), "", { label: "Email", frame: [200, 100, 200, 20] }),
          text(F("statictext:phone~0"), "Phone:", [100, 140, 60, 20]),
          field(F("textfield~1"), "", { frame: [200, 140, 200, 20] }),
          field(F("textfield~2"), "", { placeholder: "Order number", frame: [200, 400, 200, 20] }),
          field(F("textfield~3"), "", { frame: [900, 700, 200, 20] }),
          field(F("securetextfield~0"), "", { frame: [200, 500, 200, 20], states: ["secure"] }),
          field(F("textfield:name~0"), "Ines Okafor", { label: "Name", frame: [200, 60, 200, 20] }),
        ],
        { at, windowId: FORM, app: FORMS, focused: true, title: "Booking form" },
      );

    it("records the descriptor source and the candidate count for each empty field, and skips the rest", () => {
      void helper.handleReader(mail(1000, false));
      void helper.handleReader(form(2000));
      for (const [i, key] of ["textfield:email~0", "textfield~1", "textfield~2", "textfield~3", "securetextfield~0"].entries()) {
        void helper.handleReader(focus(FORM, F(key), 3000 + i, { app: FORMS }));
      }
      void helper.handleReader(focus(FORM, F("textfield:name~0"), 4000, { app: FORMS, empty: false }));
      void helper.handleReader(focus(FORM, null, 4100, { app: FORMS, editable: false }));

      const f = helper.audit?.summary().fill;
      expect(f).toMatchObject({ focuses: 7, editableFocuses: 6, emptyEditable: 5, secure: 1, measured: 4, distinctFields: 4, nodeMissing: 0 });
      expect(f?.byApp["dev.caret.fixture"]).toMatchObject({
        focuses: 4,
        derivable: 3,
        bySource: { label: 1, nearest: 1, placeholder: 1, sectionOnly: 0, none: 1 },
        hasLabel: 1,
        hasNearest: 1,
        hasPlaceholder: 1,
      });
      // The mail window's two lines, with the email also as a typed value (deduplicated by text).
      expect(f?.focusesList.map((x) => [x.source, x.candidates, x.typedCandidates])).toEqual([
        ["label", 2, 1],
        ["nearest", 2, 1],
        ["placeholder", 2, 1],
        ["none", 2, 1],
      ]);
      expect(f?.focusesList[0]?.formFields).toBe(4);
    });

    it("counts a focus on a field the model does not hold", () => {
      void helper.handleReader(form(2000));
      void helper.handleReader(focus(FORM, F("textfield~9"), 3000, { app: FORMS }));
      expect(helper.audit?.summary().fill).toMatchObject({ emptyEditable: 1, nodeMissing: 1, measured: 0 });
    });
  });

  it("renders both reports from the summary with counts and no window text", () => {
    void helper.handleReader(job(1000, "Exporting 40%", true, true));
    void helper.handleReader(mail(2000, true));
    void helper.handleReader(job(9000, "Export finished", false, false));
    void helper.handleReader(job(80_000, "Export finished", true, false));
    const s = helper.audit?.summary();
    if (s === undefined) throw new Error("audit missing");
    const markers = renderMarkerAudit({ ...s, startedAt: 0, updatedAt: 3_600_000 }, [{ name: "audit reader", meanPct: 2.5, peakPct: 9, peakRssMb: 50 }], {
      hidMinutes: 40,
      powerdMinutes: 31,
    });
    expect(markers).toContain("with 40 active minutes by the HID idle timer (which also counts events that agents post) and 31 by powerd's hardware-input spans");
    // App, leaves, with markers B5 and B6, watches B5 and B6, cleared B5 and B6.
    expect(markers).toContain("| dev.caret.jobs | 1 | 1 | 1 | 1 | 1 | 1 | 1 |");
    expect(markers).toContain("| Leaves with markers per hour | 1.0 | 1.0 |");
    expect(markers).toContain("| Of those, more than 60 s after the clear | 1 | 1 |");
    expect(markers).toContain("| verbCount | 1 | 1 | 1 |");
    expect(markers).toContain("| audit reader | 2.5% | 9.0% | 50 MB |");
    const fill = renderFillReadiness(s);
    expect(fill).toContain("Measured: 0 focuses");
    for (const t of ["Export", "Priya", "venue"]) {
      expect(markers).not.toContain(t);
      expect(fill).not.toContain(t);
    }
  });

  it("keeps hashes of what it saw and no text in its summary", () => {
    void helper.handleReader(job(1000, "Exporting 40%", true, true));
    void helper.handleReader(mail(2000, true));
    const audit = helper.audit;
    if (audit === null) throw new Error("audit missing");
    const json = JSON.stringify(audit.summary()) + JSON.stringify(audit.seen.toJSON());
    for (const s of ["Priya", "priya.raman@example.org", "Export queue", "venue deposit", "Exporting"]) expect(json).not.toContain(s);
    expect(audit.seen.lookup(audit.seen.hash("priya.raman@example.org"))).toEqual(["dev.caret.mail"]);
    expect(audit.seen.lookup(audit.seen.hash("exporting 40%"))).toEqual(["dev.caret.jobs"]);
  });
});
