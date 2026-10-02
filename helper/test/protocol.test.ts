import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, HelperMessage, HelperToReader, Node, ReaderMessage } from "../src/protocol.ts";
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
    ]);
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
