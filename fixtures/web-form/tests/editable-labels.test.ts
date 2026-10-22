// Issue #54, both halves, against the real content script in headless Chrome for Testing with the built extension
// loaded, no helper: this test speaks for it over the stubbed native port. Every value is invented.
//
// 1. A walk reads no name from an editable label, legend or aria-labelledby target. A page puts a typed legend over a
//    radio group, a typed label over an input and a typed role="Textbox" span behind an input's aria-labelledby;
//    whatever was typed must reach no control's name, no group's question and no section text or digest — the digest
//    check computes each typed string's SHA-256, since a refused section keeps its digest, not its words. A plain
//    legend and a plain label still name theirs, so the walk is not vacuous.
// 2. A combobox undo stands on the pick's page-side record (content/revs.ts ChoiceRecords): the undo runs only while
//    the control still shows what Caret picked and no trusted event has touched it, by any of the ways a person
//    reaches a combobox — the control, its label, its list and the container holding both. The person re-picking the
//    same option through any of those ways (the text unchanged) refuses the undo; no intervening input lets it restore.
// Builds extension/ into its dist/. Walks go straight to the content script; acts go helper-style through the worker,
// which checks the grant, the frame's document and its navigation generation before the page is touched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { launchHeadless, type Headless, type Tab } from "../tasks/chrome.ts";
import { sha256Hex } from "../../../extension/src/shared/sha256.ts";

const EXT = process.env.CARET_EXTENSION_DIR ?? fileURLToPath(new URL("../../../extension/", import.meta.url));
const DIST = `${EXT}dist`;

const PICK = "Bluebell State";
const TYPED_LEGEND = "Edgewater Flats";
const TYPED_LABEL = "Aunt Betty";
const TYPED_REF = "Renamed by hand";

const PAGES: Record<string, string> = {
  labels: `<!doctype html><html><head><meta charset="utf-8"><title>Editable names</title></head><body><form>
    <fieldset id="pick">
      <legend contenteditable="true" spellcheck="false">Riverbend Township</legend>
      <label><input type="radio" name="pref" value="yes">Yes</label>
      <label><input type="radio" name="pref" value="no">No</label>
    </fieldset>
    <fieldset>
      <legend>Household</legend>
      <label><input type="radio" name="size" value="one">One</label>
      <label><input type="radio" name="size" value="two">Two</label>
    </fieldset>
    <p><label for="member" contenteditable="true" spellcheck="false">Emergency contact</label>
       <input id="member" name="member"></p>
    <p><label for="home">Home address</label>
       <input id="home" name="home"></p>
    <p><input id="roleref" name="roleref" aria-labelledby="typedbox">
       <span id="typedbox" role="Textbox">Renamed by hand</span></p>
  </form></body></html>`,
  choice: `<!doctype html><html><head><meta charset="utf-8"><title>Choice anchor</title></head><body><form>
    <label for="school">School</label>
    <input id="school" name="school" role="combobox" aria-expanded="false" aria-autocomplete="list" aria-controls="school-list" autocomplete="off">
    <button type="button" id="school-chevron" aria-label="Open the school list">▾</button>
    <ul id="school-list" role="listbox" aria-label="Schools" hidden>
      <li role="option" id="opt-blue" aria-selected="false">Bluebell State</li>
      <li role="option" id="opt-red" aria-selected="false">Redwood College</li>
    </ul>
  </form><script>
    const input = document.getElementById("school");
    const list = document.getElementById("school-list");
    const options = [...list.querySelectorAll("[role=option]")];
    const show = () => { list.hidden = false; input.setAttribute("aria-expanded", "true"); };
    input.addEventListener("click", show);
    document.getElementById("school-chevron").addEventListener("click", show);
    input.addEventListener("input", () => {
      const q = input.value.toLowerCase();
      if (q === "") return; // an empty query shows nothing until the control itself is opened
      show();
      for (const o of options) o.hidden = !o.textContent.toLowerCase().includes(q);
    });
    for (const o of options) o.addEventListener("click", () => {
      input.value = o.textContent;
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
    });
  <\/script></body></html>`,
};

