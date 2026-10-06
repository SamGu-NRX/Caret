// P4's content-side halves in a real browser (headless Chrome for Testing, temporary profile, no extension): what a
// text read of the tab the user just left takes from a page and what it never takes, the 16 KB cap, the selection
// first, Google Docs' and Sheets' text for assistive technology (on replica pages), the text around the caret of the
// field being typed in, and the insert at the caret with the page's own Undo. The modules are the extension's own
// (extension/src/content/text.ts, field-text.ts, insert.ts), bundled and run in each page's main world. The worker's
// halves (which tab, which frames) are tested in extension/test/tab-text.test.ts and in the journey
// (tab-source-journey.ts). Every name and value is invented.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { build } from "esbuild";
import { launchHeadless, type Headless, type Tab } from "../tasks/chrome.ts";

const EXT = fileURLToPath(new URL("../../../extension/src/content/", import.meta.url));

/** Pages by path; each is served as it is. */
const PAGES: Record<string, string> = {
  "/mail": `<!doctype html><title>Inbox</title>
<nav>Inbox (3) Sent Drafts NAV-ONLY</nav>
<main>
<h1>Your trip details</h1>
<p>Hi Ines,</p>
<p>Traveler: Ines Vandermeer<br>Email: <a href="mailto:ines.vandermeer@example.org">ines.vandermeer@example.org</a><br>Cell: 555-0147</p>
<table><tr><td>Flight</td><td>OL 482</td></tr><tr><td>Seat</td><td>14C</td></tr></table>
<form><input type="password" value="PW-hunter2"><input type="hidden" value="HIDDEN-token"><input type="text" value="INPUT-text">
<textarea>TEXTAREA-draft</textarea><select><option>OPTION-one</option></select><button type="button">BUTTON-send</button></form>
<div role="button">ROLEBUTTON-archive</div>
<div contenteditable="true">EDITABLE-reply</div>
<span style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">SRONLY-hint</span>
<div style="display:none">DISPLAYNONE-ssn</div>
<div aria-hidden="true">ARIAHIDDEN-x</div>
<div style="opacity:0">OPACITY-x</div>
<div style="position:absolute;left:-10000px;top:0;width:200px">OFFSCREEN-x</div>
<div style="visibility:hidden">VISHIDDEN-x <span style="visibility:visible">VISIBLE-child</span></div>
<script>/*SCRIPT-x*/</script><style>.x{}/*STYLE-x*/</style>
<iframe srcdoc="<p>IFRAME-text</p>"></iframe>
</main>
<footer>FOOTER-only</footer>`,
  "/role-main": `<!doctype html><title>App</title><div id="nav">SIDEBAR-x</div><div role="main"><p>Order ORD-48213 ships Friday.</p></div><main hidden><p>HIDDEN-MAIN</p></main>`,
  "/no-main": `<!doctype html><title>Note</title><p>Phone: 555-0147</p><div style="display:none">GONE</div>`,
  "/sel": `<!doctype html><title>Sel</title><aside id="side"><p id="aside">Cell: 555-0147</p></aside>
<main><p id="a">Hi Ines,</p><p id="b">Start <span style="display:none">HIDDEN-IN-SELECTION</span>date: October 20, 2026</p><p>Thanks!</p></main>`,
  "/big": `<!doctype html><title>Big</title><main>${Array.from({ length: 400 }, (_, i) => `<p>Paragraph ${String(i).padStart(3, "0")} ${"x".repeat(80)}</p>`).join("")}</main>`,
  "/docs": `<!doctype html><title>Doc</title><body><div class="kix-appview-editor"><canvas width="10" height="10"></canvas></div>
<iframe class="docs-texteventtarget-iframe" style="position:absolute;top:-10000px;left:0;width:625px;height:1px;border:0"></iframe></body>`,
  "/sheets": `<!doctype html><title>Sheet</title><body><div role="textbox" contenteditable="false" style="position:absolute;top:100px">A1 formula bar</div>
<div id="at" role="textbox" contenteditable="true" style="position:absolute;top:-9998px;left:4px;width:600px;white-space:pre"></div></body>`,
  "/fields": `<!doctype html><title>Fields</title><main>
<input id="t" type="text" value="Hello world"><input id="e" type="email" value="ines@example.org">
<textarea id="ta"></textarea>
<div id="ce" contenteditable="true"><div>Line one</div><div>Line two<br>and more</div></div>
</main>`,
};

let server: Server;
let origin: string;
let browser: Headless;
let bundle: string;

