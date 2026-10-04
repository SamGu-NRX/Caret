import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, GRANT_MAX_MS, HelperMessage, HelperToReader, Node, ReaderMessage, StopReason } from "../src/protocol.ts";
import { PLAN_SCHEMA_PATH, renderPlanJsonSchema, renderProtocolJsonSchema, SCHEMA_PATH } from "../src/export-schema.ts";
import { helperProof } from "../src/server.ts";
import { Plan } from "../src/executor/schema.ts";

const GOLDEN = fileURLToPath(new URL("../fixtures/golden/protocol.ndjson", import.meta.url));
const lines = readFileSync(GOLDEN, "utf8").trim().split("\n");

describe("golden protocol fixture", () => {
  it("reads a fill field from a helper before B17, which sends no memory key, as one with memory null (review B17 #6)", () => {
    const line = JSON.parse(lines[7] as string) as { fields: Record<string, unknown>[] };
    const old = { ...line, fields: line.fields.filter((f) => f.memory === null).map(({ memory: _m, ...rest }) => rest) };
    const parsed = HelperMessage.parse(old) as { fields: { memory: unknown }[] };
    expect(parsed.fields.map((f) => f.memory)).toEqual([null, null]);
  });

  it("holds one of every message type", () => {
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toEqual([
      "hello", "snapshot", "focus", "appSwitch", "windowClosed", "pasteboard", "fillRequest", "fillProposal", "error",
      "readerCommand", "verbResult", "userInput", "taskProgress",
      "readerCommand", "fillResult", "taskControl", "activityRequest", "activity", "activityReply",
      "alternatives", "action", "popup", "offerAccept", "offerStop", "offerWithdrawn", "readerCommand",
      "offerWithdrawn", "taskControl", "taskProgress", "taskProgress", "offerWithdrawn",
      "settings", "settings", "offerWithdrawn",
      "actGrant", "readerCommand", "verbResult", "actRevoke",
      "planRequest", "planProposal", "planProposal",
      "readerCommand", "verbResult", "verbResult", "taskProgress", "calendarGrant",
      "skillOffer", "skillAnswer", "memoryReply", "skillOffer", "skillAnswer", "taskProgress", "taskProgress",
      "readerCommand", "userPress",
      "planRequest", "planProposal", "userPress",
      "skillOffer",
      "hello", "helperAuth", "hello", "readerCommand", "verbResult", "readerCommand", "verbResult",
    ]);
  });

  it("carries B23's hello fields, the helper's proof, a write's mark and an undo's sameAs, and the two new refusals", () => {
    const [reader, auth, host, write, moved, restore, notSame] = lines.slice(59, 66).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ReaderMessage.parse(reader)).toMatchObject({ role: "reader", session: "reader-3f9a6c21d4e8" });
    expect(ConsumerMessage.parse(host)).toMatchObject({ role: "consumer", host: true });
    // The proof is the HMAC of the reader's challenge under the launch secret: Emitter.swift checks the same line.
    const secret = Buffer.from("caret-b23-golden-launch-secret!!");
    expect(HelperToReader.parse(auth)).toEqual({ type: "helperAuth", v: 1, proof: helperProof(secret, String(reader?.challenge)) });
    expect(HelperToReader.parse(write)).toMatchObject({ verb: { kind: "write", mark: "8f14e45f-ceea-467f-a0e6-1c2b3d4e5f60" } });
    expect(HelperToReader.parse(restore)).toMatchObject({ verb: { kind: "write", sameAs: "8f14e45f-ceea-467f-a0e6-1c2b3d4e5f60" } });
    expect(ReaderMessage.parse(moved)).toMatchObject({ outcome: "focusMoved" });
    expect(ReaderMessage.parse(notSame)).toMatchObject({ outcome: "notSameElement" });
    // Each field belongs to one role, and a write records a mark or checks one, never both.
    expect(ConsumerMessage.safeParse({ ...reader, role: "consumer" }).success).toBe(false);
    expect(ReaderMessage.safeParse({ ...host, role: "reader" }).success).toBe(false);
    const verb = (write as { verb: Record<string, unknown> }).verb;
    expect(HelperToReader.safeParse({ ...write, verb: { ...verb, sameAs: "x" } }).success).toBe(false);
    expect(HelperToReader.safeParse({ ...write, verb: { ...verb, mark: "" } }).success).toBe(false);
  });

  it("carries B21's planRequest window, named as a host knows it, and the error for a window the reader has not read", () => {
    const [req, failed] = lines.slice(55, 57).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ConsumerMessage.parse(req)).toMatchObject({ type: "planRequest", window: { pid: 5150, number: 4821, title: "Caret Fixture — Executor" } });
    expect(HelperMessage.parse(failed)).toMatchObject({ outcome: "error", error: { code: "unseenWindow" } });
    const window = req?.window as Record<string, unknown>;
    for (const bad of [
      { ...req, windowId: "5150-1" },
      { ...req, window: { ...window, number: 0 } },
      { ...req, window: { ...window, number: 4821.5 } },
      { ...req, window: { ...window, pid: 0 } },
      { ...req, window: { pid: 5150, number: 4821 } },
    ]) expect(ConsumerMessage.safeParse(bad).success).toBe(false);
    // The title is the host's; an empty one (a window with no title) still names the window.
    expect(ConsumerMessage.safeParse({ ...req, window: { ...window, title: "" } }).success).toBe(true);
  });

  it("carries B20's press watch: the windows to watch, and a press the user made in one, read only", () => {
    const watch = JSON.parse(lines[53] ?? "") as Record<string, unknown>;
    const press = JSON.parse(lines[54] ?? "") as Record<string, unknown>;
    expect(HelperToReader.parse(watch)).toMatchObject({ verb: { kind: "watchPresses", windows: [{ pid: 5150, windowId: "5150-7" }] } });
    expect(ReaderMessage.parse(press)).toEqual({ type: "userPress", v: 1, at: 1790000601200, pid: 5150, windowId: "5150-7", key: "dev.caret.fixture/standard/button:send~0", role: "AXButton", label: "Send", via: "click" });
    // A press the walk did not keep has no key, and says so with null rather than leaving it out.
    expect(ReaderMessage.parse({ ...press, key: null })).toMatchObject({ key: null });
    const { key: _k, ...noKey } = press;
    expect(ReaderMessage.safeParse(noKey).success).toBe(false);
    expect(HelperMessage.safeParse(press).success).toBe(false);
    expect(ConsumerMessage.safeParse(press).success).toBe(false);
  });

  it("carries B21's press by key: Return on the window's default button, and how a press was made is required", () => {
    const press = JSON.parse(lines[57] ?? "") as Record<string, unknown>;
    expect(ReaderMessage.parse(press)).toMatchObject({ type: "userPress", label: "Send", via: "return" });
    for (const via of ["click", "return", "enter", "space"]) expect(ReaderMessage.safeParse({ ...press, via }).success).toBe(true);
    for (const bad of [{ ...press, via: "tab" }, { ...press, via: "Return" }]) expect(ReaderMessage.safeParse(bad).success).toBe(false);
    const { via: _v, ...noVia } = press;
    expect(ReaderMessage.safeParse(noVia).success).toBe(false);
  });

  it("carries B19's skills: a keep offer and its answer, skill entries in a memory reply, a promote offer, and an unprompted run", () => {
    const [keep, keepAnswer, reply, promote, promoteAnswer, started, done] = lines.slice(46, 53).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(HelperMessage.parse(keep)).toMatchObject({ kind: "keep", skillId: null, says: "Keep this as Subject and To into Mail Fixture?", detail: "Caret will offer it when you start it again." });
    expect(HelperMessage.parse(promote)).toMatchObject({ kind: "promote", skillId: "skill-5e6f7a8b", says: "Do this one on your own from now on?", detail: "You'll see it happen and can undo it." });
    for (const a of [keepAnswer, promoteAnswer]) {
      expect(ConsumerMessage.parse(a)).toMatchObject({ type: "skillAnswer", answer: "accept" });
      expect(HelperMessage.safeParse(a).success).toBe(false);
      expect(ConsumerMessage.safeParse({ ...a, answer: "later" }).success).toBe(false);
    }
    expect(ConsumerMessage.safeParse(keep).success).toBe(false);
    expect(HelperMessage.safeParse({ ...keep, skillId: "skill-5e6f7a8b" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...promote, skillId: null }).success).toBe(false);
    const parsed = HelperMessage.parse(reply) as { entries: { kind: string; status: string; fields: Record<string, unknown> }[] };
    expect(parsed.entries.map((e) => [e.kind, e.status])).toEqual([["skill", "learning"], ["skill", "learning"], ["routine", "active"]]);
    expect(parsed.entries[0]?.fields).toMatchObject({ name: "Subject and To into Mail Fixture", trigger: "a Mail Fixture window opens with Subject, To and Link empty", runs: 10, cleanRuns: 10, needed: 10, onItsOwn: false, handsOff: null });
    expect(parsed.entries[1]?.fields).toMatchObject({ handsOff: { label: "Send", why: "outbound" } });
    const badSkill = structuredClone(reply) as { entries: { fields: Record<string, unknown> }[] };
    badSkill.entries[1]!.fields.handsOff = { label: "Send", why: "unverifiable" };
    expect(HelperMessage.safeParse(badSkill).success).toBe(false);
    // The two shapes CaretScreenCore refuses too: a hands-off skill on its own, and a status its fields contradict.
    const onItsOwn = structuredClone(reply) as { entries: { status: string; fields: Record<string, unknown> }[] };
    onItsOwn.entries[1]!.fields.onItsOwn = true;
    onItsOwn.entries[1]!.status = "active";
    expect(HelperMessage.safeParse(onItsOwn).success).toBe(false);
    const wrongStatus = structuredClone(reply) as { entries: { status: string }[] };
    wrongStatus.entries[0]!.status = "active";
    expect(HelperMessage.safeParse(wrongStatus).success).toBe(false);
    for (const p of [started, done]) expect(HelperMessage.parse(p)).toMatchObject({ unprompted: true });
    expect(HelperMessage.safeParse({ ...done, unprompted: false }).success).toBe(false);
  });

  it("carries B16's calendar verbs: an add, its event, a refusal for no Calendar access, and the hand-off it becomes", () => {
    const [add, added, blocked, handoff] = lines.slice(41, 45).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(HelperToReader.parse(add)).toMatchObject({ verb: { kind: "calendarAdd", calendar: "Caret Test", taskId: "event-1" } });
    const grant = JSON.parse(lines[45] ?? "") as Record<string, unknown>;
    expect(HelperToReader.parse(grant)).toMatchObject({ type: "calendarGrant", taskId: "event-1" });
    expect(ConsumerMessage.safeParse(grant).success).toBe(false);
    expect(HelperToReader.safeParse({ ...grant, expires: (grant.at as number) + GRANT_MAX_MS + 1 }).success).toBe(false);
    expect(HelperToReader.safeParse({ ...grant, taskId: "" }).success).toBe(false);
    expect(ConsumerMessage.safeParse(add).success).toBe(false);
    expect(ReaderMessage.parse(added)).toMatchObject({ outcome: "ok", event: { id: "ev-1", title: "Coffee with Dana" } });
    expect(ReaderMessage.parse(blocked)).toMatchObject({ outcome: "blocked", blocked: "tcc" });
    expect(HelperMessage.parse(handoff)).toMatchObject({ phase: "handoff", blocked: "tcc" });
    expect(ReaderMessage.safeParse({ ...blocked, blocked: undefined }).success).toBe(false);
    expect(ReaderMessage.safeParse({ ...added, blocked: "tcc" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...handoff, phase: "done" }).success).toBe(false);
  });

  it("carries B16's planner pair: a request from the host, a proposal with a hand-off, and an error", () => {
    const [req, proposal, failed] = lines.slice(38, 41).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ConsumerMessage.parse(req)).toMatchObject({ type: "planRequest", windowId: "5150-1" });
    expect(HelperMessage.safeParse(req).success).toBe(false);
    expect(HelperMessage.parse(proposal)).toMatchObject({ outcome: "proposed", offerKey: "plan-1-ask-1", handoff: { label: "Send", why: "outbound" } });
    expect(HelperMessage.parse(failed)).toMatchObject({ outcome: "error", error: { code: "untracedValue" } });
    expect(ConsumerMessage.safeParse(proposal).success).toBe(false);
    for (const bad of [
      { ...req, instruction: "" },
      { ...req, instruction: "x".repeat(501) },
      { ...req, windowId: "" },
    ]) expect(ConsumerMessage.safeParse(bad).success).toBe(false);
    // The Swift mirror counts the same way (GoldenTests readsThePlannerPair): 250 emoji pass.
    expect(ConsumerMessage.safeParse({ ...req, instruction: "😀".repeat(250) }).success).toBe(true);
    expect(HelperMessage.safeParse({ ...failed, at: -1 }).success).toBe(false);
    for (const bad of [
      { ...proposal, error: { code: "unsure", detail: "x" } },
      { ...proposal, spec: null },
      { ...proposal, offerKey: null },
      { ...failed, error: null },
      { ...failed, offerKey: "plan-2" },
      { ...failed, handoff: { label: "Send", why: "outbound" } },
      { ...failed, error: { code: "guess", detail: "x" } },
      { ...failed, error: { code: "unsure", detail: "" } },
      { ...proposal, handoff: { label: "Send", why: "risky" } },
    ]) expect(HelperMessage.safeParse(bad).success).toBe(false);
  });

  it("carries B15's act grant: helper to reader only, capped, and a write that names its task", () => {
    const [grant, write, refused, revoke] = lines.slice(34, 38).map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const m of [grant, write, revoke]) {
      expect(HelperToReader.safeParse(m).success).toBe(true);
      expect(ConsumerMessage.safeParse(m).success).toBe(false);
      expect(ReaderMessage.safeParse(m).success).toBe(false);
    }
    expect(ReaderMessage.parse(refused)).toMatchObject({ outcome: "notAllowed" });
    expect(HelperToReader.parse(write)).toMatchObject({ verb: { kind: "write", taskId: "offer-5" } });
    const at = grant?.at as number;
    expect(HelperToReader.safeParse({ ...grant, expires: at + GRANT_MAX_MS }).success).toBe(true);
    expect(HelperToReader.safeParse({ ...grant, expires: at + GRANT_MAX_MS + 1 }).success).toBe(false);
    expect(HelperToReader.safeParse({ ...grant, expires: at }).success).toBe(false);
    for (const bad of [{ taskId: "" }, { windowId: "" }, { taskId: undefined }]) expect(HelperToReader.safeParse({ ...grant, ...bad }).success).toBe(false);
    const verb = write?.verb as Record<string, unknown>;
    expect(HelperToReader.safeParse({ ...write, verb: { ...verb, taskId: null } }).success).toBe(false);
    expect(HelperToReader.safeParse({ ...write, verb: { ...verb, taskId: "" } }).success).toBe(false);
    const { taskId: _, ...bare } = verb;
    expect(HelperToReader.safeParse({ ...write, verb: bare }).success).toBe(true);
    expect(HelperToReader.safeParse({ ...write, verb: { ...verb, attribute: "insert" } }).success).toBe(true);
    expect(HelperToReader.safeParse({ ...write, verb: { ...verb, attribute: "focusValue" } }).success).toBe(true);
    expect(HelperToReader.safeParse({ ...write, verb: { ...verb, attribute: "paste" } }).success).toBe(false);
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
    expect(ConsumerMessage.parse(full)).toEqual({ type: "settings", v: 1, at: 1790000130000, roles: ["fill", "repeat", "watch", "calendar", "words"], level: "balanced", paused: false });
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
    expect(new Set(p.steps.map((s) => s.end.kind))).toEqual(new Set(["valueEquals", "exists", "absent", "focused", "windowTitle", "windowFocused", "handoff", "calendarEvent"]));
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