interface Row {
  id: string;
  kind: string;
  name: string;
  rev?: number;
  hasValue?: boolean;
  group?: { id: string; name: string };
}
interface Report {
  controls: Row[];
  focused: { id: string; text: unknown } | null;
}
interface Frame {
  tabId: number;
  frameId: number;
  documentId: string;
  origin: string;
  navGen: number;
}
interface Snap {
  tabId: number;
  frames: (Omit<Frame, "tabId"> & { controls: (Row & { id: string })[] })[];
}
/** The snapshot's top frame as an act's target: the tab id comes from the snapshot root, not the frame. */
const topOf = (s: Snap): Frame => ({ ...s.frames[0], tabId: s.tabId } as Frame);
interface ActResult {
  outcome: string;
  detail?: string | null;
}

let site: Server;
let origin = "";
let browser: Headless;
let worker: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let commands = 0;

/** Evaluates `expression` in the extension's service worker. */
async function inWorker<T>(expression: string): Promise<T> {
  const r = (await browser.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, worker)) as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
  if (r.exceptionDetails !== undefined) throw new Error(`worker threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** The content script's walk of the frame at `url`. */
async function walk(url: string): Promise<Report> {
  return inWorker<Report>(`(async () => {
    const [tab] = await chrome.tabs.query({ url: ${JSON.stringify(`${url.split("?")[0]}*`)} });
    if (tab === undefined) throw new Error("no tab at ${url}");
    return await chrome.tabs.sendMessage(tab.id, { caret: 1, op: "walk" }, { frameId: 0 });
  })()`);
}

/** Waits for the worker's next reconnect to the bridge port this test holds, so `__inject` speaks for the helper. */
async function helperWait(): Promise<void> {
  for (let i = 0; i < 400 && !(await inWorker<boolean>("typeof globalThis.__inject === 'function'").catch(() => false)); i++) await sleep(250);
}

/** Sends one helper message through the port this test holds. */
async function helperSays(m: Record<string, unknown>): Promise<void> {
  await helperWait();
  await inWorker(`(globalThis.__inject(${JSON.stringify({ v: 1, ...m })}), true)`);
}

/** The granted walk's snapshot: every frame's ids, navigation generation and controls, as the worker saw them. */
async function snapshot(tabId: number): Promise<Snap> {
  const id = `w-${++commands}`;
  await helperSays({ type: "engineReady", engine: "e-test" });
  await helperSays({ type: "pageCommand", id, expires: Date.now() + 120_000, verb: { kind: "pageWalk", tabId } });
  for (let i = 0; i < 200; i++) {
    const s = await inWorker<Snap | null>(`globalThis.__sent.findLast((x) => x.type === "pageSnapshot" && x.id === ${JSON.stringify(id)}) ?? null`);
    if (s !== null) return s;
    await sleep(50);
  }
  throw new Error("the worker never answered the walk");
}

/** Grants `taskId` the top frame the snapshot saw, as the helper grants every act's task. */
async function grant(taskId: string, s: Snap, tabId: number): Promise<void> {
  const top = s.frames[0];
  assert.ok(top !== undefined, "the walk saw no frames");
  await helperSays({
    type: "scopedActGrant", taskId, at: Date.now(), expires: Date.now() + 300_000,
    scope: { kind: "page", engine: "e-test", tabId, frameId: top.frameId, origin: top.origin, navGen: top.navGen },
  });
}

/** Sends one verb through the worker and waits for its pageResult. */
async function act(taskId: string, f: Frame, verb: Record<string, unknown>): Promise<ActResult> {
  const id = `cmd-${++commands}`;
  const before = (await inWorker<unknown[]>("globalThis.__sent")).filter((m) => (m as { type?: string }).type === "pageResult").length;
  await helperSays({ type: "pageCommand", id, expires: Date.now() + 120_000, verb: { ...verb, taskId, tabId: f.tabId, frameId: f.frameId, documentId: f.documentId } });
  for (let i = 0; i < 300; i++) {
    const r = await inWorker<ActResult | null>(`globalThis.__sent.filter((x) => x.type === "pageResult" && x.id === ${JSON.stringify(id)}).at(-1) ?? null`);
    if (r !== null) return r;
    await sleep(50);
  }
  throw new Error(`the worker never answered the command: sent=${JSON.stringify(await inWorker<unknown[]>("globalThis.__sent"))} logs=${JSON.stringify((browser.cdp.events.filter((e) => e.method === "Runtime.consoleAPICalled").map((e) => (e.params.args as { value?: unknown }[] | undefined)?.map((a) => String(a.value ?? "")).join(" ")) ?? []).slice(-12))}`);
}

/** Opens `page`, waits for the content script to answer, and returns the tab. */
async function open(page: string): Promise<Tab> {
  const url = `${origin}/${page.replace(/^\/+/, "")}`;
  const tab = await browser.open(url);
  for (let i = 0; i < 40; i++) {
    if ((await walk(url).catch(() => null)) !== null) return tab;
    await sleep(100);
  }
  throw new Error(`the content script never answered at ${url}`);
}

/** Types into the element `selector` finds as the user would: a trusted click, then trusted text. */
async function typeInto(tab: Tab, selector: string, text: string): Promise<void> {
  await tab.click(selector);
  await tab.type(text);
}

/** The walk holds none of `typed` anywhere the walk reports, the focused field's own caret text aside — by the words
 * and by their SHA-256 (shared/sha256.ts), since a refused section leaves its digest in place of its name, and a
 * digest never contains its input. */
function assertWithoutTyped(report: Report, typed: string[], where: string): void {
  const { focused, ...rest } = report;
  const json = JSON.stringify({ ...rest, focused: focused === null ? null : { ...focused, text: null } });
  for (const t of typed) {
    assert.ok(!json.includes(t), `${where}: the walk holds ${JSON.stringify(t)}`);
    const digest = sha256Hex(t);
    assert.ok(!json.includes(digest), `${where}: the walk holds the digest of ${JSON.stringify(t)} (${digest})`);
  }
}

async function pick(taskId: string, s: Snap, row: Row & { id: string }, mark: string): Promise<ActResult> {
  return act(taskId, topOf(s), { kind: "pageChooseOption", id: row.id, control: "combobox", name: row.name, value: PICK, expectRev: row.rev ?? 0, mark });
}

const shownValue = (t: Tab): Promise<string> => t.evaluate<string>(`document.getElementById("school").value`);

/** Closes every tab at the fixture URL and waits until none is left, so the next test's tab query is unambiguous. */
async function closeTabs(url: string): Promise<void> {
  const pattern = JSON.stringify(`${url.split("?")[0]}*`);
  const ids = await inWorker<number[]>(`(async () => (await chrome.tabs.query({ url: ${pattern} })).map((t) => t.id))()`).catch(() => [] as number[]);
  if (ids.length > 0) await inWorker(`chrome.tabs.remove([${ids.join(",")}]); true`).catch(() => {});
  for (let i = 0; i < 40 && (await inWorker<number>(`(async () => (await chrome.tabs.query({ url: ${pattern} })).length)()`).catch(() => 1)) > 0; i++) await sleep(50);
}

before(async () => {
  execFileSync(process.execPath, [`${EXT}build.mjs`], { stdio: "ignore" });
  site = createServer((req, res) => {
    const page = PAGES[(req.url ?? "/").slice(1).split("?")[0] ?? ""];
    res.writeHead(page === undefined ? 404 : 200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page ?? "");
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = await launchHeadless([`--load-extension=${DIST}`, `--disable-extensions-except=${DIST}`, "--disable-features=DisableLoadExtensionCommandLineSwitch"]);
  for (let i = 0; i < 50 && worker === undefined; i++) {
    const { targetInfos } = (await browser.cdp.send("Target.getTargets")) as { targetInfos: { targetId: string; type: string; url: string }[] };
    const t = targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"));
    if (t !== undefined) worker = ((await browser.cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true })) as { sessionId: string }).sessionId;
    else await sleep(100);
  }
  assert.ok(worker !== undefined, "the extension's worker never started");
  await browser.cdp.send("Runtime.enable", {}, worker); // so the worker's console.log lines (its [caret] logs) arrive as events
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

/** Resolves within a bound even when the harness's own teardown stalls, so the runner's forced exit can fire. */
async function withLimit(p: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (p === undefined) return;
  await Promise.race([p.catch(() => {}), new Promise<void>((r) => setTimeout(r, ms))]);
}

after(async () => {
  await withLimit(browser?.stop(), 3000);
  await withLimit(new Promise<void>((r) => (site === undefined ? r() : site.close(() => r()))), 3000);
});

describe("a walk reads no name from an editable label or legend", () => {
  test("typed text in an editable legend and label reaches no name, question, section or digest; plain ones still name theirs", async () => {
    const url = `${origin}/labels`;
    const tab = await open("/labels");
    try {
      await typeInto(tab, "document.querySelector(\"#pick legend\")", TYPED_LEGEND);
      await typeInto(tab, "document.querySelector(\"label[for=member]\")", TYPED_LABEL);
      const report = await walk(url);
      assert.ok(report.controls.length >= 6, `the walk kept too few controls: ${report.controls.length}`);
      assertWithoutTyped(report, [TYPED_LEGEND, TYPED_LABEL, TYPED_REF], "the labels page");
      // Not vacuous: a plain label still names its control, and a plain legend still asks its group's question.
      assert.ok(report.controls.some((c) => c.name === "Home address"), `the walk reads no plain label: ${JSON.stringify(report.controls.map((c) => c.name))}`);
      assert.ok(report.controls.some((c) => c.group?.name === "Household"), `the walk reads no plain legend: ${JSON.stringify(report.controls.map((c) => c.group ?? c.name))}`);
      // The typed label names nothing: the editable label contributes no name at all, not even its original words.
      const member = report.controls.find((c) => c.kind === "text" && c.name !== "Home address");
      assert.ok(member !== undefined, "the walk kept only one text control");
      assert.equal(member.name, "", `the member input is named ${JSON.stringify(member.name)}`);
    } finally {
      await closeTabs(url).catch(() => {});
    }
  });
});

describe("a combobox undo stands on the pick's page-side record", () => {
  test("an undo after the person re-picked the same option is refused, and their choice stays", async () => {
    const url = `${origin}/choice`;
    const tab = await open("/choice");
    try {
      const tabId = await inWorker<number>(`chrome.tabs.query({ url: ${JSON.stringify(`${url.split("?")[0]}*`)} }).then(([t]) => t.id)`);
      const s = await snapshot(tabId);
      const row = (s.frames[0] as (typeof s.frames)[number]).controls.find((c) => c.kind === "combobox");
      assert.ok(row !== undefined, `no combobox in the walk: ${JSON.stringify(s.frames[0]?.controls)}`);
      assert.equal(row.name, "School");
      await grant("t-refuse", s, tabId);
      const pickResult = await pick("t-refuse", s, row, "m1");
      assert.equal(pickResult.outcome, "ok", `the pick did not land: ${pickResult.outcome} ${String(pickResult.detail)}`);
      assert.equal(await shownValue(tab), PICK);
      // The person re-picks the same option: a trusted click opens the control and a trusted click chooses again, so
      // the shown choice is unchanged and the control has felt the person's touches since Caret picked.
      await tab.click("document.querySelector('#school')");
      await tab.click("document.querySelector('#opt-blue')");
      assert.equal(await shownValue(tab), PICK);
      await sleep(400); // the armed frame's report of the person's input reaches the worker and ends the grant
      // The undo is granted afresh, as any re-read task would be: the refusal must come from the page-side record.
      const s2 = await snapshot(tabId);
      await grant("t-refuse", s2, tabId);
      const row2 = (s2.frames[0] as (typeof s2.frames)[number]).controls.find((c) => c.kind === "combobox");
      assert.ok(row2 !== undefined, "the fresh walk has no combobox");
      const undo = await act("t-refuse", topOf(s2), { kind: "pageChooseOption", id: row2.id, control: "combobox", name: row2.name, value: "", expectRev: row2.rev ?? 0, wrote: PICK, sameAs: "m1" });
      assert.equal(undo.outcome, "stale", `the undo ran after the person re-picked: ${undo.outcome} ${String(undo.detail)}`);
      assert.equal(undo.detail, "the undo is refused: something of the person's has touched the control since Caret picked it");
      assert.equal(await shownValue(tab), PICK, "the undo erased the person's choice");
    } finally {
      await closeTabs(url).catch(() => {});
    }
  });

  test("an undo with no intervening input restores the control's emptiness, once", async () => {
    const url = `${origin}/choice`;
    const tab = await open("/choice");
    try {
      const tabId = await inWorker<number>(`chrome.tabs.query({ url: ${JSON.stringify(`${url.split("?")[0]}*`)} }).then(([t]) => t.id)`);
      const s = await snapshot(tabId);
      const row = (s.frames[0] as (typeof s.frames)[number]).controls.find((c) => c.kind === "combobox");
      assert.ok(row !== undefined, "no combobox in the walk");
      await grant("t-restore", s, tabId);
      const pickResult = await pick("t-restore", s, row, "m2");
      assert.equal(pickResult.outcome, "ok", `the pick did not land: ${pickResult.outcome} ${String(pickResult.detail)} shown=${JSON.stringify(await shownValue(tab))} rev=${String(row.rev)} row=${JSON.stringify(row)}`);
      // The undo is granted afresh, as any re-read task would be: its walk names the rev the control holds now.
      const s2 = await snapshot(tabId);
      await grant("t-restore", s2, tabId);
      const row2 = (s2.frames[0] as (typeof s2.frames)[number]).controls.find((c) => c.kind === "combobox");
      assert.ok(row2 !== undefined, "the fresh walk has no combobox");
      const undo = await act("t-restore", topOf(s2), { kind: "pageChooseOption", id: row2.id, control: "combobox", name: row2.name, value: "", expectRev: row2.rev ?? 0, wrote: PICK, sameAs: "m2" });
      assert.equal(undo.outcome, "ok", `the undo did not run: ${undo.outcome} ${String(undo.detail)}`);
      assert.equal(await shownValue(tab), "", "the control still holds the choice");
      // The record is used up: a second undo has nothing to stand on.
      const again = await act("t-restore", topOf(s2), { kind: "pageChooseOption", id: row2.id, control: "combobox", name: row2.name, value: "", expectRev: row2.rev ?? 0, wrote: PICK, sameAs: "m2" });
      assert.equal(again.outcome, "stale", `a second undo ran: ${again.outcome} ${String(again.detail)}`);
      assert.equal(await shownValue(tab), "");
    } finally {
      await closeTabs(url).catch(() => {});
    }
  });

  test("an undo after the person re-picked by way of the control's label is refused, and their choice stays", async () => {
    const url = `${origin}/choice`;
    const tab = await open("/choice");
    try {
      const tabId = await inWorker<number>(`chrome.tabs.query({ url: ${JSON.stringify(`${url.split("?")[0]}*`)} }).then(([t]) => t.id)`);
      const s = await snapshot(tabId);
      const row = (s.frames[0] as (typeof s.frames)[number]).controls.find((c) => c.kind === "combobox");
      assert.ok(row !== undefined, "no combobox in the walk");
      await grant("t-label", s, tabId);
      const pickResult = await pick("t-label", s, row, "m3");
      assert.equal(pickResult.outcome, "ok", `the pick did not land: ${pickResult.outcome} ${String(pickResult.detail)}`);
      assert.equal(await shownValue(tab), PICK);
      // The person re-picks through the control's own name: a trusted click on the label forwards to the control and
      // opens its list, and a trusted click on the option has the page copy the choice. No trusted event's target is
      // the control and the shown choice is unchanged — the record must still end.
      await tab.click("document.querySelector('label[for=school]')");
      await tab.click("document.querySelector('#opt-blue')");
      assert.equal(await shownValue(tab), PICK);
      await sleep(400);
      // The undo is granted afresh, as any re-read task would be: the refusal must come from the page-side record.
      const s2 = await snapshot(tabId);
      await grant("t-label", s2, tabId);
      const row2 = (s2.frames[0] as (typeof s2.frames)[number]).controls.find((c) => c.kind === "combobox");
      assert.ok(row2 !== undefined, "the fresh walk has no combobox");
      const undo = await act("t-label", topOf(s2), { kind: "pageChooseOption", id: row2.id, control: "combobox", name: row2.name, value: "", expectRev: row2.rev ?? 0, wrote: PICK, sameAs: "m3" });
      assert.equal(undo.outcome, "stale", `the undo ran after the person re-picked by way of the label: ${undo.outcome} ${String(undo.detail)}`);
      assert.equal(undo.detail, "the undo is refused: something of the person's has touched the control since Caret picked it");
      assert.equal(await shownValue(tab), PICK, "the undo erased the person's choice");
    } finally {
      await closeTabs(url).catch(() => {});
    }
  });

  test("an undo after the person re-picked by way of the list's chevron button is refused, and their choice stays", async () => {
    const url = `${origin}/choice`;
    const tab = await open("/choice");
    try {
      const tabId = await inWorker<number>(`chrome.tabs.query({ url: ${JSON.stringify(`${url.split("?")[0]}*`)} }).then(([t]) => t.id)`);
      const s = await snapshot(tabId);
      const row = (s.frames[0] as (typeof s.frames)[number]).controls.find((c) => c.kind === "combobox");
      assert.ok(row !== undefined, "no combobox in the walk");
      await grant("t-chevron", s, tabId);
      const pickResult = await pick("t-chevron", s, row, "m4");
      assert.equal(pickResult.outcome, "ok", `the pick did not land: ${pickResult.outcome} ${String(pickResult.detail)}`);
      assert.equal(await shownValue(tab), PICK);
      // The person re-picks through the widget's own open button: a trusted click on the chevron opens the list
      // through the page's script, and a trusted click on the option has the page copy the choice. The chevron sits
      // beside the control, not in it, and the shown choice is unchanged — the record must still end.
      await tab.click("document.querySelector('#school-chevron')");
      await tab.click("document.querySelector('#opt-blue')");
      assert.equal(await shownValue(tab), PICK);
      await sleep(400);
      const s2 = await snapshot(tabId);
      await grant("t-chevron", s2, tabId);
      const row2 = (s2.frames[0] as (typeof s2.frames)[number]).controls.find((c) => c.kind === "combobox");
      assert.ok(row2 !== undefined, "the fresh walk has no combobox");
      const undo = await act("t-chevron", topOf(s2), { kind: "pageChooseOption", id: row2.id, control: "combobox", name: row2.name, value: "", expectRev: row2.rev ?? 0, wrote: PICK, sameAs: "m4" });
      assert.equal(undo.outcome, "stale", `the undo ran after the person re-picked by way of the chevron: ${undo.outcome} ${String(undo.detail)}`);
      assert.equal(undo.detail, "the undo is refused: something of the person's has touched the control since Caret picked it");
      assert.equal(await shownValue(tab), PICK, "the undo erased the person's choice");
    } finally {
      await closeTabs(url).catch(() => {});
    }
  });
});
