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
  // #6: a "show password" in a shadow root turns the field into a text input the user then types into.
  "text-in-shadow": shell(`<login-box id="host"></login-box>`, `const r = document.getElementById("host").attachShadow({ mode: "open" }); r.innerHTML = '<label>Password <input type="password" id="pw"></label>'; window.reveal = () => { r.getElementById("pw").type = "text"; };`),
};

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
