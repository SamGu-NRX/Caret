// The calendar end state through the reader's EventKit adapter (brief B16), over the real socket: a live
// Helper behind a HelperServer, the reader simulator answering calendar verbs as caret-screen's
// CalendarAdapter does (its own calendar on a local source, refusals for no Calendar access and no local
// source), and the executor's calendar step and undo through ReaderCalendar. The Swift adapter itself
// is tested in CalendarAdapterTests and, against real EventKit, in the VM job (evidence/screen/b16).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { HelperMessage, HelperToReader, isCalendarVerb, PROTOCOL_VERSION, ReaderMessage, TaskProgress, type CalendarBlock, type CalendarVerb, type VerbResult } from "../src/protocol.ts";
import type { Plan } from "../src/executor/schema.ts";
import { CalendarBlocked, ReaderCalendar, type SocketReaderLink } from "../src/executor/means.ts";
import { SocketReader, until } from "./socket-reader.ts";

/** caret-screen's CalendarAdapter, as the reader simulator plays it: same rules, an in-memory store. */
class AdapterStandIn {
  granted = true;
  localSource = true;
  readonly calendars = new Map<string, Map<string, { title: string; start: string; end: string }>>();
  /** The task that added each event: only it may remove the event, and a calendar holding another's is not disposed (B23). */
  private readonly addedBy = new Map<string, string>();
  private n = 0;
  answer = (v: CalendarVerb): Pick<VerbResult, "outcome" | "detail" | "event" | "blocked"> => {
    const blocked = (b: CalendarBlock) => ({ outcome: "blocked" as const, detail: null, blocked: b });
    if (!this.granted) return blocked("tcc");
    const ok = (e?: { id: string; calendar: string; title: string; start: string; end: string }) => ({ outcome: "ok" as const, detail: null, ...(e === undefined ? {} : { event: e }) });
    const owner = (id: string): string | undefined => [...this.calendars].find(([, evs]) => evs.has(id))?.[0];
    switch (v.kind) {
      case "calendarFind": {
        const hit = [...(this.calendars.get(v.calendar) ?? new Map())].find(([, e]) => e.title === v.title && Date.parse(e.start) === Date.parse(v.start) && Date.parse(e.end) === Date.parse(v.end));
        return ok(hit === undefined ? undefined : { id: hit[0], calendar: v.calendar, ...hit[1] });
      }
      case "calendarAdd": {
        if (!this.calendars.has(v.calendar)) {
          if (!this.localSource) return blocked("noLocalSource");
          this.calendars.set(v.calendar, new Map());
        }
        const id = `ev-${++this.n}`;
        this.calendars.get(v.calendar)?.set(id, { title: v.title, start: v.start, end: v.end });
        this.addedBy.set(id, v.taskId);
        return ok({ id, calendar: v.calendar, title: v.title, start: v.start, end: v.end });
      }
      case "calendarGet": {
        const c = owner(v.id);
        const e = c === undefined ? undefined : this.calendars.get(c)?.get(v.id);
        return ok(c === undefined || e === undefined ? undefined : { id: v.id, calendar: c, ...e });
      }
      case "calendarRemove": {
        const c = owner(v.id);
        if (c === undefined) return { outcome: "notAllowed", detail: "the event is not in a calendar the reader created" };
        if (this.addedBy.get(v.id) !== v.taskId) return { outcome: "notAllowed", detail: "another task added this event; only that task removes it" };
        this.calendars.get(c)?.delete(v.id);
        return ok();
      }
      case "calendarDispose": {
        const others = [...(this.calendars.get(v.calendar)?.keys() ?? [])].filter((id) => this.addedBy.get(id) !== v.taskId);
        if (others.length > 0) return { outcome: "notAllowed", detail: "the calendar holds events other tasks added; it is not deleted" };
        this.calendars.delete(v.calendar);
        return ok();
      }
    }
  };
}

