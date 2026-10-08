// HA2 focused review of eb9d19d, items 1-8: regressions built from the reviewer's probes. Fresh synthetic fixtures.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { heldReason, mintOf, NOTE_PRIVATE, NOTE_UNSHOWN, OWNER_UNREADABLE, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { OwnerVerdicts } from "../src/fill/owner-cache.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import type { Node } from "../src/protocol.ts";
import { planTask } from "../src/planner/planner.ts";
import { planWithCode } from "../src/planner/codeplan.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { field, node, snap, text, optionIs } from "./builders.ts";
import { closeRigs, rig } from "./page-rig.ts";
import { PROTOCOL_VERSION } from "../src/protocol.ts";

vi.mock("../src/codemode/sandbox.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/codemode/sandbox.ts")>();
  return {
    ...original,
    runCodePlan: (...[source, snapshots, choose, opts = {}]: Parameters<typeof original.runCodePlan>) =>
      original.runCodePlan(source, snapshots, choose, { ...opts, limits: { ...opts.limits, guestCpuMs: 10_000, watchdogMs: 10_000 } }),
  };
});

const T0 = 1_000_000;
const PHONE = "555-0388";
const OPENING = ["Signing up for the Thursday pottery class.", "I'm Odile Ferrant, second term."];
const BETWEEN = ["Class starts at six.", "Bring an apron.", "Parking is behind the hall."];
const MINE = [...OPENING, `Phone: ${PHONE}`, ...BETWEEN, "Contact lines are mine."].join("\n");
const NOT_MINE = [...OPENING, `Phone: ${PHONE}`, ...BETWEEN, "Neither contact line is mine."].join("\n");
const P = "com.google.Chrome/standard";
const TEXTEDIT = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const SLACK = { pid: 7003, bundleId: "com.tinyspeck.slackmacgap", name: "Slack" };

