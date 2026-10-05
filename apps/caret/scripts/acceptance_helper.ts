// The helper for A13's on-screen acceptance (onscreen_acceptance.py): the real helper, its planner,
// event card generator, executor and socket server, with a fake Jev and a chosen calendar. It writes
// what the run checks to --state every 200 ms: the fake calendar's events and calls, the task
// progress it published, and its act and calendar grants and revokes.
//
//   node apps/caret/scripts/acceptance_helper.ts --socket PATH --state FILE --calendar fake|reader [--routing off|live]
//
// --routing live (H6, routing_option.ts): D2-02's router runs, its questions to live Jev; the state file
// then carries the router's decisions and spend.
//
// The fake Jev says yes to "is the writer arranging something they will attend" for the event
// sentence the run types, and answers the planner from the one instruction the run asks
// (planner-eval.ts's rule: each field and press by its expected value). Anything else it is asked
// gets "no" or "none", so no other offer competes with the ones under test.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import { MemoryStore } from "../../../helper/src/patterns/memory.ts";
import { FakeCalendar } from "../../../helper/src/executor/means.ts";
import type { AskJev, JevRequest } from "../../../helper/src/fill/jev.ts";
import type { HelperMessage, TaskProgress } from "../../../helper/src/protocol.ts";
import { helperRouting, routedJev } from "./routing_option.ts";

const { values: a } = parseArgs({ options: { socket: { type: "string" }, state: { type: "string" }, calendar: { type: "string", default: "fake" }, "auth-fd": { type: "string" }, routing: { type: "string", default: "off" } } });
// B23: the launch secret caret-screen also gets, read to its end from the descriptor the caller names
// (0: standard input), so the reader accepts this helper.
const launchSecret = a["auth-fd"] === undefined ? null : readFileSync(Number(a["auth-fd"]));
if (a.socket === undefined || a.state === undefined) throw new Error("--socket and --state are required");
if (a.calendar !== "fake" && a.calendar !== "reader") throw new Error("--calendar is fake or reader");

export const INSTRUCTION = "Write 'See you at 3' in Message and send it";
const WRITES = new Map([["Message", "See you at 3"]]);
const TITLE = "Caret Fixture — Executor";

const asked: string[] = [];
const fakeJev: AskJev = async (req: JevRequest) => {
  const answers: Record<string, { choice: string; confidence: number }> = {};
  const instruction = (req.state as { instruction?: string }).instruction;
  for (const [id, q] of Object.entries(req.questions)) {
    const keys = Object.keys(q.criteria);
    const find = (pred: (d: string) => boolean): string | undefined => Object.entries(q.criteria).find(([, d]) => d !== null && pred(String(d)))?.[0];
    let choice: string | undefined;
    if (id === "attend") choice = "yes";
    else if (instruction === INSTRUCTION) {
      if (id === "window") choice = find((d) => d.endsWith(`'${TITLE}'`));
      else if (id === "press") choice = find((d) => d === "the 'Send' button");
      else {
        const label = /Label: '([^']+)'/.exec(String(q.instructions))?.[1];
        const want = label === undefined ? undefined : WRITES.get(label);
        choice = want === undefined ? "keep" : find((d) => d.startsWith(`"${want}"`));
      }
    } else choice = keys.find((k) => k === "no" || k === "none" || k === "keep");
    asked.push(`${id}:${choice ?? "?"}`);
    answers[id] = { choice: choice ?? keys[keys.length - 1] ?? "none", confidence: 0.95 };
  }
  return { model: "jev-fake", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
};

const routed = routedJev(a.routing, fakeJev);
const tmp = mkdtempSync(join(tmpdir(), "caret-a13-helper-"));
const store = new Store(join(tmp, "data"));
const memory = new MemoryStore(join(tmp, "data"));
const fake = a.calendar === "fake" ? new FakeCalendar() : null;
const progress: TaskProgress[] = [];
const grants: { at: number; type: string; taskId: string }[] = [];
const offers: { at: number; type: string; key: string; app?: string; text?: string }[] = [];
const errors: string[] = [];
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  memory,
  askJev: routed.askJev,
  ...helperRouting(a.routing),
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m: HelperMessage) => {
    if (m.type === "taskProgress") progress.push(m);
    if (m.type === "action") offers.push({ at: Date.now(), type: m.type, key: m.offerKey, app: m.app, text: m.endState.text });
    if (m.type === "popup" || m.type === "alternatives") offers.push({ at: Date.now(), type: m.type, key: m.offerKey });
    if (m.type === "error") errors.push(m.message);
    server?.publish(m);
  },
  sendToReader: (m) => {
    const sent = server?.sendToReader(m) ?? false;
    if (m.type === "actGrant" || m.type === "actRevoke" || m.type === "calendarGrant") grants.push({ at: Date.now(), type: m.type, taskId: m.taskId });
    return sent;
  },
  calendar: fake ?? "reader",
  // The fake keeps events in memory under this name; the reader creates a calendar of it on a
  // local source and deletes it after, only with --calendar-test.
  eventCalendar: "Caret Test",
});
server = new HelperServer(a.socket, () => helper, (l) => errors.push(l), launchSecret);
await server.listen();
const tick = setInterval(() => helper.tick(), 250);
const write = (): void => {
  writeFileSync(a.state as string, JSON.stringify({
    calendar: a.calendar, events: fake === null ? null : [...fake.events.values()], calls: fake?.calls ?? null,
    progress, grants, offers, asked, errors,
    router: routed.usage(),
    decisions: (helper.routing?.decisions ?? []).map((d) => ({ at: d.at, key: d.key, outcome: d.outcome, by: d.by, local: d.local, breakpoint: d.breakpoint, confidence: d.confidence, latencyMs: d.latencyMs, textRevision: d.textRevision })),
  }) + "\n");
};
const dump = setInterval(write, 200);
const stop = async (): Promise<void> => {
  clearInterval(tick);
  clearInterval(dump);
  write();
  helper.shutdown();
  await server?.close();
  memory.close();
  store.close();
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
