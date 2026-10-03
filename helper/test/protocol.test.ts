import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, HelperMessage, HelperToReader, Node, ReaderMessage, StopReason } from "../src/protocol.ts";
import { PLAN_SCHEMA_PATH, renderPlanJsonSchema, renderProtocolJsonSchema, SCHEMA_PATH } from "../src/export-schema.ts";
import { Plan } from "../src/executor/schema.ts";

const GOLDEN = fileURLToPath(new URL("../fixtures/golden/protocol.ndjson", import.meta.url));
const lines = readFileSync(GOLDEN, "utf8").trim().split("\n");

describe("golden protocol fixture", () => {
  it("holds one of every message type", () => {
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual([
      "hello", "snapshot", "focus", "appSwitch", "windowClosed", "pasteboard", "fillRequest", "fillProposal", "error",
      "readerCommand", "verbResult", "userInput", "taskProgress",
      "readerCommand", "fillResult", "taskControl", "activityRequest", "activity", "activityReply",
      "alternatives", "action", "popup", "offerAccept", "offerStop", "offerWithdrawn", "readerCommand",
      "offerWithdrawn", "taskControl", "taskProgress", "taskProgress", "offerWithdrawn",
      "settings", "settings", "offerWithdrawn",
    ]);
  });

  it("carries the host's window identity, a fill's source apps, and done and undo counts", () => {
    const [alternatives, action, popup] = lines.slice(19, 22).map((l) => HelperMessage.parse(JSON.parse(l)) as { field: { window: unknown }; sourceApps?: string[] });
    expect(alternatives?.field.window).toEqual({ number: 4421, title: "Seating" });
    expect(action?.field.window).toEqual({ number: 4421, title: "Seating" });
    expect(popup?.field.window).toEqual({ number: null, title: "Checkout" });
    expect(popup?.sourceApps).toEqual(["Mail Fixture"]);
    expect(ReaderMessage.parse(JSON.parse(lines[1] ?? ""))).toMatchObject({ window: { number: 4417 } });
    const [done, undone] = lines.slice(28, 30).map((l) => HelperMessage.parse(JSON.parse(l)));
    expect(done).toMatchObject({ phase: "done", written: 3 });
    expect(undone).toMatchObject({ phase: "undone", restored: 2, notRestored: 1, notUndoablePresses: 0 });
    const p = JSON.parse(lines[21] ?? "") as Record<string, unknown>;
    for (const bad of [[], ["Mail Fixture", "Mail Fixture"], [""]]) expect(HelperMessage.safeParse({ ...p, sourceApps: bad }).success).toBe(false);
    const field = (p.field ?? {}) as Record<string, unknown>;
    expect(HelperMessage.safeParse({ ...p, field: { ...field, window: undefined } }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...p, field: { ...field, window: { number: 0, title: "x" } } }).success).toBe(false);
  });

  it("carries B8's additions: an expired withdrawal, a pause for input, and task frames", () => {
    const [expiredLine, pauseLine] = lines.slice(26).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(HelperMessage.parse(expiredLine)).toMatchObject({ type: "offerWithdrawn", reason: "expired" });
    expect(ConsumerMessage.parse(pauseLine)).toMatchObject({ type: "taskControl", action: "pause", reason: "input" });
    expect(ConsumerMessage.safeParse({ ...pauseLine, reason: "typing" }).success).toBe(false);
    const request = JSON.parse(lines[16] ?? "") as Record<string, unknown>;
    expect(ConsumerMessage.safeParse({ ...request, requestId: "r".repeat(200) }).success).toBe(true);
    expect(ConsumerMessage.safeParse({ ...request, requestId: "r".repeat(201) }).success).toBe(false);
    const activity = JSON.parse(lines[17] ?? "") as { task: { frame: unknown; says: string } };
    expect(activity.task.frame).toEqual([640, 120, 520, 380]);
    expect(activity.task.says).toBe("'Upload' in Caret Fixture is waiting for you");
    const { frame: _, ...noFrame } = activity.task;
    expect(HelperMessage.safeParse({ ...activity, task: noFrame }).success).toBe(false);
  });

  it("carries B10's settings: roles, level and pause from the host, and a withdrawal they caused", () => {
    const [full, paused, gone] = lines.slice(31, 34).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ConsumerMessage.parse(full)).toEqual({ type: "settings", v: 1, at: 1790000130000, roles: ["fill", "repeat", "watch", "words"], level: "balanced", paused: false });
    expect(ConsumerMessage.parse(paused)).toMatchObject({ roles: ["watch"], level: "quiet", paused: true });
    expect(ConsumerMessage.safeParse({ ...full, roles: ["watch", "watch"] }).success).toBe(false);
    expect(HelperMessage.parse(gone)).toMatchObject({ type: "offerWithdrawn", reason: "settings" });
  });

  it("carries B9's re-offer: reoffered names the new key, and only reoffered may", () => {
    const line = JSON.parse(lines[30] ?? "") as Record<string, unknown>;
    expect(HelperMessage.parse(line)).toMatchObject({ type: "offerWithdrawn", reason: "reoffered", replacedBy: "offer-6" });
    const { replacedBy: _, ...bare } = line;
    expect(HelperMessage.safeParse(bare).success).toBe(false);
    expect(HelperMessage.safeParse({ ...line, replacedBy: "" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...line, reason: "stale" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...bare, reason: "stale" }).success).toBe(true);
  });

  it("carries B14's stop reason: a stopped progress says why, and only a stopped one may", () => {
    const stopped = JSON.parse(lines[12] ?? "") as Record<string, unknown>;
    const done = JSON.parse(lines[28] ?? "") as Record<string, unknown>;
    expect(HelperMessage.parse(stopped)).toMatchObject({ type: "taskProgress", phase: "stopped", stopReason: "changed" });
    const { stopReason: _, ...bare } = stopped;
    expect(HelperMessage.safeParse(bare).success).toBe(false);
    expect(HelperMessage.safeParse({ ...stopped, stopReason: "timeout" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...done, stopReason: "you" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...stopped, phase: "handoff" }).success).toBe(false);
    for (const r of StopReason.options) expect(HelperMessage.safeParse({ ...stopped, stopReason: r }).success, r).toBe(true);
  });

  it("parses every line, and each parse is lossless", () => {
    for (const l of lines) {
      const json: unknown = JSON.parse(l);
      const parsed = AnyMessage.parse(json);
      expect(parsed).toEqual(json);
    }
  });

  it("routes each line to the union for its direction", () => {
    const [hello, snapshot, focus, appSwitch, closed, pasteboard, fillRequest, proposal, error, command, verbResult, userInput, progress, watchCommand, fillResult, control, activityRequest, activity, activityReply] = lines.map(
      (l) => JSON.parse(l) as unknown,
    );
    for (const m of [fillResult, control, activityRequest]) expect(ConsumerMessage.safeParse(m).success).toBe(true);
    for (const m of [activity, activityReply]) expect(HelperMessage.safeParse(m).success).toBe(true);
    expect(HelperToReader.safeParse(watchCommand).success).toBe(true);
    expect(ConsumerMessage.safeParse(activity).success).toBe(false);
    for (const m of [hello, snapshot, focus, appSwitch, closed, pasteboard, verbResult, userInput]) expect(ReaderMessage.safeParse(m).success).toBe(true);
    expect(ConsumerMessage.safeParse(fillRequest).success).toBe(true);
    expect(ConsumerMessage.safeParse(hello).success).toBe(true);
    for (const m of [proposal, error, progress]) expect(HelperMessage.safeParse(m).success).toBe(true);
    expect(HelperToReader.safeParse(command).success).toBe(true);
    expect(ReaderMessage.safeParse(proposal).success).toBe(false);
    expect(ReaderMessage.safeParse(command).success).toBe(false);
  });

  it("routes the offer messages: three to the host, accept and stop from it", () => {
    const [alternatives, action, popup, accept, stop, withdrawn, raise] = lines.slice(19).map((l) => JSON.parse(l) as unknown);
    for (const m of [alternatives, action, popup, withdrawn]) {
      expect(HelperMessage.safeParse(m).success).toBe(true);
      expect(ConsumerMessage.safeParse(m).success).toBe(false);
    }
    for (const m of [accept, stop]) expect(ConsumerMessage.safeParse(m).success).toBe(true);
    expect(HelperToReader.safeParse(raise).success).toBe(true);
  });

  it("rejects the shapes the Swift decoder also rejects", () => {
    const base = { key: "k", parent: null, role: "AXButton" };
    expect(Node.safeParse(base).success).toBe(true);
    expect(Node.safeParse({ key: "k", role: "AXButton" }).success).toBe(false);
    expect(Node.safeParse({ ...base, editable: null }).success).toBe(false);
    expect(Node.safeParse({ ...base, editable: false }).success).toBe(false);
    expect(Node.safeParse({ ...base, label: null }).success).toBe(false);
  });

  it("rejects a snapshot with an unknown state and an unversioned message", () => {
    const snapshot = JSON.parse(lines[1] ?? "") as { nodes: { states?: string[] }[]; v?: number };
    const bad = structuredClone(snapshot);
    bad.nodes[0] = { ...bad.nodes[0], states: ["hovered"] };
    expect(ReaderMessage.safeParse(bad).success).toBe(false);
    const unversioned = structuredClone(snapshot);
    delete unversioned.v;
    expect(ReaderMessage.safeParse(unversioned).success).toBe(false);
  });
});

