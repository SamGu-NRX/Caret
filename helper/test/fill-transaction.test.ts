// D2-04: one Fill all fills the whole form. In a window the page engine owns, fill proposes a value Caret writes for
// a native select, a radio group, a checkbox and a date, time or date-and-time input as well as text and B27's custom
// dropdowns, and the pop-up's Fill all writes them all in one executor task under one grant, each read back, stopped
// by the user's input, a reload or a field that changed under it, and undone in one undo that refuses a re-rendered
// element. A box is ticked only when a source states the fact it asks, never a consent. The content script's halves
// run in a real browser in fixtures/web-form/accept.ts (its mixed-control form). Every name and value is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FillProposal, HelperMessage, fillFieldTask, PAGE_CHECKED, PAGE_SUBROLE, PROTOCOL_VERSION, type FillField, type HelperToEngine, type OfferPopup, type PageControl, type PageSnapshot, type PageVerb, type TaskProgress, type VerbResult } from "../src/protocol.ts";
import { EngineSession } from "../src/engines/session.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { ScreenModel } from "../src/model.ts";
import { boxKind, boxNeverTicked, namedInList, negates, statesFact } from "../src/fill/controls.ts";
import { readClock, readDate, readDateTime } from "../src/fill/when.ts";
import { PAGE_WINDOW_KIND, proposeFill } from "../src/fill/fill.ts";
import { fillPopupEligible, recheckFill, writtenFields } from "../src/offers/fill-popup.ts";
import { parsePopupSpec } from "../src/popup.ts";
import { field, focus, jevPickingText, node, snap, text, value } from "./builders.ts";

import { X, chrome, TITLE, WIN, hello, okReader, TEXTEDIT, NOTE, PICKS, byLabel, c, mixedControls, KEY, RADIO, FakePage } from "./fake-page.ts";

describe("the page model of a box and a radio group (D2-04)", () => {
  const model = (cs: PageControl[]): ScreenModel => {
    const page = new FakePage();
    page.controls = cs;
    const m = new ScreenModel();
    m.apply(toWindowSnapshot(page.snapshot("w"), page.session, 1));
    return m;
  };

  it("holds a box's state and a group's choice as editable values, and marks date formats, file inputs, switches and Yes/No questions", () => {
    const cs = mixedControls();
    const ticked = cs.map((x) => (x.id === "e6" || x.id === "e5" ? { ...x, checked: true } : x));
    const w = model(ticked).windows.get(WIN)!;
    expect(w.nodes.get(KEY("e6"))).toMatchObject({ role: "AXCheckBox", value: PAGE_CHECKED, editable: true });
    expect(w.nodes.get(KEY("e7"))).toMatchObject({ role: "AXCheckBox", value: "", editable: true });
    expect(w.nodes.get(RADIO)).toMatchObject({ role: "AXGroup", subrole: "AXFieldset", label: "Shift", value: "Night", editable: true });
    expect(w.nodes.get(KEY("e5"))?.editable).toBeUndefined();
    expect([KEY("e9"), KEY("e10"), KEY("e11"), KEY("e13")].map((k) => w.nodes.get(k)?.subrole)).toEqual([PAGE_SUBROLE.date, PAGE_SUBROLE.time, PAGE_SUBROLE.datetime, PAGE_SUBROLE.file]);
    const sw = model([c("s1", "checkbox", "Dark mode", { role: "switch", checked: false })]).windows.get(WIN)!;
    expect(sw.nodes.get("f0/form[apply]/checkbox:dark mode~0")?.subrole).toBe(PAGE_SUBROLE.switch);
  });
});

