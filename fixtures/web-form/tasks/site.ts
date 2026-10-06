// The browser task pages (F1) on the fixture server: the pages under public/tasks/, their search APIs, the routes
// probe.js reports to, the submit counter, and the harness's presses. FixtureSite (server.ts) routes every /tasks/
// request here, so `node server.ts` serves these pages too.
//
// Pages (TASK_PAGES): a three-page wizard, a page of dependent reveals, a 40-field form, and Greenhouse and Ashby
// look-alikes. Expected values for each live in tasks/expect/<page>.json, which no route serves.
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { Oracle, type PressRecord, type StatePost } from "../oracle.ts";

const PUBLIC = fileURLToPath(new URL("../public/tasks/", import.meta.url));
export const EXPECT_DIR = fileURLToPath(new URL("./expect/", import.meta.url));

export interface TaskPage {
  /** The page's data-oracle-page, the oracle's key for it. */
  name: string;
  path: string;
  /** The HTML files that declare its fields: the page and any frame it embeds. */
  files: string[];
  /** The page the harness's Next press leads to, for the wizard. */
  next: string | null;
}

export const TASK_PAGES: readonly TaskPage[] = [
  { name: "wizard-1", path: "/tasks/wizard/1", files: ["wizard-1.html"], next: "wizard-2" },
  { name: "wizard-2", path: "/tasks/wizard/2", files: ["wizard-2.html"], next: "wizard-3" },
  { name: "wizard-3", path: "/tasks/wizard/3", files: ["wizard-3.html"], next: null },
  { name: "reveal", path: "/tasks/reveal", files: ["reveal.html"], next: null },
  { name: "forty", path: "/tasks/forty", files: ["forty.html"], next: null },
  { name: "greenhouse", path: "/tasks/greenhouse", files: ["greenhouse.html", "greenhouse-form.html"], next: null },
  { name: "ashby", path: "/tasks/ashby", files: ["ashby.html"], next: null },
];

export function taskPage(name: string): TaskPage {
  const p = TASK_PAGES.find((x) => x.name === name);
  if (p === undefined) throw new Error(`no task page ${name}; the pages are ${TASK_PAGES.map((x) => x.name).join(", ")}`);
  return p;
}

/** Each page's expectations: the sources a person would have, and the value (or "none") of every field. */
export interface Expectation {
  page: string;
  sources: {
    note: string;
    email: { from: string; to: string; subject: string; body: string };
    memory: { key: string; value: string }[];
  };
  expected: Record<string, string>;
  /** For each field with a value: the source and the words in it that give the value. */
  basis: Record<string, string>;
}

export function loadExpectation(page: string): Expectation {
  const e = JSON.parse(readFileSync(`${EXPECT_DIR}${page}.json`, "utf8")) as Expectation;
  if (e.page !== page) throw new Error(`tasks/expect/${page}.json says it is for page ${e.page}`);
  return e;
}

const STATIC: Record<string, [file: string, type: string]> = {
  "/tasks/wizard/1": ["wizard-1.html", "text/html"],
  "/tasks/wizard/2": ["wizard-2.html", "text/html"],
  "/tasks/wizard/3": ["wizard-3.html", "text/html"],
  "/tasks/reveal": ["reveal.html", "text/html"],
  "/tasks/forty": ["forty.html", "text/html"],
  "/tasks/greenhouse": ["greenhouse.html", "text/html"],
  "/tasks/greenhouse/form": ["greenhouse-form.html", "text/html"],
  "/tasks/ashby": ["ashby.html", "text/html"],
  "/tasks/probe.js": ["probe.js", "text/javascript"],
  "/tasks/pages.js": ["pages.js", "text/javascript"],
  "/tasks/options.js": ["options.js", "text/javascript"],
  "/tasks/tasks.bundle.js": ["tasks.bundle.js", "text/javascript"],
  "/tasks/tasks.css": ["tasks.css", "text/css"],
};

