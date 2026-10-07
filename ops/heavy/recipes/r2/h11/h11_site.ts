// H11 harness only (never in the repo): runs the repo's fixture site (fixtures/web-form/server.ts, copied from the
// build's export by stage.sh) in this process, so its oracle (site.tasks.oracle) is in reach, and answers the harness
// over a Unix socket. The task pages stay on 127.0.0.1:<port> for the browser; the oracle's reads and the one
// sanctioned press (README, "Driving a journey") go only over the socket, which a page or Caret's extension can't
// open, so nothing in the browser can read the oracle or make a press count as the harness's.
//
//   node h11_site.ts --port N --embed-port M --sock PATH [--sink] [--check] [--ttl SECONDS]
//
// Prints one JSON line {main, embed, sock, sink}. --sink also starts the README's NetworkSink (a proxy that answers
// nothing) and reports its port, for a browser launched with --proxy-server. --check starts, asks itself /pages and
// /summary over the socket, prints both, and exits: a host-side test of this file that leaves nothing running. --ttl
// exits after that many seconds, for a host-side test of the harness's client.
//
// Routes (GET unless noted; every reply is JSON, an error is {"error": "..."} with status 400):
//   /pages                      TASK_PAGES
//   /expect?page=P              tasks/expect/P.json (the person's sources and every field's expected value)
//   /loads?page=P               {loads, current}: every load that reported, and the ones values() reads now
//   /values?page=P              oracle.values(P)
//   /readings?page=P            oracle.readings(P) (value, kind, visible)
//   /baseline?page=P            oracle.baseline(P): the values at the first reading of the current loads
//   /score?page=P               oracle.score(P, expected)
//   /summary                    oracle.summary() plus every submit record and every press record
//   POST /press?page=P&target=T site.tasks.harnessPress(P, T)
import { existsSync, unlinkSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { NetworkSink } from "./oracle.ts";
import { FixtureSite } from "./server.ts";
import { loadExpectation, TASK_PAGES } from "./tasks/site.ts";

const { values: opts } = parseArgs({
  options: {
    port: { type: "string", default: "0" },
    "embed-port": { type: "string", default: "0" },
    sock: { type: "string" },
    sink: { type: "boolean", default: false },
    check: { type: "boolean", default: false },
    ttl: { type: "string", default: "0" },
  },
});
const sockPath = opts.sock;
if (sockPath === undefined || sockPath === "") throw new Error("h11_site.ts: --sock PATH is required");

const site = new FixtureSite();
await site.start(Number(opts.port), Number(opts["embed-port"]));
const oracle = site.tasks.oracle;
let sink: NetworkSink | null = null;
if (opts.sink) {
  sink = new NetworkSink(oracle);
  await sink.start();
}

function reply(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) }).end(text);
}

function need(url: URL, name: string): string {
  const v = url.searchParams.get(name);
  if (v === null || v === "") throw new Error(`missing ?${name}=`);
  return v;
}

async function route(req: IncomingMessage, url: URL): Promise<unknown> {
  const page = (): string => need(url, "page");
  switch (`${req.method} ${url.pathname}`) {
    case "GET /pages":
      return TASK_PAGES;
    case "GET /expect":
      return loadExpectation(page());
    case "GET /loads":
      return { loads: oracle.loads(page()), current: oracle.currentLoads(page()) };
    case "GET /values":
      return oracle.values(page());
    case "GET /readings": {
      const r = oracle.readings(page());
      if (r === null) throw new Error(`the oracle has no state from page ${page()}`);
      return r;
    }
    case "GET /baseline":
      return oracle.baseline(page());
    case "GET /score":
      return oracle.score(page(), loadExpectation(page()).expected);
    case "GET /summary":
      return { ...oracle.summary(), submitList: oracle.submits, pressList: oracle.presses, sinkPort: sink?.port ?? null };
    case "POST /press":
      return await site.tasks.harnessPress(page(), need(url, "target"));
    default:
      throw new Error(`no route ${req.method} ${url.pathname}`);
  }
}

if (existsSync(sockPath)) unlinkSync(sockPath);
const control = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://oracle.local");
  // Bodies are not used; drain any so the socket closes cleanly.
  req.resume();
  route(req, url).then(
    (body) => reply(res, 200, body),
    (e: unknown) => reply(res, 400, { error: e instanceof Error ? e.message : String(e) }),
  );
});
await new Promise<void>((resolve, reject) => {
  control.once("error", reject);
  control.listen(sockPath, () => resolve());
});
console.log(JSON.stringify({ main: site.mainOrigin, embed: site.embedOrigin, sock: sockPath, sink: sink?.port ?? null }));

if (Number(opts.ttl) > 0) {
  setTimeout(() => {
    if (existsSync(sockPath)) unlinkSync(sockPath);
    process.exit(0);
  }, Number(opts.ttl) * 1000).unref();
}

if (opts.check) {
  const ask = (path: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const r = request({ socketPath: sockPath, path, method: "GET" }, (res) => {
        let b = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (b += c));
        res.on("end", () => resolve(`${res.statusCode} ${b.slice(0, 300)}`));
      });
      r.on("error", reject);
      r.end();
    });
  console.log("check /pages", await ask("/pages"));
  console.log("check /summary", await ask("/summary"));
  console.log("check /values?page=wizard-1", await ask("/values?page=wizard-1"));
  console.log("check /expect?page=wizard-1", (await ask("/expect?page=wizard-1")).slice(0, 80));
  control.close();
  await sink?.stop();
  await site.stop();
  if (existsSync(sockPath)) unlinkSync(sockPath);
}
