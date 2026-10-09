import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { PageEngineLink, toWindowSnapshot } from "../src/engines/page-link.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import { PageControl, ReaderMessage, type HelperMessage, type VerbResult } from "../src/protocol.ts";
import type { Plan } from "../src/executor/schema.ts";
import { executorWindow, FakeApp, K, TITLE as AX_TITLE, WIN as AX_WIN } from "./fake-app.ts";
import { FakePage, KEY, RADIO, TITLE as PAGE_TITLE, WIN as PAGE_WIN } from "./fake-page.ts";

// Issue #26. A write whose answer is lost is judged by one read after Stop, once the window is the user's again. These
// tests put the user's own input on the field between the send and that read, and check that Caret then leaves the
// field to the user and Undo leaves it too. Times are relative to the send: Stop at 40 ms, the refused answer at 250 ms
// (then the read), as in stop-inflight.test.ts.
const ORIGINAL = "Original name";
const INTENDED = "Dana";
const AX_PID = 5150;
const STOP_AT = 40;
const ANSWER_AT = 250;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});

interface Rig {
  helper: Helper;
  plan: Plan;
  key: string;
  held: () => string;
  published: HelperMessage[];
  ready: Promise<unknown>;
  dispatchAt: () => number;
  /** Delivers a reader message as the socket would: checked against the wire schema first. */
  reader: (m: unknown) => void;
  /** The user puts `value` in the field, as typing does: the page records when (PageControl.inputAt); the reader's
   * report of it is the test's to send. */
  type: (value: string) => void;
  /** Page only: walks the tab, as the helper does when the page reports typing or focus. */
  walk: () => Promise<unknown>;
  /** Page only: the page drops its record of the user's input, as it does 30 s after the grant ends. */
  forget: () => void;
}