/** Invented schools, with shared first words so a filter that matches several is the usual case. */
export const SCHOOLS = [
  "Northfield State University", "Northfield College", "North Coast Institute of Technology", "Northbridge Community College",
  "Lakeshore Polytechnic Institute", "Lakeshore University", "Cedar Valley College", "Cedar Hills University",
  "Riverside Technical Institute", "Eastgate University", "Westbrook College of Engineering", "Pine Ridge State University",
  "Harbor City University", "Summit Valley Community College", "Granite Peak Institute of Technology", "Bay Meadows University",
  "Silver Lake College", "Kingsport Technical College", "Marlow Bay University", "Stonebridge University",
];

export const PLACES = [
  "Austin, Texas, United States", "Boston, Massachusetts, United States", "Chicago, Illinois, United States", "Denver, Colorado, United States",
  "Portland, Oregon, United States", "Portland, Maine, United States", "Seattle, Washington, United States", "San Francisco, California, United States",
  "San Diego, California, United States", "San Jose, California, United States", "New York, New York, United States", "Phoenix, Arizona, United States",
  "Toronto, Ontario, Canada", "Vancouver, British Columbia, Canada", "Montreal, Quebec, Canada", "Halifax, Nova Scotia, Canada",
  "Dublin, Ireland", "London, United Kingdom", "Berlin, Germany", "Mexico City, Mexico", "Bengaluru, Karnataka, India",
];

/** How long a search answer takes: long enough that a picker that reads its list too early sees it empty. */
const SEARCH_DELAY_MS = 250;

/** Every word of `q` starts some word of the name, case-insensitively: "north tech" finds "North Coast Institute of Technology". */
export function search(list: readonly string[], q: string): string[] {
  const words = q.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) return [];
  return list.filter((name) => {
    const parts = name.toLowerCase().split(/[\s,]+/);
    return words.every((w) => parts.some((p) => p.startsWith(w)));
  }).slice(0, 8);
}

interface Poller {
  page: string;
  loadId: string;
  res: ServerResponse;
}

interface PendingPress {
  id: number;
  page: string;
  target: string;
  /** The loads it was offered to, and which answered they lack the target. */
  offered: Set<string>;
  refused: Set<string>;
  expires: number;
}

export class TaskPages {
  readonly oracle = new Oracle();
  private readonly pollers: Poller[] = [];
  private readonly pending: PendingPress[] = [];

  /**
   * Presses `page`'s button marked data-oracle-press=`target` as the harness: the press is recorded as the harness's
   * and no one else's. Resolves with the recorded press; throws when no frame of the page has the target, or no frame
   * of it is loaded and polling within `ms`.
   */
  async harnessPress(page: string, target: string, ms = 5000): Promise<PressRecord> {
    const id = this.oracle.issueHarnessPress(page, target);
    const p: PendingPress = { id, page, target, offered: new Set(), refused: new Set(), expires: Date.now() + ms };
    this.pending.push(p);
    this.offer();
    try {
      await this.oracle.waitFor(() => this.oracle.presses.some((r) => r.claim === id && r.harness) || (p.offered.size > 0 && p.refused.size === p.offered.size && !this.pollers.some((x) => x.page === page && !p.offered.has(x.loadId))), `the harness press of ${target} on ${page}`, ms);
    } finally {
      this.pending.splice(this.pending.indexOf(p), 1);
    }
    const r = this.oracle.presses.find((x) => x.claim === id && x.harness);
    if (r === undefined) throw new Error(`no frame of page ${page} has [data-oracle-press="${target}"] (offered to ${p.offered.size}, all refused)`);
    return r;
  }

  /** Hands each pending press to every poller of its page that has not had it yet. */
  private offer(): void {
    const now = Date.now();
    for (const p of this.pending) {
      if (p.expires < now) continue;
      for (const poller of [...this.pollers]) {
        if (poller.page !== p.page || p.offered.has(poller.loadId) || poller.res.writableEnded) continue;
        p.offered.add(poller.loadId);
        this.pollers.splice(this.pollers.indexOf(poller), 1);
        send(poller.res, "application/json", JSON.stringify({ id: p.id, target: p.target }));
      }
    }
  }

