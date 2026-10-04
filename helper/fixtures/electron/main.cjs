// The real-target evaluation's Electron app (B20): one window on the web form, driven over stdin the way
// caret-fixture's WebKit window is. The evaluation copies this file and form.html into a temporary directory
// and runs Electron on it, so nothing is installed or kept. It sets no accessibility switch itself: the reader
// asks Electron apps for their tree with AXManualAccessibility, and this app is there to show whether that works.
//   stdin `web EXPR`   evaluates EXPR in the form window's page; answers {"ok":true,"value":...} with its JSON
//   stdin `second`     opens a second window on the same form, for the safety case "another window of the target"
//   stdin `open QUERY` opens another window on the form with ?QUERY and answers {"ok":true,"id":N} once it loaded
//   stdin `in N EXPR`  evaluates EXPR in window N's page, as `web` does in the first
//   stdin `close N`    closes window N
// The first line on stdout is `caret-electron pid N`. With --caret-blank the first window shows a blank page
// instead of the form, so the windows `open` makes are the only ones titled as the form.
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const readline = require("node:readline");

const form = path.join(__dirname, "form.html");
let main = null;
const windows = [];
const byId = new Map();

function open(query, x, blank = false) {
  // showInactive: the window opens without taking the focus, as caret-fixture's windows do.
  const w = new BrowserWindow({ width: 520, height: 460, x, y: 160, show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  if (blank) w.loadURL("about:blank");
  else w.loadFile(form, query === undefined ? {} : { query: Object.fromEntries(new URLSearchParams(query)) });
  w.once("ready-to-show", () => w.showInactive());
  windows.push(w);
  byId.set(w.id, w);
  w.on("closed", () => byId.delete(w.id));
  return w;
}

async function evaluate(w, expr) {
  const json = await w.webContents.executeJavaScript(`JSON.stringify(${expr})`);
  return json === undefined ? null : JSON.parse(json);
}

function answer(o) {
  process.stdout.write(JSON.stringify(o) + "\n");
}

app.whenReady().then(() => {
  main = open(undefined, 620, process.argv.includes("--caret-blank"));
  process.stdout.write(`caret-electron pid ${process.pid}\n`);
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    const sp = line.indexOf(" ");
    const cmd = sp < 0 ? line : line.slice(0, sp);
    const rest = sp < 0 ? "" : line.slice(sp + 1);
    try {
      if (cmd === "web") {
        answer({ ok: true, value: await evaluate(main, rest) });
      } else if (cmd === "open") {
        const w = open(rest, 620);
        await new Promise((r) => w.webContents.once("did-finish-load", r));
        answer({ ok: true, id: w.id });
      } else if (cmd === "in") {
        const sp2 = rest.indexOf(" ");
        const w = byId.get(Number(rest.slice(0, sp2)));
        if (w === undefined) answer({ ok: false, error: `no window ${rest.slice(0, sp2)}` });
        else answer({ ok: true, value: await evaluate(w, rest.slice(sp2 + 1)) });
      } else if (cmd === "close") {
        const w = byId.get(Number(rest));
        if (w === undefined) answer({ ok: false, error: `no window ${rest}` });
        else {
          w.close();
          answer({ ok: true });
        }
      } else if (cmd === "second") {
        open("second=1", 1160);
        answer({ ok: true });
      } else answer({ ok: false, error: `unknown command ${cmd}` });
    } catch (e) {
      answer({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });
  rl.on("close", () => app.quit());
});
app.on("window-all-closed", () => app.quit());
