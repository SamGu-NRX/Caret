// H11: what the host's page task panel needs from the helper. A page segment's preview carries a view (protocol
// GoalPageView): its page window, where to anchor, the source line, each field and value as a row with pickers marked,
// and the file inputs Caret leaves to the user. A native Ask whose route is plan stays on the single-window planner when
// no writer could plan it as a goal. Jev's 402 is said as the account's credits on both the Ask and the page-planning
// paths, never as "couldn't reach its model". Every name and value is invented.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsumerMessage, HelperMessage, PROTOCOL_VERSION, type GoalProgress, type PageControl, type PageSnapshot, type PlanProposal } from "../src/protocol.ts";
import { makeJevClient, type AskJev } from "../src/fill/jev.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { SAYS } from "../src/planner/says.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import { byLabel, c, chrome, FakePage, hello, mixedControls, NOTE, okReader, PICKS, TEXTEDIT, WIN } from "./fake-page.ts";
import { caseWindow, detailsWindow, goalScene, mailWindow, type GoalScene } from "./goal-desk.ts";

type Segment = Extract<GoalProgress, { event: "segment" }>;

/** An intent writer whose every intent has `route`, scope all. */
function intentWriter(route: "fill" | "plan"): WriterPort {
  return {
    route: FAKE_WRITER_ROUTE,
    async write(req) {
      const base = { model: "canned", provider: "canned", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
      if (req.kind !== "intent") throw new Error(`asked to write a ${req.kind}`);
      const json = { route, why: "none", scope: route === "fill" ? "all" : "none", section: "none", fields: [], sources: ["any"], whose: "user", literals: [] };
      return { ...base, output: { program: null, reply: JSON.stringify(json), json } };
    },
  };
}

/** The browser window's outer frame and the top frame's viewport the extension reports (H10 PageSnapshot.view). */
const VIEW: NonNullable<PageSnapshot["view"]> = { window: [100, 50, 800, 600], viewport: [800, 500], zoom: 1 };

interface Rig {
  page: FakePage;
  helper: Helper;
  host: PageHost;
  published: HelperMessage[];
  ask(instruction: string): Promise<GoalProgress | PlanProposal>;
  close(): void;
}

const rigs: Rig[] = [];
const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) r.close();
  for (const s of scenes.splice(0)) await s.close();
  vi.unstubAllGlobals();
});

async function rig(o: { jev?: AskJev; view?: boolean; controls?: () => PageControl[]; note?: string; picks?: Record<string, string> } = {}): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "caret-h11-"));
  const store = new Store(join(dir, "data"));
  const page = new FakePage(o.controls ?? mixedControls, "Apply: Mixed controls");
  if (o.view !== false) {
    const walk = page.snapshot.bind(page);
    page.snapshot = (id: string): PageSnapshot => ({ ...walk(id), view: VIEW });
  }
  const published: HelperMessage[] = [];
  const picks = o.picks ?? PICKS;
  const pick = jevPickingText((_, ins) => picks[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? byLabel(_, ins), 0.95);
  const jev: AskJev =
    o.jev ??
    (async (req) => {
      const r = await pick(req);
      for (const [id, q] of Object.entries(req.questions)) if ("yes" in q.criteria) r.answers[id] = { choice: "yes", confidence: 0.95 };
      // I2: Jev's scope ask, which settles a reveal's fields, says every field is asked for (page-rig.ts does the same).
      if (req.purpose === "ask.scope") for (const id of Object.keys(req.questions)) r.answers[id] = { choice: id === "section" ? "fields" : "asks", confidence: 0.95 };
      return r;
    });
  let helper: Helper;
  const host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), warn: () => {} });
  helper = new Helper({ store, askJev: jev, shadow: false, allowBackgroundFocus: false, readerLink: host.link, calendar: null, publish: (m) => void published.push(m), warn: () => {}, ask: { maker: "writer", writer: intentWriter("fill") }, pageDocument: (id) => host.registry.documentOf(id) });
  wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
  host.registry.add(page.session);
  page.session.receive(hello);
  await new Promise((r) => setTimeout(r, 0));
  await helper.handleReader(snap([field("te/note", o.note ?? NOTE, { role: "AXTextArea" })], { at: Date.now() - 5000, windowId: "note", title: "Robin's details.txt", app: TEXTEDIT, focused: true }));
  expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
  const r: Rig = {
    page,
    helper,
    host,
    published,
    ask: (instruction) => helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: Date.now(), instruction, windowId: WIN }, undefined, true, true) as Promise<GoalProgress | PlanProposal>,
    close: () => {
      helper.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  rigs.push(r);
  return r;
}