/** Sources (the first is the window the user just left), then a form with a Phone field in front. */
function desk(sources: { windowId: string; nodes: Node[]; title?: string; app?: { pid: number; bundleId: string; name: string } }[]): ScreenModel {
  const m = new ScreenModel();
  [...sources].reverse().forEach((s, j) => m.apply(snap(s.nodes, { at: T0 - 20_000 + 1000 * j, windowId: s.windowId, title: s.title ?? `Note ${sources.length - j}.txt`, ...(s.app === undefined ? {} : { app: s.app }), focused: true })));
  m.apply(snap([node(`${P}/webarea:~0`, "AXWebArea", { label: "Register" }), field(`${P}/textfield:phone~0`, "", { parent: `${P}/webarea:~0`, label: "Phone", frame: [100, 40, 200, 24] })], { at: T0, windowId: "form", title: "Studio registration", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:phone~0` }));
  return m;
}
const KEY = `${P}/textfield:phone~0`;
const noteArea = (key: string, body: string): Node => field(key, body, { role: "AXTextArea" });

const namedNotes = (req: JevRequest, ins: string): string => {
  const ids = /((?:note_\d+)(?: and note_\d+)*) in source_notes/u.exec(ins)?.[1]?.split(" and ") ?? [];
  const notes = (req.state as { source_notes?: Record<string, string> }).source_notes ?? {};
  return ids.map((id) => notes[id] ?? "").join("\n");
};

/**
 * A Jev at confidence 1: picks PHONE for Phone, fields want the user's (or `whose`), checks are exact or yes; an owner
 * question is "other" when what it shows disclaims, unless `owner` says; `during` runs before each answer.
 */
function jev(o: { owner?: () => string; whose?: string; during?: (req: JevRequest) => void } = {}): AskJev & { reqs: JevRequest[] } {
  const reqs: JevRequest[] = [];
  const f = async (req: JevRequest) => {
    reqs.push(req);
    o.during?.(req);
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      const crit = Object.keys(q.criteria);
      const owner = /Whose details is (?:it|this value)/u.test(ins);
      if (req.purpose === "fill.verify") answers[id] = { choice: "exact", confidence: 1 };
      else if ("yes" in q.criteria) answers[id] = { choice: "yes", confidence: 1 };
      else if (owner && crit.includes("person")) answers[id] = { choice: o.owner?.() ?? "person", confidence: 1 };
      else if (owner && crit.includes("user")) answers[id] = { choice: o.owner?.() ?? (/\bneither\b[^.\n]*\bmine\b/iu.test(`${ins}\n${namedNotes(req, ins)}`) ? "other" : "user"), confidence: 1 };
      else if (crit.includes("user") || crit.includes("person")) answers[id] = { choice: o.whose ?? "user", confidence: 1 };
      else if (crit.includes("asks")) answers[id] = { choice: "asks", confidence: 1 };
      else {
        const hit = Object.entries(q.criteria).find(([, d]) => optionIs(d, PHONE))?.[0];
        answers[id] = { choice: hit ?? (crit.includes("keep") ? "keep" : (crit.find((c) => c === "none") ?? crit[0] ?? "none")), confidence: 1 };
      }
    }
    return { model: "jev-ha2", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  return Object.assign(f, { reqs });
}

const phone = async (m: ScreenModel, ask: AskJev, o: { scope?: FillScope; cache?: OwnerVerdicts; exclude?: ReadonlySet<string> } = {}) => {
  const p = await proposeFill(m, ask, "form", KEY, T0, { rand: () => 0, ...(o.scope === undefined ? {} : { scope: o.scope }), ...(o.cache === undefined ? {} : { ownerCache: o.cache }), ...(o.exclude === undefined ? {} : { exclude: o.exclude }) });
  return p.fields.find((f) => f.key === KEY);
};
const scopeOf = (instruction: string, extra: Partial<FillScope> = {}): FillScope => ({ fields: [KEY], windows: null, memory: false, instruction, person: null, literals: new Map(), ...extra });

const written = (run: Promise<{ checked: { writes: readonly { value: string }[] } }>): Promise<string[]> => run.then((d) => d.checked.writes.map((w) => w.value), () => []);

afterEach(() => {
  closeRigs();
});
beforeAll(() => setTestVerifier(null));
afterAll(() => setTestVerifier(STAND_IN));

describe("item 1: native planning and the code writer bind the notes the owner requests saw", () => {
  const editDuringOwnerCheck = (m: ScreenModel) => (req: JevRequest): void => {
    if (req.purpose === "plan.verify") m.apply(snap([noteArea("note/body", NOT_MINE)], { at: T0 - 5000, windowId: "note", title: "Note 1.txt", focused: false }));
  };
  const writer: WriterPort = {
    route: FAKE_WRITER_ROUTE,
    async write() {
      const program = `async function main(caret: CaretPlanAPI): Promise<PlanRef> {
  const form = await caret.readWindow();
  const all = [form, await caret.readWindow("w2" as WindowRef)];
  const t = form.targets.find((x) => x.label === "Phone");
  let v = null;
  for (const w of all) for (const x of w.values) if (v === null && x.display.startsWith('"${PHONE}"')) v = x;
  return caret.plan({ basedOn: form.snapshot, steps: t !== undefined && v !== null ? [caret.fill(t.ref, v.ref)] : [] });
}`;
      return { model: "fake", provider: "groq", output: { program, reply: program }, inputTokens: 1, outputTokens: 1, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
    },
  };
  it("planTask: a note edited to disclaim the phone while the owner check is out does not write it", async () => {
    const m = desk([{ windowId: "note", nodes: [noteArea("note/body", MINE)] }]);
    const got = await written(planTask("put my phone in", m, { values: () => [] }, { askJev: jev({ owner: () => "user", during: editDuringOwnerCheck(m) }), offerKey: "r2-1", windowId: "form", now: T0 }));
    expect(got).not.toContain(PHONE);
  });
  it("planWithCode: the same", async () => {
    const m = desk([{ windowId: "note", nodes: [noteArea("note/body", MINE)] }]);
    const got = await written(planWithCode("put my phone in", m, { values: () => [] }, { writer, askJev: jev({ owner: () => "user", during: editDuringOwnerCheck(m) }), offerKey: "r2-1c", windowId: "form", now: T0 }));
    expect(got).not.toContain(PHONE);
  });
});

describe("item 2: a conversation copied into a note keeps its conversation limit", () => {
  it("does not send more than the chat's share through the note's whole-text allotment", async () => {
    const chat = Array.from({ length: 12 }, (_, i) => `Bram: the pottery wheel ${i + 1} is booked for Thursday, and I'll bring the clay we talked about.`);
    const m = desk([
      { windowId: "note", nodes: [noteArea("note/body", [...OPENING, `Phone: ${PHONE}`, "Pasted from Slack:", ...chat].join("\n"))] },
      { windowId: "slack", app: SLACK, title: "Slack", nodes: chat.map((l, i) => text(`slack/m${i}`, l)) },
    ]);
    const j = jev();
    await phone(m, j);
    const sent = JSON.stringify(j.reqs.map((r) => [r.state, r.questions]));
    const covered = chat.filter((l) => sent.includes(l)).reduce((n, l) => n + l.length, 0);
    const total = chat.reduce((n, l) => n + l.length, 0);
    expect(covered * 2).toBeLessThan(total);
  });
});

