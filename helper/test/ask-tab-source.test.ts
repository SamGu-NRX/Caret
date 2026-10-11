// I6: an Ask reads the tab the user just left, under P4's rules (engines/tab-source.ts), on its fill path (planner/ask.ts
// fillModel) and its page-goal path (helper.ts pagePlan). The text is read once, when the fill step needs it; only the
// Ask's own offer or goal sees it; its sources are checked against it at acceptance, so text that expired before Tab
// writes nothing; and it goes when the offer or goal ends. The worker's own rules are played by the fake engine, as in
// tab-source.test.ts. Every name and value is invented.
import { answeringScope } from "./builders.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EngineSession } from "../src/engines/session.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { pageTabReader, type TabSource } from "../src/engines/tab-source.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { LEFT_TAB_MS, PAGE_SUBROLE, PROTOCOL_VERSION, type GoalProgress, type HelperMessage, type HelperToEngine, type PageControl, type PageResult, type PageSnapshot, type PageTabText, type PageVerb, type PlanProposal } from "../src/protocol.ts";
import { jevPickingText } from "./builders.ts";
import { X, chrome, hello, okReader } from "./fake-page.ts";
import { intentWriter } from "./page-rig.ts";

const MAIL = "page:eng1:3";
const FORM = "page:eng1:7";

const MESSAGE: PageTabText = {
  tabId: 3,
  leftAt: 0,
  title: "Inbox: Field Robotics Technician",
  frames: [{ frameId: 0, origin: "https://mail.example.test" }],
  selection: [],
  blocks: ["From: Gareth Lowe <gareth.lowe@example.net>", "Hi Ines,", "Your details as we have them:\nFirst name: Ines\nLast name: Vandermeer\nEmail: ines.vandermeer@example.org"],
  cut: false,
  docsText: null,
};
const PICK: Record<string, string> = { "First name": "Ines", "Last name": "Vandermeer", Email: "ines.vandermeer@example.org" };

