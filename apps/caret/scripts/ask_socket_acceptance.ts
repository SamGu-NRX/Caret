// Ask Caret over the sockets (brief A13, acceptance 2): an instruction typed into the host's ask field
// becomes the helper's proposal card; Tab runs it on caret-fixture under an act grant, the field is
// read back from the fixture's own dump, and the grant is revoked; a Send is shown as a hand-off and
// never pressed; Esc mid-run says who stopped it; a plan the helper refuses becomes a sentence.
//
//   node apps/caret/scripts/ask_socket_acceptance.ts --bin <screen-reader build dir> --caret <Caret binary> --out DIR [--rounds 5]
//
// GUI gates: caret-fixture's executor and reference windows are visible (ordered back, never
// activated), so this is an on-screen run: start it under ~/.caret-run/evidence/host/a13/gui.sh (the gui
// lease, gui.lock, 300 s idle, no quiet window, stopped when input arrives). It refuses to start
// unless gui.lock is held.
//
// Processes, all started here and only these signalled: caret-fixture (executor and reference
// windows), the reader caret-screen WITHOUT --act-pids (only its pid), and the built host with
// `--surfaces headless --perch hidden --status-item off --no-ghost` and test hooks, so it draws
// nothing, opens no window and posts no event. The helper runs in this process with its real planner,
// executor, offer registry and socket server; Jev is a fake that answers from each case's expected
// plan (as helper/scripts/planner-eval.ts does). The ask field is driven only through the host's
// debug socket (`ask type`, `ask submit`, `ask key tab|esc`), which calls what the field's keys call.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Helper } from "../../../helper/src/helper.ts";
import { HelperServer } from "../../../helper/src/server.ts";
import { Store } from "../../../helper/src/store.ts";
import { MemoryStore } from "../../../helper/src/patterns/memory.ts";
import type { AskJev, JevRequest } from "../../../helper/src/fill/jev.ts";
import type { HelperMessage, TaskProgress } from "../../../helper/src/protocol.ts";
import { fixtureExecutable } from "../../../helper/scripts/fixture-path.ts";

const { values: a } = parseArgs({
  options: {
    bin: { type: "string" },
    caret: { type: "string" },
    out: { type: "string" },
    rounds: { type: "string", default: "5" },
  },
});
for (const k of ["bin", "caret", "out"] as const) if (a[k] === undefined) throw new Error(`--${k} is required`);
// lockf -t 0 on a held lock exits 75 (EX_TEMPFAIL): the caller holds gui.lock.
if (spawnSync("/usr/bin/lockf", ["-t", "0", join(process.env.HOME ?? "", ".long-run", "locks", "gui.lock"), "true"]).status !== 75) {
  throw new Error("refused: run under ~/.caret-run/evidence/host/a13/gui.sh (gui lease and gui.lock), since the fixture's windows are visible");
}
const OUT = resolve(a.out as string);
mkdirSync(OUT, { recursive: true });
const ROUNDS = Number(a.rounds);
const TITLE = "Caret Fixture — Executor";

// MARK: - cases