/** `landed`: Caret's write reaches the field. `user`: what the user does, `at` ms after the send. */
/** `inputBefore`: page only, the user's last input on the field that many ms before the run starts. */
/** `noStop`: no Stop comes, and the plan has its first step only. `answer`: the write's late answer, refused by default. `failRead`: the recovery read fails (on a page, only that one). */
function rig(mean: "AX" | "page", o: { landed: boolean; user?: { at: number; act: (r: Rig) => void }; failRead?: boolean; inputBefore?: number; answer?: "ok" | "notAllowed"; noStop?: boolean }): Rig {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "caret-stop-input-"));
  const store = new Store(join(dir, "data"));
  const published: HelperMessage[] = [];
  let helper: Helper;
  let dispatched = false;
  let dispatchAt = 0;
  const key = mean === "AX" ? K("textfield:name~0") : KEY("e1");
  const title = mean === "AX" ? AX_TITLE : PAGE_TITLE;
  const steps: Plan["steps"] = [
    { says: "First Name", end: { kind: "valueEquals", window: { title }, target: { key, describe: "First Name" }, value: INTENDED } },
    { says: "Another field", end: { kind: "valueEquals", window: { title }, target: { key, describe: "First Name" }, value: "Must not run" } },
  ];
  const plan: Plan = { id: "stop", title: "Fill names", slots: {}, steps: steps.slice(0, o.noStop === true ? 1 : 2) };
  const self = {} as Rig;
  const dispatch = () => {
    dispatched = true;
    dispatchAt = Date.now();
    if (o.noStop !== true) setTimeout(() => helper.executor.stop("t"), STOP_AT);
    if (o.user !== undefined) {
      const user = o.user;
      setTimeout(() => user.act(self), user.at);
    }
  };
  let link: ReaderLink;
  let held: () => string;
  let show: () => void | Promise<unknown>;
  let type: (value: string) => void;
  let walk: () => Promise<unknown> = () => Promise.resolve();
  let forget = (): void => {};
  if (mean === "AX") {
    const app = new FakeApp(executorWindow());
    app.setValue(key, ORIGINAL);
    const run = app.run.bind(app);
    link = {
      grant: (m) => { if (m.type !== "calendarGrant") app.grant(m); },
      async run(verb) {
        if (verb.kind === "walk" && dispatched && o.failRead === true) return { type: "verbResult", v: 1, id: "read", at: Date.now(), outcome: "axError", detail: "injected read failure" };
        if (verb.kind !== "write" || verb.sameAs !== undefined) return run(verb);
        dispatch();
        app.dropWrites = !o.landed;
        const r = await run(verb);
        app.dropWrites = false;
        return new Promise<VerbResult>((resolve) => setTimeout(() => resolve({ ...r, outcome: o.answer ?? "notAllowed" }), ANSWER_AT));
      },
    };
    held = () => app.node(key)?.value ?? "";
    type = (value) => app.setValue(key, value);
    show = () => { app.helper = helper; app.show(); };
  } else {
    const page = new FakePage();
    page.find("e1").value = ORIGINAL;
    if (o.inputBefore !== undefined) page.find("e1").inputAt = Date.now() - o.inputBefore;
    page.onAct = (verb) => {
      if (verb.kind !== "pageWrite" || verb.sameAs !== undefined) return null;
      dispatch();
      if (o.landed) page.find("e1").value = verb.value;
      return { outcome: o.answer ?? "notAllowed", detail: "answer after Stop" };
    };
    const receive = page.session.receive.bind(page.session);
    page.session.receive = (m) => {
      if (m.type === "pageResult") {
        const command = page.sent.find((s) => s.type === "pageCommand" && s.id === m.id);
        if (command?.type === "pageCommand" && command.verb.kind === "pageWrite" && command.verb.sameAs === undefined) {
          setTimeout(() => receive(m), ANSWER_AT);
          return null;
        }
      }
      return receive(m);
    };
    const engine = new PageEngineLink(page.session, (s) => { void helper.handleReader(s); });
    let readFailed = false;
    link = {
      grant: (m) => engine.grant(m),
      run(verb) {
        if (verb.kind === "walk" && dispatched && o.failRead === true && !readFailed) {
          readFailed = true;
          return Promise.resolve({ type: "verbResult", v: 1, id: "read", at: Date.now(), outcome: "axError", detail: "injected read failure" });
        }
        if (verb.kind === "watchInput") return Promise.resolve({ type: "verbResult", v: 1, id: "watch", at: Date.now(), outcome: "ok", detail: null });
        return engine.run(verb);
      },
    };
    held = () => page.find("e1").value ?? "";
    // The content script's record of the user's own input (content/user-input.ts), reported by the next walk.
    type = (value) => { page.find("e1").value = value; page.find("e1").inputAt = Date.now(); };
    show = () => engine.run({ kind: "walk", pid: 4100, windowId: PAGE_WIN });
    walk = () => engine.run({ kind: "walk", pid: 4100, windowId: PAGE_WIN });
    forget = () => { delete page.find("e1").inputAt; };
    cleanups.push(() => { engine.cancelTrailingWalks(); page.session.close(); });
  }
  helper = new Helper({ store, readerLink: link, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => { published.push(m); } });
  cleanups.push(() => { helper.shutdown(); helper.memory.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  Object.assign(self, {
    helper, plan, key, held, published, type, walk, forget,
    ready: Promise.resolve(show()),
    dispatchAt: () => dispatchAt,
    reader: (m: unknown) => { void helper.handleReader(ReaderMessage.parse(m)); },
  });
  return self;
}

async function run(r: Rig) {
  await r.ready;
  const result = r.helper.executor.run("t", r.plan, {}, undefined, { grant: true });
  await vi.advanceTimersByTimeAsync(ANSWER_AT + 50);
  return result;
}

const fieldInput = (windowId: string | null, key: string | null, at = Date.now()) => ({ type: "fieldInput", v: 1, at, pid: AX_PID, windowId, key });
const typesAfterStop = (mean: "AX" | "page") => ({
  at: STOP_AT + 20,
  act: (r: Rig) => {
    r.type(INTENDED);
    if (mean === "AX") r.reader(fieldInput(AX_WIN, r.key));
  },
});

describe.each(["AX", "page"] as const)("%s: the user's input on the field between the send and the recovery read", (mean) => {
  it("leaves the user's own identical text when Caret's write never landed and they typed its value after Stop", async () => {
    const r = rig(mean, { landed: false, user: typesAfterStop(mean) });
    const result = await run(r);
    expect(result).toMatchObject({ outcome: "stopped", acted: 0, step: 0 });
    expect(result.detail).toContain("you typed in it after Caret sent its write, so Caret cannot tell its write from your input and left it as it is");
    expect(r.helper.executor.ledger("t")).toMatchObject([{ before: ORIGINAL, after: INTENDED, unconfirmed: true, mayIncludeInput: true }]);
    const undone = await r.helper.executor.undo("t");
    expect(undone).toMatchObject({ restored: 0, notRestored: [{ step: 0, reason: expect.stringContaining("may hold your typing") }] });
    expect(r.held()).toBe(INTENDED);
  });

  it("still leaves it when Caret's write did land and the user then typed in the field", async () => {
    const r = rig(mean, { landed: true, user: typesAfterStop(mean) });
    const result = await run(r);
    expect(result).toMatchObject({ outcome: "stopped", acted: 0 });
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0 });
    expect(r.held()).toBe(INTENDED);
  });
});

