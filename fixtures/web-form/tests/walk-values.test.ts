// A text control's value never leaves the page (counsel 2026-10-09): the real content script walks real pages in
// headless Chrome for Testing, with the built extension loaded, and no text control in any walk carries a value, nor
// does the walk hold any text typed into a field, the focused field's caret text (the one exception) aside. Then PR #14's
// review-round-4 cases, each a page built here: a password whose copy the page makes, hides or swaps in, a reveal in a
// shadow root, slotted one-time-code digits. The walk is the one the worker forwards to the helper: it asks each frame
// with the same message (worker.ts walkTab), here sent from the worker's own context. No helper, bridge or model runs.
// Builds extension/ (or CARET_EXTENSION_DIR, another checkout's extension/, to compare) into its dist/. Every value is
// invented.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { FixtureSite } from "../server.ts";
import { TASK_PAGES } from "../tasks/site.ts";
import { launchHeadless, type Headless, type Tab } from "../tasks/chrome.ts";

const EXT = process.env.CARET_EXTENSION_DIR ?? fileURLToPath(new URL("../../../extension/", import.meta.url));
const DIST = `${EXT}dist`;
const TEXT_KINDS = new Set(["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea", "combobox", "contenteditable"]);
const MARK = "Zebra-Quill-4417";
const SECRET = "Tr0mbone-Lattice-91";
const CODE = "482913";

interface Report {
  controls: { kind: string; name: string; value?: unknown; hasValue?: unknown; rev?: unknown; withheld?: string; excluded?: string }[];
  focused: { id: string; text: unknown; withheld?: string } | null;
}

let site: FixtureSite;
let rounds: Server;
let roundsOrigin = "";
let browser: Headless;
let worker: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Evaluates `expression` in the extension's service worker. */
async function inWorker<T>(expression: string): Promise<T> {
  const r = (await browser.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, worker)) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  if (r.exceptionDetails !== undefined) throw new Error(`worker threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** The content script's walk of the tab at `url`, every frame, as the worker asks for it. */
async function walk(url: string): Promise<Report[]> {
  return inWorker<Report[]>(`(async () => {
    const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(`${url.split("?")[0]}*`)} });
    if (tab === undefined) throw new Error("no tab at ${url}");
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const out = [];
    for (const f of frames) out.push(await chrome.tabs.sendMessage(tab.id, { caret: 1, op: "walk" }, { frameId: f.frameId }).catch(() => null));
    return out.filter((r) => r !== null);
  })()`);
}

/**
 * What a walk must never hold: a text control's value, or the given text anywhere outside the focused caret text.
 * Returns how many text controls the walk had, so a test can tell a vacuous walk from a clean one.
 */
function assertNoValues(reports: Report[], typed: readonly string[], where: string): number {
  assert.ok(reports.length > 0, `${where}: no frame answered`);
  let texts = 0;
  for (const r of reports) {
    for (const c of r.controls) {
      if (!TEXT_KINDS.has(c.kind)) continue;
      texts++;
      assert.ok(!("value" in c), `${where}: the ${c.kind} '${c.name}' carries a value`);
      assert.ok("hasValue" in c && "rev" in c, `${where}: the ${c.kind} '${c.name}' has no hasValue or rev`);
    }
    const { focused, ...rest } = r;
    const json = JSON.stringify({ ...rest, focused: focused === null ? null : { ...focused, text: null } });
    for (const t of typed) assert.ok(!json.includes(t), `${where}: the walk holds ${JSON.stringify(t)}`);
  }
  return texts;
}

/** Opens `url`, waits for the content script to answer, and returns the tab. */
async function open(url: string): Promise<Tab> {
  const tab = await browser.open(url);
  for (let i = 0; i < 40; i++) {
    if ((await walk(url).catch(() => [])).length > 0) return tab;
    await sleep(100);
  }
  throw new Error(`the content script never answered at ${url}`);
}

/** Types into the element `selector` finds as the user would: a trusted click, then trusted text. */
async function typeInto(tab: Tab, selector: string, text: string): Promise<void> {
  await tab.click(selector);
  await tab.type(text);
}

before(async () => {
  execFileSync(process.execPath, [`${EXT}build.mjs`], { stdio: "ignore" });
  site = new FixtureSite();
  await site.start();
  rounds = createServer((req, res) => {
    const page = ROUND4[(req.url ?? "/").slice(1).split("?")[0] ?? ""];
    res.writeHead(page === undefined ? 404 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page ?? "");
  });
  await new Promise<void>((r) => rounds.listen(0, "127.0.0.1", () => r()));
  roundsOrigin = `http://127.0.0.1:${(rounds.address() as AddressInfo).port}`;
  browser = await launchHeadless([`--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`, "--disable-features=DisableLoadExtensionCommandLineSwitch"]);
  for (let i = 0; i < 50 && worker === undefined; i++) {
    const { targetInfos } = (await browser.cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const t = targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
    if (t !== undefined) worker = ((await browser.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })) as { sessionId: string }).sessionId;
    else await sleep(100);
  }
  assert.ok(worker !== undefined, "the extension's worker never started");
  // The target can be attached before the extension's bindings exist in it.
  for (let i = 0; i < 100 && !(await inWorker<boolean>("typeof chrome === 'object' && typeof chrome.runtime?.id === 'string'").catch(() => false)); i++) await sleep(50);
  // No bridge runs: the worker's next reconnect gets a port this test holds, so the test speaks for the helper.
  await inWorker(`(() => {
    globalThis.__sent = [];
    chrome.runtime.connectNative = () => ({
      onMessage: { addListener: (f) => { globalThis.__inject = f; } },
      onDisconnect: { addListener: () => {} },
      postMessage: (m) => { globalThis.__sent.push(m); },
      disconnect: () => {},
    });
    return true;
  })()`);
});

