import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { GRANT_MAX_MS, PAGE_SUBROLE, PROTOCOL_VERSION, TaskProgress, type HelperMessage, type StopReason } from "../src/protocol.ts";
import { CalendarBlocked, CalendarRefused, FakeCalendar } from "../src/executor/means.ts";
import { RecoveryJournal } from "../src/executor/journal.ts";
import { sameValue } from "../src/executor/executor.ts";
import { classifyLabel, classifyPress } from "../src/executor/risk.ts";
import { fillSlots, Plan, PlanError, type Step } from "../src/executor/schema.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { quotedPart } from "../src/executor/target.ts";
import { field, FIXTURE_APP, MAIL_APP, snap } from "./builders.ts";
import { executorWindow, FakeApp, K, TITLE, WIN, wireButtons } from "./fake-app.ts";

const W = { titleStartsWith: TITLE };
const write = (key: string, value: string, says = `${key} holds ${value}`): Step => ({ says, end: { kind: "valueEquals", window: W, target: { key, describe: says }, value } });
const plan = (steps: Step[], id = "p"): Plan => ({ id, title: id, slots: {}, steps });

describe("executor", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  let published: HelperMessage[];
  let calendar: FakeCalendar;
  let askJev: AskJev | null;

  const progress = (taskId: string): TaskProgress[] => published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.taskId === taskId);
  const acts = () => app.verbs.filter((v) => v.kind === "write" || v.kind === "press");
  /** Why the task's last progress says it stopped (protocol.ts StopReason). */
  const stopReason = (taskId: string): StopReason | undefined => progress(taskId).at(-1)?.stopReason;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-exec-"));
    store = new Store(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    published = [];
    calendar = new FakeCalendar();
    askJev = null;
    helper = new Helper({
      store,
      askJev: (req) => (askJev === null ? Promise.reject(new Error("no Jev in this test")) : askJev(req)),
      shadow: false,
      allowBackgroundFocus: false,
      publish: (m) => published.push(m),
      readerLink: app,
      calendar,
    });
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    // Every progress any test published is valid: a stop always says why, and nothing else does.
    for (const m of published) if (m.type === "taskProgress") TaskProgress.parse(m);
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes each value, verifies it against the change log, and reports every phase", async () => {
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana Whitfield"), write(K("textfield:email~0"), "dana@example.com")]), {});
    expect(r).toMatchObject({ outcome: "done", acted: 2, skipped: 0 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana Whitfield");
    expect(progress("t1").map((p) => p.phase)).toEqual(["started", "acting", "verified", "acting", "verified", "done"]);
  });

  it("brings a window to the front with a raise, writes nothing, and skips the step when the window is already in front", async () => {
    const front: Step = { says: "The executor window is in front", end: { kind: "windowFocused", window: W } };
    // The fake app refuses to raise, as a reader without --act-pids for it would.
    const r = await helper.executor.run("t1", plan([front]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0, detail: "the reader refused: notAllowed (the fake app does not raise its window)" });
    expect(stopReason("t1")).toBe("reader");
    expect(app.verbs.filter((v) => v.kind === "raise")).toEqual([{ kind: "raise", pid: FIXTURE_APP.pid, windowId: WIN, taskId: "t1" }]);
    expect(helper.executor.ledger("t1")).toEqual([]);

    // Focused within its app is not enough: the app must also be the one the user is in.
    void helper.handleReader(snap(structuredClone(app.nodes), { at: 5000, windowId: WIN, title: TITLE, focused: true }));
    expect(await helper.executor.run("t2", plan([front], "p2"), {})).toMatchObject({ outcome: "stopped", step: 0 });
    void helper.handleReader({ type: "appSwitch", v: PROTOCOL_VERSION, at: 5100, from: null, to: FIXTURE_APP });
    expect(await helper.executor.run("t3", plan([front], "p3"), {})).toMatchObject({ outcome: "done", acted: 0, skipped: 1 });
  });

  it("hands the field to the user, plainly, when the write and both fallbacks answer ok and change nothing (B20)", async () => {
    app.dropWrites = true;
    app.dropFocusValues = true;
    app.dropInserts = true;
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "handoff", step: 0 });
    expect(r.detail).toBe(`${FIXTURE_APP.name} did not take the text for the Name field while its window was in the background, so Caret left it to you`);
    expect(progress("t1").at(-1)).toMatchObject({ phase: "handoff", step: 0, says: `${K("textfield:name~0")} holds Dana` });
    // The value write, then focus-then-value, then insert; the second step never ran, and nothing went in the ledger.
    expect(acts().map((v) => (v.kind === "write" ? v.attribute : v.kind))).toEqual(["value", "focusValue", "insert"]);
    expect(helper.executor.ledger("t1")).toEqual([]);
    expect(app.node(K("textfield:name~0"))?.value ?? "").toBe("");
  });

  it("stops at once when the page changed after a press, records the write as possibly landed, and says so plainly (B28)", async () => {
    app.pageChangeAfterWrite = ["navigationStarted", "beforeunload"];
    app.enforceGrants = true;
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Yes"), write(K("textfield:email~0"), "d@example.com")]), {}, undefined, { grant: true });
    expect(r).toMatchObject({ outcome: "stopped", step: 0, detail: "The page changed after Caret pressed 'Yes', so Caret stopped." });
    expect(stopReason("t1")).toBe("changed");
    // One write went out: no fallback, no second step.
    expect(acts().map((v) => (v.kind === "write" ? v.attribute : v.kind))).toEqual(["value"]);
    expect(helper.executor.ledger("t1")).toMatchObject([{ kind: "write", before: "", after: "Yes", unconfirmed: true }]);
    // The grant ended with the run.
    expect(app.grants.log.at(-1)).toMatchObject({ type: "actRevoke", taskId: "t1" });

    // The page left, so the field is gone: undo cannot tell whether the press landed, and does not count it as never landed.
    app.pageChangeAfterWrite = undefined;
    app.nodes = app.nodes.filter((n) => n.key !== K("textfield:name~0"));
    app.show();
    await helper.executor.undo("t1");
    const undone = progress("t1").at(-1);
    expect(undone).toMatchObject({ phase: "undone", restored: 0, notRestored: 1 });
  });

  it("reads the window once more when the field is missing right after the insert, then hands it off if it is back unchanged", async () => {
    app.dropWrites = true;
    app.dropFocusValues = true;
    app.dropInserts = true;
    app.vanishAfter = "insert";
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r).toMatchObject({ outcome: "handoff", step: 0 });
    expect(app.verbs.at(-2)).toMatchObject({ kind: "walk" });
  });

  it("finishes the step when the field the walk lost comes back holding the value", async () => {
    app.dropWrites = true;
    app.dropFocusValues = true;
    app.vanishAfter = "insert";
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana");
    expect(helper.executor.ledger("t1")).toMatchObject([{ kind: "write", before: "", after: "Dana" }]);
  });

  it("reads the window once more when the field is missing right after the first value write, and finishes when it is back written", async () => {
    app.vanishAfter = "value";
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r).toMatchObject({ outcome: "done", acted: 1 });
    expect(acts().map((v) => (v.kind === "write" ? v.attribute : v.kind))).toEqual(["value"]);
  });

  it("ends as the user asked, not as a hand-off, when they take over while the insert fallback is on its way", async () => {
    app.dropWrites = true;
    app.dropFocusValues = true;
    app.dropInserts = true;
    app.beforeVerb = (_, v) => {
      if (v.kind === "write" && v.attribute === "insert") helper.executor.pause("t1", true);
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r.outcome).toBe("paused");
    expect(progress("t1").some((p) => p.phase === "handoff")).toBe(false);
  });

  it("keeps a fallback write that landed in the ledger when the user takes over while it was on its way (B20 review)", async () => {
    app.dropWrites = true;
    app.beforeVerb = (_, v) => {
      if (v.kind === "write" && v.attribute === "focusValue") helper.executor.pause("t1", true);
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r.outcome).toBe("paused");
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana");
    expect(helper.executor.ledger("t1")).toMatchObject([{ kind: "write", key: K("textfield:name~0"), before: "", after: "Dana" }]);
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
    expect(app.node(K("textfield:name~0"))?.value ?? "").toBe("");
  });

  it("reads the window once more when the field is missing right after an undo's restore", async () => {
    expect(await helper.executor.run("t1", plan([write(K("textfield:email~0"), "d@example.com")]), {})).toMatchObject({ outcome: "done" });
    app.vanishAfter = "value";
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1, notRestored: [] });
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
  });

  it("still stops on a mismatch when a fallback lands something other than the value", async () => {
    app.dropWrites = true;
    app.normalize = (v) => v.toUpperCase();
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(stopReason("t1")).toBe("mismatch");
  });

  it("falls back to focus-then-value when a value write is answered ok and changes nothing, and undoes the same way (B20)", async () => {
    app.dropWrites = true;
    const r = await helper.executor.run("t1", plan([write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("d@example.com");
    expect(progress("t1").filter((p) => p.phase === "acting").map((p) => p.detail?.split(";")[0])).toEqual(["write value", "focusValue"]);
    expect(acts().map((v) => (v.kind === "write" ? [v.attribute, v.expect] : v.kind))).toEqual([["value", "old@example.com"], ["focusValue", "old@example.com"]]);
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
    expect(acts().slice(2).map((v) => (v.kind === "write" ? v.attribute : v.kind))).toEqual(["value", "focusValue"]);
  });

  it("falls back to focus-and-insert when focus-then-value changes nothing too", async () => {
    app.dropWrites = true;
    app.dropFocusValues = true;
    const r = await helper.executor.run("t1", plan([write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "done", acted: 1 });
    expect(acts().map((v) => (v.kind === "write" ? v.attribute : v.kind))).toEqual(["value", "focusValue", "insert"]);
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
  });

  it("does not insert when another field changed while the dropped value write was on its way", async () => {
    app.dropWrites = true;
    app.afterVerb = (a, v) => {
      if (v.kind === "write" && v.attribute === "value") {
        a.setValue(K("textfield:name~0"), "someone else");
        a.show();
      }
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(stopReason("t1")).toBe("changed");
    expect(acts().map((v) => (v.kind === "write" ? v.attribute : v.kind))).toEqual(["value"]);
  });

  it("does not insert after a value write the app took and reformatted", async () => {
    app.normalize = (v) => v.toUpperCase();
    await helper.executor.run("t1", plan([write(K("textfield:email~0"), "d@example.com")]), {});
    expect(acts().map((v) => (v.kind === "write" ? v.attribute : v.kind))).toEqual(["value"]);
  });

  it("aborts when a field the step did not target changes while it acts", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind === "write") {
        a.setValue(K("group:billing/textfield:city~0"), "Austin");
        a.show();
      }
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(r.detail).toMatch(/billing.*changed although the step did not touch it/);
    expect(stopReason(r.taskId)).toBe("changed");
  });

  it("reruns a finished plan as a no-op: every step already holds and nothing is written or pressed", async () => {
    const p = plan([
      write(K("textfield:name~0"), "Dana"),
      { says: "the order is archived", end: { kind: "exists", window: W, target: { label: "Status: Archived", describe: "archived status" } }, via: { kind: "press", target: { label: "Archive", role: "AXButton", describe: "Archive button" } } },
      { says: "page 2 is showing", end: { kind: "windowTitle", window: W, title: `${TITLE} (page 2)` }, via: { kind: "press", target: { label: "Next page", describe: "Next page button" } } },
    ]);
    // G1: no capability makes Archive Caret's press, so the first run writes and hands Archive to the user.
    expect(await helper.executor.run("first", p, {})).toMatchObject({ outcome: "handoff", step: 1, detail: "Caret cannot check what pressing 'Archive' changes; you press it" });
    expect(acts().map((v) => v.kind)).toEqual(["write"]);
    // The user archives and pages on: the plan, run again, finds every end state already true.
    for (const key of [K("button:archive~0"), K("button:next page~0")]) app.buttons.get(key)?.(app);
    app.show();
    const again = await helper.executor.run("second", p, {});
    expect(again).toMatchObject({ outcome: "done", acted: 0, skipped: 3 });
    expect(acts().map((v) => v.kind)).toEqual(["write"]);
  });

  // G1 (CU-COUNSEL-R2 Q3): SAFE_PRESSES once let any plan press Archive, Save draft or Back; only the capability table may.
  it.each([
    ["Archive", "the order is archived", { kind: "exists" as const, window: W, target: { label: "Status: Archived", describe: "archived status" } }],
    ["Next page", "page 2 is showing", { kind: "windowTitle" as const, window: W, title: `${TITLE} (page 2)` }],
  ])("hands '%s' to the user: a label risk.ts calls safe is not a capability", async (label, says, end) => {
    const r = await helper.executor.run("t1", plan([{ says, end, via: { kind: "press", target: { label, role: "AXButton", describe: `${label} button` } } }]), {});
    expect(r).toMatchObject({ outcome: "handoff", step: 0, detail: `Caret cannot check what pressing '${label}' changes; you press it` });
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  it("presses Next only for the step its capability verifies, and hands it off for any other end state", async () => {
    app.nodes.push({ key: K("button:next~0"), parent: null, role: "AXButton", label: "Next" });
    app.buttons.set(K("button:next~0"), (a) => a.nodes.push({ key: K("textfield:description~0"), parent: null, role: "AXTextField", label: "Description", editable: true }));
    app.show();
    const next = { key: K("button:next~0"), role: "AXButton", label: "Next", describe: "Next button", exact: true as const };
    const other = await helper.executor.run("t1", plan([{ says: "the description shows", end: { kind: "exists", window: W, target: { label: "Description", describe: "the description field" } }, via: { kind: "press", target: next } }]), {});
    expect(other).toMatchObject({ outcome: "handoff", step: 0, detail: "Caret presses 'Next' only to check that it shows new fields, and this step checks something else; you press it" });
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
    const reveal = await helper.executor.run("t2", plan([{ says: "the next fields show", end: { kind: "fieldsRevealed", window: W, target: next }, via: { kind: "press", target: next } }], "p2"), {});
    expect(reveal).toMatchObject({ outcome: "done", acted: 1 });
    expect(app.verbs.filter((v) => v.kind === "press").map((v) => (v.kind === "press" ? v.label : ""))).toEqual(["Next"]);
  });

  it("hands a page's press to the user, whatever its label: the page engine never runs a page's own script", async () => {
    app.windowKind = "page";
    app.nodes.push({ key: K("button:next~0"), parent: null, role: "AXButton", label: "Next" });
    app.show();
    const next = { key: K("button:next~0"), role: "AXButton", label: "Next", describe: "Next button", exact: true as const };
    const r = await helper.executor.run("t1", plan([{ says: "the next fields show", end: { kind: "fieldsRevealed", window: W, target: next }, via: { kind: "press", target: next } }]), {});
    expect(r).toMatchObject({ outcome: "handoff", step: 0, detail: "'Next' runs the page's own script; you press it" });
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  it("refuses a press whose label reads as send and hands it to the user, after doing the steps before it", async () => {
    const p = plan([
      write(K("textfield:name~0"), "Dana"),
      { says: "the message is sent", end: { kind: "exists", window: W, target: { label: "Sent!", describe: "sent notice" } }, via: { kind: "press", target: { label: "Send", describe: "Send button" } } },
    ]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "handoff", step: 1 });
    expect(r.detail).toMatch(/'Send' reads as outbound/);
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
    expect(app.node(K("statictext:sent!~0"))).toBeUndefined();
    expect(progress("t1").at(-1)?.phase).toBe("handoff");
  });

  it("stops at a handoff end state after the steps before it, naming the control, and never presses it, on rerun too", async () => {
    const p = plan([
      write(K("textfield:name~0"), "Dana"),
      { says: "You press Send", end: { kind: "handoff", window: W, target: { key: K("button:send~0"), describe: "the Send button" }, why: "outbound" } },
    ]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "handoff", step: 1, acted: 1 });
    expect(r.detail).toBe("'Send' reads as outbound; Caret leaves that press to you");
    const again = await helper.executor.run("t2", p, {});
    expect(again).toMatchObject({ outcome: "handoff", step: 1, acted: 0, skipped: 1 });
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
    expect(app.node(K("statictext:sent!~0"))).toBeUndefined();
    const safe = plan([{ says: "You press Archive", end: { kind: "handoff", window: W, target: { key: K("button:archive~0"), describe: "the Archive button" }, why: "unverifiable" } }], "q");
    expect((await helper.executor.run("t3", safe, {})).detail).toBe("Caret cannot check what pressing 'Archive' changes, so it leaves that press to you");
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  // S1 audit #10: before B22 a safe-sounding label in a permission dialog was pressed.
  it("hands any press in a system prompt to the user, whatever its label says", async () => {
    app.windowKind = "systemdialog";
    app.show();
    const p = plan([{ says: "the next page shows", end: { kind: "exists", window: W, target: { label: "Page 2", describe: "page 2" } }, via: { kind: "press", target: { label: "Next page", describe: "Next page button" } } }]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "handoff", step: 0 });
    expect(r.detail).toBe("'Next page' reads as system; you press it");
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  // B22 review: a label that matches no risk word was pressed before; only labels the table knows to be safe are.
  it("hands a press it cannot classify to the user: no risk word is not evidence of safety", async () => {
    app.nodes.push({ key: K("button:transmit~0"), parent: null, role: "AXButton", label: "Transmit" });
    app.show();
    const p = plan([{ says: "the form is sent", end: { kind: "exists", window: W, target: { label: "Sent!", describe: "sent notice" } }, via: { kind: "press", target: { label: "Transmit", describe: "Transmit button" } } }]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "handoff", step: 0 });
    expect(r.detail).toBe("Caret cannot check what pressing 'Transmit' changes; you press it");
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  it("names a handoff's reason from the control's label, whatever reason the plan gives", async () => {
    const p = plan([{ says: "You press Send", end: { kind: "handoff", window: W, target: { key: K("button:send~0"), describe: "the Send button" }, why: "unverifiable" } }]);
    expect((await helper.executor.run("t1", p, {})).detail).toBe("'Send' reads as outbound; Caret leaves that press to you");
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  it("stops as unreachable when a handoff's control is not in the window", async () => {
    const p = plan([{ says: "You press Pay", end: { kind: "handoff", window: W, target: { role: "AXButton", label: "Pay now", describe: "the Pay button" }, why: "money" } }]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(stopReason("t1")).toBe("unreachable");
  });

  it("hands off a press on a control with no label, since its effect cannot be classified", async () => {
    const p = plan([{ says: "something happens", end: { kind: "exists", window: W, target: { label: "Done", describe: "done" } }, via: { kind: "press", target: { key: K("button:~0"), describe: "the unnamed button" } } }]);
    expect(await helper.executor.run("t1", p, {})).toMatchObject({ outcome: "handoff", step: 0 });
    expect(acts()).toHaveLength(0);
  });

  it("keeps an undo ledger and restores every write, newest first", async () => {
    const p = plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "dana@example.com")]);
    await helper.executor.run("t1", p, {});
    expect(helper.executor.ledger("t1")).toEqual([
      expect.objectContaining({ kind: "write", step: 0, key: K("textfield:name~0"), before: "", after: "Dana" }),
      expect.objectContaining({ kind: "write", step: 1, key: K("textfield:email~0"), before: "old@example.com", after: "dana@example.com" }),
    ]);
    const u = await helper.executor.undo("t1");
    expect(u).toEqual({ restored: 2, notRestored: [], notUndoable: 0 });
    expect(app.node(K("textfield:name~0"))?.value).toBeUndefined();
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
    expect(helper.executor.ledger("t1")).toEqual([]);
  });

  it("does not restore a field the user changed after Caret wrote it", async () => {
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "dana@example.com")]), {});
    app.setValue(K("textfield:name~0"), "Dana W. (edited by hand)");
    const u = await helper.executor.undo("t1");
    expect(u.restored).toBe(1);
    expect(u.notRestored).toEqual([{ step: 0, reason: expect.stringMatching(/changed after Caret wrote it/) }]);
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana W. (edited by hand)");
  });

  it("stops and names the step when a field changes after the plan started", async () => {
    app.afterVerb = (a, v) => {
      // After step 0's write, the user's other app changes step 2's field; nobody walks the window.
      if (v.kind === "write" && v.key === K("textfield:name~0")) a.setValue(K("textfield:email~0"), "typed@example.com");
    };
    const p = plan([write(K("textfield:name~0"), "Dana"), write(K("group:billing/textfield:city~0"), "Austin"), write(K("textfield:email~0"), "d@example.com")]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(r.detail).toMatch(/email.*changed since the plan started/);
    expect(stopReason(r.taskId)).toBe("changed");
    expect(app.node(K("textfield:email~0"))?.value).toBe("typed@example.com");
  });

  it("stops and names the step when its target is removed", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind === "write") a.nodes = a.nodes.filter((n) => n.key !== K("textfield:email~0"));
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(r.detail).toMatch(/not found/);
    expect(stopReason(r.taskId)).toBe("unreachable");
  });

  it("stops and names the step when a sheet covers the window", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind === "write") a.nodes.push({ key: K("sheet:~0"), parent: null, role: "AXSheet" });
    };
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(r.detail).toMatch(/a sheet covers/);
    expect(stopReason(r.taskId)).toBe("sheet");
  });

  it("pauses at the next step boundary on real input in the target window, and continues on resume", async () => {
    app.afterVerb = (_, v) => {
      if (v.kind === "write" && v.key === K("textfield:name~0")) {
        void helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: 5, pid: FIXTURE_APP.pid, kind: "mouse", point: [50, 50] });
      }
    };
    const p = plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]);
    const r = await helper.executor.run("t1", p, {});
    expect(r).toMatchObject({ outcome: "paused", step: 1 });
    expect(progress("t1").at(-1)).toMatchObject({ phase: "paused", step: 1 });
    app.afterVerb = null;
    expect(await helper.executor.resume("t1")).toMatchObject({ outcome: "done", acted: 2 });
  });

  it("ignores input in other processes and clicks outside the window", async () => {
    app.afterVerb = (_, v) => {
      if (v.kind !== "write") return;
      void helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: 5, pid: 999, kind: "key", point: null });
      void helper.handleReader({ type: "userInput", v: PROTOCOL_VERSION, at: 5, pid: FIXTURE_APP.pid, kind: "mouse", point: [5000, 5000] });
    };
    expect((await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@x.example")]), {})).outcome).toBe("done");
  });

  it("tries a failed walk again, but stops after three failures in a row", async () => {
    app.failWalks = 2;
    expect((await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {})).outcome).toBe("done");
    app.failWalks = 3;
    const r = await helper.executor.run("t2", plan([write(K("textfield:email~0"), "x@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(r.detail).toMatch(/cannot re-read/);
    expect(stopReason(r.taskId)).toBe("reader");
  });

  it("keeps a step's end target and its press target apart, and names the press target in the hand-off", async () => {
    const p = plan([
      {
        says: "page 2 is showing",
        end: { kind: "valueEquals", window: W, target: { key: K("statictext:page~0"), describe: "the page line" }, value: "Page 2" },
        via: { kind: "press", target: { label: "Next page", role: "AXButton", describe: "Next page button" } },
      },
    ]);
    // The end target resolved to the page line, which does not hold; the press resolved to its own button, which G1 hands off.
    expect(await helper.executor.run("t1", p, {})).toMatchObject({ outcome: "handoff", step: 0, detail: "Caret cannot check what pressing 'Next page' changes; you press it" });
    expect(app.verbs.some((v) => v.kind === "press")).toBe(false);
  });

  it("asks the reader to watch the task's process while it runs, and stops watching after", async () => {
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    const watches = app.verbs.filter((v) => v.kind === "watchInput").map((v) => (v.kind === "watchInput" ? v.pids : []));
    expect(watches).toEqual([[FIXTURE_APP.pid], []]);
  });

  it("records what it wrote when the app reformatted it, stops on the mismatch, and refuses the undo, as a reformat reads like typing (B29)", async () => {
    app.normalize = (v) => v.toUpperCase();
    const r = await helper.executor.run("t1", plan([write(K("textfield:email~0"), "dana@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(helper.executor.ledger("t1")).toEqual([expect.objectContaining({ before: "old@example.com", after: "dana@example.com", mayIncludeInput: true })]);
    app.normalize = null;
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 0, notRestored: [{ step: 0, reason: expect.stringMatching(/may hold your typing/) }] });
    expect(app.node(K("textfield:email~0"))?.value).toBe("DANA@EXAMPLE.COM");
  });

  it("never takes a keystroke that lands between its write and the read-back for its own: undo leaves the field (B29)", async () => {
    // The user types "s" right as Caret writes "Dana"; the read-back walk sees "Danas" before the input reaches the task.
    app.keystrokeAfterWrite = "s";
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Danas");
    const ledger = helper.executor.ledger("t1");
    const u = await helper.executor.undo("t1");
    expect(app.node(K("textfield:name~0"))?.value).toBe("Danas");
    expect(u.restored).toBe(0);
    expect(u.notRestored).toEqual([{ step: 0, reason: 'the field changed while Caret wrote it and may hold your typing, so Caret left it as it is; the field now holds "Danas"; before the write it held ""' }]);
    expect(ledger).toEqual([expect.objectContaining({ before: "", after: "Dana", mayIncludeInput: true })]);
    // No restore was sent: undo refused from the field it read, before any write.
    expect(acts().filter((v) => v.kind === "write" && v.sameAs !== undefined)).toEqual([]);
  });

  it("refuses an undo whose field no longer holds exactly what Caret wrote, before sending any restore (B29)", async () => {
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(helper.executor.ledger("t1")).toEqual([expect.not.objectContaining({ mayIncludeInput: true })]);
    app.setValue(K("textfield:name~0"), "Dana ");
    const u = await helper.executor.undo("t1");
    expect(u.notRestored).toEqual([{ step: 0, reason: "the field changed after Caret wrote it, so Caret left it as it is" }]);
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana ");
    expect(acts().filter((v) => v.kind === "write" && v.sameAs !== undefined)).toEqual([]);
  });

  it("records a write whose answer was lost, so undo can still restore it", async () => {
    app.timeoutAfterWrite = true;
    const r = await helper.executor.run("t1", plan([write(K("textfield:email~0"), "dana@example.com")]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("dana@example.com");
    app.timeoutAfterWrite = false;
    expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
  });

  it("refuses to undo or resume across a reader restart, since window ids start over", async () => {
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "t" });
    await expect(helper.executor.undo("t1")).rejects.toThrow(/reader that has since restarted/);
  });

  it("restores only the element it wrote: a sibling that took over the field's key, role and value is refused by name (S1 audit #6)", async () => {
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "dana@example.com")]), {});
    // The app replaces the Name field with an identical sibling: same key, role, label, and the value Caret wrote.
    app.marks.replace(WIN, K("textfield:name~0"));
    const u = await helper.executor.undo("t1");
    expect(u.restored).toBe(1);
    expect(u.notRestored).toEqual([{ step: 0, reason: expect.stringMatching(/^the field Caret wrote is no longer the element at that place, so Caret left it alone \(another element now has this key\)$/) }]);
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana");
    expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
    // Each forward write named a mark of its own; each restore named its write's mark back.
    const writes = app.verbs.filter((v) => v.kind === "write" && v.attribute === "value");
    const marks = writes.slice(0, 2).map((v) => (v.kind === "write" ? v.mark : undefined));
    expect(marks.every((m) => typeof m === "string") && new Set(marks).size === 2).toBe(true);
    expect(writes.slice(2).map((v) => (v.kind === "write" ? v.sameAs : undefined))).toEqual([marks[1], marks[0]]);
  });

  it("keeps undo across a reconnect of the same reader, and refuses it under a reader launched since (B23)", async () => {
    const hello = (session: string) => void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "t", session });
    hello("reader-launch-1");
    app.show();
    await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    hello("reader-launch-1");
    app.show();
    expect(await helper.executor.undo("t1")).toEqual({ restored: 1, notRestored: [], notUndoable: 0 });
    await helper.executor.run("t2", plan([write(K("textfield:name~0"), "Dana")], "p2"), {});
    hello("reader-launch-2");
    app.show();
    await expect(helper.executor.undo("t2")).rejects.toThrow(/ran under a reader that has since restarted/);
    expect(app.node(K("textfield:name~0"))?.value).toBe("Dana");
  });

  it("hands the field off, plainly, when focus moves away from it as the reader focuses it, and writes nothing (S1 audit #14)", async () => {
    app.focusMovesOn = new Set(["value"]);
    const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
    expect(r).toMatchObject({ outcome: "handoff", step: 0, detail: "focus moved away from the Name field when Caret focused it, so Caret did not write it; it is yours to fill" });
    expect(progress("t1").at(-1)).toMatchObject({ phase: "handoff" });
    expect(app.node(K("textfield:name~0"))?.value).toBeUndefined();
    expect(helper.executor.ledger("t1")).toEqual([]);
    // No fallback write was tried after it.
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(1);
  });

  // B23 review: recovery renamed the task, and the reader's calendar, which lets only the adding task remove an event, refused.
  it("undoes a recovered run's calendar event under the task id the calendar knows it by", async () => {
    const addedBy = new Map<string, string>();
    const add = calendar.add.bind(calendar);
    const remove = calendar.remove.bind(calendar);
    calendar.add = async (cal, title, start, end, taskId) => {
      const ev = await add(cal, title, start, end, taskId);
      addedBy.set(ev.id, taskId ?? "");
      return ev;
    };
    calendar.remove = async (id, taskId) => {
      if (addedBy.get(id) !== taskId) throw new CalendarRefused("notAllowed", "another task added this event; only that task removes it");
      await remove(id, taskId);
    };
    const p = plan([{ says: "Lunch is on Caret Test", end: { kind: "calendarEvent", calendar: "Caret Test", title: "Lunch", start: "2026-10-08T12:00:00-05:00", end: "2026-10-08T12:30:00-05:00" } }], "lunch");
    expect(await helper.executor.run("event-1", p, {}, undefined, { grant: true })).toMatchObject({ outcome: "done" });
    // The helper dies with the run's row saved; a new helper on the same data takes it back.
    const journal = new RecoveryJournal(join(dir, "data"));
    journal.save({ taskId: "event-1", startedAt: 1, savedAt: Date.now(), plan: p, unprompted: false, granted: true, readerId: null, next: 1, ledger: [...helper.executor.ledger("event-1")], pending: null, skillId: null, window: null });
    journal.close();
    const again = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app, calendar });
    expect(again.tasks.get("event-1")).toMatchObject({ state: "failed", detail: "Stopped when Caret restarted, after its last step", undoable: true });
    expect(await again.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "event-1", action: "undo" })).toMatchObject({ restored: 1, notRestored: [] });
    expect(calendar.events.size).toBe(0);
    again.journal.close();
  });

  // B29 review 1: a row saved before B29 may hold a native write's read-back as `after`, the user's keystroke included.
  it("refuses to undo a recovered write from a row saved before B29, and still undoes one saved since", async () => {
    const p = plan([write(K("textfield:name~0"), "Dana")]);
    expect(await helper.executor.run("t-old", p, {})).toMatchObject({ outcome: "done" });
    const [entry] = helper.executor.ledger("t-old");
    if (entry?.kind !== "write") throw new Error("no write entry");
    // The user typed "s" as Caret wrote; the old code kept the read-back "Danas" as the write's result.
    app.setValue(K("textfield:name~0"), "Danas");
    const journal = new RecoveryJournal(join(dir, "data"));
    const row = { startedAt: 1, savedAt: Date.now(), plan: p, unprompted: false, granted: true, readerId: null, next: 1, pending: null, skillId: null, window: null };
    journal.save({ ...row, taskId: "legacy", ledger: [{ ...entry, after: "Danas" }] });
    journal.close();
    const again = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app, calendar });
    app.helper = again;
    app.show();
    const u = await again.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "legacy", action: "undo" });
    expect(app.node(K("textfield:name~0"))?.value).toBe("Danas");
    expect(u).toMatchObject({ restored: 0, notRestored: [{ step: 0, reason: expect.stringMatching(/may hold your typing/) }] });
    again.journal.close();
    // A row this executor saves says its `after` is what Caret meant to write, and its undo goes through.
    app.setValue(K("textfield:name~0"), "Dana");
    app.helper = helper;
    app.show();
    // The row is dropped once the run ends, so its saves are read as they happen.
    const saved: unknown[] = [];
    (helper.executor as unknown as { deps: { journal?: { save: (r: unknown) => void; drop: () => void } } }).deps.journal = { save: (r) => saved.push(r), drop: () => {} };
    expect(await helper.executor.run("t-new", plan([write(K("textfield:email~0"), "d@example.com")]), {})).toMatchObject({ outcome: "done" });
    expect(saved.at(-1)).toMatchObject({ afterIntended: true });
  });

  // B23 second review: a recovered row an undo could not finish stayed for every start, even once its reader was gone,
  // and a calendar undo refused for want of Calendar access settled its entry for good.
  it("keeps a recovered calendar run's row while Calendar access is missing, and drops it once a reader launched since connects", async () => {
    const p = plan([{ says: "Lunch is on Caret Test", end: { kind: "calendarEvent", calendar: "Caret Test", title: "Lunch", start: "2026-10-08T12:00:00-05:00", end: "2026-10-08T12:30:00-05:00" } }], "lunch");
    const hello = (h: Helper, session: string) => void h.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "t", session });
    hello(helper, "reader-launch-1");
    app.show();
    expect(await helper.executor.run("event-1", p, {}, undefined, { grant: true })).toMatchObject({ outcome: "done" });
    const journal = new RecoveryJournal(join(dir, "data"));
    journal.save({ taskId: "event-1", startedAt: 1, savedAt: Date.now(), plan: p, unprompted: false, granted: true, readerId: "reader-launch-1", next: 1, ledger: [...helper.executor.ledger("event-1")], pending: null, skillId: null, window: null });
    journal.close();
    const again = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app, calendar });
    hello(again, "reader-launch-1");
    const get = calendar.get.bind(calendar);
    calendar.get = async () => {
      throw new CalendarBlocked("tcc", "blocked: tcc");
    };
    expect(await again.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "event-1", action: "undo" })).toMatchObject({ restored: 0, notRestored: [{ step: 0 }] });
    calendar.get = get;
    expect(again.journal.rawRows()).toHaveLength(1);
    // A reader launched since can never undo it: the row goes.
    hello(again, "reader-launch-2");
    expect(again.journal.rawRows()).toEqual([]);
    again.journal.close();
  });

  describe("an ambiguous target", () => {
    const shippingCity: Step = {
      says: "the shipping city is Austin",
      end: { kind: "valueEquals", window: W, target: { role: "AXTextField", label: "City", describe: "the city field of the shipping address" }, value: "Austin" },
    };
    /** Picks the shipping field in ask 1, and `second` in ask 2. */
    const jev = (second: "shipping" | "billing"): AskJev => {
      let n = 0;
      return async (req) => {
        const which = ++n % 2 === 1 ? "shipping" : second;
        const q = req.questions.target!;
        const id = Object.entries(q.criteria).find(([, d]) => d?.includes(`inside '${which === "shipping" ? "Shipping" : "Billing"}'`))?.[0] ?? "none";
        return { model: "t", answers: { target: { choice: id, confidence: 0.9 } }, inputTokens: 100, latencyMs: 1, costUsd: 0 };
      };
    };

    it("acts when both asks pick the same element", async () => {
      askJev = jev("shipping");
      const r = await helper.executor.run("t1", plan([shippingCity]), {});
      expect(r).toMatchObject({ outcome: "done", jevCalls: 2 });
      expect(app.node(K("group:shipping/textfield:city~0"))?.value).toBe("Austin");
      expect(app.node(K("group:billing/textfield:city~0"))?.value).toBeUndefined();
    });

    describe("with the value copied from another window", () => {
      const SRC = "6262-1";
      const city: Step = { ...shippingCity, says: "the shipping city is {{city}}", end: { ...shippingCity.end, value: "{{city}}" } as Step["end"] };
      const sourced: Plan = { id: "src", title: "src", slots: { city: "the city" }, sources: { city: SRC }, steps: [city] };
      /** A Messages thread, which gives a question under half its text however short it is. */
      const showSource = (lines: string[]): void => {
        void helper.handleReader(snap(lines.map((l, i) => ({ key: `dev.caret.messages/standard/statictext:${i}~0`, parent: null, role: "AXStaticText", label: l })), { at: 100, windowId: SRC, title: "Dana", app: { pid: 6262, bundleId: "com.apple.MobileSMS", name: "Messages" } }));
      };

      it("charges the quoted value to the window it came from", async () => {
        showSource(["Ship to Austin", "Order ORD-2026-48213", "Placed September 28, 2026", "Total $1,315.50"]);
        const asked: Parameters<AskJev>[0][] = [];
        const pick = jev("shipping");
        askJev = (req) => (asked.push(req), pick(req));
        expect(await helper.executor.run("t1", sourced, { city: "Austin" })).toMatchObject({ outcome: "done", jevCalls: 2 });
        for (const req of asked) expect(req.snippets).toContainEqual({ windowId: SRC, kind: "candidate", text: "Austin" });
      });

      it("charges the window as the task found it once it has closed", async () => {
        // Austin is a whole line, so quoting it charges the chat; cut from a longer line, under 12 characters, it would
        // not be (OUTPUT-LEDGER-SPEC section 4, residuals).
        showSource(["Ship to:", "Austin", "Order ORD-2026-48213", "Placed September 28, 2026", "Total $1,315.50"]);
        const asked: Parameters<AskJev>[0][] = [];
        const pick = jev("shipping");
        askJev = (req) => (asked.push(req), pick(req));
        // run() records the task before its first await, so the source closes after the task found it
        // and before the target question.
        const running = helper.executor.run("t1", sourced, { city: "Austin" });
        expect(helper.model.close(SRC, 150)).not.toBeNull();
        expect(await running).toMatchObject({ outcome: "done", jevCalls: 2 });
        expect(asked).toHaveLength(2);
        for (const req of asked) {
          expect(req.snippets).toContainEqual({ windowId: SRC, kind: "candidate", text: "Austin" });
          expect(req.charged[SRC]).toBeGreaterThanOrEqual("Austin".length);
        }
      });

      it("does not ask when the value's window was never seen", async () => {
        let calls = 0;
        askJev = async (req) => (calls++, jev("shipping")(req));
        const r = await helper.executor.run("t1", { ...sourced, sources: { city: "9999-1" } }, { city: "Austin" });
        expect(r).toMatchObject({ outcome: "stopped", step: 0 });
        expect(calls).toBe(0);
      });

      it("does not ask when the value is more of its window than one question may carry", async () => {
        // Under half of a two-line chat is a few characters, and the city alone is more.
        showSource(["Austin, TX 78704", "ok"]);
        let calls = 0;
        askJev = async (req) => (calls++, jev("shipping")(req));
        const r = await helper.executor.run("t1", sourced, { city: "Austin, TX 78704" });
        expect(r).toMatchObject({ outcome: "stopped", step: 0 });
        expect(r.detail).toMatch(/more of a window than one question may/);
        expect(stopReason(r.taskId)).toBe("unreachable");
        expect(calls).toBe(0);
        expect(acts()).toHaveLength(0);
      });
    });

    it("stops without acting when the asks disagree", async () => {
      askJev = jev("billing");
      const r = await helper.executor.run("t1", plan([shippingCity]), {});
      expect(r).toMatchObject({ outcome: "stopped", step: 0 });
      expect(r.detail).toMatch(/did not agree/);
      expect(stopReason(r.taskId)).toBe("unreachable");
      expect(acts()).toHaveLength(0);
    });
  });

  it("adds a calendar event through the calendar interface, skips it on rerun, and undoes it", async () => {
    const ev: Step = {
      says: "Coffee with Dana is on the Caret Test calendar",
      end: { kind: "calendarEvent", calendar: "Caret Test", title: "Coffee with {{who}}", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" },
    };
    const p: Plan = { id: "cal", title: "cal", slots: { who: "the person" }, steps: [ev] };
    expect(await helper.executor.run("t1", p, { who: "Dana" })).toMatchObject({ outcome: "done", acted: 1 });
    expect([...calendar.events.values()].map((e) => e.title)).toEqual(["Coffee with Dana"]);
    expect(await helper.executor.run("t2", p, { who: "Dana" })).toMatchObject({ outcome: "done", skipped: 1, acted: 0 });
    expect(await helper.executor.undo("t1")).toEqual({ restored: 1, notRestored: [], notUndoable: 0 });
    expect(calendar.events.size).toBe(0);
  });

  it("rejects an invalid plan and a duplicate task id loudly", async () => {
    await expect(helper.executor.run("t1", { id: "x", steps: [] }, {})).rejects.toThrow(PlanError);
    await helper.executor.run("t2", plan([write(K("textfield:name~0"), "Dana")]), {});
    await expect(helper.executor.run("t2", plan([write(K("textfield:name~0"), "Dana")]), {})).rejects.toThrow(/already exists/);
  });

  it("publishes a request error instead of throwing when a consumer sends a bad plan", async () => {
    await helper.handleTask({ type: "runPlan", v: PROTOCOL_VERSION, taskId: "bad", plan: { nope: true }, slots: {} });
    expect(published.at(-1)).toMatchObject({ type: "error", message: expect.stringMatching(/task bad: invalid plan/) });
  });

  it("stops when the window the plan names is not open", async () => {
    const r = await helper.executor.run("t1", plan([{ says: "x", end: { kind: "exists", window: { title: "Nope" }, target: { label: "A", describe: "a" } } }]), {});
    expect(r).toMatchObject({ outcome: "stopped", step: 0 });
    expect(r.detail).toMatch(/no window matches/);
    expect(stopReason(r.taskId)).toBe("windowGone");
    void WIN;
  });

  // B15: the four stop reasons no test reached before.
  describe("stop reasons", () => {
    it("ambiguous: two open windows match the plan's selector", async () => {
      void helper.handleReader(snap([], { at: 2000, windowId: "5150-8", title: `${TITLE} (copy)`, reason: "request" }));
      const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {});
      expect(r).toMatchObject({ outcome: "stopped", step: 0 });
      expect(r.detail).toMatch(/2 windows match/);
      expect(stopReason("t1")).toBe("ambiguous");
      expect(acts()).toHaveLength(0);
    });

    it("readerRestarted: a new reader sends a window under an id the task already bound", async () => {
      app.afterVerb = (a, v) => {
        if (v.kind !== "write" || v.key !== K("textfield:name~0")) return;
        a.afterVerb = null;
        void helper.handleReader({ type: "hello", v: PROTOCOL_VERSION, role: "reader", mode: "live", pid: 2, version: "t" });
        // The new reader numbers windows from scratch, so the same id may now name the same window or another.
        a.show();
      };
      const r = await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]), {});
      expect(r).toMatchObject({ outcome: "stopped", step: 1 });
      expect(stopReason("t1")).toBe("readerRestarted");
      expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
    });

    it("notConfigured: a step adds an event and the helper has no calendar", async () => {
      const bareStore = new Store(join(dir, "bare"));
      const bare = new Helper({ store: bareStore, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app });
      try {
        const ev: Step = { says: "x", end: { kind: "calendarEvent", calendar: "Caret Test", title: "Coffee", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" } };
        const r = await bare.executor.run("t1", plan([ev]), {});
        expect(r).toMatchObject({ outcome: "stopped", step: 0, detail: "no calendar is configured" });
        expect(stopReason("t1")).toBe("notConfigured");
      } finally {
        bare.shutdown();
        bare.memory.close();
        bareStore.close();
      }
    });

    // G2 (CU-COUNSEL-R2 Q3): the URL opener dispatched outside act(), so no URL is Caret's to open.
    it("hands a step that opens a URL to the user, and dispatches nothing", async () => {
      const step: Step = { says: "the page is open", end: { kind: "exists", window: W, target: { label: "Status: Done", describe: "a done line" } }, via: { kind: "openUrl", url: "https://example.com/" } };
      const r = await helper.executor.run("t1", plan([step]), {});
      expect(r).toMatchObject({ outcome: "handoff", step: 0, detail: "open https://example.com/ yourself" });
      expect(progress("t1").at(-1)?.phase).toBe("handoff");
      expect(acts()).toEqual([]);
    });

    it("error: anything else that ends the run, such as the calendar store failing", async () => {
      calendar.add = () => Promise.reject(new Error("the calendar store is locked"));
      const ev: Step = { says: "x", end: { kind: "calendarEvent", calendar: "Caret Test", title: "Coffee", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" } };
      const r = await helper.executor.run("t1", plan([ev]), {});
      expect(r).toMatchObject({ outcome: "stopped", step: 0, detail: "the calendar store is locked" });
      expect(stopReason("t1")).toBe("error");
    });
  });

  // B15: a task from an accepted offer holds an act grant for its one window; the fake refuses acts
  // without one, as caret-screen started without --act-pids does.
  describe("act grants", () => {
    const two = (): Plan => plan([write(K("textfield:name~0"), "Dana"), write(K("textfield:email~0"), "d@example.com")]);
    const kinds = (): string[] => app.grants.log.map((m) => m.type);
    const taskIds = (): (string | undefined)[] => app.verbs.flatMap((v) => (v.kind === "write" || v.kind === "press" || v.kind === "raise" ? [v.taskId] : []));
    beforeEach(() => {
      app.enforceGrants = true;
    });

    it("grants the task's window before the first act, names the task on every act, and revokes when done", async () => {
      const before = Date.now();
      expect(await helper.executor.run("t1", two(), {}, undefined, { grant: true })).toMatchObject({ outcome: "done", acted: 2 });
      expect(kinds()).toEqual(["actGrant", "actRevoke"]);
      const g = app.grants.log[0];
      expect(g).toMatchObject({ taskId: "t1", pid: FIXTURE_APP.pid, windowId: WIN });
      if (g?.type !== "actGrant") throw new Error("no grant");
      expect(g.at).toBeGreaterThanOrEqual(before);
      expect(g.expires - g.at).toBe(GRANT_MAX_MS);
      expect(taskIds()).toEqual(["t1", "t1"]);
    });

    it("a consumer's runPlan gets no grant, so the reader refuses its first act and nothing is written", async () => {
      const r = await helper.handleTask({ type: "runPlan", v: PROTOCOL_VERSION, taskId: "t1", plan: two(), slots: {} });
      expect(r).toMatchObject({ outcome: "stopped", step: 0 });
      expect(r !== null && "detail" in r ? r.detail : "").toMatch(/notAllowed \(no act grant for task t1/);
      expect(stopReason("t1")).toBe("reader");
      expect(app.node(K("textfield:name~0"))?.value).toBeUndefined();
      expect(app.grants.log).toEqual([]);
    });

    it("a grant that expires mid-run stops it for reason reader, and the next field is left as it was", async () => {
      let clock = Date.now();
      app.grants.now = () => clock;
      app.afterVerb = (_, v) => {
        if (v.kind === "write" && v.key === K("textfield:name~0")) clock += GRANT_MAX_MS;
      };
      const r = await helper.executor.run("t1", two(), {}, undefined, { grant: true });
      expect(r).toMatchObject({ outcome: "stopped", step: 1 });
      expect(r.detail).toMatch(/the act grant for task t1 has expired/);
      expect(stopReason("t1")).toBe("reader");
      expect(app.node(K("textfield:name~0"))?.value).toBe("Dana");
      expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
      expect(kinds()).toEqual(["actGrant", "actRevoke"]);
    });

    it("refuses an act in another window of the same app, or in another process, under the task's grant", async () => {
      void helper.handleReader(snap([field(K("textfield:subject~0"), "")], { at: 2000, windowId: "5150-8", title: "Other window", reason: "request" }));
      void helper.handleReader(snap([field(K("textfield:subject~0"), "")], { at: 2000, windowId: "6160-1", title: "Mail form", app: MAIL_APP, reason: "request" }));
      app.readable.add("5150-8").add("6160-1");
      const elsewhere = (title: string): Step => ({ says: "subject", end: { kind: "valueEquals", window: { title }, target: { key: K("textfield:subject~0"), describe: "subject" }, value: "Hi" } });
      for (const [id, title, why] of [
        ["t1", "Other window", `covers window ${WIN}, not 5150-8`],
        ["t2", "Mail form", `covers process ${FIXTURE_APP.pid}, not ${MAIL_APP.pid}`],
      ] as const) {
        const r = await helper.executor.run(id, plan([write(K("textfield:name~0"), id), elsewhere(title)]), {}, undefined, { grant: true });
        expect(r).toMatchObject({ outcome: "stopped", step: 1 });
        expect(r.detail).toContain(why);
        expect(stopReason(id)).toBe("reader");
      }
      expect(helper.model.windows.get("5150-8")?.nodes.get(K("textfield:subject~0"))?.value).toBeUndefined();
      expect(helper.model.windows.get("6160-1")?.nodes.get(K("textfield:subject~0"))?.value).toBeUndefined();
    });

    it("a stop revokes the grant at once: an act already on its way is refused, and the run ends as stopped by you", async () => {
      app.beforeVerb = (_, v) => {
        if (v.kind === "write" && v.key === K("textfield:email~0")) helper.executor.stop("t1");
      };
      const r = await helper.executor.run("t1", two(), {}, undefined, { grant: true });
      expect(r).toMatchObject({ outcome: "stopped", step: 1 });
      expect(stopReason("t1")).toBe("you");
      expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
      expect(kinds()).toEqual(["actGrant", "actRevoke"]);
    });

    it("a take-over revokes the grant at once and the run is handed back, not failed", async () => {
      app.beforeVerb = (_, v) => {
        if (v.kind === "write" && v.key === K("textfield:email~0")) helper.executor.pause("t1", true);
      };
      const r = await helper.executor.run("t1", two(), {}, undefined, { grant: true });
      expect(r).toMatchObject({ outcome: "paused", step: 1 });
      expect(r.detail).toMatch(/handed this back/);
      expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
      expect(kinds()).toEqual(["actGrant", "actRevoke"]);
    });

    // S1 audit #3: before B22 an ordinary pause kept the grant to the step boundary.
    it("a pause revokes the grant the moment it is recorded, and resume grants again", async () => {
      app.afterVerb = (a, v) => {
        if (v.kind !== "write" || v.key !== K("textfield:name~0")) return;
        a.afterVerb = null;
        helper.executor.pause("t1", false);
        expect(kinds()).toEqual(["actGrant", "actRevoke"]);
      };
      expect(await helper.executor.run("t1", two(), {}, undefined, { grant: true })).toMatchObject({ outcome: "paused", step: 1 });
      expect(kinds()).toEqual(["actGrant", "actRevoke"]);
      expect(await helper.executor.resume("t1")).toMatchObject({ outcome: "done" });
      expect(kinds()).toEqual(["actGrant", "actRevoke", "actGrant", "actRevoke"]);
    });

    it("a pause for the user's own input, from the host or the reader, revokes the grant at once and the act on its way is refused", async () => {
      for (const [id, how] of [
        ["t1", "host"],
        ["t2", "reader"],
      ] as const) {
        app.setValue(K("textfield:name~0"), "");
        app.setValue(K("textfield:email~0"), "old@example.com");
        app.show();
        app.beforeVerb = (a, v) => {
          if (v.kind !== "write" || v.key !== K("textfield:email~0")) return;
          a.beforeVerb = null;
          if (how === "host") helper.executor.pause(id, false, "input");
          else helper.executor.onUserInput({ type: "userInput", v: PROTOCOL_VERSION, at: 1, pid: FIXTURE_APP.pid, kind: "mouse", point: [150, 50] });
        };
        const before = app.grants.log.length;
        const r = await helper.executor.run(id, two(), {}, undefined, { grant: true });
        expect(r, how).toMatchObject({ outcome: "paused", step: 1 });
        expect(app.node(K("textfield:email~0"))?.value, how).toBe("old@example.com");
        expect(app.grants.log.slice(before).map((m) => m.type), how).toEqual(["actGrant", "actRevoke"]);
      }
    });

    it("an undo is refused while Caret is paused, and a pause during one leaves the restores not yet made (B22 review)", async () => {
      const settings = (paused: boolean) => helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: 1, roles: ["fill", "repeat", "watch", "calendar", "words"], level: "balanced", paused });
      await helper.executor.run("t1", two(), {}, undefined, { grant: true });
      settings(true);
      const before = published.length;
      expect(await helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: "t1", action: "undo" })).toBeNull();
      expect(published.slice(before).find((m) => m.type === "error")).toMatchObject({ message: "task t1: nothing was restored: you paused Caret" });
      expect(app.node(K("textfield:email~0"))?.value).toBe("d@example.com");
      settings(false);
      // Newest first: Email is restored, then Caret is paused before Name's restore.
      app.afterVerb = (a, v) => {
        if (v.kind !== "write") return;
        a.afterVerb = null;
        settings(true);
      };
      const u = await helper.executor.undo("t1");
      expect(u).toMatchObject({ restored: 1, notRestored: [{ step: 0, reason: "you paused Caret" }] });
      expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
      expect(app.node(K("textfield:name~0"))?.value).toBe("Dana");
      expect(kinds().slice(-2)).toEqual(["actGrant", "actRevoke"]);
    });

    // B22 review: before, an ordinary pause or the user's input during an undo was refused or ignored.
    it("a pause or the user's own click during an undo stops it, and the undo watches for input before its first restore", async () => {
      for (const [id, how, reason] of [
        ["t1", "pause", "you paused the undo"],
        ["t2", "click", "you used the window: a click in 'Fixture — Executor'"],
      ] as const) {
        app.setValue(K("textfield:name~0"), "");
        app.setValue(K("textfield:email~0"), "old@example.com");
        app.show();
        await helper.executor.run(id, two(), {}, undefined, { grant: true });
        const from = app.verbs.length;
        app.afterVerb = (a, v) => {
          if (v.kind !== "write") return;
          a.afterVerb = null;
          if (how === "pause") helper.executor.pause(id, false);
          else helper.executor.onUserInput({ type: "userInput", v: PROTOCOL_VERSION, at: 1, pid: FIXTURE_APP.pid, kind: "mouse", point: [150, 50] });
        };
        const u = await helper.executor.undo(id);
        expect(u, how).toMatchObject({ restored: 1, notRestored: [{ step: 0, reason }] });
        expect(app.node(K("textfield:name~0"))?.value, how).toBe("Dana");
        const verbs = app.verbs.slice(from);
        const watch = verbs.findIndex((v) => v.kind === "watchInput" && v.pids.includes(FIXTURE_APP.pid));
        expect(watch, how).toBeGreaterThanOrEqual(0);
        expect(watch, how).toBeLessThan(verbs.findIndex((v) => v.kind === "write"));
      }
    });

    it("undo of a granted run is granted the run's window for the restore, then revoked", async () => {
      await helper.executor.run("t1", two(), {}, undefined, { grant: true });
      expect(await helper.executor.undo("t1")).toMatchObject({ restored: 2 });
      expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
      expect(kinds()).toEqual(["actGrant", "actRevoke", "actGrant", "actRevoke"]);
      expect(app.grants.log[2]).toMatchObject({ taskId: "t1", windowId: WIN });
    });

    it("a pause that comes in while the reader refuses an act for another reason ends as a pause, not a failure", async () => {
      app.beforeVerb = (a, v) => {
        if (v.kind !== "write" || v.key !== K("textfield:email~0")) return;
        a.beforeVerb = null;
        // The user types in Email and the host pauses the run: the reader refuses the write as changed.
        a.setValue(K("textfield:email~0"), "typed@example.com");
        helper.executor.pause("t1", false);
      };
      const r = await helper.executor.run("t1", two(), {}, undefined, { grant: true });
      expect(r).toMatchObject({ outcome: "paused", step: 1 });
      expect(app.node(K("textfield:email~0"))?.value).toBe("typed@example.com");
      expect(kinds()).toEqual(["actGrant", "actRevoke"]);
    });

    it("a stop during undo revokes its grant: the restore on its way is refused and the rest are not tried", async () => {
      await helper.executor.run("t1", two(), {}, undefined, { grant: true });
      app.beforeVerb = (a, v) => {
        if (v.kind !== "write") return;
        a.beforeVerb = null;
        helper.executor.stop("t1");
      };
      const u = await helper.executor.undo("t1");
      expect(u.restored).toBe(0);
      expect(u.notRestored.map((x) => x.reason)).toEqual([expect.stringMatching(/^notAllowed: the act grant for task t1|^notAllowed: no act grant for task t1/), "you stopped the undo"]);
      expect(app.node(K("textfield:name~0"))?.value).toBe("Dana");
      expect(app.node(K("textfield:email~0"))?.value).toBe("d@example.com");
      expect(kinds()).toEqual(["actGrant", "actRevoke", "actGrant", "actRevoke"]);
    });

    it("undo after a stop whose write ended in axError still gets a grant and restores the write", async () => {
      app.timeoutAfterWrite = true;
      app.beforeVerb = (a, v) => {
        if (v.kind === "write" && v.attribute === "value") helper.executor.stop("t1");
        a.beforeVerb = null;
      };
      // The stop revokes the grant before the write is judged, so let this one write through as a reader
      // that had already passed its last check would, then answer axError.
      app.enforceGrants = false;
      const r = await helper.executor.run("t1", plan([write(K("textfield:email~0"), "d@example.com")]), {}, undefined, { grant: true });
      expect(r.outcome).toBe("stopped");
      expect(helper.executor.ledger("t1")).toHaveLength(1);
      app.timeoutAfterWrite = false;
      app.enforceGrants = true;
      expect(await helper.executor.undo("t1")).toMatchObject({ restored: 1 });
      expect(app.node(K("textfield:email~0"))?.value).toBe("old@example.com");
    });

    it("undo does not count a field that is gone after the restore as restored", async () => {
      await helper.executor.run("t1", plan([write(K("textfield:name~0"), "Dana")]), {}, undefined, { grant: true });
      app.afterVerb = (a, v) => {
        if (v.kind !== "write") return;
        // The app's input handler removes the field as the restore clears it.
        a.nodes = a.nodes.filter((n) => n.key !== K("textfield:name~0"));
        a.show();
      };
      const u = await helper.executor.undo("t1");
      expect(u.restored).toBe(0);
      expect(u.notRestored[0]?.reason).toBe("after the restore the field is gone");
    });

    it("undo of an ungranted run is refused by the reader and restores nothing", async () => {
      app.enforceGrants = false;
      await helper.executor.run("t1", two(), {});
      app.enforceGrants = true;
      const u = await helper.executor.undo("t1");
      expect(u.restored).toBe(0);
      expect(u.notRestored[0]?.reason).toMatch(/notAllowed/);
      expect(app.node(K("textfield:email~0"))?.value).toBe("d@example.com");
    });
  });
});

