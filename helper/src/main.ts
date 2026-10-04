// caret-helper: listens on the screen socket for caret-screen and for consumers.
//   node src/main.ts --auth-fd N [--socket PATH] [--data-dir DIR] [--shadow] [--no-jev] [--allow-background-focus] [--fill-cutoff C]
// --auth-fd names an inherited descriptor holding the 32-byte launch secret, which caret-screen also got from the
// launcher (src/launch.ts); the helper answers the reader's challenge with it. It never comes on argv or in the environment.
//   node src/main.ts --audit-out FILE --audit-seen FILE --socket PATH --data-dir DIR [--audit-probe-every SECONDS]
// The second form is the read-only audit (src/audit.ts): shadow mode, Jev off, counts written to
// --audit-out every minute and at exit, the seen-text hashes to --audit-seen at exit. With
// --audit-probe-every it also times the generator on the real windows at that interval.
// The Jev key comes from TYPESAFE_API_KEY or the .env file named by CARET_ENV_FILE, read when a request is made.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { closeSync, readFileSync, writeFileSync } from "node:fs";
import { Helper } from "./helper.ts";
import { HelperServer } from "./server.ts";
import { Store } from "./store.ts";
import { loadJevKey, makeJevClient } from "./fill/jev.ts";

const { values: args } = parseArgs({
  options: {
    socket: { type: "string", default: join(homedir(), ".caret-run", "sockets", "screen.sock") },
    "data-dir": { type: "string", default: join(homedir(), "Library", "Application Support", "CaretV2") },
    shadow: { type: "boolean", default: false },
    "no-jev": { type: "boolean", default: false },
    "allow-background-focus": { type: "boolean", default: false },
    "status-every": { type: "string", default: "60" },
    "fill-cutoff": { type: "string" },
    "audit-out": { type: "string" },
    "audit-seen": { type: "string" },
    "audit-probe-every": { type: "string" },
    "auth-fd": { type: "string" },
  },
});

const warn = (line: string): void => {
  process.stderr.write(`[caret-helper ${new Date().toISOString()}] ${line}\n`);
};

const auditOut = args["audit-out"];
const auditSeen = args["audit-seen"];
if ((auditOut === undefined) !== (auditSeen === undefined)) throw new Error("--audit-out and --audit-seen go together");
if (auditOut !== undefined) {
  // The audit runs beside a shadow logger that must not be disturbed: it needs its own socket and data directory.
  const given = process.argv.slice(2);
  if (!given.includes("--socket") || !given.includes("--data-dir")) throw new Error("the audit needs its own --socket and --data-dir");
  args.shadow = true;
  args["no-jev"] = true;
}

if (!args["no-jev"] && !args.shadow) loadJevKey(); // fail at start, not at the first focus, when no key is configured

/** The launch secret from an inherited descriptor, read to its end and closed; null without --auth-fd. */
function launchSecret(fdArg: string | undefined): Buffer | null {
  if (fdArg === undefined) return null;
  const fd = Number(fdArg);
  if (!Number.isInteger(fd) || fd < 0 || fd === 1 || fd === 2) throw new Error(`--auth-fd ${fdArg} is not an inherited input descriptor (0, or 3 and above)`);
  const secret = readFileSync(fd);
  closeSync(fd);
  if (secret.length !== 32) throw new Error(`the launch secret on descriptor ${fd} is ${secret.length} bytes, expected 32`);
  return secret;
}
const secret = launchSecret(args["auth-fd"]);
if (secret === null) warn("no --auth-fd: caret-screen asks the helper to prove itself and will refuse this helper; start both with src/launch.ts");

const store = new Store(args["data-dir"]);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: args["no-jev"] ? null : makeJevClient(() => loadJevKey()),
  shadow: args.shadow,
  allowBackgroundFocus: args["allow-background-focus"],
  audit: auditOut !== undefined,
  ...(args["audit-probe-every"] === undefined ? {} : { auditProbeEveryMs: Number(args["audit-probe-every"]) * 1000 }),
  ...(args["fill-cutoff"] === undefined ? {} : { fillCutoff: Number(args["fill-cutoff"]) }),
  publish: (m) => server?.publish(m),
  sendToReader: (cmd) => server?.sendToReader(cmd) ?? false,
  // Event cards add to the reader's EventKit adapter, which answers only when started with --calendar-test.
  calendar: "reader",
  warn,
});
server = new HelperServer(args.socket, () => helper, warn, secret);
await server.listen();
warn(`listening on ${args.socket}; data in ${args["data-dir"]}; mode ${helper.mode}`);

const tick = setInterval(() => helper.tick(), 250);
const statusMs = Number(args["status-every"]) * 1000;
const status = setInterval(() => {
  const mem = process.memoryUsage();
  warn(
    `status mode=${helper.mode} windows=${helper.model.windows.size} texts=${helper.text.size} transfers10m=${helper.recentTransfers.length} rssMB=${(mem.rss / 1e6).toFixed(1)}`,
  );
}, statusMs);

const writeAudit = (): void => {
  if (helper.audit !== null && auditOut !== undefined) writeFileSync(auditOut, `${JSON.stringify(helper.audit.summary(), null, 2)}\n`, { mode: 0o600 });
};
const audit = helper.audit === null ? null : setInterval(writeAudit, 60_000);

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(tick);
  clearInterval(status);
  if (audit !== null) clearInterval(audit);
  helper.shutdown();
  if (helper.audit !== null && auditSeen !== undefined) {
    helper.audit.stop();
    writeAudit();
    writeFileSync(auditSeen, JSON.stringify(helper.audit.seen.toJSON()), { mode: 0o600 });
  }
  await server?.close();
  helper.memory.close();
  helper.journal.close();
  store.close();
  warn(`stopped on ${signal}`);
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