type DumpField = "name" | "email" | "reference" | "message" | "eventTitle" | "notes" | "billingCity" | "billingStreet" | "shippingCity" | "shippingStreet";
const FIELD_NAME: Record<DumpField, string> = {
  name: "Name", email: "Email", reference: "Reference", message: "Message", eventTitle: "Event title", notes: "Notes",
  billingCity: "Billing City", billingStreet: "Billing Street", shippingCity: "Shipping City", shippingStreet: "Shipping Street",
};
interface Case {
  id: string;
  instruction: string;
  writes: Partial<Record<DumpField, string>>;
  press?: { label: string; why: "outbound" };
  /** Esc after the first write is verified; the second write is held back until then. */
  esc?: true;
  /** Jev agrees on the window at low confidence: the helper refuses as unsure. */
  unsure?: true;
  /** What the host's ask field must show. */
  steps?: string[];
  line: string;
}
const q = (v: string): string => `“${v}”`;
const CASES: Case[] = [
  { id: "write", instruction: "Set Name to Priya Raman", writes: { name: "Priya Raman" }, steps: [`Put ${q("Priya Raman")} in Name`], line: "Done, in " },
  {
    id: "send", instruction: "Write 'See you at 3' in Message and send it", writes: { message: "See you at 3" }, press: { label: "Send", why: "outbound" },
    steps: [`Put ${q("See you at 3")} in Message`, "Press Send"], line: "Filled 1 field. Your turn: press Send in ",
  },
  {
    id: "esc", instruction: "Set the shipping city to Austin and the shipping street to 1200 Barton Springs Rd", writes: { shippingCity: "Austin", shippingStreet: "1200 Barton Springs Rd" }, esc: true,
    steps: [`Put ${q("Austin")} in Shipping City`, `Put ${q("1200 Barton Springs Rd")} in Shipping Street`], line: "You stopped it before step 2 of 2",
  },
  { id: "unsure", instruction: "Fill in the usual", writes: {}, unsure: true, line: "I wasn't sure enough which field or window you meant. Try naming it." },
];

const fakeJev: AskJev = async (req: JevRequest) => {
  const instruction = (req.state as { instruction?: string }).instruction ?? "";
  const c = CASES.find((x) => x.instruction === instruction);
  if (c === undefined) throw new Error(`the fake Jev has no case for '${instruction}'`);
  const byName = new Map(Object.entries(c.writes).map(([k, v]) => [FIELD_NAME[k as DumpField], v]));
  const answers: Record<string, { choice: string; confidence: number }> = {};
  for (const [id, question] of Object.entries(req.questions)) {
    const ins = String(question.instructions);
    const find = (pred: (d: string) => boolean): string | undefined => Object.entries(question.criteria).find(([, d]) => d !== null && pred(String(d)))?.[0];
    let choice: string | undefined;
    if (id === "window") choice = find((d) => d.endsWith(`'${TITLE}'`));
    else if (id === "press") choice = c.press === undefined ? "none" : find((d) => d === `the '${c.press?.label}' button`);
    else {
      const label = /Label: '([^']+)'/.exec(ins)?.[1];
      const section = /Section: '([^']+)'/.exec(ins)?.[1];
      const want = byName.get([section, label].filter((x) => x !== undefined).join(" "));
      choice = want === undefined ? "keep" : find((d) => d.startsWith(`"${want}"`));
    }
    if (choice === undefined) throw new Error(`the fake Jev found no option for ${id} in ${c.id}`);
    answers[id] = { choice, confidence: c.unsure === true && id === "window" ? 0.3 : 0.95 };
  }
  return { model: "jev-fake", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
};

// MARK: - helper, fixture, reader, host

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "caret-a13-ask-"));
const HELPER_SOCK = join(tmp, "helper.sock");
const HOST_SOCK = join(tmp, "host.sock");
const store = new Store(join(tmp, "data"));
const memory = new MemoryStore(join(tmp, "data"));
const toReader: { at: number; type: string; taskId: string; sent: boolean }[] = [];
const progress: TaskProgress[] = [];
const errors: string[] = [];
const slow = new Set<string>();
const release = new Map<string, () => void>();
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  memory,
  askJev: fakeJev,
  shadow: false,
  allowBackgroundFocus: false,
  publish: (m: HelperMessage) => {
    if (m.type === "taskProgress") progress.push(m);
    if (m.type === "error") errors.push(m.message);
    server?.publish(m);
  },
  sendToReader: (m) => {
    const sent = server?.sendToReader(m) ?? false;
    if (m.type === "actGrant" || m.type === "actRevoke" || m.type === "calendarGrant") toReader.push({ at: Date.now(), type: m.type, taskId: m.taskId, sent });
    return sent;
  },
  executorHooks: {
    // The Esc case's second write waits until the host's Esc has been pressed.
    beforeStep: async (taskId: string, step: number) => {
      if (slow.has(taskId) && step === 1) await new Promise<void>((r) => release.set(taskId, r));
    },
  },
});
server = new HelperServer(HELPER_SOCK, () => helper, (l) => errors.push(l));
await server.listen();
const tick = setInterval(() => helper.tick(), 250);

