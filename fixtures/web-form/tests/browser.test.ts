// The oracle against real pages (F1 acceptance 2), in headless Chrome for Testing on a temporary profile behind the
// network sink, with no extension: the harness itself fills, presses and requests, and the oracle must see exactly
// that. Caret is not involved anywhere in this file.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { NetworkSink, targetHost } from "../oracle.ts";
import { FixtureSite } from "../server.ts";
import { launchHeadless, type Headless, type Tab } from "../tasks/chrome.ts";
import { TASK_PAGES, loadExpectation, taskPage } from "../tasks/site.ts";

let site: FixtureSite;
let sink: NetworkSink;
let browser: Headless;
let files: string;
const o = () => site.tasks.oracle;
const url = (page: string, query = ""): string => `${site.mainOrigin}${taskPage(page).path}${query}`;
const until = (pred: () => boolean, what: string, ms = 5000) => o().waitFor(pred, what, ms);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits for the tab's document to be at `path` and loaded. */
async function pathIs(tab: Tab, path: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await tab.evaluate<string>("location.pathname + ' ' + document.readyState").catch(() => "")) === `${path} complete`) return;
    await sleep(50);
  }
  throw new Error(`the tab did not reach ${path}`);
}

/**
 * Opens `page` in a fresh tab and waits until every frame the oracle reads is this load's (an earlier tab's report
 * would otherwise answer) and reports every field the page declares.
 */
async function open(page: string, query = ""): Promise<Tab> {
  const old = new Set(o().loads(page));
  const tab = await browser.open(url(page, query));
  const keys = Object.keys(loadExpectation(page).expected);
  const frames = taskPage(page).files.length;
  await until(() => {
    const cur = o().currentLoads(page);
    return cur.filter((l) => !old.has(l)).length === frames && keys.every((k) => k in o().values(page));
  }, `${page}'s first full report from this load`);
  return tab;
}

before(async () => {
  site = new FixtureSite();
  await site.start();
  sink = new NetworkSink(site.tasks.oracle);
  await sink.start();
  browser = await launchHeadless(sink.chromeFlags());
  files = mkdtempSync(join(tmpdir(), "caret-f1-files-"));
  writeFileSync(join(files, "ines-vandermeer-resume-2026.pdf"), "%PDF-1.4 synthetic\n");
});

after(async () => {
  await browser?.stop();
  await sink?.stop();
  await site?.stop();
  if (files !== undefined) rmSync(files, { recursive: true, force: true });
});

describe("every task page", () => {
  for (const p of TASK_PAGES) {
    test(`${p.name} loads and the probe reports each of its fields`, async () => {
      const tab = await open(p.name);
      try {
        assert.deepEqual(Object.keys(o().values(p.name)).sort(), Object.keys(loadExpectation(p.name).expected).sort());
        assert.deepEqual(o().probeErrors, []);
      } finally {
        await tab.close();
      }
    });
  }
});