const plan = (title: string): Plan => ({
  id: "event",
  title: `Add ${title}`,
  slots: {},
  steps: [{ says: `${title} is on Caret Test`, end: { kind: "calendarEvent", calendar: "Caret Test", title, start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" } }],
});

describe("the calendar through the reader", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let reader: SocketReader;
  let adapter: AdapterStandIn;
  let published: HelperMessage[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-cal-"));
    store = new Store(join(dir, "data"));
    published = [];
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => (published.push(m), server.publish(m)), sendToReader: (c) => server.sendToReader(c), calendar: "reader" });
    server = new HelperServer(join(dir, "s.sock"), () => helper, () => {});
    await server.listen();
    reader = await SocketReader.connect(join(dir, "s.sock"));
    adapter = new AdapterStandIn();
    reader.calendar = adapter.answer;
    await until(() => helper.hasReader);
  });
  afterEach(async () => {
    for (const m of published) HelperMessage.parse(m);
    reader.client.close();
    await server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const progress = (taskId: string) => published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.taskId === taskId);

  it("adds the event, finds it on rerun without adding again, and undo removes it", async () => {
    expect(await helper.executor.run("t1", plan("Coffee with Dana"), {}, undefined, { grant: true })).toMatchObject({ outcome: "done", acted: 1 });
    expect([...(adapter.calendars.get("Caret Test")?.values() ?? [])]).toEqual([{ title: "Coffee with Dana", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" }]);
    expect(await helper.executor.run("t2", plan("Coffee with Dana"), {}, undefined, { grant: true })).toMatchObject({ outcome: "done", acted: 0, skipped: 1 });
    expect(await helper.executor.undo("t1")).toEqual({ restored: 1, notRestored: [], notUndoable: 0 });
    expect(adapter.calendars.get("Caret Test")?.size).toBe(0);
    expect(reader.verbs.map((v) => v.kind)).toEqual(["calendarFind", "calendarAdd", "calendarFind", "calendarFind", "calendarGet", "calendarRemove", "calendarGet"]);
    expect(reader.verbs.filter((v) => "taskId" in v).map((v) => ("taskId" in v ? v.taskId : ""))).toEqual(["t1", "t1"]);
  });

  it("refuses the add for a task with no calendar grant, as a consumer's runPlan has none", async () => {
    const r = await helper.executor.run("t1", plan("Coffee with Dana"), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0, acted: 0 });
    expect(r.detail).toMatch(/notAllowed \(no calendar grant for task t1\)/);
    expect(adapter.calendars.size).toBe(0);
    expect(reader.grants.log).toEqual([]);
  });

  it("grants the calendar to an accepted task, revokes it when the run ends, and grants it again for undo", async () => {
    await helper.executor.run("t1", plan("Coffee with Dana"), {}, undefined, { grant: true });
    await until(() => reader.grants.log.length === 2);
    expect(reader.grants.log.map((g) => `${g.type} ${g.taskId}`)).toEqual(["calendarGrant t1", "actRevoke t1"]);
    await helper.executor.undo("t1");
    await until(() => reader.grants.log.length === 4);
    expect(reader.grants.log.map((g) => `${g.type} ${g.taskId}`)).toEqual(["calendarGrant t1", "actRevoke t1", "calendarGrant t1", "actRevoke t1"]);
    // An undo after the grant ended is refused by the reader, not carried out quietly.
    expect(reader.grants.calendarRefusal("t1")).toBe("no calendar grant for task t1");
  });

  it("keeps an added event in the undo ledger even when it fails the check after the add", async () => {
    const answer = adapter.answer;
    let finds = 0;
    reader.calendar = (v) => (v.kind === "calendarFind" && ++finds === 2 ? { outcome: "ok", detail: null } : answer(v));
    const r = await helper.executor.run("t1", plan("Coffee with Dana"), {}, undefined, { grant: true });
    expect(r).toMatchObject({ outcome: "stopped" });
    expect(helper.executor.ledger("t1")).toHaveLength(1);
    reader.calendar = answer;
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
    expect(adapter.calendars.get("Caret Test")?.size).toBe(0);
  });

  it("keeps an add whose answer was lost but which was saved in the undo ledger, and never another task's event", async () => {
    const answer = adapter.answer;
    reader.calendar = (v) => {
      const r = answer(v);
      // The add lands, but its answer is lost on the way back.
      return v.kind === "calendarAdd" ? { outcome: "axError", detail: "no answer from the reader within 5000 ms" } : r;
    };
    const r = await helper.executor.run("t1", plan("Coffee with Dana"), {}, undefined, { grant: true });
    expect(r).toMatchObject({ outcome: "stopped" });
    expect(helper.executor.ledger("t1")).toHaveLength(1);
    reader.calendar = answer;
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
    // A second task whose add is refused because the event is already there claims nothing.
    await helper.executor.run("t2", plan("Lunch with Priya"), {}, undefined, { grant: true });
    reader.calendar = (v) => (v.kind === "calendarFind" ? { outcome: "ok", detail: null } : v.kind === "calendarAdd" ? { outcome: "changed", detail: "an identical event is already in the calendar; nothing was added" } : answer(v));
    expect(await helper.executor.run("t3", plan("Lunch with Priya"), {}, undefined, { grant: true })).toMatchObject({ outcome: "stopped" });
    expect(helper.executor.ledger("t3")).toHaveLength(0);
  });

  it("hands the step to the user as blocked tcc without Calendar access, and adds nothing", async () => {
    adapter.granted = false;
    const r = await helper.executor.run("t1", plan("Coffee with Dana"), {}, undefined, { grant: true });
    expect(r).toMatchObject({ outcome: "handoff", step: 0, acted: 0 });
    expect(r.detail).toMatch(/^blocked: tcc\. Caret has no Calendar access, and never asks for it/);
    expect(progress("t1").at(-1)).toMatchObject({ phase: "handoff", blocked: "tcc" });
    expect(helper.tasks.get("t1")).toMatchObject({ state: "needsYou", cause: "caret" });
    expect(reader.verbs.map((v) => v.kind)).toEqual(["calendarFind"]);
    expect(adapter.calendars.size).toBe(0);
  });

  it("hands the step to the user as blocked noLocalSource when there is no local account to create its calendar on", async () => {
    adapter.localSource = false;
    const r = await helper.executor.run("t1", plan("Coffee with Dana"), {}, undefined, { grant: true });
    expect(r).toMatchObject({ outcome: "handoff", step: 0, acted: 0 });
    expect(progress("t1").at(-1)).toMatchObject({ phase: "handoff", blocked: "noLocalSource" });
    expect(r.detail).toMatch(/^blocked: noLocalSource\./);
  });

  it("stops as a reader refusal when the reader runs without --calendar-test", async () => {
    reader.calendar = null;
    const r = await helper.executor.run("t1", plan("Coffee with Dana"), {}, undefined, { grant: true });
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(progress("t1").at(-1)).toMatchObject({ phase: "stopped", stopReason: "reader" });
    expect(r.detail).toMatch(/notAllowed \(the reader was not started with --calendar-test\)/);
  });

});

describe("ReaderCalendar", () => {
  const link = (answer: (v: CalendarVerb) => Pick<VerbResult, "outcome" | "detail" | "event" | "blocked">) => {
    const sent: CalendarVerb[] = [];
    return {
      sent,
      run: async (v: Parameters<SocketReaderLink["run"]>[0]): Promise<VerbResult> => {
        if (!isCalendarVerb(v)) throw new Error("not a calendar verb");
        sent.push(v);
        return { type: "verbResult", v: PROTOCOL_VERSION, id: "x", at: 1, ...answer(v) };
      },
    };
  };

  it("sends one verb per call, maps blocked to CalendarBlocked and any other refusal to an error, and disposes by name", async () => {
    const l = link((v) => (v.kind === "calendarAdd" ? { outcome: "blocked", detail: null, blocked: "noLocalSource" } : v.kind === "calendarGet" ? { outcome: "axError", detail: "EKErrorDomain 3" } : { outcome: "ok", detail: null }));
    const cal = new ReaderCalendar(l);
    expect(await cal.find("Caret Test", "t", "2026-10-08T15:00:00-05:00", "2026-10-08T15:30:00-05:00")).toBeNull();
    await expect(cal.add("Caret Test", "t", "2026-10-08T15:00:00-05:00", "2026-10-08T15:30:00-05:00", "t1")).rejects.toBeInstanceOf(CalendarBlocked);
    await expect(cal.add("Caret Test", "t", "2026-10-08T15:00:00-05:00", "2026-10-08T15:30:00-05:00", "t1")).rejects.toMatchObject({ reason: "noLocalSource" });
    await expect(cal.get("ev-1")).rejects.toThrow("the reader's calendar refused calendarGet: axError (EKErrorDomain 3)");
    await cal.dispose("Caret Test", "t1");
    expect(l.sent.map((v) => v.kind)).toEqual(["calendarFind", "calendarAdd", "calendarAdd", "calendarGet", "calendarDispose"]);
  });
});

describe("calendar messages", () => {
  const result = { type: "verbResult", v: PROTOCOL_VERSION, id: "c1", at: 1, outcome: "ok", detail: null };
  const event = { id: "ev-1", calendar: "Caret Test", title: "Coffee with Dana", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" };
  it("pairs outcome blocked with its reason and nothing else", () => {
    expect(ReaderMessage.safeParse({ ...result, event }).success).toBe(true);
    expect(ReaderMessage.safeParse({ ...result, outcome: "blocked", blocked: "tcc" }).success).toBe(true);
    expect(ReaderMessage.safeParse({ ...result, outcome: "blocked" }).success).toBe(false);
    expect(ReaderMessage.safeParse({ ...result, blocked: "tcc" }).success).toBe(false);
    expect(ReaderMessage.safeParse({ ...result, outcome: "blocked", blocked: "icloud" }).success).toBe(false);
    expect(ReaderMessage.safeParse({ ...result, event: { ...event, start: "2026-10-08T15:00:00" } }).success).toBe(false);
  });

  it("lets only a hand-off say blocked", () => {
    const p = { type: "taskProgress", v: PROTOCOL_VERSION, at: 1, taskId: "t", planId: "p", step: 0, steps: 1, says: null, detail: null };
    expect(TaskProgress.safeParse({ ...p, phase: "handoff", blocked: "tcc" }).success).toBe(true);
    expect(TaskProgress.safeParse({ ...p, phase: "handoff" }).success).toBe(true);
    expect(TaskProgress.safeParse({ ...p, phase: "done", blocked: "tcc" }).success).toBe(false);
    expect(TaskProgress.safeParse({ ...p, phase: "stopped", stopReason: "reader", blocked: "tcc" }).success).toBe(false);
  });

  it("refuses a calendar verb with an empty calendar name or a time without an offset", () => {
    const cmd = { type: "readerCommand", v: PROTOCOL_VERSION, id: "c", expires: 2, verb: { kind: "calendarAdd", calendar: "Caret Test", title: "t", start: event.start, end: event.end, taskId: "t1" } };
    expect(HelperToReader.safeParse(cmd).success).toBe(true);
    const { taskId: _, ...untasked } = cmd.verb;
    expect(HelperToReader.safeParse({ ...cmd, verb: untasked }).success).toBe(false);
    expect(HelperToReader.safeParse({ type: "calendarGrant", v: PROTOCOL_VERSION, taskId: "t1", at: 1, expires: 1 + 120_000 }).success).toBe(true);
    expect(HelperToReader.safeParse({ type: "calendarGrant", v: PROTOCOL_VERSION, taskId: "t1", at: 1, expires: 2 + 120_000 }).success).toBe(false);
    expect(HelperToReader.safeParse({ ...cmd, verb: { ...cmd.verb, calendar: "" } }).success).toBe(false);
    expect(HelperToReader.safeParse({ ...cmd, verb: { ...cmd.verb, end: "2026-10-08T15:30:00" } }).success).toBe(false);
    expect(HelperToReader.safeParse({ ...cmd, verb: { kind: "calendarRemove", id: "", taskId: "t1" } }).success).toBe(false);
    expect(HelperToReader.safeParse({ ...cmd, verb: { kind: "calendarRemove", id: "ev-1" } }).success).toBe(false);
  });
});
