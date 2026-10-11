import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { PAGE_SUBROLE, type HelperMessage } from "../src/protocol.ts";
import type { Plan, Step } from "../src/executor/schema.ts";
import { executorWindow, FakeApp, K, TITLE, WIN } from "./fake-app.ts";

const NAME = K("textfield:name~0");
const EMAIL = K("textfield:email~0");
const write = (key: string, value: string): Step => ({
  says: `${key} holds ${value}`,
  end: { kind: "valueEquals", window: { title: TITLE }, target: { key, describe: key }, value },
});
const plan: Plan = { id: "e1", title: "Stop evidence", slots: {}, steps: [write(NAME, "Dana"), write(EMAIL, "d@example.com")] };

describe("E1 stop at the reader's last grant check", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let app: FakeApp;
  let published: HelperMessage[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-e1-stop-"));
    store = new Store(join(dir, "data"));
    app = new FakeApp(executorWindow());
    app.enforceGrants = true;
    published = [];
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, readerLink: app, publish: (m) => published.push(m) });
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a queued second write never lands; the finished first write is undoable", async () => {
    app.beforeVerb = (a, v) => {
      if (v.kind !== "write" || v.key !== EMAIL) return;
      a.beforeVerb = null;
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result).toMatchObject({ outcome: "stopped", step: 1 });
    expect(app.node(NAME)?.value).toBe("Dana");
    expect(app.node(EMAIL)?.value).toBe("old@example.com");
    expect(helper.executor.ledger("t")).toMatchObject([{ kind: "write", key: NAME, before: "", after: "Dana" }]);
    expect(helper.executor.ledger("t")).toHaveLength(1);
    expect(app.grants.log.map((m) => m.type)).toEqual(["actGrant", "actRevoke"]);
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(app.node(NAME)?.value ?? "").toBe("");
    expect(app.node(EMAIL)?.value).toBe("old@example.com");
  });

  it("a stop after dispatch finishes read-back and records undo before acknowledging stop", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind !== "write" || v.key !== NAME) return;
      a.afterVerb = null;
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result).toMatchObject({ outcome: "stopped", step: 1, acted: 1 });
    expect(app.verbs.filter((v) => v.kind === "write").map((v) => v.key)).toEqual([NAME]);
    expect(helper.model.windows.get(WIN)?.nodes.get(NAME)?.value).toBe("Dana");
    const phases = published.flatMap((m) => m.type === "taskProgress" && m.taskId === "t" ? [m.phase] : []);
    expect(phases).toEqual(["started", "acting", "verified", "stopped"]);
    expect(helper.executor.ledger("t")).toMatchObject([{ kind: "write", key: NAME, before: "", after: "Dana" }]);
    expect(helper.executor.ledger("t")).toHaveLength(1);
    expect(helper.executor.ledger("t")[0]).not.toHaveProperty("unconfirmed", true);
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(app.node(NAME)?.value ?? "").toBe("");
    expect(app.node(EMAIL)?.value).toBe("old@example.com");
  });

  it("a partial write with a lost acknowledgement is read before stop and restored by undo", async () => {
    // Fault injection, not runtime evidence: the app takes only a prefix before its reader times out.
    app.normalize = (value) => value.slice(0, 2);
    app.timeoutAfterWrite = true;
    app.afterVerb = (a, v) => {
      if (v.kind !== "write" || v.key !== NAME) return;
      a.afterVerb = null;
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result.outcome).toBe("stopped");
    expect(app.node(NAME)?.value).toBe("Da");
    expect(app.node(EMAIL)?.value).toBe("old@example.com");
    expect(helper.model.windows.get(WIN)?.nodes.get(NAME)?.value).toBe("Da");
    expect(helper.executor.ledger("t")).toMatchObject([{ kind: "write", key: NAME, before: "", after: "Dana", unconfirmed: true, partialWrite: true }]);
    expect(helper.executor.ledger("t")).toHaveLength(1);
    app.timeoutAfterWrite = false;
    app.normalize = null;
    const beforeUndo = app.verbs.filter((v) => v.kind === "write").length;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(beforeUndo + 1);
    expect(app.node(NAME)?.value ?? "").toBe("");
    expect(app.node(EMAIL)?.value).toBe("old@example.com");
  });

  it("a stop between writes leaves the second write unstarted", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind !== "write" || v.key !== NAME) return;
      a.afterVerb = null;
      helper.executor.stop("t");
    };
    await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(app.verbs.some((v) => v.kind === "write" && v.key === EMAIL)).toBe(false);
    expect(app.node(EMAIL)?.value).toBe("old@example.com");
  });

  it.each(["value", "focusValue", "insert"] as const)("restores a partial %s replacement of non-empty original text", async (method) => {
    app.setValue(NAME, "Original name");
    app.dropWrites = method !== "value";
    app.dropFocusValues = method === "insert";
    app.normalize = (value) => value.slice(0, 2);
    app.afterVerb = (a, v) => {
      if (v.kind !== "write" || v.attribute !== method) return;
      a.afterVerb = null;
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result.outcome).toBe("stopped");
    expect(helper.executor.ledger("t")).toMatchObject([{ before: "Original name", after: "Dana", partialWrite: true }]);
    app.normalize = null;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(app.node(NAME)?.value).toBe("Original name");
  });

  it("reads a successful answer that omitted read-back before trying a fallback", async () => {
    const show = app.show.bind(app);
    app.beforeVerb = (a, v) => {
      if (v.kind === "write") a.show = () => {};
    };
    app.afterVerb = (a, v) => {
      if (v.kind !== "write") return;
      a.show = show;
      a.beforeVerb = null;
      a.afterVerb = null;
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result).toMatchObject({ outcome: "stopped", acted: 1 });
    expect(helper.model.windows.get(WIN)?.nodes.get(NAME)?.value).toBe("Dana");
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(1);
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1 });
  });

  it("keeps partial undo when the reader call throws instead of answering", async () => {
    app.setValue(NAME, "Original name");
    app.normalize = () => "Da";
    app.timeoutAfterWrite = true;
    const run = app.run.bind(app);
    app.run = async (verb) => {
      const result = await run(verb);
      if (verb.kind === "write" && verb.sameAs === undefined) throw new Error("lost connection after dispatch");
      return result;
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result).toMatchObject({ outcome: "stopped" });
    expect(helper.model.windows.get(WIN)?.nodes.get(NAME)?.value).toBe("Da");
    expect(helper.executor.ledger("t")).toMatchObject([{ before: "Original name", after: "Dana", unconfirmed: true, partialWrite: true }]);
    app.run = run;
    app.normalize = null;
    app.timeoutAfterWrite = false;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(app.node(NAME)?.value).toBe("Original name");
  });

  it("retains undo if both read-back and recovery reads fail, then classifies at undo", async () => {
    app.setValue(NAME, "Original name");
    app.normalize = () => "Da";
    const show = app.show.bind(app);
    app.beforeVerb = (a, v) => {
      if (v.kind === "write") a.show = () => {};
    };
    app.afterVerb = (a, v) => {
      if (v.kind !== "write") return;
      a.show = show;
      a.beforeVerb = null;
      a.afterVerb = null;
      a.failWalks = 6;
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result).toMatchObject({ outcome: "stopped", acted: 0 });
    expect(result.detail).toContain("could not read the field");
    expect(helper.executor.ledger("t")).toMatchObject([{ before: "Original name", after: "Dana", unconfirmed: true }]);
    expect(helper.executor.ledger("t")[0]).not.toHaveProperty("partialWrite");
    const entry = helper.executor.ledger("t")[0];
    app.normalize = null;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(entry).toHaveProperty("partialWrite", true);
    expect(app.node(NAME)?.value).toBe("Original name");
  });

  it("recognizes the original before treating it as a proper prefix", async () => {
    app.setValue(NAME, "Da");
    app.normalize = () => "Da";
    app.timeoutAfterWrite = true;
    await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(helper.executor.ledger("t")[0]).not.toHaveProperty("partialWrite");
    const writes = app.verbs.filter((v) => v.kind === "write").length;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [] });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(writes);
    expect(app.node(NAME)?.value).toBe("Da");
  });

  it("reports exact unknown content and the original on stop and undo without a restore", async () => {
    const original = "Previous name\n\"quoted\"";
    const held = "Danas\n" + "x".repeat(120);
    app.setValue(NAME, original);
    app.normalize = () => held;
    app.timeoutAfterWrite = true;
    app.afterVerb = (a, v) => {
      if (v.kind !== "write") return;
      a.afterVerb = null;
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result.detail).toContain(JSON.stringify(held));
    expect(result.detail).toContain(JSON.stringify(original));
    const writes = app.verbs.filter((v) => v.kind === "write").length;
    const undo = await helper.executor.undo("t");
    expect(undo.restored).toBe(0);
    expect(undo.notRestored[0]?.reason).toContain(JSON.stringify(held));
    expect(undo.notRestored[0]?.reason).toContain(JSON.stringify(original));
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(writes);
    expect(app.node(NAME)?.value).toBe(held);
  });

  it("keeps undo for a disappeared field but never dispatches a blind restore", async () => {
    const original = "Original name " + "x".repeat(120);
    app.setValue(NAME, original);
    app.afterVerb = (a, v) => {
      if (v.kind !== "write") return;
      a.afterVerb = null;
      a.nodes = a.nodes.filter((n) => n.key !== NAME);
      a.show();
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result.detail).toContain("the field is gone");
    expect(result.detail).toContain(JSON.stringify(original));
    expect(helper.executor.ledger("t")).toMatchObject([{ before: original, after: "Dana", unconfirmed: true }]);
    const writes = app.verbs.filter((v) => v.kind === "write").length;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 0, notRestored: [{ reason: expect.stringContaining(JSON.stringify(original)) }] });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(writes);
  });

  it("does not restore a confirmed write the user later shortened to a prefix", async () => {
    await helper.executor.run("t", { ...plan, steps: [write(NAME, "Dana")] }, {}, undefined, { grant: true });
    app.setValue(NAME, "Da");
    const writes = app.verbs.filter((v) => v.kind === "write").length;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 0 });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(writes);
    expect(app.node(NAME)?.value).toBe("Da");
  });

  it("preserves an exact read-back when the user shortens the field before acknowledgement", async () => {
    app.afterVerb = (a, v) => {
      if (v.kind !== "write" || v.key !== NAME) return;
      a.afterVerb = null;
      a.setValue(NAME, "Da");
      a.show();
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result.outcome).toBe("stopped");
    expect(helper.executor.ledger("t")[0]).not.toHaveProperty("unconfirmed");
    expect(helper.executor.ledger("t")[0]).not.toHaveProperty("partialWrite");
    const writes = app.verbs.filter((v) => v.kind === "write").length;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 0 });
    expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(writes);
    expect(app.node(NAME)?.value).toBe("Da");
  });

  it("keeps successful numeric-equivalence read-back out of partial recovery", async () => {
    app.nodes = app.nodes.map((node) => node.key === NAME ? { ...node, subrole: PAGE_SUBROLE.number } : node);
    app.normalize = () => "1";
    await helper.executor.run("t", { ...plan, steps: [write(NAME, "1.00")] }, {}, undefined, { grant: true });
    expect(helper.executor.ledger("t")[0]).not.toHaveProperty("unconfirmed");
    expect(helper.executor.ledger("t")[0]).not.toHaveProperty("partialWrite");
    app.normalize = null;
    app.setValue(NAME, "1.000");
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(app.node(NAME)?.value ?? "").toBe("");
  });

  it("never treats a pre-write refusal containing axError text as a partial write", async () => {
    app.setValue(NAME, "Original name");
    app.beforeVerb = (a, v) => {
      if (v.kind !== "write") return;
      a.beforeVerb = null;
      a.setValue(NAME, "axError");
    };
    const result = await helper.executor.run("t", { ...plan, steps: [write(NAME, "axErrorXYZ")] }, {}, undefined, { grant: true });
    expect(result.outcome).toBe("stopped");
    expect(helper.executor.ledger("t")).toEqual([]);
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 0 });
    expect(app.node(NAME)?.value).toBe("axError");
  });

  it("rechecks partial content at the restore dispatch rather than overwriting new typing", async () => {
    app.normalize = () => "Da";
    app.timeoutAfterWrite = true;
    await helper.executor.run("t", plan, {}, undefined, { grant: true });
    app.normalize = null;
    app.timeoutAfterWrite = false;
    const typing = "Danas" + "y".repeat(120);
    app.beforeVerb = (a, v) => {
      if (v.kind !== "write" || v.sameAs === undefined) return;
      a.beforeVerb = null;
      expect(v.expect).toBe("Da");
      a.setValue(NAME, typing);
    };
    const undo = await helper.executor.undo("t");
    expect(undo).toMatchObject({ restored: 0 });
    expect(undo.notRestored[0]?.reason).toContain(JSON.stringify(typing));
    expect(undo.notRestored[0]?.reason).toContain('before the write it held ""');
    expect(app.node(NAME)?.value).toBe(typing);
  });

  it("undo never changes unrecognized content over an exhaustive small-string domain", async () => {
    const strings = ["", " ", "\n", "\"", "😀", "Da", "Danas"];
    const generate = (prefix: string, depth: number): void => {
      strings.push(prefix);
      if (depth > 0) for (const character of ["a", "b", "c"]) generate(prefix + character, depth - 1);
    };
    generate("", 3);
    let cases = 0;
    for (const [original, intended] of [["c", "ab"], ["a", "abc"], ["", "Dana"]] as const) {
      for (const held of new Set(strings)) {
        if (held === original || held === intended || (held.length > 0 && held.length < intended.length && intended.startsWith(held))) continue;
        const taskId = `property-${cases++}`;
        app.setValue(NAME, original);
        app.normalize = () => held;
        app.timeoutAfterWrite = true;
        await helper.executor.run(taskId, { ...plan, steps: [write(NAME, intended)] }, {}, undefined, { grant: true });
        app.normalize = null;
        app.timeoutAfterWrite = false;
        const writes = app.verbs.filter((v) => v.kind === "write").length;
        const undo = await helper.executor.undo(taskId);
        expect(undo.restored, JSON.stringify({ original, intended, held })).toBe(0);
        expect(app.verbs.filter((v) => v.kind === "write")).toHaveLength(writes);
        expect(app.node(NAME)?.value ?? "").toBe(held);
      }
    }
    expect(cases).toBeGreaterThan(100);
  });

  it("a dispatched write with a lost acknowledgement remains undoable, not falsely verified", async () => {
    app.timeoutAfterWrite = true;
    app.afterVerb = (a, v) => {
      if (v.kind !== "write" || v.key !== NAME) return;
      a.afterVerb = null;
      helper.executor.stop("t");
    };
    const result = await helper.executor.run("t", plan, {}, undefined, { grant: true });
    expect(result.outcome).toBe("stopped");
    expect(app.node(NAME)?.value).toBe("Dana");
    expect(app.node(EMAIL)?.value).toBe("old@example.com");
    expect(helper.executor.ledger("t")).toMatchObject([{ kind: "write", key: NAME, before: "", after: "Dana", unconfirmed: true }]);
    expect(helper.executor.ledger("t")).toHaveLength(1);
    expect(published.some((m) => m.type === "taskProgress" && m.taskId === "t" && m.phase === "verified")).toBe(false);
    app.timeoutAfterWrite = false;
    expect(await helper.executor.undo("t")).toMatchObject({ restored: 1, notRestored: [] });
    expect(app.node(NAME)?.value ?? "").toBe("");
    expect(app.node(EMAIL)?.value).toBe("old@example.com");
  });
});