const procs: ChildProcessWithoutNullStreams[] = [];
process.on("exit", () => {
  for (const p of procs) p.kill("SIGTERM");
  rmSync(tmp, { recursive: true, force: true });
});
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => process.exit(143));

const fixture = spawn(fixtureExecutable(a.bin as string), ["--windows", "executor,reference", "--duration", "1800"]);
procs.push(fixture);
let fixturePid = 0;
let fixtureBuf = "";
const replies: ((o: Record<string, unknown>) => void)[] = [];
fixture.stdout.setEncoding("utf8");
fixture.stdout.on("data", (d: string) => {
  fixtureBuf += d;
  let nl: number;
  while ((nl = fixtureBuf.indexOf("\n")) >= 0) {
    const line = fixtureBuf.slice(0, nl);
    fixtureBuf = fixtureBuf.slice(nl + 1);
    const m = /^caret-fixture pid (\d+)/.exec(line);
    if (m?.[1] !== undefined) fixturePid = Number(m[1]);
    else if (line.startsWith("{")) replies.shift()?.(JSON.parse(line) as Record<string, unknown>);
  }
});
const fx = (cmd: string): Promise<Record<string, unknown>> => new Promise((res) => (replies.push(res), fixture.stdin.write(cmd + "\n")));
const until = async <T>(what: string, get: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 15_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = await get();
    if (v !== null && v !== undefined && v !== false) return v as T;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(80);
  }
};
await until("the fixture", () => fixturePid > 0);
await sleep(800);
const reader = spawn(join(a.bin as string, "caret-screen"), ["--socket", HELPER_SOCK, "--only-pids", String(fixturePid), "--event-pids", String(fixturePid)]);
procs.push(reader);
let readerLog = "";
reader.stderr.setEncoding("utf8");
reader.stderr.on("data", (d: string) => (readerLog += d));
const executorWindow = () => [...helper.model.windows.values()].find((w) => w.window.title.startsWith(TITLE));
await until("the executor window in the screen model", () => executorWindow() !== undefined);

const host = spawn(a.caret as string, [], {
  env: {
    ...process.env,
    CARET_SCREEN_SOCKET: HELPER_SOCK, CARET_HOST_SOCKET: HOST_SOCK, CARET_SETTINGS_PATH: join(tmp, "settings.json"),
    CARET_SURFACES: "headless", CARET_PERCH: "hidden", CARET_STATUS_ITEM: "off", CARET_GHOST: "off", CARET_TEST_HOOKS: "1",
    CARET_ONBOARDING: "off", CARET_ALLOW_PIDS: String(fixturePid),
  },
});
procs.push(host);
let hostLog = "";
host.stderr.setEncoding("utf8");
host.stderr.on("data", (d: string) => (hostLog += d));
const hostCmd = (cmd: string): Promise<Record<string, unknown>> =>
  new Promise((res, rej) => {
    const c = createConnection(HOST_SOCK);
    let buf = "";
    c.setEncoding("utf8");
    c.on("connect", () => c.write(cmd + "\n"));
    c.on("data", (d: string) => {
      buf += d;
      if (buf.includes("\n")) {
        c.end();
        try { res(JSON.parse(buf.slice(0, buf.indexOf("\n"))) as Record<string, unknown>); } catch (e) { rej(e); }
      }
    });
    c.on("error", rej);
  });
