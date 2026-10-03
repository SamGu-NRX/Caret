// The calendar's TCC refusal on a Mac without Calendar access (brief B16), end to end: the helper's
// executor, ReaderCalendar, the socket and the real caret-screen with --calendar-test.
//
//   node scripts/calendar-refusal-host.ts --bin ../apps/screen-reader/.build/debug --out DIR
//
// It first asks `caret-screen --calendar-probe`, which reads the authorization status only, and refuses
// to go on if access is already granted: then the adapter would create a calendar here, and that run
// belongs in the VM (evidence/screen/b16/vm-job). Without access the adapter answers every verb blocked
// before it creates an EventKit store, and nothing ever asks for access.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { HelperMessage, TaskProgress } from "../src/protocol.ts";

const { values: a } = parseArgs({ options: { bin: { type: "string" }, out: { type: "string" } } });
if (a.bin === undefined || a.out === undefined) throw new Error("--bin and --out are required");
const OUT = resolve(a.out);
mkdirSync(OUT, { recursive: true });
const BIN = join(a.bin, "caret-screen");

const probe = JSON.parse(execFileSync(BIN, ["--calendar-probe"], { encoding: "utf8" })) as { calendar: string };
if (probe.calendar === "fullAccess") {
  console.log("Calendar access is granted here, so the adapter would write; this check runs only where it is not. Nothing was started.");
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), "caret-cal-host-"));
const socketPath = join(dir, "s.sock");
const store = new Store(dir);
const published: HelperMessage[] = [];
let server: HelperServer | null = null;
const helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => (published.push(m), server?.publish(m)), sendToReader: (c) => server?.sendToReader(c) ?? false, calendar: "reader" });
server = new HelperServer(socketPath, () => helper, () => {});
await server.listen();
// The reader reads only this script's own process, which has no windows.
const reader = spawn(BIN, ["--socket", socketPath, "--calendar-test", "--only-pids", String(process.pid)]);
let readerLog = "";
reader.stderr.setEncoding("utf8");
reader.stderr.on("data", (d: string) => (readerLog += d));
process.on("exit", () => reader.kill("SIGTERM"));
const t0 = Date.now();
while (!helper.hasReader) {
  if (Date.now() - t0 > 20_000) throw new Error("the reader did not connect");
  await new Promise((r) => setTimeout(r, 100));
}

const plan = { id: "event", title: "Add Coffee with Dana", slots: {}, steps: [{ says: "Coffee with Dana is on Caret Test", end: { kind: "calendarEvent" as const, calendar: "Caret Test", title: "Coffee with Dana", start: "2026-10-08T15:00:00-05:00", end: "2026-10-08T15:30:00-05:00" } }] };
const r = await helper.executor.run("event-1", plan, {});
const last = published.filter((m): m is TaskProgress => m.type === "taskProgress").at(-1);
const probeAfter = JSON.parse(execFileSync(BIN, ["--calendar-probe"], { encoding: "utf8" })) as { calendar: string };
reader.kill("SIGTERM");
await new Promise((res) => reader.once("exit", res));
await server.close();
store.close();

const ok = r.outcome === "handoff" && last?.phase === "handoff" && last.blocked === "tcc" && probeAfter.calendar === probe.calendar;
const md = [
  "# Calendar refusal on the host (no Calendar access)",
  "",
  `- Probe before: ${probe.calendar}; after: ${probeAfter.calendar} (unchanged means nothing asked for access)`,
  `- Run: ${r.outcome} at step ${r.step}, acted ${r.acted}; last taskProgress: ${last?.phase} blocked=${last?.blocked ?? "-"}`,
  `- Detail: ${r.detail}`,
  `- Activity: ${JSON.stringify({ state: helper.tasks.get("event-1")?.state, cause: helper.tasks.get("event-1")?.cause })}`,
  `- Passed: ${ok}`,
];
writeFileSync(join(OUT, "calendar-refusal-host.md"), md.join("\n") + "\n");
writeFileSync(join(OUT, "reader.log"), readerLog);
console.log(md.join("\n"));
process.exit(ok ? 0 : 1);
