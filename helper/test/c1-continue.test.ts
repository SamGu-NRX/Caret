// C1 item 4 (lead decision): when a step fails, the page closes any open list and puts the control back; the executor
// reads it back, and only when it reads as it was is the field listed as the user's, with the reason, and the steps that
// do not depend on it go on in the same task, under the same undo. A restore that cannot be verified stops the run as
// before. Driven through the Helper, the goal runs and the page engine of fill-transaction.test.ts. Every name and value
// is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type GoalProgress, type HelperMessage, type PageControl, type PageResult, type PageVerb } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { pageHost, type PageHost } from "../src/engines/host.ts";
import { wirePageEngines } from "../src/engines/wire.ts";
import { restoredPick } from "../src/engines/page-link.ts";
import { dependsOn } from "../src/executor/dependents.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import { c, chrome, FakePage, hello, okReader, TEXTEDIT, WIN } from "./fake-page.ts";

type Segment = Extract<GoalProgress, { event: "segment" }>;
type Finished = Extract<GoalProgress, { event: "finished" }>;
type Stopped = Extract<GoalProgress, { event: "stopped" }>;

const NOTE = ["Full name: Robin Vale", "Country: Canada", "City: Toronto", "Email: robin@example.test"].join("\n");
const PICKS: Record<string, string> = { "Full name": "Robin Vale", Country: "Canada", City: "Toronto", Email: "robin@example.test" };

/** A form whose second field is a custom dropdown, with a field after it that depends on it (City) and one that does not. */
const controls = (): PageControl[] => [c("e1", "text", "Full name", { value: "" }), c("e2", "combobox", "Country", { value: "" }), c("e3", "text", "City", { value: "" }), c("e4", "email", "Email", { value: "" })];

/** The combobox handler's answer when no list opened (content/combobox.ts stopped): the list closed, the text put back. */
const putBack = (extra: Partial<PageResult> = {}): object => ({
  outcome: "failed",
  detail: "no list that belongs to this control opened within 1500 ms (opening); Caret put the control back and stopped",
  readings: { before: "", afterInput: "", afterBlur: "", invalid: false, error: null },
  choice: { flavor: "reactSelect", matches: [], expanded: false, hiddenInput: "unchanged" },
  ...extra,
});