describe("exported JSON Schema", () => {
  it("matches the zod schemas (run `pnpm schema` after editing protocol.ts)", () => {
    expect(readFileSync(SCHEMA_PATH, "utf8")).toBe(renderProtocolJsonSchema());
  });
});

describe("plan schema", () => {
  const PLAN = fileURLToPath(new URL("../fixtures/golden/plan.json", import.meta.url));
  const golden: unknown = JSON.parse(readFileSync(PLAN, "utf8"));

  it("parses the golden plan losslessly, with one step of every end-state kind and both vias", () => {
    const p = Plan.parse(golden);
    expect(p).toEqual(golden);
    expect(new Set(p.steps.map((s) => s.end.kind))).toEqual(new Set(["valueEquals", "exists", "absent", "focused", "windowTitle", "windowFocused", "calendarEvent"]));
    expect(new Set(p.steps.flatMap((s) => (s.via === undefined ? [] : [s.via.kind])))).toEqual(new Set(["press", "openUrl"]));
  });

  it("rejects a target with nothing to find it by, a window with no title, and a date without an offset", () => {
    const g = structuredClone(golden) as { steps: { end: Record<string, unknown> }[] };
    const step = (end: Record<string, unknown>) => ({ ...g, steps: [{ says: "x", end }] });
    expect(Plan.safeParse(step({ kind: "exists", window: { title: "W" }, target: { describe: "x" } })).success).toBe(false);
    expect(Plan.safeParse(step({ kind: "exists", window: { bundleId: "b" }, target: { key: "k", describe: "x" } })).success).toBe(false);
    expect(Plan.safeParse(step({ kind: "calendarEvent", calendar: "c", title: "t", start: "2026-10-08T15:00:00", end: "2026-10-08T15:30:00Z" })).success).toBe(false);
    expect(Plan.safeParse(step({ kind: "pressed", window: { title: "W" } })).success).toBe(false);
  });

  it("matches the exported JSON Schema (run `pnpm schema` after editing executor/schema.ts)", () => {
    expect(readFileSync(PLAN_SCHEMA_PATH, "utf8")).toBe(renderPlanJsonSchema());
  });
});