after(async () => {
  await browser?.stop();
  await site?.stop();
  await new Promise<void>((r) => (rounds === undefined ? r() : rounds.close(() => r())));
});

describe("every fixture page's walk", () => {
  const pages = ["/form", "/mixed", "/number", "/support", "/holds", ...TASK_PAGES.map((p) => `${p.path}?show=all`)];
  for (const path of pages) {
    test(`${path}: no text control carries a value, typed by the user or set by the page`, async () => {
      const url = `${site.mainOrigin}${path}`;
      const tab = await open(url);
      // The user types into the first visible text field; then the page's own script fills every other one.
      const first = await tab.evaluate<string | null>(`(() => {
        const e = [...document.querySelectorAll("input[type=text], input:not([type]), textarea")].find((x) => x.offsetParent !== null);
        if (!e) return null;
        e.id ||= "caret-walk-first";
        return e.id;
      })()`);
      if (first !== null) await typeInto(tab, `document.getElementById(${JSON.stringify(first)})`, "typed by hand");
      const n = await tab.evaluate<number>(`(() => {
        const fields = [...document.querySelectorAll("input, textarea")].filter((e) => e !== document.activeElement && !["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color", "hidden"].includes(e.type ?? ""));
        for (const f of fields) { f.value = ${JSON.stringify(MARK)}; f.dispatchEvent(new Event("input", { bubbles: true })); }
        return fields.length;
      })()`);
      const texts = assertNoValues(await walk(url), [MARK, "typed by hand"], `${path} (${n} fields filled)`);
      // The walk saw the fields it was given: a page with text fields walks some of them.
      assert.ok(n === 0 || texts > 0, `${path}: ${n} fields filled, none walked`);
      await tab.close();
    });
  }
});

/** Sends the worker a helper message through the port this test holds, and waits for the pageResult of `id`, if any. */
async function helperSays(m: Record<string, unknown>, id?: string): Promise<Record<string, unknown> | null> {
  for (let i = 0; i < 400 && !(await inWorker<boolean>("typeof globalThis.__inject === 'function'")); i++) await sleep(250);
  await inWorker(`(globalThis.__inject(${JSON.stringify({ v: 1, ...m })}), true)`);
  if (id === undefined) return null;
  for (let i = 0; i < 100; i++) {
    const r = await inWorker<Record<string, unknown> | null>(`globalThis.__sent.find((x) => x.type === "pageResult" && x.id === ${JSON.stringify(id)}) ?? null`);
    if (r !== null) return r;
    await sleep(100);
  }
  throw new Error(`no pageResult for ${id}`);
}

