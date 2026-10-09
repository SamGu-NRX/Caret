// Offers shown with the router on and off (brief H6, "Offers per hour"), on the A5 offers socket fixture.
//
// Each of A5's recordings (helper/fixtures/recorded offers-fill, offers-loop, offers-pending) is replayed into a
// fresh helper, in process, behind the built host running headless, and the offers the host received are counted.
// Nothing is accepted. Two modes:
//   off   the helper without the router, the host's "Always suggest as I type": today's behavior.
//   live  D2-02's router with live Jev for router questions (routing_option.ts, spend capped), the host's
//         "Caret decides when to help".
// Wanted offers are the ones each recording exists to produce, as offers_socket_acceptance.ts waits for them:
// the fill pop-up, the loop's alternatives, and the finished watch's "Open" action. The result says, per mode,
// offers shown, offers per hour of replayed time, and which wanted offers were shown.
//
//   node apps/caret/scripts/offers_routing_measure.ts --out DIR [--runs 3] [--settle-ms 6000]
import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { newLaunchSecret } from "../../../helper/src/launch.ts";
import { spawnCaret } from "../../../helper/scripts/spawn-caret.ts";
import { Store } from "../../../helper/src/store.ts";
import type { AskJev } from "../../../helper/src/fill/jev.ts";
import type { HelperMessage } from "../../../helper/src/protocol.ts";
import { jevPickingText } from "../../../helper/test/builders.ts";
import { SocketReader, loadRecording } from "../../../helper/test/socket-reader.ts";
import { routedJev, routingHarness } from "./routing_option.ts";

