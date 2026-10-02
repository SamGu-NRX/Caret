// caret-helper: listens on the screen socket for caret-screen and for consumers.
//   node src/main.ts [--socket PATH] [--data-dir DIR] [--shadow] [--no-jev] [--allow-background-focus]
// The Jev key comes from TYPESAFE_API_KEY or the .env file named by CARET_ENV_FILE, read when a request is made.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
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
  },
});

const warn = (line: string): void => {
  process.stderr.write(`[caret-helper ${new Date().toISOString()}] ${line}\n`);
};

if (!args["no-jev"] && !args.shadow) loadJevKey(); // fail at start, not at the first focus, when no key is configured

const store = new Store(args["data-dir"]);
let server: HelperServer | null = null;
const helper = new Helper({
  store,
  askJev: args["no-jev"] ? null : makeJevClient(() => loadJevKey()),
  shadow: args.shadow,
  allowBackgroundFocus: args["allow-background-focus"],
  publish: (m) => server?.publish(m),
  warn,
});
server = new HelperServer(args.socket, () => helper, warn);
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

let stopping = false;
const stop = async (signal: string): Promise<void> => {
  if (stopping) return;
  stopping = true;
  clearInterval(tick);
  clearInterval(status);
  helper.shutdown();
  await server?.close();
  store.close();
  warn(`stopped on ${signal}`);
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