describe("item 3: an answer in flight never refills an invalidated cache", () => {
  for (const [name, invalidate] of [
    ["a Sites change, lock or sign-out (clear)", (c: OwnerVerdicts) => c.clear()],
    ["forgetting the note's window", (c: OwnerVerdicts) => c.forget(new Set(["note"]))],
  ] as const) {
    it(`drops the answers when ${name} happens while the owner request is out`, async () => {
      const m = desk([{ windowId: "note", nodes: [noteArea("note/body", MINE)] }]);
      const cache = new OwnerVerdicts();
      await phone(m, jev({ during: (req) => (req.purpose === "fill.whose" ? invalidate(cache) : undefined) }), { cache });
      expect(cache.size).toBe(0);
    });
  }
});

describe("item 4: the cache key holds the instruction", () => {
  it("asks the owner question again for an Ask with another instruction", async () => {
    const m = desk([{ windowId: "note", nodes: [noteArea("note/body", MINE)] }]);
    const cache = new OwnerVerdicts();
    const owners = (j: { reqs: JevRequest[] }): number => j.reqs.filter((r) => r.purpose === "fill.whose").flatMap((r) => Object.keys(r.questions).filter((k) => k.endsWith("_owner"))).length;
    const a = jev();
    await phone(m, a, { cache, scope: scopeOf("I am Odile; fill my phone") });
    const b = jev();
    await phone(m, b, { cache, scope: scopeOf("I am Bram; fill my phone") });
    expect(owners(a)).toBeGreaterThan(0);
    expect(owners(b)).toBeGreaterThan(0);
  });
});

describe("item 5: an Ask that names a person meets the evidence gate", () => {
  const bram = (): FillScope => scopeOf("use Bram Keller's details", { person: "Bram Keller" });
  it("withholds a value from a note redaction cut", async () => {
    const m = desk([{ windowId: "note", nodes: [noteArea("note/body", ["Bram Keller", `Phone: ${PHONE}`, "API key note: none of this is Bram's"].join("\n"))] }]);
    const f = await phone(m, jev({ whose: "person" }), { scope: bram() });
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? null : heldReason(f)).toBe(`Caret left Phone: ${NOTE_PRIVATE}.`);
  });
  it("withholds a value from a note too long to show", async () => {
    const long = Array.from({ length: 24 }, (_, i) => `Reminder (${i + 1}): bring the receipt from last term, because the desk asked about it twice already.`);
    const m = desk([{ windowId: "note", nodes: [noteArea("note/body", ["Bram Keller", `Phone: ${PHONE}`, ...long].join("\n"))] }]);
    const f = await phone(m, jev({ whose: "person" }), { scope: bram() });
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? null : heldReason(f)).toBe(`Caret left Phone: ${NOTE_UNSHOWN}.`);
  });
});

describe("item 6: an editable one-line field is not a whole note", () => {
  it("judges a phone in an editable text field with its whole window, where a sibling disclaims it", async () => {
    const m = desk([{ windowId: "note", nodes: [field("note/field", `Phone: ${PHONE}`, { label: "Contact" }), text("note/after", "Neither contact line is mine.")] }]);
    const f = await phone(m, jev());
    expect(f?.value ?? null).toBeNull();
  });
});