describe.each(["AX", "page"] as const)("%s: input on the field when the answer comes back ok after Stop (PR #33 review)", (mean) => {
  it("still restores a write that answered ok when nobody touched the field", async () => {
    const r = rig(mean, { landed: true, answer: "ok" });
    await run(r);
    expect(r.helper.executor.ledger("t")).toMatchObject([{ before: ORIGINAL, after: INTENDED }]);
    expect(r.helper.executor.ledger("t")[0]).not.toHaveProperty("mayIncludeInput");
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1 });
    expect(r.held()).toBe(ORIGINAL);
  });
});

describe("AX: which reader input counts", () => {
  // A page's ok carries the content script's own read-back, taken as it wrote (PageEngineLink.patched), so it cannot be
  // the user's later typing; the reader's ok is followed by a walk, which can.
  it("keeps Undo off a value the user typed while Caret's write was dropped and the answer came back ok (PR #33 review)", async () => {
    const r = rig("AX", { landed: false, answer: "ok", user: typesAfterStop("AX") });
    await run(r);
    expect(r.helper.executor.ledger("t")).toMatchObject([{ before: ORIGINAL, after: INTENDED, mayIncludeInput: true }]);
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringContaining("may hold your typing") }] });
    expect(r.held()).toBe(INTENDED);
  });

  it("does not count the Esc that stops the run: the reader sends it as window-level userInput only", async () => {
    // caret-screen sends no fieldInput for Esc (ScreenReader.inputSeen); its userInput still reaches the executor.
    const r = rig("AX", { landed: true, user: { at: STOP_AT - 5, act: (x) => x.reader({ type: "userInput", v: 1, at: Date.now(), pid: AX_PID, kind: "key", point: null }) } });
    const result = await run(r);
    expect(result).toMatchObject({ outcome: "stopped", acted: 1, step: 1, detail: expect.stringContaining("Written before stop") });
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(r.held()).toBe(ORIGINAL);
  });

  it("does not count typing in another field of the window", async () => {
    const r = rig("AX", { landed: true, user: { at: STOP_AT + 20, act: (x) => x.reader(fieldInput(AX_WIN, K("textfield:email~0"))) } });
    expect(await run(r)).toMatchObject({ outcome: "stopped", acted: 1, detail: expect.stringContaining("Undo puts it back") });
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1 });
    expect(r.held()).toBe(ORIGINAL);
  });

  it("does not count a key the reader saw before the write was sent", async () => {
    const r = rig("AX", { landed: true, user: { at: STOP_AT + 20, act: (x) => x.reader(fieldInput(AX_WIN, x.key, x.dispatchAt() - 1)) } });
    expect(await run(r)).toMatchObject({ outcome: "stopped", acted: 1 });
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1 });
  });

  it.each([
    ["at no known element of the window", AX_WIN, null],
    ["in no known window of the process", null, null],
  ])("counts a key placed %s", async (_, windowId, key) => {
    const r = rig("AX", { landed: true, user: { at: STOP_AT + 20, act: (x) => x.reader(fieldInput(windowId, key)) } });
    const result = await run(r);
    expect(result).toMatchObject({ outcome: "stopped", acted: 0, detail: expect.stringContaining("you typed in its window") });
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0 });
    expect(r.held()).toBe(INTENDED);
  });

  it("counts a key in a stopped task's field: the watch is per write, not per acting task", async () => {
    // Stop at 40 ms ends acting() for the task; the key at 60 ms must still reach the write's watch.
    const r = rig("AX", { landed: false, user: typesAfterStop("AX") });
    expect(await run(r)).toMatchObject({ acted: 0, detail: expect.stringContaining("you typed in it") });
  });

  it("counts a click inside the field's window, and one elsewhere in its app (PR #33 review)", async () => {
    const click = (point: [number, number]) => ({ at: STOP_AT + 20, act: (x: Rig) => x.reader({ type: "userInput", v: 1, at: Date.now(), pid: AX_PID, kind: "mouse", point }) });
    const inside = rig("AX", { landed: true, user: click([150, 50]) });
    expect(await run(inside)).toMatchObject({ acted: 0, detail: expect.stringContaining("you clicked in its window") });
    expect(await inside.helper.executor.undo("t")).toMatchObject({ restored: 0 });
    for (const close of cleanups.splice(0)) close();
    // A suggestion list outside the window's frame can put the value in too.
    const outside = rig("AX", { landed: true, user: click([900, 700]) });
    expect(await run(outside)).toMatchObject({ acted: 0, detail: expect.stringContaining("you clicked in its app") });
    expect(await outside.helper.executor.undo("t")).toMatchObject({ restored: 0 });
  });

  it("does not count a click in another app", async () => {
    const r = rig("AX", { landed: true, user: { at: STOP_AT + 20, act: (x) => x.reader({ type: "userInput", v: 1, at: Date.now(), pid: AX_PID + 1, kind: "mouse", point: [150, 50] }) } });
    expect(await run(r)).toMatchObject({ acted: 1 });
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1 });
  });

  it("keeps Undo off the field when the reader's report arrives after the recovery read (B29)", async () => {
    const r = rig("AX", { landed: false });
    // The user typed before the read, so the read shows their text; the reader's report of it comes only afterwards.
    setTimeout(() => r.type(INTENDED), STOP_AT + 20);
    const result = await run(r);
    expect(result).toMatchObject({ outcome: "stopped", acted: 1, detail: expect.stringContaining("Written before stop") });
    r.reader(fieldInput(AX_WIN, r.key, r.dispatchAt() + STOP_AT + 20));
    expect(r.helper.executor.ledger("t")).toMatchObject([{ mayIncludeInput: true }]);
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringContaining("may hold your typing") }] });
    expect(r.held()).toBe(INTENDED);
  });

  it("promises no Undo when the recovery read fails after the user typed in the field", async () => {
    const r = rig("AX", { landed: true, failRead: true, user: typesAfterStop("AX") });
    const result = await run(r);
    expect(result.detail).toContain("The field may have been written, but you typed in it after Caret sent it, so Undo leaves it");
    expect(result.detail).not.toContain("Undo can put it back");
    expect(r.helper.executor.ledger("t")).toMatchObject([{ unconfirmed: true, mayIncludeInput: true }]);
  });
});