describe("one Fill all over a mixed form (D2-04)", () => {
  let dir: string;
  let store: Store;
  let page: FakePage;
  let host: PageHost;
  let helper: Helper;
  let published: HelperMessage[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-d204-"));
    store = new Store(join(dir, "data"));
    page = new FakePage();
    published = [];
    host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), warn: () => {} });
    helper = new Helper({ store, askJev: jevPickingText(byLabel, 0.95), shadow: false, allowBackgroundFocus: false, readerLink: host.link, pageCovers: (pid) => host.registry.forBrowser(pid) !== undefined, calendar: null, publish: (m) => void published.push(m), warn: () => {} });
    wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
    host.registry.add(page.session);
    page.session.receive(hello);
    await new Promise((r) => setTimeout(r, 0));
    const now = Date.now();
    await helper.handleReader(snap([field("te/note", NOTE, { role: "AXTextArea" })], { at: now - 5000, windowId: "note", title: "Robin's details.txt", app: TEXTEDIT, focused: true }));
    expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
  });
  afterEach(() => {
    helper.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Focus in Full name: fill asks canned Jev and publishes the pop-up. */
  const offer = async (): Promise<{ proposal: FillProposal; popup: OfferPopup }> => {
    const proposal = await helper.handleReader(focus(WIN, KEY("e1"), Date.now(), { app: chrome }));
    const popup = published.find((m): m is OfferPopup => m.type === "popup");
    if (proposal === null || proposal === undefined || popup === undefined) throw new Error(`no pop-up: ${JSON.stringify(published.map((m) => m.type))}`);
    return { proposal: proposal as FillProposal, popup };
  };
  const accept = (offerId: string) => helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId, actionId: "fillAll", overrides: {}, at: Date.now() });
  const field_ = (p: FillProposal, id: string): FillField | undefined => p.fields.find((f) => f.key === (id === "radio" ? RADIO : KEY(id)));
  const everyShown = (): Record<string, string | boolean | undefined> => Object.fromEntries(["e1", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9", "e10", "e11", "e12"].map((id) => [id, page.shown(id)]));
  const EMPTY = { e1: "", e2: "", e3: "", e4: false, e5: false, e6: false, e7: false, e8: false, e9: "", e10: "", e11: "", e12: "" };
  const FILLED = { ...EMPTY, e1: "Robin Vale", e2: "robin@example.test", e3: "Canada", e5: true, e6: true, e9: "2026-10-20", e10: "15:30", e11: "2026-10-19T09:00", e12: "United States" };

  it("proposes a written value for every control the page engine handles, leaves the inferred box and the consent box alone, and stays valid on the wire", async () => {
    const { proposal } = await offer();
    expect(FillProposal.safeParse(proposal).success).toBe(true);
    expect(field_(proposal, "e1")).toMatchObject({ control: "text", value: "Robin Vale", handoff: null });
    expect(field_(proposal, "e3")).toMatchObject({ control: "select", value: null, handoff: { value: "Canada", writes: true } });
    expect(field_(proposal, "radio")).toMatchObject({ control: "radio", value: null, handoff: { value: "Night", writes: true } });
    expect(field_(proposal, "e6")).toMatchObject({ control: "checkbox", handoff: { value: PAGE_CHECKED, display: "Ticked", writes: true } });
    // "Age: 34" says nothing about whether the box's statement holds: no tick, and nothing to hand off.
    expect(field_(proposal, "e7")).toMatchObject({ control: "checkbox", handoff: null, withheld: "ambiguous" });
    expect(field_(proposal, "e8")).toBeUndefined();
    expect(field_(proposal, "e9")).toMatchObject({ control: "date", handoff: { value: "2026-10-20", writes: true } });
    expect(field_(proposal, "e10")).toMatchObject({ control: "time", handoff: { value: "15:30", display: "3:30 PM", writes: true } });
    expect(field_(proposal, "e11")).toMatchObject({ control: "date", handoff: { value: "2026-10-19T09:00", writes: true } });
    expect(field_(proposal, "e12")).toMatchObject({ control: "combobox", value: null, handoff: { value: "United States", writes: true } });
  });

  it("lists what it leaves to the user, the value it has included, and says how many it fills", async () => {
    const { popup } = await offer();
    expect(parsePopupSpec(popup.spec)).toEqual(popup.spec);
    expect(HelperMessage.safeParse(popup).success).toBe(true);
    expect(popup.spec.blocks.find((b) => b.type === "header")).toMatchObject({ title: { text: "Fill 9 fields" } });
    const yours = popup.spec.blocks.find((b) => b.id === "yours");
    expect(yours?.type === "facts" ? yours.rows.map((r) => [r.label, r.value.text]) : null).toEqual([
      ["You set", "Are you over 18?"],
      ["", "Send me news and offers"],
      ["", "Resume"],
    ]);
    expect(popup.spec.blocks.find((b) => b.type === "actions")).toEqual({ type: "actions", items: [{ id: "fillAll", label: "Fill 9", key: "tab" }] });
  });

  it("writes every field in one task under one grant, reads each back, presses nothing, and undoes them all in one undo, newest first, never rebinding", async () => {
    const { popup } = await offer();
    const r = await accept(popup.offerKey);
    expect(r).toMatchObject({ outcome: "done" });
    expect(everyShown()).toEqual(FILLED);
    // One task, one grant: the task's one scoped grant for the tab's one frame.
    expect(page.sent.filter((m) => m.type === "scopedActGrant").map((m) => (m.type === "scopedActGrant" ? m.taskId : ""))).toEqual([popup.offerKey]);
    const acts = page.verbs.filter((v) => v.kind !== "pageWalk");
    expect(acts.every((v) => v.kind !== "pagePress" && v.kind !== "pageAttachFile" && "taskId" in v && v.taskId === popup.offerKey)).toBe(true);
    // Document order: the country before the fields after it.
    expect(acts.map((v) => v.id)).toEqual(["e1", "e2", "e3", "e5", "e6", "e9", "e10", "e11", "e12"]);
    const progress = published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.taskId === popup.offerKey);
    expect(progress.filter((m) => m.phase === "verified")).toHaveLength(9);

    const u = await helper.executor.undo(popup.offerKey);
    expect(u).toEqual({ restored: 9, notRestored: [], notUndoable: 0 });
    expect(everyShown()).toEqual(EMPTY);
    const undos = page.verbs.filter((v) => v.kind !== "pageWalk").slice(acts.length);
    expect(undos.map((v) => v.id)).toEqual(["e12", "e11", "e10", "e9", "e6", "e5", "e3", "e2", "e1"]);
    expect(undos.every((v) => "rebind" in v && v.rebind === false && typeof v.sameAs === "string")).toBe(true);
    expect(undos.find((v) => v.id === "e5")).toMatchObject({ kind: "pageSetChecked", checked: false });
  });

  it("refuses an undo whose element the page re-rendered, and restores the rest", async () => {
    const { popup } = await offer();
    expect((await accept(popup.offerKey))?.outcome).toBe("done");
    page.onAct = (v) => (v.id === "e3" && v.kind === "pageSelect" && v.rebind === false ? { outcome: "notSameElement", detail: "the element Caret wrote was replaced" } : null);
    const u = await helper.executor.undo(popup.offerKey);
    expect(u.restored).toBe(8);
    expect(u.notRestored).toHaveLength(1);
    expect(page.shown("e3")).toBe("Canada");
  });

  it("stops at the user's click in the page, keeping what it wrote for undo", async () => {
    const { popup } = await offer();
    let n = 0;
    page.onAct = (v, p) => {
      if (++n === 3) p.session.receive({ type: "pageInput", v: 1, at: Date.now(), tabId: 7, frameId: 0, kind: "mouse" });
      return null;
    };
    const r = await accept(popup.offerKey);
    expect(r).toMatchObject({ outcome: "paused" });
    expect(r?.detail).toContain("a click in");
    expect(page.verbs.filter((v) => v.kind !== "pageWalk")).toHaveLength(3);
    expect(helper.executor.ledger(popup.offerKey)).toHaveLength(3);
  });

  it("stops when the page reloads mid-task, and writes nothing into the new document", async () => {
    const { popup } = await offer();
    let n = 0;
    page.onAct = (_, p) => {
      if (++n === 2) p.reload();
      return null;
    };
    const r = await accept(popup.offerKey);
    expect(r?.outcome).toBe("stopped");
    // The second write was refused under the old grant (the reload came first); nothing went into the new page.
    expect(everyShown()).toEqual(EMPTY);
    expect(page.verbs.filter((v) => v.kind !== "pageWalk" && v.documentId === page.documentId)).toEqual([]);
  });

  it("stops when a field it has not reached changes under it", async () => {
    const { popup } = await offer();
    let n = 0;
    page.onAct = (_, p) => {
      if (++n === 2) p.find("e9").value = "2026-12-01";
      return null;
    };
    const r = await accept(popup.offerKey);
    expect(r?.outcome).toBe("stopped");
    expect(r?.detail).toMatch(/changed/);
    expect(page.shown("e9")).toBe("2026-12-01");
  });

  it("never takes the user's edit made right after a write for its own: undo leaves it (review R3)", async () => {
    const { popup } = await offer();
    page.onAct = (v, p) => {
      if (v.id !== "e9" || v.kind !== "pageWrite" || v.sameAs !== undefined) return null;
      // Caret's write lands and reads back; the user then types another date before the engine's walk.
      p.find("e9").value = "2026-12-01";
      return { outcome: "ok", detail: null, readings: { before: "", afterInput: v.value, afterBlur: v.value, invalid: false, error: null } };
    };
    const r = await accept(popup.offerKey);
    expect(r?.outcome).toBe("stopped");
    // P2's deferred walk: the model takes the engine's own verified read-back, not a re-walk that happened to see the
    // user's date, so the entry is Caret's write; undo's own read then finds the field changed and leaves it.
    expect(helper.executor.ledger(popup.offerKey).find((e) => e.kind === "write" && e.key === KEY("e9"))).toMatchObject({ before: "", after: "2026-10-20" });
    const u = await helper.executor.undo(popup.offerKey);
    expect(page.shown("e9")).toBe("2026-12-01");
    expect(u.notRestored.map((x) => x.reason)).toEqual(["the field changed after Caret wrote it, so Caret left it as it is"]);
  });

  describe("a page number field that reformats what Caret wrote (B29)", () => {
    // "1" comes back as "1.00", as a page's own script formats a number on input.
    // The content script answers such a write "failed" (actions.ts judge); "ok" stands for an engine whose read came first.
    const reformatting = (ids: readonly string[], answer: "ok" | "failed" = "ok") => (v: Exclude<PageVerb, { kind: "pageWalk" }>, p: FakePage): object | null => {
      if (v.kind !== "pageWrite" || !ids.includes(v.id) || v.sameAs !== undefined) return null;
      p.find(v.id).value = "1.00";
      const readings = { before: "", afterInput: "1.00", afterBlur: "1.00", invalid: false, error: null };
      return answer === "ok" ? { outcome: "ok", detail: null, readings } : { outcome: "failed", detail: "the page holds another value than Caret wrote", readings };
    };
    const written = async (id: string, kind: PageControl["kind"], extra: Partial<PageControl> = {}) => {
      page.controls = [c(id, kind, "Guests", { value: "", ...extra })];
      await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
      const key = `f0/${page.controls[0]!.key}`;
      const r = await helper.executor.run("n1", { id: "n1", title: "n1", slots: {}, steps: [{ says: "Guests holds 1", end: { kind: "valueEquals", window: { titleStartsWith: TITLE }, target: { key, describe: "Guests" }, value: "1" } }] }, {}, undefined, { grant: true });
      expect(page.find(id).value).toBe("1.00");
      return { r, key };
    };

    it.each([
      ["an input of type number", "number", {}, "ok"],
      ["a text input with a numeric inputmode", "text", { numeric: true as const }, "ok"],
      ["an input of type number, answered failed", "number", {}, "failed"],
    ] as const)("undoes the write in %s: 1 and 1.00 are the same number", async (_, kind, extra, answer) => {
      page.onAct = reformatting(["n"], answer);
      const { key } = await written("n", kind, extra);
      expect(helper.model.windows.get(WIN)?.nodes.get(key)?.subrole).toBe(PAGE_SUBROLE.number);
      expect(helper.executor.ledger("n1")).toEqual([expect.objectContaining({ before: "", after: "1" })]);
      expect(helper.executor.ledger("n1")[0]).not.toHaveProperty("mayIncludeInput");
      const u = await helper.executor.undo("n1");
      expect(u).toMatchObject({ restored: 1, notRestored: [] });
      expect(page.find("n").value).toBe("");
    });

    it("never compares a text field as a number: the same reformat leaves an undo that refuses", async () => {
      page.onAct = reformatting(["n"]);
      const { key } = await written("n", "text");
      expect(helper.model.windows.get(WIN)?.nodes.get(key)?.subrole).toBeUndefined();
      expect(helper.executor.ledger("n1")).toEqual([expect.objectContaining({ after: "1", mayIncludeInput: true })]);
      const u = await helper.executor.undo("n1");
      expect(u).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringMatching(/may hold your typing/) }] });
      expect(page.find("n").value).toBe("1.00");
    });

    it("still refuses a number the user changed: 1.00 against 12", async () => {
      page.onAct = reformatting(["n"]);
      await written("n", "number");
      page.find("n").value = "12";
      await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN });
      const u = await helper.executor.undo("n1");
      expect(u).toMatchObject({ restored: 0, notRestored: [{ reason: "the field changed after Caret wrote it, so Caret left it as it is" }] });
      expect(page.find("n").value).toBe("12");
    });
  });

  it("stops, recording nothing, when a box or a choice it is about to set was set by someone else since the walk (review R6)", async () => {
    const { popup } = await offer();
    page.onAct = (v) => (v.kind === "pageSetChecked" && v.id === "e5" ? { outcome: "alreadyTrue", detail: null } : null);
    const r = await accept(popup.offerKey);
    expect(r?.outcome).toBe("stopped");
    expect(r?.detail).toContain("set by someone else");
    expect(helper.executor.ledger(popup.offerKey).some((e) => e.kind === "write" && e.key === RADIO)).toBe(false);
  });

  it("runs the same transaction for the host's Command-1 on a per-field proposal, once", async () => {
    const asked = await helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: WIN, fieldKey: KEY("e1") });
    const p = asked as FillProposal;
    expect(fillPopupEligible(p)).toBe(true);
    const r = await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: p.id, at: Date.now() });
    expect(r).toMatchObject({ outcome: "done" });
    expect(everyShown()).toEqual(FILLED);
    expect(await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: p.id, at: Date.now() })).toBeNull();
    expect(await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: "nope", at: Date.now() })).toBeNull();
    const refusals = published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.stopReason === "refused").map((m) => [m.taskId, m.detail]);
    expect(refusals).toEqual([[p.id, "this proposal was already filled"], ["nope", "no such fill proposal, or it expired"]]);
  });

  it("keeps a page's pop-up when Accessibility's view of the browser reports an editable focus (H10)", async () => {
    const { popup } = await offer();
    await helper.handleReader(snap([node("tb/address", "AXTextField", { label: "Address and search bar", editable: true })], { at: Date.now(), windowId: "4100-1", title: TITLE, app: chrome, number: 35, focused: true }));
    await helper.handleReader(focus("4100-1", "tb/address", Date.now(), { app: chrome }));
    expect(published.filter((m) => m.type === "offerWithdrawn").map((m) => (m as { id: string }).id)).not.toContain(popup.offerKey);
    // An editable field of another app still ends it, as before.
    await helper.handleReader(snap([field("te/other", "", {})], { at: Date.now(), windowId: "other", title: "Other", focused: true }));
    await helper.handleReader(focus("other", "te/other", Date.now()));
    expect(published.filter((m) => m.type === "offerWithdrawn").map((m) => (m as { id: string }).id)).toContain(popup.offerKey);
  });

  it("writes only the field a host's Tab names, as that field's own task, once, and undoes it alone (H10)", async () => {
    const p = (await helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: WIN, fieldKey: KEY("e1") })) as FillProposal;
    // The reader's window of the same browser, with the page's title and a window number, as the real app has it: the
    // plan must still bind the page window alone (WindowSel.page).
    await helper.handleReader(snap([node("tb/address", "AXTextField", { label: "Address and search bar" })], { at: Date.now(), windowId: "4100-1", title: TITLE, app: chrome, number: 35 }));
    // And another tab with the same form and title (H10 review 4): the run binds the proposal's own page alone.
    await helper.handleReader(toWindowSnapshot({ ...page.snapshot("s9"), tabId: 9 }, page.session, 99));
    const task = fillFieldTask(p.id, KEY("e2"));
    const r = await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: p.id, fieldKey: KEY("e2"), at: Date.now() });
    expect(r).toMatchObject({ outcome: "done" });
    expect(everyShown()).toEqual({ ...EMPTY, e2: "robin@example.test" });
    expect(published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.phase === "done").map((m) => [m.taskId, m.written])).toEqual([[task, 1]]);
    // The same field again, a field the proposal does not hold, and then the whole form: each refused by name.
    expect(await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: p.id, fieldKey: KEY("e2"), at: Date.now() })).toBeNull();
    expect(await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: p.id, fieldKey: KEY("e8"), at: Date.now() })).toBeNull();
    expect(await helper.handleFillAll({ type: "fillAll", v: PROTOCOL_VERSION, proposalId: p.id, at: Date.now() })).toBeNull();
    const refusals = published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.stopReason === "refused").map((m) => [m.taskId, m.detail]);
    expect(refusals).toEqual([
      [task, "this field was already filled"],
      [fillFieldTask(p.id, KEY("e8")), `Caret writes no field ${KEY("e8")} of this proposal`],
      [p.id, "a field of this proposal was already filled on its own"],
    ]);
    const u = await helper.executor.undo(task);
    expect(u).toMatchObject({ restored: 1, notRestored: [] });
    expect(everyShown()).toEqual(EMPTY);
  });
});