await until("the host's socket", async () => { try { return (await hostCmd("ping")).ok === true; } catch { return false; } });
await until("the host connected to the helper", async () => ((await hostCmd("state")).helper as { connected?: boolean } | undefined)?.connected === true);

// MARK: - running

interface Ask { text: string; phase: string; requestId?: string; card?: { title: string; steps: { text: string; yours: boolean; state: string }[]; offerKey: string; action: string }; line?: string }
const ask = async (cmd = ""): Promise<Ask> => (await hostCmd(cmd === "" ? "ask" : `ask ${cmd}`)) as unknown as Ask;
interface Dump { fields: Record<string, string | null>; sent: boolean; deleted: boolean; paid: boolean }
interface Row { round: number; id: string; checks: Record<string, boolean>; detail: Record<string, unknown> }
const rows: Row[] = [];

for (let round = 1; round <= ROUNDS; round++) {
  for (const c of CASES) {
    await fx("reset");
    const w = executorWindow();
    if (w !== undefined) await helper.readerVerb({ kind: "walk", pid: w.app.pid, windowId: w.window.windowId });
    const checks: Record<string, boolean> = {};
    const detail: Record<string, unknown> = {};
    await ask(`type ${c.instruction}`);
    const submitted = await hostCmd("ask submit");
    checks.sent = submitted.sent === true;
    const answered = await until("the proposal on the host", async () => { const s = await ask(); return s.phase === "proposed" || s.phase === "failed" ? s : null; });
    detail.answered = answered;
    if (c.unsure === true) {
      checks.refusedAsSentence = answered.phase === "failed" && answered.line === c.line;
      const tab = await hostCmd("ask key tab");
      checks.tabDoesNothing = tab.consumed === false;
    } else {
      const card = answered.card;
      checks.proposalCard = answered.phase === "proposed" && card !== undefined;
      checks.steps = JSON.stringify(card?.steps.map((s) => s.text)) === JSON.stringify(c.steps);
      checks.handoffMarkedYours = c.press === undefined ? card?.steps.every((s) => !s.yours) === true : card?.steps.at(-1)?.yours === true && card.steps.filter((s) => s.yours).length === 1;
      const key = card?.offerKey ?? "";
      if (c.esc === true) slow.add(key);
      const grants0 = toReader.length;
      const tab = await hostCmd("ask key tab");
      checks.tabConsumed = tab.consumed === true;
      if (c.esc === true) {
        await until("the first write verified", () => progress.some((p) => p.taskId === key && p.phase === "verified" && p.step === 0));
        const esc = await hostCmd("ask key esc");
        checks.escConsumed = esc.consumed === true;
        release.get(key)?.();
      }
      const ended = await until("the run's end on the host", async () => { const s = await ask(); return s.phase === "ended" ? s : null; });
      detail.ended = ended;
      checks.line = c.line.endsWith(" ") ? (ended.line ?? "").startsWith(c.line) : ended.line === c.line;
      const revoked = await until("actRevoke for the task", () => toReader.slice(grants0).some((g) => g.taskId === key && g.type === "actRevoke" && g.sent), 10_000).catch(() => false);
      const mine = toReader.slice(grants0).filter((g) => g.taskId === key);
      detail.grants = mine.map((g) => `${g.type}${g.sent ? "" : " (not delivered)"}`);
      checks.grantedThenRevoked = mine[0]?.type === "actGrant" && mine[0].sent && revoked === true && mine.at(-1)?.type === "actRevoke";
      // The reader's side: a write under the task's id after the revoke is refused and changes nothing.
      const ew = executorWindow();
      const nameNode = ew === undefined ? undefined : [...ew.nodes.values()].find((n) => n.label === "Name" && n.editable === true);
      if (ew !== undefined && nameNode !== undefined) {
        const before = ((await fx("dump")) as unknown as Dump).fields.name ?? "";
        const r = await helper.readerVerb({ kind: "write", pid: ew.app.pid, windowId: ew.window.windowId, key: nameNode.key, role: nameNode.role, attribute: "value", expect: before, value: "after revoke", taskId: key });
        const afterDump = ((await fx("dump")) as unknown as Dump).fields.name ?? "";
        detail.afterRevoke = r.outcome;
        checks.writeAfterRevokeRefused = r.outcome === "notAllowed" && afterDump === before;
      } else checks.writeAfterRevokeRefused = false;
      const d = (await fx("dump")) as unknown as Dump;
      const want: Record<string, string> = Object.fromEntries((Object.keys(FIELD_NAME) as DumpField[]).map((k) => [k, c.writes[k] ?? ""]));
      // Esc stopped the run before its second write: that field stays empty.
      if (c.esc === true) want.shippingStreet = "";
      const wrong = Object.entries(want).filter(([k, v]) => d.fields[k] !== v).map(([k, v]) => `${k}='${d.fields[k]}' want '${v}'`);
      detail.readBack = wrong;
      checks.readBack = wrong.length === 0;
      checks.nothingPressed = !d.sent && !d.deleted && !d.paid;
      await ask("key esc");
    }
    rows.push({ round, id: c.id, checks, detail });
    const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    process.stdout.write(`round ${round} ${c.id}: ${failed.length === 0 ? "ok" : `FAILED ${failed.join(", ")}`}\n`);
  }
}
await fx("reset");
const hostState = await hostCmd("state");