describe("page: the walk's record of the user's input", () => {
  // pageInput names no control, and a key there may be the Esc that stops the run; a click on the field itself reaches
  // its inputAt (extension content/user-input.ts). W3's revoked pick keeps its Undo (page-w3.test.ts 1d).
  it.each(["key", "mouse"] as const)("does not count a %s the page reports without naming a control", async (kind) => {
    const r = rig("page", { landed: true, user: { at: STOP_AT - 10, act: (x) => x.helper.executor.onPageInput(PAGE_WIN, kind) } });
    expect(await run(r)).toMatchObject({ acted: 1 });
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1 });
  });

  it("refuses Undo after a failed recovery read when the page's walk at Undo shows the user's input (PR #33 review)", async () => {
    const r = rig("page", { landed: false, failRead: true, user: typesAfterStop("page") });
    const result = await run(r);
    expect(result.detail).toContain("may have been written");
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringContaining("may hold your typing") }] });
    expect(r.held()).toBe(INTENDED);
  });

  it("keeps Undo off the field after the page forgets the input, once a later walk saw it (PR #33 review)", async () => {
    const r = rig("page", { landed: false, failRead: true, user: typesAfterStop("page") });
    expect((await run(r)).detail).toContain("may have been written");
    // The page reports the typing, and the helper walks the tab; then Undo comes after the page's 30 s record is gone.
    await r.walk();
    expect(r.helper.executor.ledger("t")).toMatchObject([{ mayIncludeInput: true }]);
    await vi.advanceTimersByTimeAsync(31_000);
    r.forget();
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringContaining("may hold your typing") }] });
    expect(r.held()).toBe(INTENDED);
  });

  it("keeps Undo off a reconciled write the user retyped with the same text, which changes only inputAt (PR #33 review)", async () => {
    const r = rig("page", { landed: true });
    expect(await run(r)).toMatchObject({ acted: 1, detail: expect.stringContaining("Written before stop") });
    // The user selects the field's text and types the same value: the walk shows no change of text, only the input time.
    r.type(INTENDED);
    await r.walk();
    expect(r.helper.executor.ledger("t")).toMatchObject([{ mayIncludeInput: true }]);
    await vi.advanceTimersByTimeAsync(31_000);
    r.forget();
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringContaining("may hold your typing") }] });
    expect(r.held()).toBe(INTENDED);
  });

  it("keeps the send time across a helper restart, so a recovered write's Undo still reads the page's input (PR #33 review)", async () => {
    const r = rig("page", { landed: false });
    await r.ready;
    const sentAt = Date.now() - 1000;
    // The row a crash left with the write on its way; the content script outlived the helper and saw the user type.
    r.helper.executor.recover({ taskId: "rec", startedAt: sentAt - 100, savedAt: sentAt, plan: r.plan, unprompted: false, granted: true, readerId: null, next: 0, ledger: [], pending: { kind: "write", step: 0, pid: 4100, windowId: PAGE_WIN, key: r.key, role: "AXTextField", before: ORIGINAL, value: INTENDED, mark: "m-rec", sentAt }, skillId: null, window: null, afterIntended: true });
    expect(r.helper.executor.ledger("rec")).toMatchObject([{ unconfirmed: true, sentAt }]);
    r.type(INTENDED);
    // A walk after the restart reads the page's record, and keeps it for Undo past the page's 30 s.
    await r.walk();
    expect(r.helper.executor.ledger("rec")).toMatchObject([{ mayIncludeInput: true }]);
    // Saved to the row the recovered run keeps, so a second restart keeps it too (PR #33 review).
    expect(r.helper.journal.load(Date.now()).records.find((x) => x.taskId === "rec")?.ledger).toMatchObject([{ mayIncludeInput: true, sentAt }]);
    await vi.advanceTimersByTimeAsync(31_000);
    r.forget();
    expect(await r.helper.executor.undo("rec")).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringContaining("may hold your typing") }] });
    expect(r.held()).toBe(INTENDED);
  });

  it("keeps Undo off a write that finished normally when the user then retypes its value (PR #33 review)", async () => {
    const r = rig("page", { landed: true, answer: "ok", noStop: true });
    await run(r);
    expect(r.helper.executor.ledger("t")[0]).toMatchObject({ after: INTENDED, sentAt: r.dispatchAt() });
    r.type(INTENDED);
    await r.walk();
    await vi.advanceTimersByTimeAsync(31_000);
    r.forget();
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringContaining("may hold your typing") }] });
    expect(r.held()).toBe(INTENDED);
  });

  it("does not count input from before the write was sent, such as the key that accepted the fill", async () => {
    const r = rig("page", { landed: true, inputBefore: 1000 });
    expect(await run(r)).toMatchObject({ outcome: "stopped", acted: 1, detail: expect.stringContaining("Written before stop") });
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1 });
    expect(r.held()).toBe(ORIGINAL);
  });
});