describe("what a Fill all writes, control by control (D2-04)", () => {
  const W = "dev.caret.page/page";
  const NOTE_APP = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
  /** A note the user just left, and a page (or Accessibility) form of one text field and the given controls. */
  function desk(note: string, controls: ReturnType<typeof node>[], kind = PAGE_WINDOW_KIND): ScreenModel {
    const m = new ScreenModel();
    m.apply(snap([field("te/note", note, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Details.txt", app: NOTE_APP, focused: true }));
    const nodes = [node(`${W}/webarea:~0`, "AXWebArea", { label: "Apply" }), field(`${W}/textfield:name~0`, "", { parent: `${W}/webarea:~0`, label: "Name" }), ...controls.map((n) => ({ ...n, parent: n.parent ?? `${W}/webarea:~0` }))];
    m.apply(snap(nodes, { at: 1000, windowId: "form", kind, title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${W}/textfield:name~0` }));
    return m;
  }
  const box = (label: string, extra = {}) => node(`${W}/checkbox:${label}~0`, "AXCheckBox", { label, editable: true, value: "", ...extra });
  const select = (label: string, options: string[]) => [node(`${W}/select:${label}~0`, "AXPopUpButton", { label, value: "", editable: true }), ...options.map((o, i) => node(`${W}/select:${label}~0/option~${i}`, "AXMenuItem", { label: o, parent: `${W}/select:${label}~0` }))];
  const dateField = (label: string, subrole: string, role = "AXDateField") => node(`${W}/date:${label}~0`, role, { label, subrole, editable: true });
  const ask = (picks: Record<string, string>) => jevPickingText((_, ins) => picks[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.95);
  const get = (p: FillProposal, key: string) => p.fields.find((f) => f.key === key);

  it("ticks a box only when the source states its fact, never from a related fact, a question, a negation or a consent", async () => {
    const note = ["Valid driving license: yes", "Age: 34", "Are you a US citizen?", "Toppings: no mushroom", "Newsletter: yes"].join("\n");
    const boxes = [box("Do you have a valid driving license?"), box("Are you over 18?"), box("Are you a US citizen?"), box("Mushroom"), box("Subscribe to our newsletter")];
    const p = await proposeFill(
      desk(note, boxes),
      ask({ "Do you have a valid driving license?": "yes", "Are you over 18?": "34", "Are you a US citizen?": "Are you a US citizen?", Mushroom: "no mushroom", "Subscribe to our newsletter": "yes" }),
      "form",
      `${W}/textfield:name~0`,
      2000,
    );
    expect(get(p, boxes[0]!.key)?.handoff).toMatchObject({ value: PAGE_CHECKED, writes: true });
    for (const b of boxes.slice(1, 4)) expect(get(p, b.key)).toMatchObject({ handoff: null, withheld: "ambiguous" });
    // A sign-up box is never asked about, so never ticked.
    expect(get(p, boxes[4]!.key)).toBeUndefined();
  });

  it("gives no value to a box the user speaks in, the second review's included, nor to a list item under a negated or conditional line", async () => {
    const note = ["I want to hear about new products: yes", "I verify my answers are correct: yes", "Do not include: bacon, extra cheese", "If available: onion, mushroom"].join("\n");
    const boxes = [box("I want to hear about new products"), box("I verify my answers are correct"), box("Bacon"), box("Mushroom")];
    const p = await proposeFill(desk(note, boxes), ask({ "I want to hear about new products": "yes", "I verify my answers are correct": "yes", Bacon: "bacon, extra cheese", Mushroom: "onion, mushroom" }), "form", `${W}/textfield:name~0`, 2000);
    for (const b of boxes) expect(get(p, b.key)?.handoff ?? null, b.label).toBeNull();
  });

  it("writes a box's tick only from a 'Label: yes' line; the user's own sentence, or a bare-phrase box, is handed to them", async () => {
    const note = ["I have a valid driving license", "Remote work: yes", "Toppings: bacon, extra cheese"].join("\n");
    const boxes = [box("Do you have a valid driving license?"), box("Remote work"), box("Bacon")];
    const p = await proposeFill(desk(note, boxes), ask({ "Do you have a valid driving license?": "I have a valid driving license", "Remote work": "yes", Bacon: "bacon, extra cheese" }), "form", `${W}/textfield:name~0`, 2000);
    for (const b of boxes) expect(get(p, b.key)?.handoff, b.label).toMatchObject({ value: PAGE_CHECKED });
    for (const b of boxes) expect(get(p, b.key)?.handoff?.writes, b.label).toBeUndefined();
  });

  it("rechecks an unlabelled control's line whole, and a labelled control's line by what it holds (second review)", async () => {
    const m = desk("Canada\nStart: Tuesday, October 20, 2026", [...select("Country", ["Canada", "Mexico"]), dateField("Start", PAGE_SUBROLE.date)]);
    // The reader's typed date inside the line, as it reads one: the span is the date, the line's value is longer.
    m.apply(snap([field("te/note", "Canada\nStart: Tuesday, October 20, 2026", { role: "AXTextArea" })], { at: 950, windowId: "note", title: "Details.txt", app: NOTE_APP, values: [value("date", "October 20, 2026", "te/note")] }));
    const p = await proposeFill(m, ask({ Country: "Canada", Start: "October 20, 2026" }), "form", `${W}/textfield:name~0`, 2000);
    const g = writtenFields(p, m.windows.get("form"));
    expect(g.fields.map((f) => [f.value, f.context])).toEqual([["Canada", null], ["2026-10-20", "Start"]]);
    expect(recheckFill(m, g, () => null)).toBeNull();
    m.apply(snap([field("te/note", "Not Canada\nStart: Tuesday, October 20, 2026", { role: "AXTextArea" })], { at: 1100, windowId: "note", title: "Details.txt", app: NOTE_APP }));
    expect(recheckFill(m, g, () => null)).toBe("the source te/note changed");
  });

  it("never offers the review's marketing and certification boxes, nor ticks a conditional statement even as a hand-off (R1, R5)", async () => {
    const note = ["Receive product announcements: yes", "All information is accurate: yes", "Willing to relocate: for the right role"].join("\n");
    const boxes = [box("Receive product announcements"), box("All information is accurate"), box("Are you willing to relocate?")];
    const p = await proposeFill(desk(note, boxes), ask({ "Receive product announcements": "yes", "All information is accurate": "yes", "Are you willing to relocate?": "for the right role" }), "form", `${W}/textfield:name~0`, 2000);
    expect(get(p, boxes[0]!.key)).toBeUndefined();
    expect(get(p, boxes[1]!.key)).toBeUndefined();
    expect(get(p, boxes[2]!.key)).toMatchObject({ handoff: null, withheld: "ambiguous" });
  });

  it("rechecks the very line a box's yes came from: a source that now says no is stale though 'yes' is still on screen (R4)", async () => {
    const m = desk("Valid driving license: yes", [box("Do you have a valid driving license?")]);
    const p = await proposeFill(m, ask({ "Do you have a valid driving license?": "yes" }), "form", `${W}/textfield:name~0`, 2000);
    const g = writtenFields(p, m.windows.get("form"));
    expect(g.fields.map((f) => [f.value, f.context])).toEqual([[PAGE_CHECKED, "Valid driving license"]]);
    expect(recheckFill(m, g, () => null)).toBeNull();
    m.apply(snap([field("te/note", "Valid driving license: no\nNeeds renewal: yes", { role: "AXTextArea" })], { at: 1100, windowId: "note", title: "Details.txt", app: NOTE_APP }));
    expect(recheckFill(m, g, () => null)).toBe("the source te/note changed");
  });

  it("never asks about a box whose nearest text is a sign-up, and leaves a switch's tick to the user", async () => {
    const offers = text(`${W}/text:offers~0`, "Email me offers", [100, 300, 160, 20], `${W}/webarea:~0`);
    const unlabelled = box("", { label: undefined, frame: [280, 300, 20, 20] });
    const p = await proposeFill(
      desk("Remote work: yes\nI can start right away", [offers, unlabelled, box("Remote work", { subrole: PAGE_SUBROLE.switch }), box("I can start right away")]),
      ask({ "Remote work": "yes", "I can start right away": "I can start right away" }),
      "form",
      `${W}/textfield:name~0`,
      2000,
    );
    expect(get(p, unlabelled.key)).toBeUndefined();
    expect(get(p, `${W}/checkbox:Remote work~0`)?.handoff).toEqual({ value: PAGE_CHECKED, display: "Ticked", source: expect.anything(), memory: null, context: "Remote work" });
    // The user speaks in that box's label, as consents do: no value at all.
    expect(get(p, `${W}/checkbox:I can start right away~0`)).toMatchObject({ handoff: null, withheld: "ambiguous" });
  });

  it("writes an option only on an exact match, and hands off one the span names among other words", async () => {
    const p = await proposeFill(desk("Size: Large\nOrder: Large, mushroom and onion", [...select("Size", ["Small", "Large"]), ...select("Crust", ["Thin", "Large"])]), ask({ Size: "Large", Crust: "Large, mushroom and onion" }), "form", `${W}/textfield:name~0`, 2000);
    expect(get(p, `${W}/select:Size~0`)?.handoff).toMatchObject({ value: "Large", writes: true });
    expect(get(p, `${W}/select:Crust~0`)?.handoff).toEqual({ value: "Large", display: "Large", source: expect.anything(), memory: null, context: "Order" });
  });

  it("never writes a control through Accessibility", async () => {
    const p = await proposeFill(desk("Size: Large\nValid driving license: yes", [...select("Size", ["Small", "Large"]), box("Valid driving license")], "AXStandardWindow"), ask({ Size: "Large", "Valid driving license": "yes" }), "form", `${W}/textfield:name~0`, 2000);
    expect(p.fields.flatMap((f) => (f.handoff === null ? [] : [f.handoff.writes]))).toEqual([undefined, undefined]);
    expect(writtenFields(p).fields).toEqual([]);
  });

  it("writes each date-like input in its own format, and hands off what it cannot read without a guess", async () => {
    const fields = [dateField("Start", PAGE_SUBROLE.date), dateField("From", PAGE_SUBROLE.datetime), dateField("Abroad", PAGE_SUBROLE.datetime), dateField("Month", PAGE_SUBROLE.month), dateField("At", PAGE_SUBROLE.time, "AXTimeField"), dateField("Zoned", PAGE_SUBROLE.time, "AXTimeField"), dateField("Around", PAGE_SUBROLE.time, "AXTimeField")];
    const note = ["Start: 2026-10-20", "From: Oct 19, 2026 at 9:00 AM", "Abroad: Oct 19, 2026 at 9:00 AM UTC+2", "Month: October 3, 2026", "At: 09:30", "Zoned: 3pm PT", "Around: around 7:45 pm"].join("\n");
    const picks = { Start: "2026-10-20", From: "Oct 19, 2026 at 9:00 AM", Abroad: "Oct 19, 2026 at 9:00 AM UTC+2", Month: "October 3, 2026", At: "09:30", Zoned: "3pm PT", Around: "around 7:45 pm" };
    const ctx = { locale: "en-US", timeZone: "America/Chicago", referenceInstant: null };
    const p = await proposeFill(desk(note, fields), ask(picks), "form", `${W}/textfield:name~0`, 2000, { resolve: ctx });
    const h = (label: string) => get(p, `${W}/date:${label}~0`);
    expect(h("Start")?.handoff).toMatchObject({ value: "2026-10-20", writes: true });
    expect(h("From")?.handoff).toMatchObject({ value: "2026-10-19T09:00", writes: true });
    expect(h("Abroad")).toMatchObject({ handoff: null, withheld: "ambiguous" });
    expect(h("Month")?.handoff).toEqual({ value: "2026-10-03", display: expect.any(String), source: expect.anything(), memory: null, context: "Month" });
    expect(h("At")?.handoff).toMatchObject({ value: "09:30", writes: true });
    // A zone, or words around the time: the user's, with B24's reading shown to them.
    expect(h("Zoned")?.handoff).toEqual({ value: "15:00", display: "3:00 PM", source: expect.anything(), memory: null, context: "Zoned" });
    expect(h("Around")?.handoff).toEqual({ value: "19:45", display: "7:45 PM", source: expect.anything(), memory: null, context: "Around" });
  });
});

describe("the checkbox rule (D2-04): stated facts only", () => {
  it.each([
    ["I have a valid driving license", "I have a valid driving license", null],
    ["Do you have a valid driving license?", "yes", "Valid driving license"],
    ["Are you over 18?", "Yes", "Over 18"],
    ["Are you willing to relocate?", "I am willing to relocate.", null],
    ["I do not need visa sponsorship", "I do not need visa sponsorship", null],
    ["Are you a US citizen?", "I'm a US citizen", "Citizenship"],
    ["Are you a US citizen?", "yes", "Are you a US citizen?"],
  ])("ticks %s from %s (labelled %s)", (label, span, context) => {
    expect(statesFact(label, span, context)).toBe(true);
  });

  it.each([
    ["Are you over 18?", "34", "Age"],
    ["Are you over 18?", "Age: 34", null],
    ["Are you a US citizen?", "Are you a US citizen?", null],
    ["Valid driving license", "no", "Valid driving license"],
    ["Valid driving license", "I do not have a valid driving license", null],
    ["Willing to relocate", "not willing to relocate", null],
    ["Willing to relocate", "willing to relocate for the right role", null],
    ["Do you have a valid driving license?", "yes", "Driving license number"],
    ["Mushroom", "no mushroom", null],
    ["Remote", "yes", "Not remote"],
    // The review's: a tense or modal, a question without its mark, a negated context, a bare phrase under someone's heading.
    ["I have a valid driving license", "I will have a valid driving license", "Status"],
    ["US citizen", "Are you a US citizen", "Question"],
    ["US citizen", "US citizen", "Not"],
    ["Do you have a valid driving license?", "Valid driving license", "Requirements"],
    ["Willing to relocate", "Willing to relocate for the right role", "Preference"],
    ["US citizen", "US citizen? Please respond.", "Citizenship"],
  ])("does not tick %s from %s (labelled %s)", (label, span, context) => {
    expect(statesFact(label, span, context)).toBe(false);
  });

  it("sees negations the label does not hold, apostrophes included", () => {
    expect(negates("Willing to relocate", "I won't relocate")).toBe(true);
    expect(negates("I don't need sponsorship", "I don't need sponsorship")).toBe(false);
    expect(negates("Mushroom", "mushroom")).toBe(false);
  });

  it("takes a box's label as a choice only as one exact item of a list", () => {
    expect(namedInList("Bacon", "bacon, extra cheese")).toBe(true);
    expect(namedInList("Extra cheese", "bacon and extra cheese")).toBe(true);
    for (const [label, span] of [["Cheese", "bacon, extra cheese"], ["Bacon", "bacon"], ["Bacon", "bacon or ham"], ["Mushroom", "no mushroom, onion"], ["Bacon", "bacon, ham?"]]) expect(namedInList(label as string, span as string), `${label} in ${span}`).toBe(false);
  });

  it("never ticks a consent, certification or sign-up box, the review's two among them", () => {
    for (const l of ["Receive product announcements", "All information is accurate", "I agree to the terms of service", "Email me offers", "Share my profile with partners", "I certify the above is true and correct", "Contact me about events"]) expect(boxNeverTicked(l), l).toBe(true);
    for (const l of ["I have a valid driving license", "Are you over 18?", "Willing to relocate", "Bacon"]) expect(boxNeverTicked(l), l).toBe(false);
  });

  it("proposes a tick only for a box that asks the user a fact, or hands one off for a bare phrase; a box the user speaks in gets none", () => {
    for (const l of ["Are you over 18?", "Do you have a car?", "Have you worked here before?", "Are you willing to relocate?"]) expect(boxKind(l), l).toBe("question");
    for (const l of ["I have a valid driving license", "I want to hear about new products", "I verify my answers are correct", "My answers are correct", "Would you like to receive our newsletter?", "Do you want to join?", "Can we contact you?"]) expect(boxKind(l), l).toBe("statement");
    for (const l of ["Valid driving license", "Remote work", "Bacon"]) expect(boxKind(l), l).toBe("other");
  });

  it("names no list item under a negated or conditional line (second review)", () => {
    expect(namedInList("Bacon", "bacon, extra cheese", "Toppings")).toBe(true);
    expect(namedInList("Bacon", "bacon, extra cheese", "Do not include")).toBe(false);
    expect(namedInList("Bacon", "bacon, extra cheese", "If available")).toBe(false);
    expect(namedInList("Bacon", "bacon, extra cheese if they have it", null)).toBe(false);
  });
});

describe("dates and times in a field's own format (D2-04)", () => {
  const ctx = { locale: "en-US", timeZone: "America/Los_Angeles", referenceInstant: null };
  it.each([
    ["3:30 PM", "15:30"],
    ["09:30", "09:30"],
    ["noon", "12:00"],
    ["18:05:30", "18:05:30"],
  ])("reads the time %s as %s", (t, v) => {
    expect(readClock(t, ctx)?.value).toBe(v);
  });

  it.each(["3:30", "at 3", "3pm PT", "15:00 UTC+2", "9am-5pm", "midnight", "around 7:45 pm", ""])("reads no time from %s", (t) => {
    expect(readClock(t, ctx)).toBeNull();
  });

  it("reads the time of a span that names its day only when that day is known", () => {
    expect(readClock("Saturday, October 17 at 8:45am", ctx)).toBeNull();
    expect(readClock("Saturday, October 17 at 8:45am", { ...ctx, referenceInstant: "2026-10-05T12:00:00-07:00" })?.value).toBe("08:45");
  });

  it("reads no time Daylight Saving skips or repeats on the day the span names, nor one in another zone than the user's", () => {
    expect(readClock("March 8, 2026 at 2:30 AM", ctx)).toBeNull();
    expect(readClock("November 1, 2026 at 1:30 AM", ctx)).toBeNull();
    expect(readClock("October 19, 2026 at 9:00 AM", ctx)?.value).toBe("09:00");
    expect(readClock("October 19, 2026 at 9:00 AM", { ...ctx, sourceTimeZone: "America/New_York" })).toBeNull();
    expect(readClock("October 19, 2026 at 9:00 AM", { ...ctx, sourceTimeZone: null })).toBeNull();
    expect(readClock("9:00 AM", { ...ctx, sourceTimeZone: "America/New_York" })).toBeNull();
  });

  it("reads a date and time as a datetime-local holds it, only in the user's own zone", () => {
    expect(readDateTime("Oct 19, 2026 at 9:00 AM", ctx)?.value).toBe("2026-10-19T09:00");
    expect(readDateTime("2026-10-19T09:00", ctx)?.value).toBe("2026-10-19T09:00");
    expect(readDateTime("Oct 19, 2026 at 9:00 AM PT", ctx)?.value).toBe("2026-10-19T09:00");
    expect(readDateTime("Oct 19, 2026 at 9:00 AM ET", ctx)).toBeNull();
    expect(readDateTime("Oct 19, 2026", ctx)).toBeNull();
    // Los Angeles skips 2:30 on 2026-03-08: a question, so no value.
    expect(readDateTime("March 8, 2026 at 2:30 AM", ctx)).toBeNull();
    expect(readDate("Oct 19, 2026 at 9:00 AM", ctx)?.value).toBe("2026-10-19");
  });
});
