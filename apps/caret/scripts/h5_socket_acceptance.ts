// H5's headless acceptances, against a helper on a temporary home in this process and the built Caret host
// with nothing on screen (`--surfaces headless`, `--perch hidden`, `--status-item off`, its own settings file).
// The helper runs its real fill path, Ask and server; the reader is a socket client sending synthetic windows
// (helper/test/socket-reader.ts); Jev and the intent writer are fakes that answer by rule. No key or click is
// posted anywhere: the host's debug socket drives the ask field.
//
//   1. A fill proposal with hand-off rows: a Chrome-shaped order form, a note with the values, focus in its first
//      field. The helper's pop-up reaches the host with its control row: "Pizza Size: Large, you set this".
//   2. An Ask that refuses: "pay for it" through the host's ask field. The desk shows B26's sentence as the helper
//      sends it: "Paying is yours to do. Caret stops before payment."
//   3. "Caret can't see this page yet": the reader says a Chrome window is in front and the user typed in it, with
//      no page engine. The helper says missing; the host shows the line once the browser is the front app, and
//      takes it down when an engine connects.
//
//   node apps/caret/scripts/h5_socket_acceptance.ts --out DIR
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import { BrowserPresence } from "../../../helper/src/engines/presence.ts";
import type { HelperMessage, Node, ReaderMessage } from "../../../helper/src/protocol.ts";
import type { WriterPort } from "../../../helper/src/writer/port.ts";
import { field, jevPickingText, node, snap, text, value } from "../../../helper/test/builders.ts";
import { SocketReader } from "../../../helper/test/socket-reader.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const CARET = resolve(ROOT, "apps", "caret", ".build", "Caret.app", "Contents", "MacOS", "Caret");
const { values: a } = parseArgs({ options: { out: { type: "string" } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const SOCKETS = join(homedir(), ".caret-run", "sockets");
const HELPER_SOCK = join(SOCKETS, "h5-helper.sock");
const HOST_SOCK = join(SOCKETS, "h5-host.sock");
// Synthetic pids, checked not to be live: the note, the form's browser.
const NOTE_PID = 7301;
const CHROME_PID = 7302;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];
const results: { name: string; ok: boolean; detail: unknown }[] = [];

for (const pid of [NOTE_PID, CHROME_PID]) {
  let live = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    live = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (live) throw new Error(`pid ${pid} is a live process; the synthetic pids must not exist. Nothing was started.`);
}

// MARK: - the scene

const P = "com.google.Chrome/standard";
const CHROME = { pid: CHROME_PID, bundleId: "com.google.Chrome", name: "Google Chrome" };
const TEXTEDIT = { pid: NOTE_PID, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const NAME_KEY = `${P}/textfield:customer name~0`;
const FORM = `${CHROME_PID}-1`;
const NOTE = `${NOTE_PID}-1`;
const page = (): Node[] => [
  node(`${P}/webarea:~0`, "AXWebArea", { label: "Pizza order" }),
  field(NAME_KEY, "", { parent: `${P}/webarea:~0`, label: "Customer name:", frame: [100, 100, 200, 20] }),
  field(`${P}/textfield:phone~0`, "", { parent: `${P}/webarea:~0`, label: "Phone:", frame: [100, 130, 200, 20] }),
  node(`${P}/group:pizza size~0`, "AXGroup", { parent: `${P}/webarea:~0`, subrole: "AXFieldset", label: "Pizza Size" }),
  node(`${P}/group:pizza size/radiobutton:small~0`, "AXRadioButton", { parent: `${P}/group:pizza size~0`, label: "Small", frame: [100, 170, 20, 20] }),
  node(`${P}/group:pizza size/radiobutton:large~0`, "AXRadioButton", { parent: `${P}/group:pizza size~0`, label: "Large", frame: [100, 190, 20, 20] }),
  text(`${P}/statictext:checkout~0`, "Orders are baked fresh and delivered within the area shown at checkout.", undefined, `${P}/webarea:~0`),
];
const NOTE_TEXT = ["Pizza order", "Name: Jordan Reyes", "Phone: (512) 555-0147", "Large, mushroom and onion"].join("\n");
const pick = (_: string, ins: string): string | null =>
  ins.includes("'Customer name'") ? "Jordan Reyes" : ins.includes("'Phone'") ? "(512) 555-0147" : ins.includes("'Pizza Size'") ? "Large, mushroom and onion" : null;

/** The intent writer, by rule: "pay for it" is refused as payment (B26 lead decision 3). */
const writer: WriterPort = {
  route: { provider: "groq", baseUrl: "http://127.0.0.1:9", keyName: "H5_NO_KEY", model: "fake-intent-writer" } as WriterPort["route"],
  async write() {
    const json = { route: "refuse", why: "payment", scope: "none", section: "", fields: [], sources: [], whose: "", literals: [] };
    return { model: "fake-intent-writer", provider: "fake", output: { program: null, reply: JSON.stringify(json), json }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
  },
};

// MARK: - the helper

const dir = mkdtempSync(join(tmpdir(), "caret-h5-"));
const store = new Store(join(dir, "data"));
const published: HelperMessage[] = [];
let server: HelperServer | null = null;
const publish = (m: HelperMessage): void => {
  published.push(m);
  server?.publish(m);
};
const helper = new Helper({
  store,
  memoryDir: join(dir, "memory"),
  askJev: jevPickingText(pick),
  shadow: false,
  allowBackgroundFocus: false,
  publish,
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
  ask: { maker: "writer", writer },
  warn: (l) => log.push(`helper: ${l}`),
});
// The presence signal as engines/wire.ts joins it, with no page engine ever connected.
const engines = new Set<number>();
const presence = new BrowserPresence({ publish, hasEngine: (pid) => engines.has(pid) });
helper.onReaderMessage((m) => presence.onReader(m));
server = new HelperServer(HELPER_SOCK, () => helper, (l) => log.push(`server: ${l}`));
await server.listen();
const reader = await SocketReader.connect(HELPER_SOCK);

// MARK: - the host, headless

const host: ChildProcess = spawn(CARET, [
  "--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--no-ghost", "--perch", "hidden", "--surfaces", "headless", "--test-hooks",
  "--allow-pids", `${NOTE_PID},${CHROME_PID}`, "--status-item", "off", "--settings", join(dir, "settings.json"),
]);
host.stderr?.setEncoding("utf8");
host.stderr?.on("data", (d: string) => log.push(`host: ${d.trim().slice(0, 300)}`));
process.on("exit", () => host.kill("SIGTERM"));

function hostCommand(command: string): Promise<Record<string, unknown>> {
  return new Promise((res, rej) => {
    const s: Socket = createConnection(HOST_SOCK);
    let buf = "";
    s.setEncoding("utf8");
    s.on("connect", () => s.write(command + "\n"));
    s.on("data", (d: string) => (buf += d));
    s.on("end", () => {
      try {
        res(JSON.parse(buf) as Record<string, unknown>);
      } catch {
        rej(new Error(`host ${command}: ${buf.slice(0, 200)}`));
      }
    });
    s.on("error", rej);
  });
}

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await probe();
      if (v !== null) return v;
    } catch {
      // The host's socket may not be up yet.
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

async function check(name: string, body: () => Promise<unknown>): Promise<void> {
  try {
    results.push({ name, ok: true, detail: await body() });
    console.log(`PASS ${name}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const expectThat = (ok: boolean, what: string, detail: unknown): void => {
  if (!ok) throw new Error(`${what}: ${JSON.stringify(detail).slice(0, 600)}`);
};

try {
  await until("the host to connect to the helper", async () => ((await hostCommand("state")).helper as { connected?: boolean } | undefined)?.connected === true ? true : null, 20_000);

  await check("a fill proposal's control reaches the host as a row the user sets", async () => {
    reader.send(snap([field("te/note", NOTE_TEXT, { role: "AXTextArea" })], { at: 900, windowId: NOTE, title: "Order note.txt", app: TEXTEDIT, focused: true, values: [value("phone", "(512) 555-0147", "te/note")] }));
    reader.send(snap(page(), { at: 1000, windowId: FORM, title: "Pizza order", app: CHROME, focused: true, focusedKey: NAME_KEY }));
    const focus: ReaderMessage = { type: "focus", v: 1, at: 1010, app: CHROME, windowId: FORM, key: NAME_KEY, role: "AXTextField", editable: true, empty: true, frontmost: true };
    reader.send(focus);
    const popup = await until("the helper's fill pop-up", async () => (published.find((m) => m.type === "popup") ?? null), 10_000);
    const rows = popup.type === "popup" ? popup.spec.blocks.filter((b) => b.type === "fields").map((b) => (b.type === "fields" ? b.rows.map((r) => [r.destination.text, r.value?.text, r.state]) : [])) : [];
    expectThat(JSON.stringify(rows).includes(`"Large","yours"`), "the pop-up holds a row the user sets", rows);
    const surface = await until("the host to show it", async () => {
      const s = (await hostCommand("state")).surface as { kind?: string; popupSpoken?: string } | undefined;
      return s?.kind === "popup" && s.popupSpoken !== undefined ? s : null;
    });
    expectThat((surface.popupSpoken ?? "").includes("Pizza Size: Large, you set this"), "the host's pop-up says the row is the user's", surface);
    expectThat(!/Pizza Size: Large\.\s|Pizza Size: Large$/.test(surface.popupSpoken ?? ""), "and never as a value Tab fills", surface);
    return { rows, spoken: surface.popupSpoken };
  });

  await check("an Ask that refuses shows the helper's sentence on the desk", async () => {
    await hostCommand("ask type pay for it");
    await hostCommand("ask submit");
    const ask = await until("the desk's answer", async () => {
      const r = await hostCommand("ask");
      return r.phase === "failed" ? r : null;
    }, 15_000);
    const proposal = published.length;
    expectThat(ask.line === "Paying is yours to do. Caret stops before payment.", "the desk's sentence is B26's", ask);
    return { line: ask.line, published: proposal };
  });

  await check("Caret can't see this page yet: a Chrome window in front, typed in, with no page engine", async () => {
    reader.send({ type: "appSwitch", v: 1, at: 2000, from: null, to: CHROME });
    reader.send({ type: "focus", v: 1, at: 2001, app: CHROME, windowId: FORM, key: NAME_KEY, role: "AXTextField", editable: true, empty: true, frontmost: true });
    reader.send({ type: "userInput", v: 1, at: 2002, pid: CHROME_PID, kind: "key", point: null });
    const said = await until("the helper's pageEngine missing", async () => (published.find((m) => m.type === "pageEngine") ?? null));
    expectThat(said.type === "pageEngine" && said.state === "missing", "the helper says missing", said);
    const heard = await until("the host to hear it", async () => {
      const s = await hostCommand("pagesight");
      return (s.missing as number[] | undefined)?.includes(CHROME_PID) ? s : null;
    });
    // The real front app is whatever this Mac has in front; the synthetic browser comes to the front by the hook.
    const shown = await hostCommand(`pagesight front ${CHROME_PID}`);
    expectThat(shown.shown === "Google Chrome", "the line shows for the browser in front", shown);
    expectThat(shown.onScreen === false, "and draws nothing headless", shown);
    const again = await hostCommand(`pagesight front ${CHROME_PID}`);
    expectThat(again.shown === "Google Chrome" && (again.asked as number[]).length === 1, "once per browser per session", again);
    engines.add(CHROME_PID);
    presence.engineConnected(CHROME);
    const gone = await until("the line to go when an engine connects", async () => {
      const s = await hostCommand("pagesight");
      return s.shown === undefined && !(s.missing as number[]).includes(CHROME_PID) ? s : null;
    });
    return { heard, shown, gone };
  });
} finally {
  reader.close();
  helper.shutdown();
  await server.close();
  helper.memory.close();
  store.close();
  host.kill("SIGTERM");
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
  const passed = results.filter((r) => r.ok).length;
  writeFileSync(join(OUT, "h5-acceptance.json"), JSON.stringify({ passed, of: results.length, results, log: log.slice(-200) }, null, 2));
  console.log(`${passed}/${results.length} passed -> ${OUT}`);
  process.exitCode = passed === results.length ? 0 : 1;
}
