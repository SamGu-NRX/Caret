// L1: on the socket, a page preview's source excerpts (the user's own text around each value) go whole only to a
// goal-planning host whose hello listed sourceExcerpts; every other recipient of the same preview gets it with every
// `excerpt` removed, and a consumer that is not a goal-planning host gets no preview at all, as before.
// Every name and value is invented.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { PROTOCOL_VERSION, type HelperMessage } from "../src/protocol.ts";

const pageGoal = readFileSync(new URL("../fixtures/golden/page-goal.ndjson", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
/** A line of the source that no other part of the preview quotes. */
const SECRET = "Notes: met Robin at the spring fair";

/** page-goal.ndjson's first preview, its first row carrying a source and an excerpt. */
function preview(attach = false): HelperMessage {
  const p = structuredClone(pageGoal[2]) as { steps: { index: number; kind: string; says: string }[]; page: { rows: Record<string, unknown>[] } };
  const rows = p.page.rows;
  rows[0] = { ...rows[0], source: { kind: "window", name: "TextEdit" }, excerpt: { text: `Robin Vale\n${SECRET}`, start: 0, end: 10, name: "Robin's details.txt", edited: null } };
  rows[1] = { ...rows[1], source: { kind: "request", name: "" } };
  if (attach) p.steps.push({ index: 9, kind: "attach", says: "Attach a file to Resume" });
  return p as unknown as HelperMessage;
}

function connect(path: string): Promise<{ s: Socket; lines: string[] }> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path);
    const lines: string[] = [];
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (d: string) => {
      buf += d;
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
    });
    s.once("connect", () => resolve({ s, lines }));
    s.once("error", reject);
  });
}
const send = (s: Socket, m: unknown): void => void s.write(JSON.stringify(m) + "\n");
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const hello = (pid: number, capabilities: string[], host = true) => ({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid, version: "test", ...(host ? { host: true } : {}), capabilities });
const previews = (c: { lines: string[] }): Record<string, unknown>[] => c.lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((m) => m.type === "goalProgress");

describe("source excerpts on the socket (L1)", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let path: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-excerpt-sock-"));
    path = join(dir, "screen.sock");
    store = new Store(join(dir, "data"));
    let s: HelperServer | null = null;
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => s?.publish(m) });
    server = new HelperServer(path, () => helper, () => {});
    s = server;
    await server.listen();
  });
  afterEach(async () => {
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends excerpts whole only to a goal-planning host that declared sourceExcerpts; another goal host gets none", async () => {
    const shows = await connect(path);
    const plain = await connect(path);
    const consumer = await connect(path);
    send(shows.s, hello(1, ["goalPlans", "sourceExcerpts"]));
    send(plain.s, hello(2, ["goalPlans"]));
    send(consumer.s, hello(3, ["goalPlans", "sourceExcerpts"], false));
    await tick();
    const m = preview();
    server.publish(m);
    await tick();
    expect(shows.lines).toEqual([JSON.stringify(m)]);
    const [got] = previews(plain);
    expect(plain.lines).toHaveLength(1);
    expect(plain.lines[0]).not.toContain("excerpt");
    expect(plain.lines[0]).not.toContain(SECRET);
    // The same preview otherwise: the sources stay.
    const rows = (got?.page as { rows: Record<string, unknown>[] }).rows;
    expect(rows[0]?.source).toEqual({ kind: "window", name: "TextEdit" });
    const { excerpt: _e, ...first } = (m as unknown as { page: { rows: Record<string, unknown>[] } }).page.rows[0] as Record<string, unknown>;
    expect(rows[0]).toEqual(first);
    expect(consumer.lines).toEqual([]);
    for (const c of [shows, plain, consumer]) c.s.destroy();
  });

  it("keeps a preview with an attach row to hosts that show attach rows, and strips excerpts there too", async () => {
    const both = await connect(path);
    const files = await connect(path);
    const excerpts = await connect(path);
    send(both.s, hello(1, ["goalPlans", "goalFiles", "sourceExcerpts"]));
    send(files.s, hello(2, ["goalPlans", "goalFiles"]));
    send(excerpts.s, hello(3, ["goalPlans", "sourceExcerpts"]));
    await tick();
    server.publish(preview(true));
    await tick();
    expect(both.lines[0]).toContain(SECRET);
    expect(files.lines).toHaveLength(1);
    expect(files.lines[0]).not.toContain("excerpt");
    expect(excerpts.lines).toEqual([]);
    for (const c of [both, files, excerpts]) c.s.destroy();
  });

  it("counts a hello as showing excerpts only with host: true, goalPlans and sourceExcerpts", async () => {
    const seen: unknown[][] = [];
    const real = helper.hostConnected.bind(helper);
    vi.spyOn(helper, "hostConnected").mockImplementation((...a: Parameters<Helper["hostConnected"]>) => {
      seen.push(a.slice(1));
      real(...a);
    });
    const noPlans = await connect(path);
    const noHost = await connect(path);
    const yes = await connect(path);
    send(noPlans.s, hello(1, ["sourceExcerpts"]));
    await tick();
    send(noHost.s, hello(2, ["goalPlans", "sourceExcerpts"], false));
    await tick();
    send(yes.s, hello(3, ["goalPlans", "sourceExcerpts"]));
    await tick();
    // [routing, goalFiles, sourceExcerpts]; the consumer without host: true is no host at all.
    expect(seen).toEqual([
      [false, false, false],
      [false, false, true],
    ]);
    server.publish(preview());
    await tick();
    expect(noPlans.lines).toEqual([]);
    expect(noHost.lines).toEqual([]);
    expect(yes.lines[0]).toContain(SECRET);
    for (const c of [noPlans, noHost, yes]) c.s.destroy();
  });
});
