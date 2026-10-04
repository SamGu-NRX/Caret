// The fixture site, on 127.0.0.1 only. Two servers: the main origin serves the form, its same-origin frame and the
// 40-tab page; the second port is another origin, for the cross-origin frame. Submit only counts (/submitted).
// The page posts its React state to /state and takes test commands from /control (fixture.js).
//   node server.ts [--port N] [--embed-port M]      prints {"main":"http://127.0.0.1:N","embed":"http://127.0.0.1:M"}
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const read = (f: string): string => readFileSync(`${PUBLIC}${f}`, "utf8");

export interface Command {
  id: number;
  cmd: string;
  [k: string]: unknown;
}

export interface Ack {
  id: number;
  loadId: string;
  ok: boolean;
  value?: string;
  error?: string;
}

export class FixtureSite {
  submitted = 0;
  /** Tabs of the memory run that finished loading (tab.html posts /tabhello). */
  tabsLoaded = 0;
  state: Record<string, unknown> | null = null;
  readonly loads: { loadId: string; href: string; at: number }[] = [];
  private readonly queue: Command[] = [];
  private readonly pollers: ServerResponse[] = [];
  private readonly acks = new Map<number, (a: Ack) => void>();
  private nextId = 1;
  private main: Server | null = null;
  private embed: Server | null = null;
  mainOrigin = "";
  embedOrigin = "";

  async start(port = 0, embedPort = 0): Promise<void> {
    this.embed = await listen(embedPort, (req, res) => this.serveEmbed(req, res));
    this.embedOrigin = `http://127.0.0.1:${(this.embed.address() as AddressInfo).port}`;
    this.main = await listen(port, (req, res) => void this.serveMain(req, res));
    this.mainOrigin = `http://127.0.0.1:${(this.main.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const p of this.pollers.splice(0)) p.writeHead(204).end();
    for (const s of [this.main, this.embed]) {
      if (s === null) continue;
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }

  /** Sends a command to the page that polls next and waits for its answer. */
  command(c: { cmd: string; [k: string]: unknown }, ms = 5000): Promise<Ack> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(id);
        reject(new Error(`the page did not answer ${c.cmd} within ${ms} ms`));
      }, ms);
      this.acks.set(id, (a) => {
        clearTimeout(timer);
        resolve(a);
      });
      this.queue.push({ ...c, id });
      this.flush();
    });
  }

  /** Resolves when a page load whose address matches has said hello since `since`. */
  async waitForLoad(match: (href: string) => boolean, since: number, ms = 10_000): Promise<string> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const l = this.loads.find((x) => x.at >= since && match(x.href));
      if (l !== undefined) return l.loadId;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no page load matched within ${ms} ms`);
  }

  private flush(): void {
    while (this.queue.length > 0 && this.pollers.length > 0) {
      const res = this.pollers.shift() as ServerResponse;
      if (res.writableEnded || res.destroyed) continue;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(this.queue.shift()));
    }
  }

  private serveEmbed(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", this.embedOrigin);
    if (url.pathname === "/frame/embed") return html(res, read("frame.html").replaceAll("__TITLE__", "Embedded portfolio").replaceAll("__ID__", "portfolio").replaceAll("__NAME__", "portfolio_url").replaceAll("__LABEL__", "Portfolio URL"));
    res.writeHead(404).end();
  }

  private async serveMain(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.mainOrigin);
    const body = req.method === "POST" ? await readBody(req) : "";
    switch (`${req.method} ${url.pathname}`) {
      case "GET /form":
      case "GET /form2":
        return html(res, read("form.html").replaceAll("__EMBED_ORIGIN__", this.embedOrigin));
      case "GET /frame/same":
        return html(res, read("frame.html").replaceAll("__TITLE__", "Referral").replaceAll("__ID__", "referral").replaceAll("__NAME__", "referral_code").replaceAll("__LABEL__", "Referral code"));
      case "GET /frame/hidden":
        return html(res, read("frame.html").replaceAll("__TITLE__", "Hidden frame").replaceAll("__ID__", "hiddenframe").replaceAll("__NAME__", "hidden_frame").replaceAll("__LABEL__", "Hidden frame field"));
      case "GET /opener": {
        // Headless Chrome takes one URL on its command line, so the memory run opens its tabs from here.
        const n = Math.min(Number(url.searchParams.get("n") ?? "0"), 100);
        return html(res, `<!doctype html><title>Opener</title><script>for (let i = 0; i < ${n}; i++) window.open("/tab?i=" + i, "_blank", "noopener");</script>`);
      }
      case "POST /tabhello":
        this.tabsLoaded++;
        return send(res, "application/json", "{}");
      case "GET /tab":
        return html(res, read("tab.html").replaceAll("__N__", url.searchParams.get("i") ?? "0"));
      case "GET /fixture.js":
        return send(res, "text/javascript", read("fixture.js"));
      case "GET /app.bundle.js":
        return send(res, "text/javascript", read("app.bundle.js"));
      case "POST /submit":
        this.submitted++;
        return send(res, "application/json", "{}");
      case "GET /submitted":
        return send(res, "application/json", JSON.stringify({ count: this.submitted }));
      case "POST /state":
        this.state = JSON.parse(body) as Record<string, unknown>;
        return send(res, "application/json", "{}");
      case "POST /hello": {
        const h = JSON.parse(body) as { loadId: string; href: string };
        this.loads.push({ loadId: h.loadId, href: h.href, at: Date.now() });
        return send(res, "application/json", "{}");
      }
      case "GET /control/next":
        // Long poll: held until a command comes or 20 s pass.
        this.pollers.push(res);
        setTimeout(() => {
          const i = this.pollers.indexOf(res);
          if (i >= 0) {
            this.pollers.splice(i, 1);
            res.writeHead(204).end();
          }
        }, 20_000);
        this.flush();
        return;
      case "POST /control/ack": {
        const a = JSON.parse(body) as Ack;
        this.acks.get(a.id)?.(a);
        this.acks.delete(a.id);
        return send(res, "application/json", "{}");
      }
      default:
        res.writeHead(404).end();
    }
  }
}

function listen(port: number, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> {
  const s = createServer(handler);
  return new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (b += c));
    req.on("end", () => resolve(b));
  });
}

function send(res: ServerResponse, type: string, body: string): void {
  res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }).end(body);
}

function html(res: ServerResponse, body: string): void {
  send(res, "text/html", body);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { port: { type: "string", default: "0" }, "embed-port": { type: "string", default: "0" } } });
  const site = new FixtureSite();
  await site.start(Number(values.port), Number(values["embed-port"]));
  console.log(JSON.stringify({ main: site.mainOrigin, embed: site.embedOrigin }));
}