describe("risk class table", () => {
  it.each([
    ["Send", "outbound"],
    ["Send now", "outbound"],
    ["Submit application", "outbound"],
    ["Delete draft", "destructive"],
    ["Move to Trash", "destructive"],
    ["Pay $12.00", "money"],
    ["Place order", "money"],
    ["Archive", "safe"],
    ["Next page", "safe"],
    ["Sender", "safe"],
    ["Payroll report", "safe"],
    ["Add note", "safe"],
  ])("%s is %s", (label, cls) => {
    expect(classifyLabel(label)).toBe(cls);
  });

  // S1 audit #10: before B22, "Allow" in a permission dialog read as safe. The reader's table must agree (RiskTable.swift).
  const golden = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/golden/press-risk.json", import.meta.url)), "utf8")) as {
    cases: { label: string; role: string; windowSubrole: string | null; bundleId: string; risk: string }[];
  };
  /** ElementKey.windowKind with no identifier: the subrole without "AX" and "window", lowercased. */
  const kindOf = (subrole: string | null): string => (subrole ?? "AXStandardWindow").replace(/^AX/, "").toLowerCase().replace(/window/g, "") || "standard";
  it.each(golden.cases.map((c) => [c.label, c.windowSubrole, c.bundleId, c.risk] as const))("'%s' in a %s window of %s is %s (fixtures/golden/press-risk.json)", (label, subrole, bundleId, risk) => {
    expect(classifyPress({ label, windowKind: kindOf(subrole), bundleId })).toBe(risk);
  });
});

