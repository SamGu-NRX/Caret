import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type Activity, type HelperMessage, type MemoryReply, type PatternOffer } from "../src/protocol.ts";
import { decide, type GateContext, type GateInput } from "../src/patterns/gate.ts";
import { MemoryError, MemoryStore, FORGET_BLOCK_MS } from "../src/patterns/memory.ts";
import { applyMemory, captureEdit } from "../src/patterns/preferences.ts";
import { Desk, PEOPLE, cellKey, grid, roster, type GridWindow, type ListWindow } from "./scene.ts";
import { FIXTURE_APP, MAIL_APP } from "./builders.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("speak-now gate", () => {
  const ok: GateContext = { shadow: false, permission: "ask", dontOfferHere: false, ignoredToday: 0, settings: [], routineSightings: 2 };
  const loop: GateInput = { offerKind: "loopNext", hits: 1, misses: 0, paused: false, grounded: true };
  const routine = (hits: number, misses: number): GateInput => ({ offerKind: "routine", hits, misses, paused: false, grounded: true });

  it("lets a loop prediction speak at round two", () => {
    expect(decide(loop, ok)).toEqual({ speak: true, reasons: [], showProbability: 2 / 3 });
  });
  it("holds a routine until the level's sightings matched, at 80% or better", () => {
    expect(decide(routine(1, 0), ok).reasons).toEqual(["unproven"]);
    expect(decide(routine(2, 0), ok).speak).toBe(true);
    expect(decide(routine(2, 1), ok).reasons).toEqual(["unproven"]);
    expect(decide(routine(4, 1), ok).speak).toBe(true);
    // Balanced asks for three; a level with routines off never proves one.
    expect(decide(routine(2, 0), { ...ok, routineSightings: 3 }).reasons).toEqual(["unproven"]);
    expect(decide(routine(3, 0), { ...ok, routineSightings: 3 }).speak).toBe(true);
    expect(decide(routine(9, 0), { ...ok, routineSightings: null }).reasons).toEqual(["unproven"]);
  });
  it("lists every rule that holds an offer", () => {
    const d = decide(
      { ...loop, grounded: false, paused: true },
      { shadow: true, permission: "handoff", dontOfferHere: true, ignoredToday: 2, settings: ["caretPaused", "roleOff", "levelOff", "hourlyBudget"], routineSightings: 2 },
    );
    expect(d.reasons).toEqual(["shadowMode", "caretPaused", "roleOff", "levelOff", "paused", "permissionHandoff", "dontOfferHere", "ignoredToday", "hourlyBudget", "ungrounded"]);
  });
});