function intentWriter(): WriterPort {
  return {
    route: FAKE_WRITER_ROUTE,
    async write(req) {
      const base = { model: "canned", provider: "canned", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
      if (req.kind !== "intent") throw new Error(`asked to write a ${req.kind}`);
      const json = { route: "fill", why: "none", scope: "all", section: "none", fields: [], sources: ["any"], whose: "user", literals: [] };
      return { ...base, output: { program: null, reply: JSON.stringify(json), json } };
    },
  };
}

interface Rig {
  page: FakePage;
  helper: Helper;
  host: PageHost;
  published: HelperMessage[];
  preview: Segment;
  accept(): ReturnType<Helper["handleGoalAccept"]>;
  close(): void;
}

const rigs: Rig[] = [];
afterEach(() => {
  for (const r of rigs.splice(0)) r.close();
});

/** A Helper over one page tab and the note, planned by the page planner; `onChoose` answers the Country pick. */
async function rig(onChoose: (v: Extract<PageVerb, { kind: "pageChooseOption" }>, page: FakePage) => object | null): Promise<Rig> {
  const dir = mkdtempSync(join(tmpdir(), "caret-c1-"));
  const store = new Store(join(dir, "data"));
  const page = new FakePage(controls, "Apply: Robotics technician");
  page.onAct = (v, p) => (v.kind === "pageChooseOption" ? onChoose(v, p) : null);
  const published: HelperMessage[] = [];
  const pick = jevPickingText((_, ins) => PICKS[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.95);
  const jev: AskJev = async (req) => {
    const r = await pick(req);
    for (const [id, q] of Object.entries(req.questions)) if ("yes" in q.criteria) r.answers[id] = { choice: "yes", confidence: 0.95 };
    // I2 ruling: every Ask route asks Jev's per-field scope question first; every field is one this Ask asks for.
    if (req.purpose === "ask.scope") for (const id of Object.keys(req.questions)) r.answers[id] = { choice: "asks", confidence: 0.95 };
    return r;
  };
  let helper: Helper;
  const host = pageHost({ path: join(dir, "page.sock"), secret: Buffer.alloc(32, 1), reader: okReader, apply: (m) => void helper.handleReader(m), purge: (s) => helper.purgeWindow(s), warn: () => {} });
  helper = new Helper({ store, askJev: jev, shadow: false, allowBackgroundFocus: false, readerLink: host.link, calendar: null, publish: (m) => void published.push(m), warn: () => {}, ask: { maker: "writer", writer: intentWriter() }, pageDocument: (id) => host.registry.documentOf(id) });
  wirePageEngines({ host, helper, publish: () => {}, warn: () => {} });
  host.registry.add(page.session);
  page.session.receive(hello);
  await new Promise((r) => setTimeout(r, 0));
  await helper.handleReader(snap([field("te/note", NOTE, { role: "AXTextArea" })], { at: Date.now() - 5000, windowId: "note", title: "Robin's details.txt", app: TEXTEDIT, focused: true }));
  expect((await host.link.run({ kind: "walk", pid: chrome.pid, windowId: WIN })).outcome).toBe("ok");
  const preview = (await helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "a1", at: Date.now(), instruction: "fill out this form from my note", windowId: WIN }, undefined, true, true)) as Segment;
  expect(preview.event).toBe("segment");
  // I6: the form has no forward button, so its hand-off row says the rest is the user's.
  expect(preview.steps.map((s) => s.says)).toEqual(["Full name: Robin Vale", "Country: Canada", "City: Toronto", "Email: robin@example.test", "The rest is yours"]);
  const r: Rig = {
    page,
    helper,
    host,
    published,
    preview,
    accept: () => helper.handleGoalAccept({ type: "goalAccept", v: PROTOCOL_VERSION, goalId: preview.goalId, segment: 0, digest: preview.digest, at: Date.now() }),
    close: () => {
      helper.shutdown();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  rigs.push(r);
  return r;
}

const goalEnd = (r: Rig): GoalProgress | undefined => r.published.filter((m): m is GoalProgress => m.type === "goalProgress" && (m.event === "finished" || m.event === "stopped")).at(-1);
const shown = (r: Rig): (string | boolean | undefined)[] => ["e1", "e2", "e3", "e4"].map((id) => r.page.shown(id));
const wroteTo = (r: Rig, id: string): number => r.page.verbs.filter((v) => (v.kind === "pageWrite" || v.kind === "pageChooseOption") && v.id === id && v.sameAs === undefined).length;

describe("a failed pick the page put back, read back as it was: the field is yours and the rest goes on (C1 item 4)", () => {
  it("writes the steps that do not depend on it, lists it and its dependent as yours with the reason, and one undo restores the rest", async () => {
    const r = await rig(() => putBack());
    const result = await r.accept();
    await r.helper.goals.idle();
    expect(shown(r)).toEqual(["Robin Vale", "", "", "robin@example.test"]);
    // City may depend on Country (a state, city or ZIP list follows the country), so it is skipped, never written.
    expect(wroteTo(r, "e3")).toBe(0);
    expect(wroteTo(r, "e2")).toBe(1);
    expect(r.page.verbs.filter((v) => v.kind === "pagePress")).toEqual([]);
    expect(result?.outcome).toBe("done");
    const end = goalEnd(r) as Finished;
    expect(end).toMatchObject({ event: "finished", outcome: "partial", verified: 2 });
    expect(end.left.find((l) => l.startsWith("'Country' is yours"))).toMatch(/no list that belongs to this control opened/);
    expect(end.left.find((l) => l.startsWith("'City' is yours"))).toMatch(/depend.*'Country'/);
    expect(r.helper.executor.leftToYou(`${r.preview.goalId}:s0`).map((l) => l.step)).toEqual([1, 2]);
    // Nothing of the failed pick is in the undo ledger: the page put it back and the read-back saw it so.
    expect(r.helper.executor.ledger(`${r.preview.goalId}:s0`).map((e) => (e.kind === "write" ? e.key : e.kind))).toEqual([`f0/${controls()[0]?.key}`, `f0/${controls()[3]?.key}`]);
    const u = await r.helper.executor.undo(`${r.preview.goalId}:s0`);
    expect(u.notRestored).toEqual([]);
    expect(shown(r)).toEqual(["", "", "", ""]);
  });
});

describe("a failed step whose restore is not verified stops the run as before (C1 item 4)", () => {
  const stoppedAtCountry = async (r: Rig, why: RegExp): Promise<void> => {
    const result = await r.accept();
    await r.helper.goals.idle();
    expect(result?.outcome).toBe("stopped");
    expect(result?.step).toBe(1);
    expect(result?.detail).toMatch(why);
    expect((goalEnd(r) as Stopped).event).toBe("stopped");
    expect(wroteTo(r, "e3")).toBe(0);
    expect(wroteTo(r, "e4")).toBe(0);
    expect(r.helper.executor.leftToYou(`${r.preview.goalId}:s0`)).toEqual([]);
  };

  it("failed with no readings (may have landed)", async () => {
    const r = await rig(() => ({ outcome: "failed", detail: "the pick went in, then the task's grant ended (before blur); Caret stopped without touching the control again", choice: { flavor: "reactSelect", matches: ["Canada"], expanded: false, hiddenInput: "unchanged" } }));
    await stoppedAtCountry(r, /^the reader refused: axError \(failed: the pick went in/);
  });

  it("failed with the control showing other text after the stop", async () => {
    const r = await rig((v, p) => {
      p.find(v.id).value = "Can";
      return putBack({ readings: { before: "", afterInput: "Can", afterBlur: "Can", invalid: false, error: null } });
    });
    await stoppedAtCountry(r, /^the reader refused: axError \(failed: no list/);
  });

  it("failed with the list still open", async () => {
    const r = await rig(() => putBack({ choice: { flavor: "reactSelect", matches: [], expanded: true, hiddenInput: "unchanged" } }));
    await stoppedAtCountry(r, /^the reader refused: changed \(failed: no list[^;]*; Caret put the control back and stopped\)$/);
  });

  it("failed with react-select's form value changed", async () => {
    const r = await rig(() => putBack({ choice: { flavor: "reactSelect", matches: [], expanded: false, hiddenInput: "set" } }));
    await stoppedAtCountry(r, /^the reader refused: changed \(failed: no list[^;]*; Caret put the control back and stopped\)$/);
  });

  it("put back by the page's word, but the executor's own read-back finds other text", async () => {
    const r = await rig((v, p) => {
      p.find(v.id).value = "Can";
      return putBack();
    });
    await stoppedAtCountry(r, /Caret read 'Country' back as 'Can', not '' as before, so it stopped$/);
  });

  it("put back, but another field changed while Caret acted", async () => {
    const r = await rig((_, p) => {
      p.find("e4").value = "someone@example.test";
      return putBack();
    });
    await stoppedAtCountry(r, /changed although the step did not touch it$/);
  });

  it("put back, in a run that did not ask to go on (a plain task: Fill all, a skill)", async () => {
    const r = await rig(() => putBack());
    const seg = r.helper.goals.planOf(r.preview.goalId)?.segments[0];
    if (seg === undefined) throw new Error("no segment");
    const result = await r.helper.executor.run("plain", seg.plan, seg.slots, undefined, { grant: true });
    expect(result).toMatchObject({ outcome: "stopped", step: 1, detail: "the reader refused: changed (failed: no list that belongs to this control opened within 1500 ms (opening); Caret put the control back and stopped)" });
    expect(wroteTo(r, "e4")).toBe(0);
    expect(r.helper.executor.leftToYou("plain")).toEqual([]);
  });
});

describe("which failed pick reads as put back (engines/page-link.ts restoredPick)", () => {
  const verb: PageVerb = { kind: "pageChooseOption", tabId: 7, frameId: 0, documentId: "D0", id: "e2", control: "combobox", name: "Country", taskId: "t", expect: "", value: "Canada" };
  const res = (extra: Partial<PageResult> = {}): PageResult => ({ type: "pageResult", v: PROTOCOL_VERSION, id: "x", at: 0, ...(putBack(extra) as Omit<PageResult, "type" | "v" | "id" | "at">) });
  it("is a combobox stop with readings equal before and after, the list closed and the form value unchanged", () => {
    expect(restoredPick(verb, res())).toBe(true);
    expect(restoredPick(verb, res({ choice: { flavor: "aria", matches: [], expanded: false, hiddenInput: "none" } }))).toBe(true);
  });
  it("is nothing else", () => {
    expect(restoredPick(verb, res({ readings: undefined }))).toBe(false);
    expect(restoredPick(verb, res({ readings: { before: "", afterInput: "C", afterBlur: "C", invalid: false, error: null } }))).toBe(false);
    expect(restoredPick(verb, res({ choice: undefined }))).toBe(false);
    expect(restoredPick(verb, res({ choice: { flavor: "aria", matches: [], expanded: null, hiddenInput: "none" } }))).toBe(false);
    expect(restoredPick(verb, res({ choice: { flavor: "aria", matches: [], expanded: true, hiddenInput: "none" } }))).toBe(false);
    expect(restoredPick(verb, res({ choice: { flavor: "reactSelect", matches: [], expanded: false, hiddenInput: "set" } }))).toBe(false);
    expect(restoredPick(verb, res({ outcome: "stale" }))).toBe(false);
    expect(restoredPick({ ...verb, control: "button" }, res())).toBe(false);
    expect(restoredPick({ kind: "pageWrite", tabId: 7, frameId: 0, documentId: "D0", id: "e1", control: "text", name: "Full name", taskId: "t", expect: "", value: "x" }, res())).toBe(false);
  });
});

describe("which later step depends on a failed one (executor/dependents.ts, the page planner's one declared dependency)", () => {
  it("a state, city or ZIP after a country", () => {
    expect(dependsOn("Country", "State")).toBe(true);
    expect(dependsOn("Country of residence", "City")).toBe(true);
    expect(dependsOn("Country", "ZIP code")).toBe(true);
    expect(dependsOn("Country", "Province")).toBe(true);
  });
  it("nothing else", () => {
    expect(dependsOn("Country", "Email")).toBe(false);
    expect(dependsOn("Country code", "City")).toBe(false);
    expect(dependsOn("School", "Degree")).toBe(false);
    expect(dependsOn("State", "City")).toBe(false);
  });
});
