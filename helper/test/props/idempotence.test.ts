// P6 - Idempotence properties (G3): running the same accepted plan twice writes nothing the second time.
//
// executor.ts:3 - "The executor runs the plan's steps in order. Each step checks the end state holds before it
// acts ... the skip is the end state, not the history." The desk is the executor harness (test/executor.test.ts,
// test/fake-app.ts executorWindow): Name, Email, and one City in each of Billing and Shipping.
import fc from "fast-check";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../../src/helper.ts";
import { Store } from "../../src/store.ts";
import { FakeCalendar } from "../../src/executor/means.ts";
import type { AskJev } from "../../src/fill/jev.ts";
import type { Plan, Step } from "../../src/executor/schema.ts";
import { FakeApp, executorWindow, K, TITLE, wireButtons } from "../fake-app.ts";
import { arbPlainValue, runs } from "./gens.ts";

const W = { titleStartsWith: TITLE };
const write = (key: string, value: string, says = `${key} holds ${value}`): Step => ({ says, end: { kind: "valueEquals", window: W, target: { key, describe: says }, value } });
const plan = (steps: Step[], id = "p"): Plan => ({ id, title: id, slots: {}, steps });

/** Every Executor.run takes a fresh task id: a task id already in the ledger is refused (executor.ts:462). */
let runSeq = 0;
const uid = (): string => `t${++runSeq}`;

const FIELDS = [K("textfield:name~0"), K("textfield:email~0"), K("group:billing/textfield:city~0"), K("group:shipping/textfield:city~0")];

/** A plan of one to three steps, each a distinct field of the executor window and a plain value. */
const arbPlan: fc.Arbitrary<[Plan, string[]]> = fc
  .record({ picks: fc.array(fc.nat({ max: 3 }), { minLength: 1, maxLength: 3 }), values: fc.array(arbPlainValue, { minLength: 1, maxLength: 3 }) })
  .map(({ picks, values }) => {
    const steps: Step[] = [];
    const keys: string[] = [];
    for (const pick of picks) {
      if (steps.length >= values.length) break;
      const key = FIELDS[pick];
      if (key === undefined || keys.includes(key)) continue;
      const value = values[steps.length];
      if (value === undefined) break;
      keys.push(key);
      steps.push(write(key, value));
    }
    return [plan(steps), keys] as [Plan, string[]];
  });

describe("the executor reruns the same accepted plan as a no-op (executor.ts:3)", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  let askJev: AskJev | null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-props-exec-"));
    store = new Store(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    askJev = null;
    helper = new Helper({
      store,
      askJev: (req) => (askJev === null ? Promise.reject(new Error("no Jev in this test")) : askJev(req)),
      shadow: false,
      allowBackgroundFocus: false,
      publish: () => {},
      readerLink: app,
      calendar: new FakeCalendar(),
    });
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the second run of the same plan acts nothing, skips everything, and leaves every field's value as the first run wrote it", async () => {
    // Every fc.assert here is awaited: an un-awaited property outlives its test and races the next test's
    // beforeEach/afterEach, which is how the seed-20261008 CI run ended in unhandled rejections on a closed
    // store and stale models (an act of 0 on a field the model had not seen change).
    await fc.assert(
      fc.asyncProperty(arbPlan, async ([p, keys]) => {
        // The desk persists across this property's runs, so a later case can inherit an earlier case's value on
        // the same field; the executor would then rightly skip. Each case's premise is the window fresh.
        for (const key of FIELDS) app.setValue(key, "");
        const first = await helper.executor.run(uid(), p, {});
        expect(first.outcome).toBe("done");
        expect(first.acted).toBe(keys.length);
        expect(first.skipped).toBe(0);
        const valuesAfterFirst = keys.map((key) => app.node(key)?.value);
        const second = await helper.executor.run(uid(), p, {});
        expect(second.outcome).toBe("done");
        expect(second.acted).toBe(0);
        expect(second.skipped).toBe(keys.length);
        expect(keys.map((key) => app.node(key)?.value)).toEqual(valuesAfterFirst);
      }),
      runs(25),
    );
  });

  it("the skip is the end state, not the history: change the field and the same plan acts again", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlan, async ([p, keys]) => {
        await helper.executor.run(uid(), p, {});
        // Someone else moves the first field after the first run.
        const target = keys[0];
        if (target === undefined) throw new Error("no steps");
        const planned = p.steps[0];
        if (planned?.end.kind !== "valueEquals") throw new Error("no value step");
        const other = `${planned.end.value} (moved)`;
        app.setValue(target, other);
        // The model learns the move on the next run's own walk (FakeApp.perform answers a walk with a full
        // snapshot), so holds is false, and the write goes out with expect set to what the model just read -
        // the reader's compare-and-swap, which refuses a value it did not see. Nothing here is expected to
        // refuse: the moved value is not Caret's write, and overwriting it is exactly what the plan is for.
        const second = await helper.executor.run(uid(), p, {});
        expect(second.acted).toBeGreaterThan(0);
        expect(app.node(target)?.value).toBe(planned.end.value);
      }),
      runs(25),
    );
  });

  it("a step whose field already holds its value is skipped on the first run: the precondition is enough", async () => {
    await fc.assert(
      fc.asyncProperty(arbPlan, async ([p, keys]) => {
        const target = keys[0];
        if (target === undefined) throw new Error("no steps");
        const planned = p.steps[0];
        if (planned?.end.kind !== "valueEquals") throw new Error("no value step");
        // The desk persists across this property's runs; each case's premise is the window fresh but the target.
        for (const key of FIELDS) app.setValue(key, "");
        app.setValue(target, planned.end.value);
        const first = await helper.executor.run(uid(), p, {});
        expect(first.outcome).toBe("done");
        expect(first.skipped).toBe(1);
        expect(first.acted).toBe(keys.length - 1);
        expect(app.node(target)?.value).toBe(planned.end.value);
      }),
      runs(25),
    );
  });
});