describe("memory store", () => {
  let dir: string;
  let m: MemoryStore;
  const hash = (s: string): string => `h(${s.length}:${s.charCodeAt(0)}:${s.charCodeAt(s.length - 1)}:${s.slice(-6)})`;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-memory-"));
    m = new MemoryStore(dir);
  });
  afterEach(() => {
    m.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("seeds the permission table from the plan and refuses what an action type cannot become", () => {
    const perms = m.list("permission");
    expect(perms.map((p) => p.says)).toContain("Write where you are: ask first");
    expect(() => m.edit("permission-sensitive", { rule: "act" }, 1)).toThrow(MemoryError);
    expect(() => m.edit("permission-writeHere", { rule: "handoff" }, 1)).toThrow(/ask or act/);
    expect(m.edit("permission-outbound", { rule: "ask" }, 1).says).toBe("Send, submit, post: ask first");
    expect(() => m.forget("permission-read", 1)).toThrow(MemoryError);
  });

  it("keeps about-you, people and preference values sealed on disk", () => {
    const id = m.upsert("about", "k1", { label: "Work email", value: "dana@lumen.example", source: "typed" }, 1, null);
    m.upsert("people", "k2", { alias: "Dana", name: "Dana Reyes" }, 1, "Mail");
    m.close();
    for (const f of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, f)).toString("latin1");
      expect(bytes.includes("lumen.example"), f).toBe(false);
      expect(bytes.includes("Reyes"), f).toBe(false);
    }
    m = new MemoryStore(dir);
    expect(m.get(id).says).toBe("Work email: dana@lumen.example (you typed this)");
  });

  it("rejects an edit with a field the kind does not have, naming it", () => {
    const id = m.upsert("about", "k", { label: "Work email", value: "a@b.example", source: "typed" }, 1, null);
    expect(() => m.edit(id, { value: "x@y.example", color: "red" }, 2)).toThrow(/color/);
    expect(m.edit(id, { value: "x@y.example" }, 2).says).toBe("Work email: x@y.example (you typed this)");
  });

  it("learns a phone format, a person and a use-instead value from edits, and applies them", () => {
    const base = { kind: null, dstShapeHash: "dst1", fieldLabel: "Guest", app: "Mail" } as const;
    expect(captureEdit(m, hash, { ...base, kind: "phone", source: "+1 (512) 555-0142", written: "+1 (512) 555-0142", edited: "512-555-0142" }, 1)?.entry).toBe("format");
    expect(applyMemory(m, hash, "+1 (415) 555-0199", "phone", "any").value).toBe("415-555-0199");
    expect(captureEdit(m, hash, { ...base, source: "Dana", written: "Dana", edited: "Dana Reyes" }, 1)?.entry).toBe("people");
    expect(applyMemory(m, hash, "dana", null, "any").value).toBe("Dana Reyes");
    expect(captureEdit(m, hash, { ...base, source: "Marcus Lowe", written: "Marcus Lowe", edited: "M. Lowe (ops)" }, 1)?.entry).toBe("useInstead");
    expect(applyMemory(m, hash, "Marcus Lowe", null, "dst1").value).toBe("M. Lowe (ops)");
    expect(applyMemory(m, hash, "Marcus Lowe", null, "other field").value).toBe("Marcus Lowe");
    expect(captureEdit(m, hash, { ...base, source: "Marcus Lowe", written: "Marcus Lowe", edited: "" }, 1)).toBeNull();
    // A second correction of the same source value replaces the first: the next fill gets the newest.
    expect(captureEdit(m, hash, { ...base, source: "Marcus Lowe", written: "M. Lowe (ops)", edited: "Marcus Lowe, Ops" }, 2)?.entry).toBe("useInstead");
    expect(applyMemory(m, hash, "Marcus Lowe", null, "dst1").value).toBe("Marcus Lowe, Ops");
    expect(captureEdit(m, hash, { ...base, source: "Marcus Lowe", written: "M. Lowe (ops)", edited: "M. Lowe (ops)" }, 2)).toBeNull();
    expect(m.list("preference").map((p) => p.says).sort().slice(1)).toEqual(["Phone numbers go in as 512-555-0100 (you changed this once)"]);
    expect(m.list("preference").find((p) => p.kind === "preference" && p.fields.rule === "useInstead")?.says).toBe("Guest gets your Guest, Marcus Lowe, Ops (you changed this 2 times)");
  });

  it("blocks relearning a forgotten routine for 30 days", () => {
    const step = { shapeHash: "s", srcBundle: "a", srcApp: "A", srcWindowKind: "standard", srcTemplateHash: "t", srcPos: 0, part: "whole", dstBundle: "b", dstApp: "B", dstWindowKind: "standard", dstTemplateHash: "u", dstPos: 0 };
    const r = m.recordRoutine("sig", [step, { ...step, shapeHash: "s2" }], 10);
    expect(r?.count).toBe(1);
    m.forget(r!.id, 100);
    expect(m.recordRoutine("sig", [step], 100 + FORGET_BLOCK_MS - 1)).toBeNull();
    expect(m.recordRoutine("sig", [step], 100 + FORGET_BLOCK_MS + 1)?.count).toBe(1);
  });
});