// The in-process server's launch secret. Caret gets the host key derived from it (spawnCaret), so the server admits it
// as the host (helper/src/host-auth.ts).
const launchSecret = newLaunchSecret();

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");
const CARET = resolve(ROOT, "apps", "caret", ".build", "Caret.app", "Contents", "MacOS", "Caret");
const { values: a } = parseArgs({ options: { out: { type: "string" }, runs: { type: "string", default: "3" }, "settle-ms": { type: "string", default: "6000" } } });
if (a.out === undefined) throw new Error("--out is required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(a.runs);
const SETTLE_MS = Number(a["settle-ms"]);
const SOCKETS = join(homedir(), ".caret-run", "sockets");
const HELPER_SOCK = join(SOCKETS, "h6-offers-helper.sock");
const HOST_SOCK = join(SOCKETS, "h6-offers-host.sock");
const PIDS = [5150, 6160, 7170];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log: string[] = [];

for (const pid of PIDS) {
  let live = true;
  try {
    process.kill(pid, 0);
  } catch (e) {
    live = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  if (live) throw new Error(`pid ${pid} is a live process; the recordings' pids must not exist. Nothing was started.`);
}

/** A5's fake Jev (offers_socket_acceptance.ts) for every question that is not a router's. */
const FILL_VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com", Phone: "+1 (512) 555-0142" };
const fakeJev: AskJev = async (req) => {
  if (req.questions.finished !== undefined) {
    const done = /done|passed/i.test(String((req.state as Record<string, unknown>).lines_that_changed));
    return { model: "jev-test", answers: { finished: { choice: done ? "yes" : "no", confidence: 0.9 }, waiting: { choice: "no", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  }
  return jevPickingText((_, instructions) => FILL_VALUES[/Label: '([^']+)'/.exec(instructions)?.[1] ?? ""] ?? null)(req);
};

/** Each recording and the offer kind it exists to produce. */
const RECORDINGS: { file: string; wanted: string }[] = [
  { file: "offers-fill.ndjson", wanted: "popup" },
  { file: "offers-loop.ndjson", wanted: "alternatives" },
  { file: "offers-pending.ndjson", wanted: "action" },
];

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
type HostState = { helper?: { connected: boolean; offers: number; routeDecisions?: number }; routing?: Record<string, unknown> };
const state = async (): Promise<HostState> => (await hostCommand("state")) as HostState;
async function until<T>(what: string, f: () => Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await f().catch(() => null);
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const host: ChildProcess = spawnCaret(CARET, [
  "--helper-socket", HELPER_SOCK, "--socket", HOST_SOCK, "--no-ghost", "--perch", "hidden", "--surfaces", "headless", "--test-hooks",
  "--allow-pids", PIDS.join(","), "--status-item", "off", "--settings", join(mkdtempSync(join(tmpdir(), "caret-h6-offers-")), "settings.json"),
], launchSecret);
host.stderr?.setEncoding("utf8");
host.stderr?.on("data", (d: string) => log.push(`host: ${d.trim().slice(0, 300)}`));
process.on("exit", () => host.kill("SIGTERM"));

interface Replay {
  recording: string;
  /** The recording's own time span, from its first line to its last. */
  spanMs: number;
  offersSent: Record<string, number>;
  hostOffers: number;
  wantedShown: boolean;
  decisions: unknown[];
}

async function replay(mode: "off" | "live", file: string, wanted: string, routed: ReturnType<typeof routedJev>): Promise<Replay> {
  const dir = mkdtempSync(join(tmpdir(), "caret-h6-offers-"));
  const store = new Store(join(dir, "data"));
  const sent: HelperMessage[] = [];
  let server: HelperServer | null = null;
  const routing = routingHarness(mode);
  const helper = new Helper({
    store,
    askJev: routed.askJev,
    ...routing.options,
    shadow: false,
    allowBackgroundFocus: false,
    publish: (m) => {
      sent.push(m);
      server?.publish(m);
    },
    sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
    warn: (l) => log.push(`helper: ${l}`),
  });
  server = new HelperServer(HELPER_SOCK, () => helper, (l) => log.push(`server: ${l}`), launchSecret);
  await server.listen();
  const reader = await SocketReader.connect(HELPER_SOCK);
  await until("the host on the helper", async () => ((await state()).helper?.connected ? true : null), 8000);
  const before = (await state()).helper?.offers ?? 0;
  const lines = loadRecording(file);
  await reader.replay(lines, { applied: (w, at) => helper.model.windows.get(w)?.updatedAt === at, tick: (at) => helper.tick(at) });
  await sleep(SETTLE_MS);
  await routing.settle(helper);
  const after = (await state()).helper?.offers ?? 0;
  const offersSent: Record<string, number> = {};
  for (const m of sent) if (m.type === "popup" || m.type === "alternatives" || m.type === "action") offersSent[m.type] = (offersSent[m.type] ?? 0) + 1;
  const ats = lines.map((l) => (l as { at?: number }).at).filter((x): x is number => typeof x === "number");
  const decisions = (helper.routing?.decisions ?? []).map((d) => ({ outcome: d.outcome, by: d.by, local: d.local, route: d.route, breakpoint: d.breakpoint, confidence: d.confidence, latencyMs: d.latencyMs }));
  await routing.stop(helper);
  reader.close();
  helper.shutdown();
  await server.close();
  helper.memory.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  await until("the host to notice the helper left", async () => ((await state()).helper?.connected === false ? true : null), 5000);
  return { recording: file, spanMs: ats.length > 1 ? Math.max(...ats) - Math.min(...ats) : 0, offersSent, hostOffers: after - before, wantedShown: (offersSent[wanted] ?? 0) > 0, decisions };
}

const result: Record<string, unknown> = { at: new Date().toISOString(), runs: RUNS, settleMs: SETTLE_MS };
try {
  await until("the host's socket", async () => ((await state()) ? true : null), 15_000);
  for (const mode of ["off", "live"] as const) {
    await hostCommand(`settings set routing ${mode === "live" ? "on" : "off"}`);
    const routed = routedJev(mode, fakeJev);
    const replays: Replay[] = [];
    for (let run = 1; run <= RUNS; run++) for (const r of RECORDINGS) replays.push(await replay(mode, r.file, r.wanted, routed));
    const shown = replays.reduce((n, r) => n + r.hostOffers, 0);
    const hours = replays.reduce((n, r) => n + r.spanMs, 0) / 3_600_000;
    result[mode] = {
      offersShown: shown,
      replayedHours: Number(hours.toFixed(4)),
      offersPerHour: hours > 0 ? Number((shown / hours).toFixed(1)) : null,
      wantedShown: `${replays.filter((r) => r.wantedShown).length}/${replays.length}`,
      router: routed.usage(),
      hostRouting: (await state()).routing ?? null,
      replays,
    };
    console.log(`${mode}: ${shown} offers shown, wanted ${replays.filter((r) => r.wantedShown).length}/${replays.length}, router ${JSON.stringify(routed.usage())}`);
  }
} catch (e) {
  result.error = String(e).slice(0, 400);
  console.log(`error: ${result.error}`);
} finally {
  writeFileSync(join(OUT, "offers-routing.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(OUT, "offers-routing.log"), log.join("\n") + "\n");
  host.kill("SIGTERM");
  process.exit(result.error === undefined ? 0 : 1);
}