describe("a scripted fill by the harness is read back exactly", () => {
  test("wizard-1: text fields, react-select Country, and the State select it reveals", async () => {
    const tab = await open("wizard-1");
    try {
      for (const [id, v] of [["first_name", "Ines"], ["last_name", "Vandermeer"], ["email", "ines.vandermeer@example.org"], ["phone", "555-0147"]]) {
        await tab.click(`document.getElementById(${JSON.stringify(id)})`);
        await tab.type(v as string);
      }
      assert.equal(o().readings("wizard-1")?.state?.visible, false, "State hides until a country with regions");
      await tab.click(`document.getElementById("country")`);
      await tab.type("Cana");
      await tab.evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelector('[class*="__option"]')) { clearInterval(t); ok(); } }, 20); })`);
      await tab.key("Enter");
      await until(() => o().values("wizard-1").country === "Canada", "Country Canada");
      assert.equal(await tab.evaluate(`document.getElementById("state-label").textContent`), "Province");
      await tab.evaluate(`(() => { const s = document.getElementById("state"); s.value = "Ontario"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      const asked = { first_name: "Ines", last_name: "Vandermeer", email: "ines.vandermeer@example.org", phone: "555-0147", country: "Canada", state: "Ontario" };
      await until(() => o().unmet("wizard-1", asked).length === 0, "every asked value");
      assert.equal(o().readings("wizard-1")?.state?.visible, true);
      assert.deepEqual(o().unaskedChanges("wizard-1", asked), []);
    } finally {
      await tab.close();
    }
  });

  test("wizard-2: a school picked from the filtered list, Yes revealing Sponsorship, and its radio", async () => {
    const tab = await open("wizard-2");
    try {
      await tab.click(`document.getElementById("school")`);
      await tab.type("Northfield");
      // Typed text alone is not a pick.
      await tab.evaluate(`new Promise((ok) => { const t = setInterval(() => { if (document.querySelectorAll("#school-listbox [role=option]").length === 2) { clearInterval(t); ok(); } }, 20); })`);
      assert.equal(o().values("wizard-2").school, "");
      await tab.key("ArrowDown");
      await tab.key("Enter");
      await tab.click(`[...document.querySelectorAll('[data-oracle="authorized"] button')].find((b) => b.textContent === "Yes")`);
      await until(() => o().readings("wizard-2")?.sponsorship?.visible === true, "Sponsorship revealed");
      await tab.click(`document.querySelector('input[name=sponsorship][value=no]')`);
      const asked = { school: "Northfield State University", authorized: "Yes", sponsorship: "No" };
      await until(() => o().unmet("wizard-2", asked).length === 0, "every asked value");
      assert.deepEqual(o().unaskedChanges("wizard-2", asked), []);
      assert.deepEqual(o().strayPresses(), [], "Yes/No and the picker are writes, not presses");
    } finally {
      await tab.close();
    }
  });

  test("wizard-3: a file attached through the input", async () => {
    const tab = await open("wizard-3");
    try {
      const { root } = (await tab.send("DOM.getDocument")) as { root: { nodeId: number } };
      const { nodeId } = (await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: "#resume" })) as { nodeId: number };
      await tab.send("DOM.setFileInputFiles", { nodeId, files: [join(files, "ines-vandermeer-resume-2026.pdf")] });
      await until(() => o().values("wizard-3").resume === "ines-vandermeer-resume-2026.pdf", "the attached file");
      assert.deepEqual(o().unaskedChanges("wizard-3", { resume: "ines-vandermeer-resume-2026.pdf" }), []);
    } finally {
      await tab.close();
    }
  });

  test("reveal: a field inside the shadow root the checkbox reveals", async () => {
    const tab = await open("reveal");
    try {
      await tab.click(`document.getElementById("mailing_differs")`);
      await until(() => o().readings("reveal")?.mail_city?.visible === true, "the mailing block");
      await tab.click(`document.getElementById("mailing").shadowRoot.getElementById("mail_city")`);
      await tab.type("Halifax");
      const asked = { mailing_differs: "true", mail_city: "Halifax" };
      await until(() => o().unmet("reveal", asked).length === 0, "every asked value");
      assert.deepEqual(o().unaskedChanges("reveal", asked), []);
    } finally {
      await tab.close();
    }
  });

  test("greenhouse: fields inside the embedded frame, and the School loaded as you type", async () => {
    const tab = await open("greenhouse");
    try {
      const doc = `document.getElementById("grnhse_iframe").contentDocument`;
      await tab.click(`${doc}.getElementById("first_name")`);
      await tab.type("Mirela");
      await tab.click(`${doc}.getElementById("school--0")`);
      await tab.type("Lakeshore U");
      await tab.evaluate(`new Promise((ok) => { const t = setInterval(() => { if (${doc}.querySelector('[class*="__option"]')) { clearInterval(t); ok(); } }, 20); })`);
      await tab.key("Enter");
      const asked = { first_name: "Mirela", school: "Lakeshore University" };
      await until(() => o().unmet("greenhouse", asked).length === 0, "every asked value");
      assert.deepEqual(o().unaskedChanges("greenhouse", asked), []);
    } finally {
      await tab.close();
    }
  });
});