before(async () => {
  const out = await build({
    stdin: {
      contents: `import * as t from "./text.ts"; import * as f from "./field-text.ts"; import * as i from "./insert.ts"; globalThis.__p4 = { ...t, ...f, ...i };`,
      resolveDir: EXT,
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    target: "chrome116",
    logLevel: "warning",
  });
  bundle = out.outputFiles[0]?.text ?? "";
  server = createServer((req, res) => {
    const page = PAGES[new URL(req.url ?? "/", "http://x").pathname];
    if (page === undefined) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await launchHeadless();
});

after(async () => {
  await browser?.stop();
  await new Promise((r) => server?.close(r));
});

/** Opens `path` with the extension's modules loaded as `__p4` in the page. */
async function open(path: string): Promise<Tab> {
  const tab = await browser.open(`${origin}${path}`);
  await tab.evaluate(`${bundle};true`);
  return tab;
}

interface Read {
  selection: string[];
  blocks: string[];
  cut: boolean;
}

const MUST_NOT = ["NAV-ONLY", "PW-hunter2", "HIDDEN-token", "INPUT-text", "TEXTAREA-draft", "OPTION-one", "BUTTON-send", "ROLEBUTTON-archive", "EDITABLE-reply", "SRONLY-hint", "DISPLAYNONE-ssn", "ARIAHIDDEN-x", "OPACITY-x", "OFFSCREEN-x", "VISHIDDEN-x", "SCRIPT-x", "STYLE-x", "IFRAME-text", "FOOTER-only"];

describe("what a read takes from the page (rule 4)", () => {
  test("only the main region's visible text, never a control, a hidden or off-screen element, a script or a frame", async () => {
    const tab = await open("/mail");
    const r = await tab.evaluate<Read>("__p4.readMainText()");
    const all = [...r.selection, ...r.blocks].join("\n\n");
    for (const s of MUST_NOT) assert.ok(!all.includes(s), `${s} was read`);
    assert.deepEqual(r.blocks.slice(0, 4), ["Your trip details", "Hi Ines,", "Traveler: Ines Vandermeer\nEmail: ines.vandermeer@example.org\nCell: 555-0147", "Flight\tOL 482\nSeat\t14C"]);
    assert.ok(all.includes("VISIBLE-child"), "a visible child of a hidden parent is text a person sees");
    assert.equal(r.cut, false);
    await tab.close();
  });

  test("the first rendered [role=main], else body; a hidden main is not the region", async () => {
    const a = await open("/role-main");
    assert.deepEqual((await a.evaluate<Read>("__p4.readMainText()")).blocks, ["Order ORD-48213 ships Friday."]);
    await a.close();
    const b = await open("/no-main");
    assert.deepEqual((await b.evaluate<Read>("__p4.readMainText()")).blocks, ["Phone: 555-0147"]);
    await b.close();
  });

  test("is capped at 16 KB, cut between paragraphs", async () => {
    const tab = await open("/big");
    const r = await tab.evaluate<Read>("__p4.readMainText()");
    const bytes = r.blocks.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
    assert.ok(bytes <= 16 * 1024 + 1, `${bytes} bytes`);
    assert.equal(r.cut, true);
    assert.ok(r.blocks.length > 100 && r.blocks.length < 400);
    r.blocks.forEach((p, i) => assert.equal(p, `Paragraph ${String(i).padStart(3, "0")} ${"x".repeat(80)}`));
    await tab.close();
  });
});

describe("a selection is read first (rule 4)", () => {
  test("the text the user selected comes before the main region's, even outside it, and still without hidden text", async () => {
    const tab = await open("/sel");
    await tab.evaluate(`(() => {
      const s = getSelection(); s.removeAllRanges();
      const r = document.createRange(); r.selectNodeContents(document.getElementById("aside")); s.addRange(r);
    })()`);
    const r = await tab.evaluate<Read>("__p4.readMainText()");
    assert.deepEqual(r.selection, ["Cell: 555-0147"]);
    assert.deepEqual(r.blocks, ["Hi Ines,", "Start date: October 20, 2026", "Thanks!"]);
    await tab.evaluate(`(() => {
      const s = getSelection(); s.removeAllRanges();
      const r = document.createRange(); r.setStart(document.getElementById("b").firstChild, 0); r.setEnd(document.getElementById("b").lastChild, 5); s.addRange(r);
    })()`);
    const r2 = await tab.evaluate<Read>("__p4.readMainText()");
    assert.deepEqual(r2.selection, ["Start date:"]);
    assert.ok(!r2.selection.join("").includes("HIDDEN-IN-SELECTION"));
    // The cap counts the selection first: a selection always survives a long page.
    const capped = await tab.evaluate<Read>("__p4.readMainText(document, 40)");
    assert.deepEqual(capped.selection, ["Start date:"]);
    await tab.close();
  });
});

describe("Google Docs and Sheets: their own text for assistive technology (item 6)", () => {
  test("names the editors by origin and path only", async () => {
    const tab = await open("/no-main");
    const kinds = await tab.evaluate<(string | null)[]>(`[
      __p4.docsKind("https://docs.google.com", "/document/d/abc/edit"),
      __p4.docsKind("https://docs.google.com", "/document/u/0/d/abc/edit"),
      __p4.docsKind("https://docs.google.com", "/spreadsheets/d/abc/edit"),
      __p4.docsKind("https://docs.google.com", "/spreadsheets/d/abc/htmlview"),
      __p4.docsKind("https://docs.google.com.evil.test", "/document/d/abc/edit"),
      __p4.docsKind("https://mail.google.com", "/mail/u/0/"),
    ]`);
    assert.deepEqual(kinds, ["document", "document", "spreadsheet", null, null, null]);
    await tab.close();
  });

  test("reads Docs' text-event target when screen reader and braille support put the document there, and says off when not", async () => {
    const tab = await open("/docs");
    await tab.evaluate(`(() => {
      const d = document.querySelector("iframe").contentDocument;
      d.body.innerHTML = '<div role="textbox" contenteditable="true" aria-label="Document content">\\u200b\\u200b</div>';
    })()`);
    assert.deepEqual(await tab.evaluate("__p4.readFrameText('https://docs.google.com', '/document/d/abc/edit', true)"), { selection: [], blocks: [], cut: false, docsText: "off" });
    // The main region of a Docs page holds no document text: it is drawn on the canvas.
    assert.deepEqual((await tab.evaluate<Read>("__p4.readMainText()")).blocks, []);
    await tab.evaluate(`(() => {
      const box = document.querySelector("iframe").contentDocument.querySelector("[role=textbox]");
      box.innerHTML = "<p>Quarterly plan</p><p>Owner: Ines Vandermeer</p><p>Email: ines.vandermeer@example.org</p>";
    })()`);
    const on = await tab.evaluate<Read & { docsText: string }>("__p4.readFrameText('https://docs.google.com', '/document/d/abc/edit', true)");
    assert.equal(on.docsText, "on");
    assert.deepEqual(on.blocks, ["Quarterly plan", "Owner: Ines Vandermeer", "Email: ines.vandermeer@example.org"]);
    // A child frame of a Docs page, or a page elsewhere, never takes this path.
    assert.equal((await tab.evaluate<{ docsText: string | null }>("__p4.readFrameText('https://docs.google.com', '/document/d/abc/edit', false)")).docsText, null);
    // The caret in the text-event target: the sentence being typed (not checked in a real editable Doc: brief addendum).
    await tab.evaluate(`(() => {
      const d = document.querySelector("iframe").contentDocument;
      const box = d.querySelector("[role=textbox]"); box.focus();
      const p = box.querySelectorAll("p")[1].firstChild; const r = d.createRange(); r.setStart(p, 7); r.collapse(true);
      const s = d.getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    const focus = await tab.evaluate<{ text: string; field: { before: string; after: string } | null }>("__p4.docsFocus(document, 'document')");
    assert.equal(focus.text, "on");
    assert.equal(focus.field?.before, "Quarterly plan\nOwner: ");
    assert.ok(focus.field?.after.startsWith("Ines Vandermeer"));
    await tab.close();
  });

  test("reads Sheets' off-screen textbox row by row, and never the visible formula bar", async () => {
    const tab = await open("/sheets");
    assert.equal((await tab.evaluate<{ docsText: string }>("__p4.readFrameText('https://docs.google.com', '/spreadsheets/d/abc/edit', true)")).docsText, "off");
    await tab.evaluate(`document.getElementById("at").textContent = "\\n\\nName\\tEmail\\t\\t\\nInes Vandermeer\\tines.vandermeer@example.org\\t\\n"`);
    const r = await tab.evaluate<Read & { docsText: string }>("__p4.readFrameText('https://docs.google.com', '/spreadsheets/d/abc/edit', true)");
    assert.equal(r.docsText, "on");
    assert.deepEqual(r.blocks, ["Name\tEmail", "Ines Vandermeer\tines.vandermeer@example.org"]);
    await tab.close();
  });
});

describe("the text around the caret of the field being typed in (item 7)", () => {
  test("an input and a textarea: before the caret up to 2000, after up to 500, and the selection", async () => {
    const tab = await open("/fields");
    assert.deepEqual(await tab.evaluate(`(() => { const t = document.getElementById("t"); t.focus(); t.setSelectionRange(5, 5); return __p4.fieldText(t); })()`), { before: "Hello", after: " world", selection: "" });
    assert.deepEqual(await tab.evaluate(`(() => { const t = document.getElementById("t"); t.setSelectionRange(0, 5); return __p4.fieldText(t); })()`), { before: "", after: " world", selection: "Hello" });
    const long = await tab.evaluate<{ before: string; after: string }>(`(() => {
      const ta = document.getElementById("ta"); ta.value = "a".repeat(2500) + "b".repeat(1000); ta.focus(); ta.setSelectionRange(2500, 2500); return __p4.fieldText(ta);
    })()`);
    assert.equal(long.before, "a".repeat(2000));
    assert.equal(long.after, "b".repeat(500));
    // Chrome gives no caret in an email input: nothing is guessed.
    assert.equal(await tab.evaluate(`__p4.fieldText(document.getElementById("e"))`), null);
    await tab.close();
  });

  test("a contenteditable, through the DOM selection, with its lines as a person sees them", async () => {
    const tab = await open("/fields");
    const r = await tab.evaluate(`(() => {
      const ce = document.getElementById("ce"); ce.focus();
      const t = ce.querySelectorAll("div")[1].lastChild; const r = document.createRange(); r.setStart(t, 3); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      return __p4.fieldText(ce);
    })()`);
    assert.deepEqual(r, { before: "Line one\nLine two\nand", after: " more", selection: "" });
    await tab.close();
  });
});

describe("the insert at the caret (item 8)", () => {
  const insert = (sel: string, expect: string, text: string): string =>
    `__p4.insertAtCaret(document.querySelector(${JSON.stringify(sel)}), { expect: ${JSON.stringify(expect)}, text: ${JSON.stringify(text)} }, async () => null)`;

  test("goes in at the caret of the focused textarea, is read back, and the page's own Undo takes it out", async () => {
    const tab = await open("/fields");
    await tab.evaluate(`(() => { const ta = document.getElementById("ta"); ta.value = "I am writing to apply for the  position."; ta.focus(); ta.setSelectionRange(30, 30); })()`);
    const a = await tab.evaluate<{ outcome: string }>(insert("#ta", "I am writing to apply for the ", "Field Robotics Technician"));
    assert.equal(a.outcome, "ok");
    assert.equal(await tab.evaluate(`document.getElementById("ta").value`), "I am writing to apply for the Field Robotics Technician position.");
    await tab.evaluate(`document.execCommand("undo")`);
    assert.equal(await tab.evaluate(`document.getElementById("ta").value`), "I am writing to apply for the  position.");
    await tab.close();
  });

  test("goes in at the caret of a contenteditable editor, and Undo takes it out", async () => {
    const tab = await open("/fields");
    await tab.evaluate(`(() => {
      const ce = document.getElementById("ce"); ce.focus();
      const t = ce.querySelectorAll("div")[1].lastChild; const r = document.createRange(); r.setStart(t, 3); r.collapse(true);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    })()`);
    assert.equal((await tab.evaluate<{ outcome: string }>(insert("#ce", "Line one\nLine two\nand", " a little"))).outcome, "ok");
    assert.equal(await tab.evaluate(`document.getElementById("ce").innerText`), "Line one\nLine two\nand a little more");
    await tab.evaluate(`document.execCommand("undo")`);
    assert.equal(await tab.evaluate(`document.getElementById("ce").innerText`), "Line one\nLine two\nand more");
    await tab.close();
  });

  test("touches nothing when the text before the caret changed, text is selected, or the field lost focus", async () => {
    const tab = await open("/fields");
    await tab.evaluate(`(() => { const ta = document.getElementById("ta"); ta.value = "Dear team, "; ta.focus(); ta.setSelectionRange(11, 11); })()`);
    assert.equal((await tab.evaluate<{ outcome: string }>(insert("#ta", "Dear all, ", "thanks"))).outcome, "stale");
    await tab.evaluate(`document.getElementById("ta").setSelectionRange(0, 4)`);
    assert.equal((await tab.evaluate<{ outcome: string }>(insert("#ta", "", "thanks"))).outcome, "stale");
    await tab.evaluate(`(() => { const ta = document.getElementById("ta"); ta.setSelectionRange(11, 11); document.getElementById("t").focus(); })()`);
    assert.equal((await tab.evaluate<{ outcome: string }>(insert("#ta", "Dear team, ", "thanks"))).outcome, "stale");
    assert.equal(await tab.evaluate(`document.getElementById("ta").value`), "Dear team, ");
    await tab.close();
  });
});
