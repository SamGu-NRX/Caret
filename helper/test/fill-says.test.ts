// A fill that fails says why in a plain sentence, with no window or field id (B27; B26 lead decision 3). What the
// check found, ids and all, goes to the log.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { FillError, type FillErrorWhy } from "../src/fill/fill.ts";
import { fillSays, SAYS } from "../src/planner/says.ts";
import { PROTOCOL_VERSION, type HelperMessage } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";

const FORM = "5150-77";
const EMAIL = "dev.caret.fixture/standard/textfield:email~0";

describe("what a failed fill says", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("publishes a sentence with no id when nothing on screen can fill the form, and logs the check's text", async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-fill-says-"));
    const store = new Store(dir);
    const sent: HelperMessage[] = [];
    const warned: string[] = [];
    const helper = new Helper({ store, askJev: jevPickingText(() => null), shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), warn: (m) => warned.push(m) });
    await helper.handleReader(snap([field(EMAIL, "", { label: "Email", frame: [100, 40, 200, 24] })], { at: Date.now(), windowId: FORM, title: "Claim form", focused: true }));
    await helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId: FORM, fieldKey: EMAIL });
    const errors = sent.flatMap((m) => (m.type === "error" ? [m.message] : []));
    expect(errors).toEqual([SAYS.fillNothing]);
    expect(errors[0]).not.toContain(FORM);
    expect(warned.some((w) => w.startsWith("fill: no candidate values") && w.includes(FORM))).toBe(true);
    helper.memory.close();
    store.close();
  });

  it.each([
    ["an unknown window", "9191-33", EMAIL, SAYS.windowClosed],
    ["a field the window lacks", FORM, "dev.caret.fixture/standard/textfield:absent~0", SAYS.notEditable],
  ])("publishes a sentence with no id for %s, and logs the ids (B27 second review)", async (_, windowId, fieldKey, says) => {
    dir = mkdtempSync(join(tmpdir(), "caret-fill-says-"));
    const store = new Store(dir);
    const sent: HelperMessage[] = [];
    const warned: string[] = [];
    const helper = new Helper({ store, askJev: jevPickingText(() => null), shadow: false, allowBackgroundFocus: false, publish: (m) => sent.push(m), warn: (m) => warned.push(m) });
    await helper.handleReader(snap([field(EMAIL, "", { label: "Email", frame: [100, 40, 200, 24] })], { at: Date.now(), windowId: FORM, title: "Claim form", focused: true }));
    await helper.handleConsumer({ type: "fillRequest", v: PROTOCOL_VERSION, windowId, fieldKey });
    const errors = sent.flatMap((m) => (m.type === "error" ? [m.message] : []));
    expect(errors).toEqual([says]);
    expect(errors[0]).not.toContain(windowId);
    expect(warned.some((w) => w.startsWith("fill: ") && (w.includes(windowId) || w.includes(fieldKey)))).toBe(true);
    helper.memory.close();
    store.close();
  });

  it.each<[FillErrorWhy | null, string]>([
    ["noWindow", SAYS.windowClosed],
    ["noField", SAYS.notEditable],
    ["instructionTooLong", SAYS.privacy],
    ["labelTooLong", SAYS.fillLabelTooLong],
    ["nothingToCopy", SAYS.fillNothing],
    ["badAnswer", SAYS.fillFailed],
    [null, SAYS.fillFailed],
  ])("says %s as a sentence", (why, says) => {
    expect(fillSays(why)).toBe(says);
    expect(says).toMatch(/^[A-Z].*\.$/u);
    expect(says).not.toMatch(/\d{3,}|[a-z]+\.[a-z]+\//u);
  });

  it("keeps the check's text, with its ids, in the error's message", () => {
    const e = new FillError("nothingToCopy", `no candidate values in any window other than ${FORM}`);
    expect(e.why).toBe("nothingToCopy");
    expect(e.message).toContain(FORM);
  });
});
