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
  /** B28: landings on /replica/landed, by how the page left (via=submit or via=location). */
  readonly landed = new Map<string, number>();
  /** Tabs of the memory run that finished loading (tab.html posts /tabhello). */
  tabsLoaded = 0;
  state: Record<string, unknown> | null = null;
  readonly loads: { loadId: string; href: string; at: number }[] = [];
  private readonly queue: Command[] = [];
  private readonly pollers: ServerResponse[] = [];
  private readonly acks = new Map<number, (a: Ack) => void>();
  private nextId = 1;
  /** Holds the run armed (holds.html): each answers its page's synchronous request only when released. */
  private readonly holds = new Map<string, { arrived: () => void; res: ServerResponse | null }>();
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

  /**
   * Arms the hold `tag`: the page's next /hold?tag request is kept open until `release`, or 15 s pass. `arrived`
   * resolves when the page made it, with the page's main thread now waiting on it.
   */
  armHold(tag: string): { arrived: Promise<void>; release: () => void } {
    let arrived = (): void => {};
    const p = new Promise<void>((r) => (arrived = r));
    const h = { arrived, res: null as ServerResponse | null };
    this.holds.set(tag, h);
    const release = (): void => {
      if (this.holds.get(tag) === h) this.holds.delete(tag);
      if (h.res !== null && !h.res.writableEnded) send(h.res, "application/json", "{}");
    };
    setTimeout(release, 15_000).unref();
    return { arrived: p, release };
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
      case "GET /holds":
        return html(res, read("holds.html"));
      // D2-04: one of each control a Fill all writes, beside the ones it leaves to the user.
      case "GET /mixed":
        return html(res, read("mixed.html"));
      // B29: number fields whose page shows "1" as "1.00", beside a text field that does the same.
      case "GET /number":
        return html(res, read("number.html"));
      // D2-06: a support form a goal plan fills from an email, with a Continue only the user presses.
      case "GET /support":
        return html(res, read("support.html"));
      case "GET /holds.js":
        return send(res, "text/javascript", read("holds.js"));
      case "GET /hold": {
        const h = this.holds.get(url.searchParams.get("tag") ?? "");
        if (h === undefined || h.res !== null) return send(res, "application/json", "{}");
        h.res = res;
        h.arrived();
        return;
      }
      case "GET /decoy":
        return html(res, read("decoy.html"));
      case "GET /frame/offscreen":
        return html(res, read("frame.html").replaceAll("__TITLE__", "Off screen").replaceAll("__ID__", "offscreen").replaceAll("__NAME__", "offscreen_field").replaceAll("__LABEL__", "Offscreen frame field"));
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
      // W4: local replicas of real application forms' widgets (public/replica), built from W4's saved markup.
      case "GET /replica/greenhouse":
      case "GET /replica/ashby":
      case "GET /replica/lever":
      case "GET /replica/navpress":
        return html(res, read(`replica/${url.pathname.slice("/replica/".length)}.html`));
      // B28: where navpress.html's Yes handlers go. Counted by how they came, and fixture.js keeps taking commands here.
      case "GET /replica/landed": {
        const via = url.searchParams.get("via") ?? "";
        this.landed.set(via, (this.landed.get(via) ?? 0) + 1);
        return html(res, `<!doctype html><title>Landed</title><p>Landed by ${via === "submit" ? "a form" : "location"}.</p><script src="/fixture.js"></script>`);
      }
      case "GET /replica/landings":
        return send(res, "application/json", JSON.stringify(Object.fromEntries(this.landed)));
      case "GET /replica/replica.js":
        return send(res, "text/javascript", read("replica/replica.js"));
      case "GET /busy":
        return html(res, read("busy.html"));
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
        // Long poll: held until a command comes or 20 s pass. A tab that closes drops its poll, so no command goes to it.
        this.pollers.push(res);
        res.once("close", () => {
          const i = this.pollers.indexOf(res);
          if (i >= 0) this.pollers.splice(i, 1);
        });
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