  /** Answers a /tasks/ request; false for any other path. A malformed probe report is recorded as a probe error. */
  async handle(req: IncomingMessage, url: URL, body: string, res: ServerResponse): Promise<boolean> {
    if (!url.pathname.startsWith("/tasks/")) return false;
    try {
      this.route(req, url, body, res);
    } catch (e) {
      this.oracle.recordProbeError("(server)", `${req.method} ${url.pathname}: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) res.writeHead(400).end();
    }
    return true;
  }

  private route(req: IncomingMessage, url: URL, body: string, res: ServerResponse): void {
    const route = `${req.method} ${url.pathname}`;
    const file = req.method === "GET" ? STATIC[url.pathname] : undefined;
    if (file !== undefined) {
      send(res, file[1], readFileSync(`${PUBLIC}${file[0]}`, "utf8"));
      return;
    }
    switch (route) {
      case "GET /tasks/api/schools":
      case "GET /tasks/api/places": {
        const list = url.pathname.endsWith("schools") ? SCHOOLS : PLACES;
        const found = search(list, url.searchParams.get("q") ?? "");
        setTimeout(() => send(res, "application/json", JSON.stringify(found)), SEARCH_DELAY_MS);
        return;
      }
      case "GET /tasks/submit":
      case "POST /tasks/submit":
        this.oracle.recordSubmit({ page: url.searchParams.get("page") ?? "(unnamed)", method: req.method ?? "?", via: url.searchParams.get("via") ?? "(unnamed)" });
        send(res, "text/html", "<!doctype html><title>Application received</title><p>Application received.</p>");
        return;
      case "POST /tasks/oracle/state":
        this.oracle.recordState(parse<StatePost>(body, ["page", "frame", "loadId", "seq", "reason", "fields"]));
        send(res, "application/json", "{}");
        return;
      case "POST /tasks/oracle/press": {
        const p = parse<Omit<PressRecord, "harness" | "at">>(body, ["page", "frame", "loadId", "target", "trusted", "claim"]);
        this.oracle.recordPress(p);
        send(res, "application/json", "{}");
        return;
      }
      case "POST /tasks/oracle/error": {
        const e = parse<{ page: string; error: string }>(body, ["page", "error"]);
        this.oracle.recordProbeError(e.page, e.error);
        send(res, "application/json", "{}");
        return;
      }
      case "POST /tasks/oracle/harness-ack": {
        const a = parse<{ id: number; ok: boolean; loadId?: string }>(body, ["id", "ok"]);
        const p = this.pending.find((x) => x.id === a.id);
        if (p !== undefined && !a.ok) p.refused.add(a.loadId ?? "?");
        send(res, "application/json", "{}");
        return;
      }
      case "GET /tasks/oracle/harness": {
        // Long poll: held until a press for this page comes, or 20 s pass.
        const poller = { page: url.searchParams.get("page") ?? "", loadId: url.searchParams.get("load") ?? "", res };
        this.pollers.push(poller);
        const drop = (): void => {
          const i = this.pollers.indexOf(poller);
          if (i >= 0) this.pollers.splice(i, 1);
        };
        res.once("close", drop);
        setTimeout(() => {
          if (this.pollers.includes(poller)) {
            drop();
            res.writeHead(204).end();
          }
        }, 20_000).unref();
        this.offer();
        return;
      }
      default:
        res.writeHead(404).end();
    }
  }

  /** Ends every held poll, for a server that is stopping. */
  close(): void {
    for (const p of this.pollers.splice(0)) if (!p.res.writableEnded) p.res.writeHead(204).end();
  }
}

/** Parses a probe's JSON body and checks it has `keys`; a malformed report is an error, never a silent drop. */
function parse<T>(body: string, keys: string[]): T {
  const v = JSON.parse(body) as Record<string, unknown>;
  const missing = keys.filter((k) => !(k in v));
  if (missing.length > 0) throw new Error(`a probe report lacks ${missing.join(", ")}: ${body.slice(0, 200)}`);
  return v as T;
}

function send(res: ServerResponse, type: string, body: string): void {
  res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }).end(body);
}