describe("item 7: evidence from a window Caret may not read is never sent", () => {
  it("withholds a value an excluded window also holds, and sends nothing of that window", async () => {
    const m = desk([
      { windowId: "note", nodes: [noteArea("note/body", MINE)] },
      { windowId: "private", title: "Private journal", nodes: [noteArea("private/body", ["Journal entry, do not share.", `Bram's number is ${PHONE}.`].join("\n"))] },
    ]);
    const j = jev();
    const f = await phone(m, j, { exclude: new Set(["private"]) });
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? null : heldReason(f)).toBe(`Caret left Phone: ${OWNER_UNREADABLE}.`);
    expect(JSON.stringify(j.reqs)).not.toContain("Journal entry");
  });
  it("withholds it when the Ask's sources leave that window out", async () => {
    const m = desk([
      { windowId: "note", nodes: [noteArea("note/body", MINE)] },
      { windowId: "other", title: "Other note", nodes: [noteArea("other/body", ["Other note.", `Bram: ${PHONE}`].join("\n"))] },
    ]);
    const j = jev();
    const f = await phone(m, j, { scope: scopeOf("put my phone from my note in", { windows: new Set(["note"]) }) });
    expect(f?.value ?? null).toBeNull();
    expect(JSON.stringify(j.reqs)).not.toContain("Other note.");
  });
});

describe("item 8: the field's instruction literal survives a duplicate screen value and an 'other' verdict on it", () => {
  it("fills 'put 555-0388 in Phone' from the instruction though a note that disclaims the same phone is on screen", async () => {
    const m = desk([{ windowId: "note", nodes: [noteArea("note/body", NOT_MINE)] }]);
    const f = await phone(m, jev(), { scope: scopeOf(`put ${PHONE} in Phone`, { literals: new Map([[KEY, PHONE]]) }) });
    expect(f?.value).toBe(PHONE);
    // The instruction's own option: its provenance is the instruction, never the note's window.
    const pr = JSON.stringify(f === undefined ? null : mintOf(f)?.provenance);
    expect(pr).toContain(`"kind":"instruction","span":"${PHONE}"`);
    expect(pr).not.toContain('"kind":"window"');
  });
});

describe("item 3 again: a cache hit invalidated while the field-ownership requests are out is never consumed", () => {
  const filledTwice = async (invalidate: (cache: OwnerVerdicts) => void, cache = new OwnerVerdicts()) => {
    const m = desk([{ windowId: "note", nodes: [noteArea("note/body", MINE)] }]);
    expect((await phone(m, jev(), { cache }))?.value).toBe(PHONE);
    expect(cache.size).toBeGreaterThan(0);
    const j = jev({ during: (req) => (req.purpose === "fill.whose" ? invalidate(cache) : undefined) });
    const f = await phone(m, j, { cache });
    return { f, ownerQuestions: j.reqs.flatMap((r) => Object.keys(r.questions).filter((k) => k.endsWith("_owner"))).length };
  };
  it.each([
    ["clear()", (c: OwnerVerdicts) => c.clear()],
    ["forget() of the note's window", (c: OwnerVerdicts) => c.forget(new Set(["note"]))],
  ] as const)("gives no write from the stale hit after %s", async (_, invalidate) => {
    const { f } = await filledTwice(invalidate);
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? undefined : mintOf(f)).toBeUndefined();
  });

  it.each(["a Sites change", "sessionLocked"] as const)("gives no write from the stale hit after %s reaches the helper", async (what) => {
    const r = await rig();
    const cache = (r.helper as unknown as { ownerVerdicts: OwnerVerdicts }).ownerVerdicts;
    r.helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: ["fill"], level: "balanced", paused: false, sitesOff: [] });
    const run = filledTwice(() => {
      if (what === "sessionLocked") r.helper.handleSessionLocked({ type: "sessionLocked", v: PROTOCOL_VERSION, at: Date.now(), why: "lock" });
      else r.helper.handleSettings({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: ["fill"], level: "balanced", paused: false, sitesOff: ["https://blocked.example"] });
    }, cache);
    // INT1: on v2/next a site switched off while the fill is out refuses every later request of that fill (PV2,
    // privacy/disclosure.ts verify), so the fill stops before its value questions: no proposal, no write.
    if (what === "a Sites change") return void (await expect(run).rejects.toThrow(/switched off after this request was built/u));
    const { f } = await run;
    expect(f?.value ?? null).toBeNull();
    expect(f === undefined ? undefined : mintOf(f)).toBeUndefined();
  });
});