describe("a page segment's preview carries the panel's view (H11)", () => {
  it("names the page window, the source line, each field and value, pickers, and the file input left to the user", async () => {
    const r = await rig();
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview).toMatchObject({ type: "goalProgress", event: "segment" });
    const page = preview.page;
    expect(page?.windowId).toBe(WIN);
    expect(page?.app).toEqual({ pid: chrome.pid, bundleId: chrome.bundleId, name: chrome.name });
    expect(page?.from).toBe("TextEdit, Robin's details.txt");
    const row = (label: string) => page?.rows.find((x) => x.label === label);
    expect(row("Full name")).toMatchObject({ value: "Robin Vale", picked: false });
    expect(row("Country")).toMatchObject({ value: "Canada", picked: true });
    expect(row("Country of residence")).toMatchObject({ value: "United States", picked: true });
    // Each row is a write step of this segment, by its index in the goal.
    for (const x of page?.rows ?? []) expect(preview.steps.find((s) => s.index === x.step)?.kind).toBe("write");
    // A box to tick has no row; its step's words say it.
    expect(page?.rows.some((x) => /driving/.test(x.label))).toBe(false);
    expect(page?.attach).toEqual(["Resume"]);
  });

  it("anchors at the first field it writes, inside the page's visible area, in screen points", async () => {
    const r = await rig();
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    // The viewport sits at the window's bottom: y = 50 + 600 - 500. Every fake control's rect is [0, 0, 200, 20].
    expect(preview.page?.viewport).toEqual([100, 150, 800, 500]);
    expect(preview.page?.anchor).toEqual([100, 150, 200, 20]);
  });

  it("has no anchor or viewport when the walk did not say where the page is", async () => {
    const r = await rig({ view: false });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.page).toMatchObject({ anchor: null, viewport: null });
  });
});

/** The mixed form, where choosing Canada shows a Province menu (page-goals.test.ts revealing). */
function revealing(page: FakePage): void {
  page.onAct = (v, p) => {
    if (v.kind === "pageSelect" && v.id === "e3" && !p.controls.some((x) => x.id === "e20")) {
      p.controls.splice(p.controls.findIndex((x) => x.id === "e3") + 1, 0, c("e20", "select", "Province", { options: [{ value: "", label: "Choose a province", selected: true }, { value: "on", label: "Ontario", selected: false }, { value: "qc", label: "Quebec", selected: false }] }));
    }
    return null;
  };
}

describe("a reveal's preview (H11)", () => {
  it("shows no row for a field an Ask's writes revealed (I2 ruling B: the scope is settled once)", async () => {
    const r = await rig({ note: `${NOTE}\nProvince: Ontario`, picks: { ...PICKS, Province: "Ontario" } });
    revealing(r.page);
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    await r.helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: preview.goalId, segment: 0, digest: preview.digest, at: Date.now() });
    await r.helper.goals.idle();
    const next = r.published.find((m): m is Segment => m.type === "goalProgress" && m.event === "segment" && m.goalId !== preview.goalId);
    // I2 lead ruling B: the revealed Province was never asked about, so an Ask's goal shows no row that writes it.
    expect(next?.page?.rows?.some((x) => x.label === "Province") ?? false).toBe(false);
  });
});