describe("the page's own writes, restores and compares, end to end, and no copy", () => {
  let n = 0;
  const command = async (verb: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const id = `c${++n}`;
    try {
      return (await helperSays({ type: "pageCommand", id, expires: Date.now() + 8000, verb }, id)) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`${String(verb.kind)} ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  test("writes by rev, answers in booleans, restores the text it kept, compares whole values, and never answers with withheld text", async () => {
    const url = `${site.mainOrigin}/mixed`;
    const tab = await open(url);
    await helperSays({ type: "engineReady", engine: "e-walk" });
    const tabId = await inWorker<number>(`chrome.tabs.query({ url: ${JSON.stringify(`${url}*`)} }).then(([t]) => t.id)`);
    const walked = async (): Promise<{ frames: { frameId: number; documentId: string; origin: string; navGen: number; controls: Report["controls"] & { id: string }[] }[] }> => {
      const id = `w${++n}`;
      await helperSays({ type: "pageCommand", id, expires: Date.now() + 8000, verb: { kind: "pageWalk", tabId } }, id);
      return inWorker(`globalThis.__sent.findLast((x) => x.type === "pageSnapshot")`);
    };
    let s = await walked();
    const top = s.frames[0] as (typeof s.frames)[number];
    // From the latest walk, which `s` holds.
    const field = (name: string) => (s.frames[0] as typeof top).controls.find((c) => c.name === name) as { id: string; kind: string; name: string; rev: number; hasValue: boolean };
    await helperSays({ type: "scopedActGrant", taskId: "t1", at: Date.now(), expires: Date.now() + 60_000, scope: { kind: "page", engine: "e-walk", tabId, frameId: top.frameId, origin: top.origin, navGen: top.navGen } });
    const name = field("Full name");
    const target = { tabId, frameId: top.frameId, documentId: top.documentId, id: name.id, control: name.kind, name: name.name, taskId: "t1" };
    const read = () => tab.evaluate<string>(`[...document.querySelectorAll("input")].find((e) => e.labels?.[0]?.textContent?.includes("Full name"))?.value ?? null`);

    const wrote = await command({ kind: "pageWrite", ...target, expectRev: name.rev, value: "Robin Vale" });
    assert.equal(wrote.outcome, "ok", JSON.stringify(wrote));
    assert.deepEqual({ ...(wrote.readings as object), rev: 0 }, { sameAsBefore: false, landed: true, equivalent: true, empty: false, typedBetween: false, rev: 0 });
    assert.equal(await read(), "Robin Vale");
    assert.ok(!JSON.stringify(wrote).includes("Robin Vale"), "the answer holds the field's text");
    // The walk's rev, now old, makes another write stale.
    assert.equal((await command({ kind: "pageWrite", ...target, expectRev: name.rev, value: "Someone" })).outcome, "stale");
    assert.deepEqual((await command({ kind: "pageCompare", ...target, candidates: ["Robin Vale", "Robin", "Someone Else"] })).compare, ["equal", "different", "different"]);
    s = await walked();
    assert.equal(field("Full name").hasValue, true);
    assert.equal(field("Full name").rev, (wrote.readings as { rev: number }).rev);
    // No verb copies a field's text out (audit HIGH 2): the content script itself refuses the counsel's copy verb by
    // name, even under a live grant and sent straight to the frame, past the worker that drops it.
    const copy = await inWorker<Record<string, unknown>>(`chrome.tabs.sendMessage(${tabId}, { caret: 1, op: "act", deadline: Date.now() + 5000, guardUntil: Date.now() + 5000, verb: ${JSON.stringify({ kind: "pageSourceGrant", tabId, frameId: top.frameId, documentId: top.documentId, taskId: "t1", ids: [name.id] })} }, { frameId: ${top.frameId} })`);
    assert.equal(copy.outcome, "unsupported", JSON.stringify(copy));
    assert.ok(!("source" in copy) && !JSON.stringify(copy).includes("Robin Vale"), "the content script answered the copy verb with text");
    const restored = await command({ kind: "pageRestore", ...target, wrote: "Robin Vale" });
    assert.equal(restored.outcome, "ok", JSON.stringify(restored));
    assert.equal((restored.restore as { outcome: string }).outcome, "restored");
    assert.equal(await read(), "");

    // Written again, then the user types in it: the page refuses to restore over their input.
    s = await walked();
    const again = await command({ kind: "pageWrite", ...target, expectRev: field("Full name").rev, value: "Robin Vale" });
    assert.equal(again.outcome, "ok", JSON.stringify(again));
    await tab.click(`[...document.querySelectorAll("input")].find((e) => e.labels?.[0]?.textContent?.includes("Full name"))`).catch((e: unknown) => { throw new Error(`click: ${String(e)}`); });
    await tab.evaluate(`(() => { const e = document.activeElement; e.setSelectionRange(e.value.length, e.value.length); return true; })()`).catch((e: unknown) => { throw new Error(`caret to end: ${String(e)}`); });
    await tab.type("!").catch((e: unknown) => { throw new Error(`type: ${String(e)}`); });
    // The user's click ended the frame's grants (W3); the undo comes under a new one, as the helper grants it.
    await helperSays({ type: "scopedActGrant", taskId: "t1", at: Date.now(), expires: Date.now() + 60_000, scope: { kind: "page", engine: "e-walk", tabId, frameId: top.frameId, origin: top.origin, navGen: top.navGen } });
    const refused = await command({ kind: "pageRestore", ...target, wrote: "Robin Vale" });
    assert.deepEqual(refused.restore, { outcome: "refused", why: "mayIncludeInput" });
    assert.equal(await read(), "Robin Vale!");
    // Nor does the page write over it, whatever rev it is named by: the field holds the user's text now, not Caret's.
    s = await walked();
    const over = await command({ kind: "pageWrite", ...target, expectRev: field("Full name").rev ?? 0, value: "Someone Else" });
    assert.equal(over.outcome, "stale", JSON.stringify(over));
    assert.equal(await read(), "Robin Vale!");

    // The page's own script puts text in another field: withheld, so no copy, no compare and no write over it.
    await tab.evaluate(`(() => { const e = [...document.querySelectorAll("input")].find((x) => x.labels?.[0]?.textContent?.includes("Email")); e.value = "set-by-page@example.test"; return true; })()`);
    s = await walked();
    const email = field("Email") as ReturnType<typeof field> & { withheld?: string };
    assert.equal(email.withheld, "programmatic");
    assert.equal(email.hasValue, null);
    const emailTarget = { ...target, id: email.id, control: email.kind, name: email.name };
    assert.deepEqual((await command({ kind: "pageCompare", ...emailTarget, candidates: ["set-by-page@example.test"] })).compare, ["unknown"]);
    assert.equal((await command({ kind: "pageWrite", ...emailTarget, expectRev: 0, value: "robin@example.test" })).outcome, "excluded");
    // Nor an insert at the caret of a text field the page's script filled, which would confirm a guess of its text by
    // the insert's check of the text before the caret (audit MED 5): refused before that check.
    await tab.evaluate(`(() => { document.getElementById("m_name").value = "Dana from the page"; return true; })()`);
    s = await walked();
    const named = field("Full name") as ReturnType<typeof field> & { withheld?: string };
    assert.equal(named.withheld, "programmatic");
    await tab.click(`document.getElementById("m_name")`);
    await tab.evaluate(`(() => { const e = document.getElementById("m_name"); e.setSelectionRange(e.value.length, e.value.length); return true; })()`);
    await helperSays({ type: "scopedActGrant", taskId: "t1", at: Date.now(), expires: Date.now() + 60_000, scope: { kind: "page", engine: "e-walk", tabId, frameId: top.frameId, origin: top.origin, navGen: top.navGen } });
    const inserted = await command({ kind: "pageInsertText", ...target, id: named.id, expect: "Dana from the page", text: "x" });
    assert.equal(inserted.outcome, "excluded", JSON.stringify(inserted));
    assert.equal(await tab.evaluate<string>(`document.getElementById("m_name").value`), "Dana from the page");
    const sent = await inWorker<string>("JSON.stringify(globalThis.__sent)");
    assert.ok(!sent.includes("set-by-page@example.test"), "the worker sent the page's own text");
    await tab.close();
  });
});

/** The six round-4 cases of PR #14, each a page whose script does what the review found, after the user typed a secret. */
const shell = (body: string, script: string): string => `<!doctype html><meta charset="utf-8"><title>Round 4</title><form id="f">${body}</form><script>${script}</script>`;
const ROUND4: Record<string, string> = {
  // #1: the page detaches a wrapper holding the password, clears it, and adds an anonymous text copy in one task.
  "removal-root": shell(`<div id="wrap"><label>Password <input type="password" id="pw" name="pw"></label></div>`, `window.reveal = () => { const w = document.getElementById("wrap"); const v = document.getElementById("pw").value; w.remove(); w.innerHTML = ""; const c = document.createElement("input"); c.type = "text"; c.id = "copy"; c.value = v; document.getElementById("f").append(c); };`),
  // #2: the replacement is added as type=hidden holding the password, then turned into a text input.
  "hidden-then-text": shell(`<label>Password <input type="password" id="pw" name="pw"></label>`, `window.reveal = () => { const p = document.getElementById("pw"); const c = document.createElement("input"); c.type = "hidden"; c.id = "copy"; c.value = p.value; p.replaceWith(c); setTimeout(() => { c.type = "text"; }, 50); };`),
  // #3: the copy comes 2,101 ms after the removal, past the replacement window.
  "late-copy": shell(`<label>Password <input type="password" id="pw" name="pw"></label>`, `window.reveal = () => { const p = document.getElementById("pw"); const v = p.value; p.remove(); setTimeout(() => { const c = document.createElement("input"); c.type = "text"; c.id = "copy"; c.value = v; document.getElementById("f").append(c); }, 2101); };`),
  // #4: a password in a shadow root, revealed as type=number.
  "number-in-shadow": shell(`<pin-box id="host"></pin-box>`, `const r = document.getElementById("host").attachShadow({ mode: "open" }); r.innerHTML = '<label>PIN <input type="password" id="pw"></label>'; window.reveal = () => { r.getElementById("pw").type = "number"; };`),
  // #5: one-time-code digit boxes slotted into a shadow textbox named "Verification code".
  "slotted-otp": shell(`<otp-box id="host"><input id="d1" aria-label="Digit 1" maxlength="1"><input id="d2" aria-label="Digit 2" maxlength="1"><input id="d3" aria-label="Digit 3" maxlength="1"></otp-box>`, `document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<div role="textbox" aria-label="Verification code"><slot></slot></div>'; window.reveal = () => {};`),
  // The label rule: an editor named by its own id would be named by its draft.
  "self-labelled-editor": shell(`<div contenteditable="true" id="ed" aria-labelledby="ed" style="min-height: 2em"></div><input id="other" aria-labelledby="ed">`, `window.reveal = () => {};`),
  // Audit HIGH 1: a title the user types into an editable heading, an editable role=heading and an editable legend.
  "editable-headings": shell(`<h1 contenteditable="true" id="title" style="min-height: 1em"></h1><div role="heading" aria-level="2" contenteditable="true" id="sub" style="min-height: 1em"></div><fieldset><legend contenteditable="true" id="leg" style="min-width: 4em; min-height: 1em"></legend><input id="n" aria-label="Name"></fieldset>`, `window.reveal = () => {};`),
  // Audit MED 3: an address form Chrome's own autofill fills, recording the events it fires.
  autofill: shell(`<label>Email <input id="email" name="email" autocomplete="email"></label><label>Street <input id="street" name="street" autocomplete="address-line1"></label><label>City <input id="city" name="city" autocomplete="address-level2"></label><label>ZIP <input id="zip" name="zip" autocomplete="postal-code"></label>`, `window.events = []; for (const t of ["beforeinput", "input", "change"]) addEventListener(t, (e) => { window.events.push({ type: e.type, trusted: e.isTrusted, inputType: e.inputType ?? null }); }, true); window.reveal = () => {};`),
  // Audit MED 4: two fields to type into, on a page of its own, so no closing tab of another test answers its walk.
  typing: shell(`<label>Note <input id="note" name="note" autocomplete="off"></label><label>Other note <input id="other" name="other" autocomplete="off"></label><label>Last <input id="last" name="last" autocomplete="off"></label>`, `window.reveal = () => {};`),
  // #6: a "show password" in a shadow root turns the field into a text input the user then types into.
  "text-in-shadow": shell(`<login-box id="host"></login-box>`, `const r = document.getElementById("host").attachShadow({ mode: "open" }); r.innerHTML = '<label>Password <input type="password" id="pw"></label>'; window.reveal = () => { r.getElementById("pw").type = "text"; };`),
};

describe("names never read from an editable element (the counsel's label rule)", () => {
  test("an editor, and another field, named by the editor's own id carry none of the draft", async () => {
    const url = `${roundsOrigin}/self-labelled-editor`;
    const tab = await open(url);
    await typeInto(tab, `document.getElementById("ed")`, "Dear Maya, my locker code is 7130");
    await tab.click(`document.getElementById("other")`);
    const reports = await walk(url);
    assertNoValues(reports, ["Dear Maya", "locker code"], "self-labelled-editor");
    await tab.close();
  });
});

describe("an editable heading's text is the user's draft, not the page's outline", () => {
  test("a typed h1, role=heading and legend reach no heading list, section text or section digest", async () => {
    const url = `${roundsOrigin}/editable-headings`;
    const tab = await open(url);
    await typeInto(tab, `document.getElementById("title")`, "Plan for Maya's surprise");
    await typeInto(tab, `document.getElementById("sub")`, "Budget kept from Ravi");
    await typeInto(tab, `document.getElementById("leg")`, "Locker 7130 notes");
    await tab.click(`document.getElementById("n")`);
    const reports = await walk(url) as (Report & { headings: string[]; sections?: { text?: string; digest?: string }[]; sectionOverflow?: string[] })[];
    assertNoValues(reports, ["Maya", "Ravi", "7130"], "editable-headings");
    for (const r of reports) {
      assert.deepEqual(r.headings, [], "an editable heading's text reached the heading list");
      // The page has no other heading or legend, so any section digest would be one of the typed titles, unsalted.
      for (const o of r.sections ?? []) assert.ok(o.text === undefined && o.digest === undefined, `a section carries ${JSON.stringify(o)}`);
      assert.equal(r.sectionOverflow, undefined);
    }
    await tab.close();
  });
});

describe("browser autofill and the user's typing (audit MED 3, MED 4)", () => {
  test("Chrome's autofill fires trusted input and change events with no inputType, and the fields it filled are withheld", async () => {
    const url = `${roundsOrigin}/autofill`;
    const tab = await open(url);
    const { root } = (await tab.send("DOM.getDocument", { depth: -1 })) as { root: { nodeId: number } };
    const { nodeId } = (await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#email" })) as { nodeId: number };
    const { node } = (await tab.send("DOM.describeNode", { nodeId })) as { node: { backendNodeId: number } };
    const fields = [{ name: "EMAIL_ADDRESS", value: "robin@example.test" }, { name: "ADDRESS_HOME_LINE1", value: "1 Synthetic Way" }, { name: "ADDRESS_HOME_CITY", value: "Testville" }, { name: "ADDRESS_HOME_ZIP", value: "00000" }];
    await tab.send("Autofill.trigger", { fieldId: node.backendNodeId, address: { fields } });
    let events: { type: string; trusted: boolean; inputType: string | null }[] = [];
    for (let i = 0; i < 40 && events.filter((e) => e.type === "change").length < 4; i++) {
      await sleep(50);
      events = await tab.evaluate("window.events");
    }
    // What this settles: autofill's events are trusted, come with no beforeinput, and carry no inputType. So a
    // trusted event alone cannot make a field's text the user's typing.
    assert.ok(events.length >= 8, `autofill fired ${JSON.stringify(events)}`);
    assert.ok(events.every((e) => e.trusted && e.type !== "beforeinput" && e.inputType === null), `autofill fired ${JSON.stringify(events)}`);
    const reports = await walk(url);
    assertNoValues(reports, fields.filter((f) => f.value.length >= 3).map((f) => f.value), "autofill");
    for (const label of ["Email", "Street", "City", "ZIP"]) {
      const c = reports.flatMap((r) => r.controls).find((x) => x.name === label);
      assert.ok(c !== undefined, `no ${label} field walked`);
      // Prefilled when first read after the fill; programmatic when read empty first (this test's open() walks).
      assert.ok(c.excluded !== undefined || ((c.withheld === "prefilled" || c.withheld === "programmatic") && c.hasValue === null && c.rev === null), `the autofilled ${label} reads ${JSON.stringify(c)}`);
    }
    await tab.close();
  });

  test("a field's rev moves as much for eight typed characters as for one", async () => {
    const url = `${roundsOrigin}/typing`;
    const tab = await open(url);
    const revOf = async (name: string): Promise<number> => {
      const c = (await walk(url)).flatMap((r) => r.controls).find((x) => x.name === name);
      assert.ok(c !== undefined && typeof c.rev === "number", `${name} reads ${JSON.stringify(c)}`);
      return c.rev;
    };
    const note0 = await revOf("Note");
    const other0 = await revOf("Other note");
    await tab.click(`document.getElementById("note")`);
    await tab.type("x");
    await tab.click(`document.getElementById("other")`);
    for (const ch of "Quarters") await tab.type(ch);
    await tab.click(`document.getElementById("last")`);
    const typed = await tab.evaluate<string[]>(`[document.getElementById("note").value, document.getElementById("other").value]`);
    assert.deepEqual(typed, ["x", "Quarters"]);
    assert.equal((await revOf("Note")) - note0, 1);
    assert.equal((await revOf("Other note")) - other0, 1);
    // Typed, so the user's own: not withheld.
    const other = (await walk(url)).flatMap((r) => r.controls).find((x) => x.name === "Other note");
    assert.ok(other?.hasValue === true && other.withheld === undefined, `the typed field reads ${JSON.stringify(other)}`);
    await tab.close();
  });
});

describe("PR #14's review-round-4 cases: the walk holds none of the secret", () => {
  const cases: { page: string; typeAt: string; secret: string; focus: string; wait?: number }[] = [
    { page: "removal-root", typeAt: `document.getElementById("pw")`, secret: SECRET, focus: `document.getElementById("copy")` },
    { page: "hidden-then-text", typeAt: `document.getElementById("pw")`, secret: SECRET, focus: `document.getElementById("copy")`, wait: 200 },
    { page: "late-copy", typeAt: `document.getElementById("pw")`, secret: SECRET, focus: `document.getElementById("copy")`, wait: 2400 },
    { page: "number-in-shadow", typeAt: `document.getElementById("host").shadowRoot.getElementById("pw")`, secret: CODE, focus: `document.getElementById("host").shadowRoot.getElementById("pw")` },
    { page: "slotted-otp", typeAt: `document.getElementById("d1")`, secret: "4", focus: `document.getElementById("d1")` },
    { page: "text-in-shadow", typeAt: `document.getElementById("host").shadowRoot.getElementById("pw")`, secret: SECRET, focus: `document.getElementById("host").shadowRoot.getElementById("pw")` },
  ];
  for (const k of cases) {
    test(`${k.page}: no value, no caret text, and the field withheld once it holds the secret`, async () => {
      const url = `${roundsOrigin}/${k.page}`;
      const tab = await open(url);
      await typeInto(tab, k.typeAt, k.secret);
      await tab.evaluate("window.reveal()");
      await sleep(k.wait ?? 100);
      // The user goes to the field that now shows the secret, and types one more character into it.
      await tab.click(k.focus);
      await tab.type("x");
      const reports = await walk(url);
      // A secret shorter than three characters (one digit) is checked by the field, not by searching the text.
      assertNoValues(reports, k.secret.length >= 3 ? [k.secret, `${k.secret}x`] : [], k.page);
      const focused = reports.find((r) => r.focused !== null)?.focused ?? null;
      // The field the user is in is walked, and says only that its text is withheld.
      assert.ok(focused !== null, `${k.page}: the field the user is in was not walked`);
      assert.ok(focused.text === null && focused.withheld !== undefined, `${k.page}: the focused field's caret text was sent, or not marked withheld`);
      for (const c of reports.flatMap((r) => r.controls)) {
        if (!TEXT_KINDS.has(c.kind) || c.hasValue === false) continue;
        assert.ok(c.excluded !== undefined || c.withheld !== undefined, `${k.page}: the ${c.kind} '${c.name}' holds text and is not withheld`);
      }
      await tab.close();
    });
  }
});