// MARK: - report

clearInterval(tick);
for (const p of procs) p.kill("SIGTERM");
await server.close();
memory.close();
store.close();

const md: string[] = ["# Ask Caret over the sockets (A13 acceptance 2)", ""];
md.push(`Real helper (planner, executor, act grants) in process with a fake Jev; caret-fixture; the reader without --act-pids; the built host headless with test hooks. ${ROUNDS} rounds of ${CASES.length} cases. Fields read from the fixture's own dump.`, "");
const count = (id: string, k: string): string => `${rows.filter((r) => r.id === id && r.checks[k] === true).length}/${rows.filter((r) => r.id === id && k in r.checks).length}`;
md.push("| Case | Instruction | Proposal card | Steps as expected | Hand-off marked yours | Tab ran it | Line | Read back | Granted then revoked | Nothing pressed |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const c of CASES) {
  if (c.unsure === true) {
    md.push(`| ${c.id} | ${c.instruction} | refused as a sentence ${count(c.id, "refusedAsSentence")}; Tab did nothing ${count(c.id, "tabDoesNothing")} | - | - | - | - | - | - | - |`);
    continue;
  }
  md.push(`| ${c.id} | ${c.instruction} | ${count(c.id, "proposalCard")} | ${count(c.id, "steps")} | ${count(c.id, "handoffMarkedYours")} | ${count(c.id, "tabConsumed")} | ${count(c.id, "line")} | ${count(c.id, "readBack")} | ${count(c.id, "grantedThenRevoked")} | ${count(c.id, "nothingPressed")} |`);
}
const all = rows.every((r) => Object.values(r.checks).every(Boolean));
md.push("", `All checks: ${all ? "passed" : "FAILED"}. Helper errors: ${errors.length}. Host planRequests ${(hostState.helper as Record<string, number>).planRequests}, planProposals ${(hostState.helper as Record<string, number>).planProposals}, accepts ${(hostState.helper as Record<string, number>).accepts}, stops ${(hostState.helper as Record<string, number>).stops}.`);
writeFileSync(join(OUT, "ask-acceptance.md"), md.join("\n") + "\n");
writeFileSync(join(OUT, "ask-acceptance.json"), JSON.stringify({ rows, errors, toReader, hostHelper: hostState.helper }, null, 2) + "\n");
writeFileSync(join(OUT, "reader.log"), readerLog);
writeFileSync(join(OUT, "host.log"), hostLog);
console.log(md.join("\n"));
process.exit(all ? 0 : 1);