describe("page: a control's input time on its node", () => {
  it("copies each control's inputAt, and gives a radio group the latest of its buttons', since a write targets the group", () => {
    const page = new FakePage();
    page.find("e1").inputAt = 1_790_000_000_100;
    page.find("e4").inputAt = 1_790_000_000_200;
    page.find("e5").inputAt = 1_790_000_000_300;
    const nodes = new Map(toWindowSnapshot(page.snapshot("w"), page.session, 1).nodes.map((n) => [n.key, n]));
    expect(nodes.get(KEY("e1"))?.inputAt).toBe(1_790_000_000_100);
    expect(nodes.get(RADIO)?.inputAt).toBe(1_790_000_000_300);
    expect(nodes.get(KEY("e2"))).not.toHaveProperty("inputAt");
    page.session.close();
  });
});

describe("FieldInput on the wire", () => {
  const golden = readFileSync(fileURLToPath(new URL("../fixtures/golden/field-input.ndjson", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as unknown);

  it("reads every golden line as a reader message: a placed key, an unknown element, an unknown window", () => {
    expect(golden.map((l) => ReaderMessage.parse(l))).toMatchObject([
      { type: "fieldInput", pid: AX_PID, windowId: AX_WIN, key: K("textfield:name~0") },
      { type: "fieldInput", windowId: AX_WIN, key: null },
      { type: "fieldInput", windowId: null, key: null },
    ]);
  });

  it("carries no key code or characters: an extra field is dropped, and a missing one refused", () => {
    const line = golden[0] as Record<string, unknown>;
    expect(ReaderMessage.parse({ ...line, chars: "D", keyCode: 2 })).not.toHaveProperty("chars");
    const { key: _key, ...noKey } = line;
    expect(() => ReaderMessage.parse(noKey)).toThrow();
  });

  it("is a page control's inputAt only as a timestamp", () => {
    const c = { id: "e1", key: "textbox:name~0", strongKey: null, kind: "text", role: "textbox", name: "Name", form: null, rect: [0, 0, 10, 10] };
    expect(PageControl.parse({ ...c, inputAt: 1790000000000 }).inputAt).toBe(1790000000000);
    expect(() => PageControl.parse({ ...c, inputAt: "now" })).toThrow();
  });
});