describe("plan slots", () => {
  const p: Plan = { id: "s", title: "s", slots: { name: "the person's name" }, steps: [write(K("textfield:name~0"), "{{name}}")] };
  it("fills declared slots everywhere", () => {
    const f = fillSlots(p, { name: "Dana" });
    expect(f.steps[0]?.end).toMatchObject({ value: "Dana" });
  });
  it("refuses a missing value and an undeclared slot", () => {
    expect(() => fillSlots(p, {})).toThrow(/slot name has no value/);
    const bad: Plan = { ...p, steps: [write(K("textfield:name~0"), "{{other}}")] };
    expect(() => fillSlots(bad, { name: "Dana" })).toThrow(/not a declared slot/);
  });
});

describe("quotedPart", () => {
  it("finds a whole value, the start of one a cut ends inside, or none", () => {
    expect(quotedPart("Ship to Austin, TX", "Austin")).toBe("Austin");
    expect(quotedPart("City holds 1200 Barton Spr…", "1200 Barton Springs Rd")).toBe("1200 Barton Spr");
    // However short: B12 let a start under 3 characters go uncharged (B13 review).
    expect(quotedPart("City holds 12…", "1200 Barton Springs Rd")).toBe("12");
    expect(quotedPart("City holds 1…", "1200 Barton Springs Rd")).toBe("1");
    expect(quotedPart("City holds Austin", "Dallas")).toBeNull();
    expect(quotedPart("City holds Aus", "Austin")).toBeNull();
    expect(quotedPart("anything", "")).toBeNull();
  });
});