const ctl = (id: string, kind: PageControl["kind"], name: string): PageControl => ({ id, key: `form[apply]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#apply", rect: [0, 0, 200, 20], value: "" });

/** The mail tab (3) the user left and the form tab (7), as the worker answers for them; acts write the form's values. */
class TwoTabs {
  readonly sent: HelperToEngine[] = [];
  readonly session: EngineSession;
  form = [ctl("e1", "text", "First name"), ctl("e2", "text", "Last name"), ctl("e3", "email", "Email")];
  left: number | null = null;
  /** What a read of the tab left finds (H13: a Google editor whose text is off finds none). */
  tabText: PageTabText = MESSAGE;
  /** The form field with focus. */
  focusedId = "e1";
  grantedGen: number | null = null;
  constructor() {
    this.session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: X, bridgeVersion: "0", connectedAt: 0 }, (m) => {
      this.sent.push(m);
      if (m.type === "scopedActGrant" && m.scope.kind === "page") this.grantedGen = m.scope.navGen;
      queueMicrotask(() => this.answer(m));
      return true;
    }, 500);
  }
  private reply(id: string, r: object): void {
    this.session.receive({ type: "pageResult", v: 1, id, at: Date.now(), ...r } as never);
  }
  private walk(tabId: number, id: string): PageSnapshot {
    const mail = tabId === 3;
    const title = mail ? MESSAGE.title : "Apply: Field Robotics Technician";
    const origin = mail ? "https://mail.example.test" : "http://127.0.0.1:4310";
    return {
      type: "pageSnapshot", v: PROTOCOL_VERSION, id, at: Date.now(), tabId, browserWindowId: 1, active: mail ? this.left !== 3 : true, inFocusedWindow: true, title,
      frames: [{ frameId: 0, parentFrameId: -1, documentId: `D${tabId}`, origin, path: "/", navGen: 1, title, headings: [], iframes: [], excluded: {}, truncated: false, controls: mail ? [ctl("m1", "search", "Search mail")] : structuredClone(this.form) }],
      missing: [],
      focused: mail ? null : { frameId: 0, id: this.focusedId, selection: [0, 0] },
    };
  }
  private answer(m: HelperToEngine): void {
    if (m.type === "pageReadText") {
      if (this.left !== m.tabId) return this.reply(m.id, { outcome: "notAllowed", detail: "it is not the tab you just left" });
      return this.reply(m.id, { outcome: "ok", detail: null, text: { ...this.tabText, leftAt: Date.now() - 1000 } } satisfies Omit<PageResult, "type" | "v" | "id" | "at">);
    }
    if (m.type !== "pageCommand") return;
    const v: PageVerb = m.verb;
    if (v.kind === "pageWalk") {
      this.session.receive(this.walk(v.tabId ?? 7, m.id));
      return this.reply(m.id, { outcome: "ok", detail: null });
    }
    if (v.kind !== "pageWrite") return this.reply(m.id, { outcome: "handoff", detail: "yours", risk: "pageScript" });
    const x = this.form.find((c) => c.id === v.id);
    if (x === undefined || (x.value ?? "") !== v.expect) return this.reply(m.id, { outcome: "stale", detail: "changed" });
    x.value = v.value;
    return this.reply(m.id, { outcome: "ok", detail: null, readings: { before: v.expect, afterInput: v.value, afterBlur: v.value, invalid: false, error: null } });
  }
  get reads(): number[] {
    return this.sent.flatMap((m) => (m.type === "pageReadText" ? [m.tabId] : []));
  }
}

type Segment = Extract<GoalProgress, { event: "segment" }>;

describe("an Ask reads the tab the user just left (I6)", () => {
  let dir: string;
  let store: Store;
  let tabs: TwoTabs;
  let host: PageHost;
  let helper: Helper;
  let published: HelperMessage[];
  let warnings: string[];
  let ahead = 0;
  let jevCalls = 0;

  beforeEach(async () => {
    ahead = 0;
    jevCalls = 0;
    dir = mkdtempSync(join(tmpdir(), "caret-i6-"));
    store = new Store(join(dir, "data"));
    tabs = new TwoTabs();
    published = [];
    warnings = [];
    const pick = jevPickingText((_, ins) => PICK[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.95);
    // Confirmation questions (planner/ask.ts confirmScope) answer yes; everything else is fill's.
    const jev: AskJev = async (req) => {
      // I2 ruling D: the per-field scope question every route asks, before any source is read: every field it is asked
      // about. Not counted: these tests count the questions that read the tab.
      if (req.purpose === "ask.scope") return answeringScope(async () => { throw new Error("unreachable"); })(req);
      jevCalls++;
      const r = await pick(req);
      for (const [id, q] of Object.entries(req.questions)) if ("yes" in q.criteria) r.answers[id] = { choice: "yes", confidence: 0.95 };
      return r;
    };
    // Each test's engine applies to its own helper only: an earlier test's trailing walk must not reach this one's.
    let mine: Helper | null = null;
    host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void mine?.handleReader(m), purge: (s) => mine?.purgeWindow(s), warn: (l) => void warnings.push(l) });
    mine = helper = new Helper({
      store, askJev: jev, shadow: false, allowBackgroundFocus: false, readerLink: host.link, calendar: null, now: () => Date.now() + ahead,
      tabReader: pageTabReader(host.registry), publish: (m) => void published.push(m), warn: (l) => void warnings.push(l),
      ask: { maker: "writer", writer: intentWriter({ scope: "all" }) },
      pageDocument: (id) => host.registry.documentOf(id),
      pageContext: (id) => host.registry.contextOf(id),
    });
    wirePageEngines({ host, helper, publish: () => {}, warn: (l) => void warnings.push(l), allowBackground: true });
    host.registry.add(tabs.session);
    tabs.session.receive(hello);
    await new Promise((r) => setTimeout(r, 0));
    // The user reads the mail tab, then switches to the form tab.
    tabs.session.onFocus?.({ type: "pageFocus", v: 1, at: Date.now(), tabId: 3, frameId: 0 }, tabs.session);
    await vi.waitFor(() => expect(helper.model.windows.get(MAIL)?.focused).toBe(true));
    tabs.left = 3;
    tabs.session.onFocus?.({ type: "pageFocus", v: 1, at: Date.now(), tabId: 7, frameId: 0 }, tabs.session);
    await vi.waitFor(() => expect(helper.model.windows.get(FORM)?.focused).toBe(true));
  });
  afterEach(() => {
    tabs.session.close();
    helper.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const tabSource = (): TabSource => (helper as unknown as { tabSource: TabSource }).tabSource;
  const modelHoldsText = (): boolean => [...(helper.model.windows.get(MAIL)?.nodes.values() ?? [])].some((n) => n.subrole === PAGE_SUBROLE.readOnDemand);
  const askFill = (): Promise<PlanProposal> =>
    helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: Date.now(), instruction: "fill this form from the email", windowId: FORM }, undefined, true, false) as Promise<PlanProposal>;
  const askGoal = (): Promise<GoalProgress> =>
    helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: Date.now(), instruction: "fill this form from the email", windowId: FORM }, undefined, true, true) as Promise<GoalProgress>;
  const acceptPlan = (p: PlanProposal): ReturnType<Helper["handleOfferAccept"]> => helper.handleOfferAccept({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: p.offerKey ?? "", actionId: "run", overrides: {}, at: Date.now() });
  const acceptGoal = (s: Segment): ReturnType<Helper["handleGoalAccept"]> => helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: s.goalId, segment: s.segment, digest: s.digest, at: Date.now() });

  describe("the fill path", () => {
    it("reads the tab once, offers the message's values, and writes them on Tab after its sources recheck", async () => {
      const p = await askFill();
      expect(p.error).toBeNull();
      expect(tabs.reads).toEqual([3]);
      for (const v of ["Ines", "Vandermeer", "ines.vandermeer@example.org"]) expect(JSON.stringify(p.spec)).toContain(v);
      expect(modelHoldsText()).toBe(false);
      expect(tabSource().holding()).toBe(MAIL);
      const r = await acceptPlan(p);
      expect(r).toMatchObject({ outcome: "done" });
      expect(tabs.form.map((c) => c.value)).toEqual(["Ines", "Vandermeer", "ines.vandermeer@example.org"]);
      // Taken: the text went with the offer, and no warning carries it.
      expect(tabSource().holding()).toBeNull();
      expect(warnings.join("\n")).not.toMatch(/Vandermeer|Gareth/);
    });

    it("refuses a Tab after the text expired: the value is then in no window, and nothing is written", async () => {
      const p = await askFill();
      expect(p.error).toBeNull();
      ahead = LEFT_TAB_MS + 10;
      expect(await acceptPlan(p)).toBeNull();
      expect(published.some((m) => m.type === "error" && /untracedValue/.test(m.message))).toBe(true);
      expect(tabs.form.map((c) => c.value)).toEqual(["", "", ""]);
    });

    it("withdraws the offer whole when the text is dropped before Tab", async () => {
      const p = await askFill();
      // The user turns Caret off for the mail site: the held text goes, and the offer made from it with it.
      host.registry.setSitesOff(["https://mail.example.test"]);
      expect(tabSource().holding()).toBeNull();
      await new Promise((r) => setTimeout(r, 0));
      expect(published.some((m) => m.type === "offerWithdrawn" && m.id === p.offerKey)).toBe(true);
      expect(await acceptPlan(p)).toBeNull();
      expect(tabs.form.map((c) => c.value)).toEqual(["", "", ""]);
    });

    it("reads nothing when the worker says the tab is not the one just left, and keeps nothing for a refused Ask", async () => {
      tabs.left = null;
      const p = await askFill();
      expect(tabs.reads).toEqual([3]);
      expect(p.error?.code).toBe("nothingToDo");
      expect(tabSource().holding()).toBeNull();
    });

    it("asks Jev nothing more once the text expired while it answered, and offers nothing", async () => {
      const base = jevCalls;
      // The text runs out while the fill's first question is out.
      const inner = (helper as unknown as { ask: AskJev }).ask;
      (helper as unknown as { ask: AskJev }).ask = async (req) => {
        const r = await inner(req);
        if (tabs.reads.length > 0) ahead = LEFT_TAB_MS + 10;
        return r;
      };
      const p = await askFill();
      expect(p.error?.code).toBe("unseenWindow");
      expect(p.error?.detail).toMatch(/text of the tab you left/);
      expect(tabSource().holding()).toBeNull();
      expect(jevCalls - base).toBeLessThanOrEqual(2);
    });
  });

  describe("the page-goal path", () => {
    it("reads the tab once, previews the message's values, holds the text for the goal alone, and lets it go when the goal ends", async () => {
      const s = (await askGoal()) as Segment;
      expect(s.event).toBe("segment");
      expect(tabs.reads).toEqual([3]);
      expect(s.steps.map((x) => x.says).join(" | ")).toMatch(/Ines.*Vandermeer.*ines\.vandermeer@example\.org/);
      expect(modelHoldsText()).toBe(false);
      expect(tabSource().holds(s.goalId)).toBe(true);
      const r = await acceptGoal(s);
      expect(r).toMatchObject({ outcome: "done" });
      expect(tabs.form.map((c) => c.value)).toEqual(["Ines", "Vandermeer", "ines.vandermeer@example.org"]);
      await helper.goals.idle();
      expect(tabSource().holding()).toBeNull();
      // The plan keeps fill's values and spans, never the tab's whole text (page-planner.ts sources); once the goal has
      // ended and let the text go, the plan it keeps forgets those values too (review finding 2).
      await new Promise((x) => setTimeout(x, 0));
      const kept = JSON.stringify(helper.goals.planOf(s.goalId), (_, v: unknown) => (v instanceof Map ? [...v.entries()] : v));
      expect(kept).not.toMatch(/Gareth|Vandermeer|ines\.vandermeer|Ines/);
      expect(helper.goals.planOf(s.goalId)?.segments[0]?.steps.map((x) => x.says)).toEqual(["First name: …", "Last name: …", "Email: …", "The rest is yours"]);
    });

    it("forgets the values from the tab in a preview that stopped untaken, and logs no refusal that could quote it", async () => {
      const s = (await askGoal()) as Segment;
      host.registry.setSitesOff(["https://mail.example.test"]);
      expect(tabSource().holding()).toBeNull();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      const kept = JSON.stringify(helper.goals.planOf(s.goalId), (_, v: unknown) => (v instanceof Map ? [...v.entries()] : v));
      expect(kept).not.toMatch(/Vandermeer|ines\.vandermeer/);
      expect(warnings.join("\n")).not.toMatch(/Vandermeer|Gareth/);
    });

    it("logs a page plan's refusal by its code alone when the plan read the tab", async () => {
      // Jev is unsure of every value: the planner refuses with a sentence that may quote what it read.
      (helper as unknown as { ask: AskJev }).ask = answeringScope(async (req) => ({ answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "none", confidence: 0.2 }])), costUsd: 0, latencyMs: 0 }) as never);
      const g = await askGoal();
      // Said as the planner's own refusal, not as text that expired (the release in pagePlan's catch comes after that check).
      expect(g).toMatchObject({ event: "stopped", says: "Caret found nothing to put in First name, Last name or Email." });
      expect(tabs.reads).toEqual([3]);
      expect(warnings.some((l) => /refused \(nothingToDo\); not logged, since it may quote the tab you left/.test(l))).toBe(true);
      expect(tabSource().holding()).toBeNull();
    });

    it("keeps an ambient Fill all off the page while the goal's preview waits, so the goal keeps its text (review finding 3)", async () => {
      const s = (await askGoal()) as Segment;
      helper.model.frontmostPid = chrome.pid;
      // The user clicks into the form's next field while reading the preview (the host passes on a focus only when it moves, H10).
      tabs.focusedId = "e2";
      tabs.session.onFocus?.({ type: "pageFocus", v: 1, at: Date.now(), tabId: 7, frameId: 0 }, tabs.session);
      for (let i = 0; i < 20; i++) await new Promise((x) => setTimeout(x, 5));
      await helper.routedSettled;
      expect(tabs.reads).toEqual([3]);
      expect(tabSource().holds(s.goalId)).toBe(true);
      expect(published.some((m) => m.type === "goalProgress" && m.event === "stopped")).toBe(false);
      store.flush();
      expect(store.counts()["fill.held_goal"]).toBeGreaterThan(0);
    });

    it("refuses the acceptance after the text expired: the sources recheck finds the values gone, and nothing is written", async () => {
      const s = (await askGoal()) as Segment;
      expect(s.event).toBe("segment");
      ahead = LEFT_TAB_MS + 10;
      expect(await acceptGoal(s)).toBeNull();
      expect(published.some((m) => m.type === "error" && /goalAccept refused/.test(m.message))).toBe(true);
      expect(tabs.form.map((c) => c.value)).toEqual(["", "", ""]);
    });

    it("stops the waiting preview when the text is dropped", async () => {
      const s = (await askGoal()) as Segment;
      host.registry.setSitesOff(["https://mail.example.test"]);
      expect(tabSource().holding()).toBeNull();
      await new Promise((r) => setTimeout(r, 0));
      const stopped = published.find((m): m is Extract<GoalProgress, { event: "stopped" }> => m.type === "goalProgress" && m.event === "stopped" && m.goalId === s.goalId);
      expect(stopped?.reason).toBe("sourceChanged");
      expect(stopped?.says).toMatch(/tab you left/);
    });
  });

  // H13 (brief item 3): the tab left is a Google Doc whose text for assistive technology is off, so the read finds
  // nothing in it. Each path says what to turn on instead of finding nothing silently.
  describe("a Google Doc whose text is off (H13)", () => {
    const DOC: PageTabText = { ...MESSAGE, title: "Robin's details - Google Docs", frames: [{ frameId: 0, origin: "https://docs.google.com" }], blocks: [], docsText: "off" };
    const TURN_ON = "Turn on screen reader and braille support in Google Docs, ⌘⌥Z then ⌘⌥H, so Caret can read it.";

    it("a fill nobody asked for says what to turn on, to the host", async () => {
      tabs.tabText = DOC;
      helper.model.frontmostPid = chrome.pid;
      tabs.focusedId = "e2";
      tabs.session.onFocus?.({ type: "pageFocus", v: 1, at: Date.now(), tabId: 7, frameId: 0 }, tabs.session);
      await vi.waitFor(() => expect(published.some((m) => m.type === "error" && m.sourceOff !== undefined)).toBe(true));
      const e = published.find((m): m is Extract<HelperMessage, { type: "error" }> => m.type === "error" && m.sourceOff !== undefined);
      expect(e).toMatchObject({ message: TURN_ON, sourceOff: "Google Docs" });
      expect(warnings.join("\n")).not.toMatch(/Robin's details/);
    });

    it("an Ask's refusal says what to turn on", async () => {
      tabs.tabText = DOC;
      const p = await askFill();
      expect(p.error?.says).toBe(TURN_ON);
    });

    it("a page goal's refusal says it too, and a Sheet is named as one", async () => {
      tabs.tabText = { ...DOC, title: "Budget - Google Sheets" };
      const g = await askGoal();
      expect(g).toMatchObject({ event: "stopped", says: "Turn on screen reader and braille support in Google Sheets, ⌘⌥Z then ⌘⌥H, so Caret can read it." });
    });

    it("a tab whose text is on, or any other page, refuses as before", async () => {
      tabs.tabText = { ...DOC, docsText: "on" };
      const p = await askFill();
      expect(p.error?.says).not.toBe(TURN_ON);
    });
  });
});