describe("pattern engine in the helper", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let desk: Desk;
  let sent: HelperMessage[];
  const offers = (kind?: PatternOffer["kind"]): PatternOffer[] => sent.filter((m): m is PatternOffer => m.type === "patternOffer" && (kind === undefined || m.kind === kind));
  const take = (o: PatternOffer) => helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: o.id, action: "take" });
  const ask = (op: "list" | "edit" | "pause" | "resume" | "forget", rest: { id?: string; kind?: "about" | "routine" | "preference"; fields?: Record<string, unknown> } = {}): MemoryReply =>
    helper.handleMemory({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "r", op, ...rest });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-patterns-"));
    store = new Store(dir);
    sent = [];
    desk = new Desk();
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: desk });
    desk.attach(helper);
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const startLoop = (dst: GridWindow, src: ListWindow = roster()): void => {
    desk.showList(src);
    desk.advance(1000);
    desk.showGrid(dst);
    desk.fill(dst, 0, 0, src.lines[0]!);
    desk.fill(dst, 1, 0, src.lines[1]!);
  };

  it("predicts row 3, takes it, then finishes rows 4 to 6 through the executor", async () => {
    const dst = grid();
    startLoop(dst);
    const [next] = offers("loopNext");
    expect(next?.cells.map((c) => [c.key, c.value])).toEqual([[cellKey(dst, 2, 0), PEOPLE[2]]]);
    expect(next?.showProbability).toBeCloseTo(2 / 3);

    expect((await take(next!))?.outcome).toBe("done");
    const [finish] = offers("loopFinish");
    expect(finish?.says).toBe("Finish the rest: 3 more values from Caret Fixture");
    expect((await take(finish!))?.outcome).toBe("done");
    desk.advance(3000);
    expect([0, 1, 2, 3, 4, 5].map((r) => dst.values.get(cellKey(dst, r, 0)))).toEqual(PEOPLE.slice(0, 6));
    // The executor's own writes come back as transfers; the loop absorbs them and offers nothing more.
    expect(offers()).toHaveLength(2);
    const log = helper.memory.decisions().filter((d) => d.speak);
    expect(log.map((d) => [d.offerKind, d.showProbability])).toEqual([["loopNext", 2 / 3], ["loopFinish", 0.75]]);
    // The finish is one task in the activity feed: ready when offered, then the run under the offer's id.
    const states = sent.filter((m): m is Activity => m.type === "activity" && m.task.id === finish!.id).map((m) => [m.from, m.task.state]);
    expect(states[0]).toEqual([null, "ready"]);
    expect(states.at(-1)).toEqual(["running", "done"]);
    expect(helper.tasks.get(finish!.id)).toMatchObject({ kind: "loopFinish", says: finish!.says, remaining: [], undoable: true });
  });

  it("lists a loop finish withdrawn before it ran as undone", () => {
    const dst = grid();
    startLoop(dst);
    desk.fill(dst, 2, 0, PEOPLE[2]!);
    const [finish] = offers("loopFinish");
    void helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: finish!.id, action: "dismiss" });
    expect(helper.tasks.get(finish!.id)).toMatchObject({ state: "undone", cause: "you", detail: "withdrawn: dismissed" });
  });

  it("confirms the loop when the user types the predicted row instead of taking it", () => {
    const dst = grid();
    startLoop(dst);
    desk.fill(dst, 2, 0, PEOPLE[2]!);
    expect(offers().map((o) => o.kind)).toEqual(["loopNext", "loopFinish"]);
    expect(sent.find((m) => m.type === "offerWithdrawn")).toMatchObject({ reason: "taken" });
  });

  it("holds every offer in an app after 'Don't offer this here', and says so in memory", async () => {
    const dst = grid();
    startLoop(dst);
    const [next] = offers("loopNext");
    await helper.handleOffer({ type: "offerControl", v: PROTOCOL_VERSION, offerId: next!.id, action: "dontOfferHere" });
    expect(ask("list", { kind: "preference" }).entries.map((e) => e.says)).toEqual(["Don't offer next-row predictions in Mail Fixture"]);
    const again = grid(["Guest"], 6, "6160-9");
    startLoop(again);
    expect(offers()).toHaveLength(1);
    expect(helper.memory.decisions().at(-1)?.reasons).toEqual(["dontOfferHere"]);
  });

  it("learns from an edit to a filled value, and an edit to that memory changes the next fill", async () => {
    const dst = grid();
    startLoop(dst);
    await take(offers("loopNext")[0]!);
    // The user corrects what Caret wrote in row 3.
    desk.fill(dst, 2, 0, "Marcus Lowe (ops)");
    const about = ask("list", { kind: "about" }).entries;
    expect(about.map((e) => e.says)).toEqual(["Guest: Marcus Lowe (ops) (from your edit)"]);

    // A later sitting: another seating chart of the same shape, filled from the same roster.
    desk.close(dst.windowId);
    const second = grid(["Guest"], 6, "6160-3");
    startLoop(second);
    expect(offers("loopNext").at(-1)?.cells[0]).toMatchObject({ value: "Marcus Lowe (ops)", memory: expect.arrayContaining([about[0]!.id]) });

    expect(ask("edit", { id: about[0]!.id, fields: { value: "Marcus Lowe, Operations" } }).error).toBeNull();
    desk.close(second.windowId);
    const third = grid(["Guest"], 6, "6160-4");
    startLoop(third);
    expect(offers("loopNext").at(-1)?.cells[0]?.value).toBe("Marcus Lowe, Operations");
  });

  describe("found in review", () => {
    it("refuses to take a prediction whose field the user filled meanwhile, and writes nothing", async () => {
      const dst = grid();
      startLoop(dst);
      const [next] = offers("loopNext");
      dst.values.set(cellKey(dst, 2, 0), "Someone else");
      desk.showGrid(dst);
      expect(await take(next!)).toBeNull();
      expect(dst.values.get(cellKey(dst, 2, 0))).toBe("Someone else");
      expect(sent.filter((m) => m.type === "error").at(-1)).toMatchObject({ message: expect.stringContaining("no longer empty") });
    });

    it("never falls back to another field when the predicted one is gone", async () => {
      const dst = grid();
      startLoop(dst);
      const [next] = offers("loopNext");
      dst.rows = 2;
      desk.showGrid(dst);
      const writes = desk.verbs.length;
      expect(await take(next!)).toBeNull();
      expect(desk.verbs.slice(writes).filter((v) => v.kind === "write")).toEqual([]);
    });

    it("keeps a loopNext open when its source list changes elsewhere, and withdraws it when the predicted line changes", () => {
      const dst = grid();
      startLoop(dst);
      const [next] = offers("loopNext");
      desk.showList(roster([...PEOPLE, "Zora Quill"]));
      expect(helper.patterns.openOffers().map((o) => o.id)).toEqual([next!.id]);
      desk.showList(roster(PEOPLE.map((p, i) => (i === 2 ? `${p} (away)` : p))));
      expect(sent.filter((m) => m.type === "offerWithdrawn").at(-1)).toMatchObject({ id: next!.id, reason: "stale" });
    });

    it("withdraws an open offer when a memory entry it used is paused", () => {
      const dst = grid();
      const dstShape = store.hash(`dst\u0000${MAIL_APP.bundleId}\u0000standard\u0000${MAIL_APP.bundleId}/standard/textfield:guest`);
      captureEdit(helper.memory, (t) => store.hash(t), { source: PEOPLE[2]!, written: PEOPLE[2]!, edited: "Marcus L. (ops)", kind: null, dstShapeHash: dstShape, fieldLabel: "Guest", app: "Mail Fixture" }, 1);
      startLoop(dst);
      const [next] = offers("loopNext");
      expect(next?.cells[0]?.value).toBe("Marcus L. (ops)");
      const aboutId = ask("list", { kind: "about" }).entries[0]!.id;
      ask("pause", { id: aboutId });
      expect(sent.filter((m) => m.type === "offerWithdrawn").at(-1)).toMatchObject({ id: next!.id, reason: "stale" });
    });

    it("keeps the loop when Caret writes a value a memory rule changed into another name on screen", async () => {
      const dst = grid();
      const dstShape = store.hash(`dst\u0000${MAIL_APP.bundleId}\u0000standard\u0000${MAIL_APP.bundleId}/standard/textfield:guest`);
      captureEdit(helper.memory, (t) => store.hash(t), { source: PEOPLE[2]!, written: PEOPLE[2]!, edited: PEOPLE[5]!, kind: null, dstShapeHash: dstShape, fieldLabel: "Guest", app: "Mail Fixture" }, 1);
      startLoop(dst);
      expect((await take(offers("loopNext")[0]!))?.outcome).toBe("done");
      desk.advance(3000);
      expect(dst.values.get(cellKey(dst, 2, 0))).toBe(PEOPLE[5]);
      expect(offers("loopFinish")).toHaveLength(1);
      expect(sent.some((m) => m.type === "offerWithdrawn" && m.reason === "diverged")).toBe(false);
    });

    it("forgets the rounds before a reader restart", () => {
      desk.showList(roster());
      desk.advance(1000);
      const before = grid();
      desk.showGrid(before);
      desk.fill(before, 0, 0, PEOPLE[0]!);
      void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 1, version: "t" });
      desk.showList(roster());
      desk.advance(1000);
      const after = grid();
      desk.showGrid(after);
      desk.fill(after, 1, 0, PEOPLE[1]!);
      expect(offers()).toEqual([]);
    });

    it("does not store an edit too long for memory, and the list still renders", () => {
      const r = captureEdit(helper.memory, (t) => store.hash(t), { source: "Dana", written: "Dana", edited: "x".repeat(501), kind: null, dstShapeHash: "d", fieldLabel: "Guest", app: "A" }, 1);
      expect(r).toBeNull();
      expect(() => helper.memory.upsert("about", "m", { label: "L", value: "y".repeat(501), source: "edit" }, 1, null)).toThrow(MemoryError);
      expect(ask("list").error).toBeNull();
    });
  });

  describe("routines across days", () => {
    const calendar = (day: number): ListWindow => ({
      windowId: "5150-20",
      app: FIXTURE_APP,
      title: "Calendar",
      group: "Event",
      lines: [`Design review ${day}`, `priya.raman+${day}@northwind.example`, `https://meet.example.com/day-${day}`],
    });
    const compose = (day: number): GridWindow => ({ windowId: `6160-${100 + day}`, app: MAIL_APP, title: `New message ${day}`, columns: ["Subject", "To", "Link"], rows: 1, values: new Map() });

    /** One day: the calendar shows that day's event, a compose window opens, the user copies three values, and closes it. */
    const occurrence = (day: number): PatternOffer[] => {
      desk.at += DAY;
      const before = offers("routine").length;
      const cal = calendar(day);
      desk.showList(cal);
      desk.advance(1000);
      const c = compose(day);
      desk.showGrid(c);
      const opened = offers("routine").slice(before);
      for (let i = 0; i < 3; i++) desk.fill(c, 0, i, cal.lines[i]!);
      desk.close(c.windowId);
      return opened;
    };

    it("offers a routine at Balanced only after three silent predictions matched, and stops after forget", () => {
      expect(occurrence(1)).toEqual([]);
      const [routine] = ask("list", { kind: "routine" }).entries;
      expect(routine?.says).toBe("3 values from Caret Fixture to Mail Fixture (seen once; learning, 0 of 3 silent predictions right)");
      expect(occurrence(2)).toEqual([]);
      expect(occurrence(3)).toEqual([]);
      expect(ask("list", { kind: "routine" }).entries[0]?.status).toBe("learning");
      expect(occurrence(4)).toEqual([]);
      const ready = ask("list", { kind: "routine" }).entries[0]!;
      expect(ready.fields).toMatchObject({ silent: { hits: 3, misses: 0 } });
      expect(ready.status).toBe("active");

      const [offer] = occurrence(5);
      expect(offer?.cells.map((c) => c.value)).toEqual(calendar(5).lines);
      expect(offer?.showProbability).toBe(0.8);
      const routineDecisions = helper.memory.decisions().filter((d) => d.offerKind === "routine");
      expect(routineDecisions.map((d) => d.speak)).toEqual([false, false, false, true]);
      expect(routineDecisions[0]?.reasons).toEqual(["unproven"]);

      expect(ask("forget", { id: ready.id }).error).toBeNull();
      expect(occurrence(6)).toEqual([]);
      expect(occurrence(7)).toEqual([]);
      expect(ask("list", { kind: "routine" }).entries).toEqual([]);
    });

    it("takes the level from the next settings message: Eager offers after two, Quiet never", () => {
      const settings = (level: "quiet" | "balanced" | "eager") => helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: desk.at, roles: ["fill", "repeat", "watch", "words"], level, paused: false });
      for (let d = 1; d <= 3; d++) expect(occurrence(d)).toEqual([]);
      settings("quiet");
      expect(occurrence(4)).toEqual([]);
      expect(helper.memory.decisions().filter((d) => d.offerKind === "routine").at(-1)?.reasons).toEqual(["levelOff", "unproven"]);
      settings("eager");
      expect(ask("list", { kind: "routine" }).entries[0]?.says).toContain("asks first");
      expect(occurrence(5)).toHaveLength(1);
    });

    it("scores a prediction as a miss when the user does something else, and never offers", () => {
      occurrence(1);
      for (let d = 2; d <= 5; d++) {
        desk.at += DAY;
        desk.showList(calendar(d));
        desk.advance(1000);
        const c = compose(d);
        desk.showGrid(c);
        // Only the subject this time: the predicted bundle does not happen.
        desk.fill(c, 0, 0, calendar(d).lines[0]!);
        desk.close(c.windowId);
      }
      expect(offers("routine")).toEqual([]);
      expect(ask("list", { kind: "routine" }).entries[0]?.fields).toMatchObject({ silent: { hits: 0, misses: 4 } });
    });

    it("scores a copy the user then replaced from another row as a miss", () => {
      occurrence(1);
      for (let d = 2; d <= 4; d++) {
        desk.at += DAY;
        const cal = calendar(d);
        desk.showList(cal);
        desk.advance(1000);
        const c = compose(d);
        desk.showGrid(c);
        for (let i = 0; i < 3; i++) desk.fill(c, 0, i, cal.lines[i]!);
        // The subject was wrong: the user replaces it with the room line.
        c.values.delete(cellKey(c, 0, 0));
        desk.showGrid(c);
        desk.fill(c, 0, 0, cal.lines[3] ?? `Room ${d}`);
        desk.close(c.windowId);
      }
      expect(offers("routine")).toEqual([]);
      const r = ask("list", { kind: "routine" }).entries.find((e) => e.kind === "routine" && e.fields.silent.hits + e.fields.silent.misses > 0);
      expect(r?.fields).toMatchObject({ silent: { hits: 0 } });
    });

    it("pausing a routine stops its predictions and offers until it is resumed", () => {
      for (let d = 1; d <= 4; d++) occurrence(d);
      const id = ask("list", { kind: "routine" }).entries[0]!.id;
      expect(ask("pause", { id }).entries[0]?.status).toBe("paused");
      expect(occurrence(5)).toEqual([]);
      expect(ask("resume", { id }).entries[0]?.status).toBe("active");
      expect(occurrence(6)).toHaveLength(1);
    });
  });
});