describe("a native Ask whose route is plan, with no writer (H11)", () => {
  it("stays on the single-window planner for a host that runs goal plans, instead of refusing for want of a writer", async () => {
    const sc = goalScene({ scripts: [], windows: [mailWindow(), caseWindow(), detailsWindow()], userWindow: "7171-1", writer: null, askJev: async () => ({ answers: {}, model: "m", latencyMs: 0, inputTokens: 0, costUsd: 0 }), ask: { maker: "writer", writer: intentWriter("plan") } });
    scenes.push(sc);
    const r = await sc.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "n1", at: sc.desk.at, instruction: "press Submit in the case", windowId: "7171-1" }, sc.session, true, true);
    expect(r.type).toBe("planProposal");
    expect(JSON.stringify(r)).not.toContain(SAYS.noPlanWriter);
  });
});

describe("Jev's 402 (H11)", () => {
  const unpaid = (): void => {
    vi.stubGlobal("fetch", async () => new Response("no available TypeSafe API credits", { status: 402 }));
  };

  it("an Ask says the account is out of credits, not that the model could not be reached", async () => {
    unpaid();
    const sc = goalScene({ scripts: [], windows: [mailWindow(), caseWindow(), detailsWindow()], userWindow: "7171-1", writer: null, askJev: makeJevClient(() => "k"), ask: { maker: "jev" } });
    scenes.push(sc);
    const r = (await sc.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "p1", at: sc.desk.at, instruction: "fill in the order number", windowId: "7171-1" }, sc.session, true, true)) as PlanProposal;
    expect(r.type).toBe("planProposal");
    expect(r.error?.says).toBe(SAYS.jevBilling);
    expect(JSON.stringify(r)).not.toContain(SAYS.unreachable);
  });

  it("an Ask whose scope question meets the 402 says the same sentence, not the planner's internal failure", async () => {
    unpaid();
    const r = await rig({ jev: makeJevClient(() => "k") });
    const reply = await r.ask("fill out this form from my note");
    // I2 ruling D: the Ask's per-field scope question is its first Jev request, so the out-of-credits sentence comes
    // back as the Ask's own refusal, before any page is planned; still not as the planner's internal failure.
    expect(reply).toMatchObject({ type: "planProposal", outcome: "error", error: { says: SAYS.jevBilling } });
  });
});

describe("the page goal golden (fixtures/golden/page-goal.ndjson), the contract the host's panel decodes", () => {
  const lines = readFileSync(new URL("../fixtures/golden/page-goal.ndjson", import.meta.url), "utf8").trim().split("\n");
  const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  const CONSUMER = new Set(["hello", "planRequest", "goalAccept", "taskControl"]);

  it("parses every line and writes it back byte for byte", () => {
    for (const [i, l] of lines.entries()) {
      const m = parsed[i] as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), `line ${i + 1}`).toBe(l);
    }
  });

  it("ties each acceptance to its preview, the reveal to the goal it follows, and each row to a write step", () => {
    const previews = parsed.filter((m) => m.event === "segment") as Segment[];
    expect(previews.map((p) => p.reason)).toEqual(["start", "afterReveal"]);
    for (const a of parsed.filter((m) => m.type === "goalAccept")) expect(previews.some((p) => p.goalId === a.goalId && p.segment === a.segment && p.digest === a.digest)).toBe(true);
    expect(previews[1]?.replaces).toBe(previews[0]?.goalId);
    for (const p of previews) for (const r of p.page?.rows ?? []) expect(p.steps.find((x) => x.index === r.step)?.kind).toBe("write");
    // The host's ⌘Z undoes every task the page's goals ran, newest first.
    expect(parsed.filter((m) => m.type === "taskControl").map((m) => m.taskId)).toEqual(["goal-2-a1~1:s0", "goal-2-a1:s0"]);
    expect(parsed.at(-1)).toMatchObject({ event: "stopped", reason: "refused", says: SAYS.jevBilling });
  });

  it("refuses a page view the contract rules out", () => {
    const preview = parsed[2] as Segment;
    const bad = (page: unknown): boolean => !HelperMessage.safeParse({ ...preview, page }).success;
    expect(bad({ ...preview.page, windowId: "" })).toBe(true);
    expect(bad({ ...preview.page, anchor: [1, 2, 3] })).toBe(true);
    expect(bad({ ...preview.page, rows: [{ step: -1, label: "x", value: "y", picked: false }] })).toBe(true);
    expect(bad({ ...preview.page, attach: [""] })).toBe(true);
  });
});