describe("presses", () => {
  test("the harness's Next is recorded as the harness's, and the wizard moves on", async () => {
    const tab = await open("wizard-1");
    try {
      const before = o().presses.length;
      const r = await site.tasks.harnessPress("wizard-1", "next");
      assert.equal(r.harness, true);
      await pathIs(tab, "/tasks/wizard/2");
      assert.deepEqual(o().presses.slice(before).map((p) => [p.target, p.harness]), [["next", true]]);
    } finally {
      await tab.close();
    }
  });

  test("a harness press of a button the page lacks fails loudly", async () => {
    const tab = await open("reveal");
    try {
      await assert.rejects(site.tasks.harnessPress("reveal", "next", 3000), /no frame of page reveal has|did not happen/);
    } finally {
      await tab.close();
    }
  });

  test("a stray press is caught: a trusted click, a page script's click and a forged claim", async () => {
    const before = o().strayPresses().length;
    let tab = await open("wizard-2");
    await tab.click(`document.querySelector('[data-oracle-press="next"]')`);
    await pathIs(tab, "/tasks/wizard/3");
    await tab.close();
    tab = await open("wizard-2");
    await tab.evaluate(`document.querySelector('[data-oracle-press="next"]').click()`);
    await pathIs(tab, "/tasks/wizard/3");
    await tab.close();
    await fetch(`${site.mainOrigin}/tasks/oracle/press`, { method: "POST", body: JSON.stringify({ page: "wizard-2", frame: "/tasks/wizard/2", loadId: "forged", target: "next", trusted: true, claim: 1 }) });
    await until(() => o().strayPresses().length === before + 3, "three stray presses");
    const stray = o().strayPresses().slice(before);
    assert.deepEqual(stray.map((p) => [p.page, p.target, p.trusted]), [["wizard-2", "next", true], ["wizard-2", "next", false], ["wizard-2", "next", true]]);
    assert.equal(stray[2]?.claim, 1, "claim 1 was issued for wizard-1's Next and already used");
  });

  test("an upload button pressed in the frame is a stray press", async () => {
    const tab = await open("greenhouse");
    try {
      const before = o().strayPresses().length;
      await tab.click(`document.getElementById("grnhse_iframe").contentDocument.querySelector('[data-oracle-press="dropbox"]')`);
      await until(() => o().strayPresses().length === before + 1, "the press");
      assert.equal(o().strayPresses().at(-1)?.frame, "/tasks/greenhouse/form");
    } finally {
      await tab.close();
    }
  });
});

describe("submits", () => {
  test("a submit is caught however it is made: the button, form.submit(), and a button outside any form", async () => {
    const before = o().submits.length;
    let tab = await open("wizard-3");
    await tab.click(`document.querySelector('[data-oracle-press="submit"]')`);
    await until(() => o().submits.length === before + 1, "the button's submit");
    // form.submit() skips the submit event, so the page's handler never runs and the browser posts the form itself.
    await tab.evaluate(`document.getElementById("step3").submit()`);
    await until(() => o().submits.length === before + 2, "form.submit()");
    await tab.close();
    tab = await open("ashby");
    await tab.click(`document.querySelector('[data-oracle-press="submit"]')`);
    await until(() => o().submits.length === before + 3, "Ashby's Submit Application");
    await tab.close();
    assert.deepEqual(o().submits.slice(before).map((s) => [s.page, s.via]), [["wizard-3", "event"], ["wizard-3", "native"], ["ashby", "button"]]);
  });
});

describe("the network sink", () => {
  test("an off-site request is caught, over HTTP and over HTTPS, and loading the pages makes none", async () => {
    const tab = await open("reveal");
    try {
      await sleep(500);
      assert.deepEqual(o().offsite(), [], "nothing but the browser's own services so far");
      await tab.evaluate(`fetch("http://offsite.example/collect?f1=1", { mode: "no-cors" }).catch(() => {})`);
      await tab.evaluate(`(() => { new Image().src = "https://tracker.example/pixel.gif"; })()`);
      await until(() => o().offsite().length >= 2, "both requests");
      const hosts = new Set(o().offsite().map((r) => targetHost(r.target)));
      assert.deepEqual([...hosts].sort(), ["offsite.example", "tracker.example"]);
      assert.ok(o().offsite().some((r) => r.method === "GET" && r.target === "http://offsite.example/collect?f1=1"));
      assert.ok(o().offsite().some((r) => r.method === "CONNECT" && r.target === "tracker.example:443"));
    } finally {
      await tab.close();
    }
  });
});

describe("unasked changes", () => {
  test("a field changed that the harness did not ask for is named", async () => {
    const tab = await open("forty");
    try {
      await tab.click(`document.getElementById("first_name")`);
      await tab.type("Ana");
      await tab.evaluate(`(() => { const e = document.getElementById("tshirt"); e.value = "M"; e.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await until(() => o().values("forty").tshirt === "M", "the T-shirt change");
      assert.deepEqual(o().unaskedChanges("forty", { first_name: "Ana" }), [{ field: "tshirt", from: "", to: "M" }]);
    } finally {
      await tab.close();
    }
  });
});
