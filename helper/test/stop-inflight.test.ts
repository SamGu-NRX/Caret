import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { PageEngineLink } from "../src/engines/page-link.ts";
import type { ReaderLink } from "../src/executor/means.ts";
import type { HelperMessage, VerbResult } from "../src/protocol.ts";
import type { Plan } from "../src/executor/schema.ts";
import { executorWindow, FakeApp, K, TITLE as AX_TITLE } from "./fake-app.ts";
import { FakePage, KEY, TITLE as PAGE_TITLE, WIN as PAGE_WIN } from "./fake-page.ts";

// The injected timer scheduler holds each forward answer until 250 ms. Stop is scheduled relative to dispatch,
// not to plan preparation. The target changes independently of its acknowledgement, as an AX call or page setter can.
const ORIGINAL = "Original name";
const INTENDED = "Dana";
type Answer = "refused" | "ok" | "lost";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.useRealTimers();
});

function rig(mean: "AX" | "page", stopAfter: number, answer: Answer, landed = true, failRead = false, pauseFirst = false) {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), "caret-stop-flight-"));
  const store = new Store(join(dir, "data"));
  const published: HelperMessage[] = [];
  let helper: Helper;
  let dispatched = false;
  let recoveryReads = 0;
  let dispatchAt = 0;
  let recover = failRead;
  const key = mean === "AX" ? K("textfield:name~0") : KEY("e1");
  const title = mean === "AX" ? AX_TITLE : PAGE_TITLE;
  const plan: Plan = { id: "stop", title: "Fill names", slots: {}, steps: [
    { says: "First Name", end: { kind: "valueEquals", window: { title }, target: { key, describe: "First Name" }, value: INTENDED } },
    { says: "Another field", end: { kind: "valueEquals", window: { title }, target: { key, describe: "First Name" }, value: "Must not run" } },
  ] };
  const dispatch = () => {
    dispatched = true;
    dispatchAt = Date.now();
    // This row must already exist when the writer receives the command. Its original must precede the setter.
    expect(helper.journal.load(Date.now()).records[0]?.pending).toMatchObject({ kind: "write", before: ORIGINAL, value: INTENDED });
    setTimeout(() => pauseFirst ? helper.executor.pause("t", false, "input") : helper.executor.stop("t"), stopAfter);
  };
  let link: ReaderLink;
  let held: () => string;
  let show: () => void | Promise<unknown>;
  if (mean === "AX") {
    const app = new FakeApp(executorWindow());
    app.setValue(key, ORIGINAL);
    const run = app.run.bind(app);
    link = {
      grant: (m) => { if (m.type !== "calendarGrant") app.grant(m); },
      async run(verb) {
        if (verb.kind === "walk" && dispatched) {
          recoveryReads++;
          if (recover) return { type: "verbResult", v: 1, id: "read", at: Date.now(), outcome: "axError", detail: "injected read failure" };
        }
        if (verb.kind !== "write" || verb.sameAs !== undefined) return run(verb);
        dispatch();
        app.dropWrites = !landed;
        const r = await run(verb);
        app.dropWrites = false;
        return new Promise<VerbResult>((resolve) => {
          if (answer !== "lost") setTimeout(() => resolve({ ...r, outcome: answer === "ok" ? "ok" : "notAllowed" }), 250);
        });
      },
    };
    held = () => app.node(key)?.value ?? "";
    show = () => { app.helper = helper; app.show(); };
  } else {
    const page = new FakePage();
    page.find("e1").value = ORIGINAL;
    const receive = page.session.receive.bind(page.session);
    const command = page.session.command.bind(page.session);
    page.session.command = (verb, timeout) => {
      if (verb.kind === "pageWalk" && dispatched) recoveryReads++;
      return command(verb, timeout);
    };
    page.onAct = (verb) => {
      if (verb.kind !== "pageWrite" || verb.sameAs !== undefined) return null;
      dispatch();
      if (landed) page.find("e1").value = verb.value;
      return { outcome: answer === "ok" ? "ok" : "notAllowed", detail: "answer after Stop" };
    };
    page.session.receive = (m) => {
      if (m.type === "pageResult") {
        const command = page.sent.find((s) => s.type === "pageCommand" && s.id === m.id);
        if (command?.type === "pageCommand" && command.verb.kind === "pageWrite" && command.verb.sameAs === undefined) {
          if (answer !== "lost") setTimeout(() => receive(m), 250);
          return null;
        }
      }
      return receive(m);
    };
    const engine = new PageEngineLink(page.session, (s) => { void helper.handleReader(s); });
    link = {
      grant: (m) => engine.grant(m),
      run(verb) {
        if (verb.kind === "watchInput") return Promise.resolve({ type: "verbResult", v: 1, id: "watch", at: Date.now(), outcome: "ok", detail: null });
        if (verb.kind === "walk" && dispatched) {
          if (recover) {
            recoveryReads++;
            return Promise.resolve({ type: "verbResult", v: 1, id: "read", at: Date.now(), outcome: "axError", detail: "injected read failure" });
          }
        }
        return engine.run(verb);
      },
    };
    held = () => page.find("e1").value ?? "";
    show = () => engine.run({ kind: "walk", pid: 4100, windowId: PAGE_WIN });
    cleanups.push(() => { engine.cancelTrailingWalks(); page.session.close(); });
  }
  helper = new Helper({ store, readerLink: link, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => {
    published.push(m);
    // GoalRuns performs this conversion when the reader reports Esc as input before the host's Stop arrives.
    if (pauseFirst && m.type === "taskProgress" && m.phase === "paused") queueMicrotask(() => helper.executor.stop("t"));
  } });
  const ready = Promise.resolve(show());
  cleanups.push(() => { helper.shutdown(); helper.memory.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { helper, plan, key, held, published, ready, dispatched: () => dispatched, dispatchAt: () => dispatchAt, recoveryReads: () => recoveryReads, allowReads: () => { recover = false; } };
}

async function complete(r: ReturnType<typeof rig>, wait: number) {
  await r.ready;
  const result = r.helper.executor.run("t", r.plan, {}, undefined, { grant: true });
  // Zero-time advancement drains preparation and the dispatch microtasks, then fires Stop at 0 ms if requested.
  await vi.advanceTimersByTimeAsync(0);
  expect(r.dispatched()).toBe(true);
  await vi.advanceTimersByTimeAsync(wait);
  return result;
}

describe.each(["AX", "page"] as const)("%s in-flight reconciliation", (mean) => {
  it.each([0, 10, 40, 200])("Stop %i ms after dispatch reconciles a landed write despite a refused answer", async (ms) => {
    const r = rig(mean, ms, "refused");
    const result = await complete(r, 300);
    expect(result).toMatchObject({ outcome: "stopped", acted: 1, step: 1 });
    expect(result.detail).toContain(`Written before stop: ${mean === "AX" ? "Name" : "Full name"}`);
    expect(result.detail).toContain("Undo puts it back");
    expect(r.helper.executor.ledger("t")).toMatchObject([{ kind: "write", before: ORIGINAL, after: INTENDED, step: 0 }]);
    expect(r.helper.executor.ledger("t")).toHaveLength(1);
    expect(r.recoveryReads()).toBe(1);
    expect(r.held()).toBe(INTENDED);
    expect(r.published.filter((m) => m.type === "taskProgress").map((m) => m.phase)).toEqual(["started", "acting", "verified", "stopped"]);
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(r.held()).toBe(ORIGINAL);
  });

  it.each([false, true])("preserves reconciliation when input pauses first and the goal then stops, read failure %s", async (failRead) => {
    const r = rig(mean, 40, "refused", true, failRead, true);
    await complete(r, 300);
    const stopped = r.published.find((m) => m.type === "taskProgress" && m.phase === "stopped");
    expect(stopped).toMatchObject({ step: failRead ? 0 : 1, detail: expect.stringContaining(failRead ? "may have been written" : "Written before pause") });
    expect(r.helper.executor.ledger("t")).toMatchObject([{ before: ORIGINAL, after: INTENDED }]);
    expect(r.helper.executor.ledger("t")).toHaveLength(1);
    r.allowReads();
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(r.held()).toBe(ORIGINAL);
  });

  it("reports an untouched refused write as not run and removes its undo entry", async () => {
    const r = rig(mean, 40, "refused", false);
    expect(await complete(r, 300)).toMatchObject({ outcome: "stopped", acted: 0, step: 0, detail: expect.stringContaining("before step 1") });
    expect(r.helper.executor.ledger("t")).toEqual([]);
    expect(r.recoveryReads()).toBe(1);
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [] });
    expect(r.held()).toBe(ORIGINAL);
  });

  it("retains the original for guarded undo when the single recovery read fails", async () => {
    const r = rig(mean, 40, "refused", true, true);
    expect(await complete(r, 300)).toMatchObject({ outcome: "stopped", acted: 0, detail: expect.stringContaining("may have been written") });
    expect(r.helper.executor.ledger("t")).toMatchObject([{ before: ORIGINAL, after: INTENDED, unconfirmed: true }]);
    expect(r.recoveryReads()).toBe(1);
    r.allowReads();
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(r.held()).toBe(ORIGINAL);
  });

  it("bounds the wait for a lost answer and reconciles once before returning", async () => {
    const r = rig(mean, 40, "lost");
    const result = await complete(r, 5100);
    expect(Date.now() - r.dispatchAt()).toBe(5100);
    expect(result).toMatchObject({ outcome: "stopped", acted: 1, step: 1 });
    expect(r.recoveryReads()).toBe(1);
    expect(r.helper.executor.ledger("t")).toMatchObject([{ before: ORIGINAL, after: INTENDED }]);
    expect(await r.helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(r.held()).toBe(ORIGINAL);
  });
});