describe("sameValue: undo identity (B29)", () => {
  const num = { key: "k", parent: null, role: "AXTextField", subrole: PAGE_SUBROLE.number };
  const txt = { key: "k", parent: null, role: "AXTextField" };
  it.each([
    ["1", "1.00", true],
    ["1.5", "1.50", true],
    ["-0", "0", true],
    ["1e2", "100", true],
    [".5", "0.5", true],
    ["1.", "1", true],
    ["1", "1", true],
    ["1", "12", false],
    ["1,000", "1000", false],
    ["1,00", "1", false],
    ["1 ", "1", false],
    ["", "0", false],
    ["0x10", "16", false],
    ["Infinity", "1e999", false],
    ["$1", "1", false],
    // Review 1: Number() made these equal.
    ["9007199254740993", "9007199254740992", false],
    ["2e309", "1e309", false],
    ["1e-999", "0", false],
    ["0.10000000000000001", "0.1", false],
    ["1e2", "1E+2", true],
    ["+5", "5.0", true],
    ["0.0", "-0", true],
    ["", "", true],
    [".", "0", false],
    ["1e1234567", "1", false],
  ] as const)("in a number field, %j against %j is %s", (held, wrote, same) => {
    expect(sameValue(num, held, wrote)).toBe(same);
  });
  it("compares a text field exactly", () => {
    expect(sameValue(txt, "1.00", "1")).toBe(false);
    expect(sameValue(txt, "Dana", "Dana")).toBe(true);
  });
});
