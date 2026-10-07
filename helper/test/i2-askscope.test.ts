// I2: an Ask's settled scope is enforced by the write contract (fill/ask-scope.ts), once, for every path. Each path
// below is driven by a stand-in that proposes a value for every field of the form; only the fields the Ask settled may
// be minted, written or run. The three reproductions from the review of the A3 merge come first: the writer goal wrote
// Email when Jev chose only Name; a resumed native plan wrote into a field that changed after the question; and a
// picked person never reached native planning.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setGeneratorClock } from "../src/fill/candidates.ts";
import { askScope, fieldFingerprint, type AskScope } from "../src/fill/ask-scope.ts";
import { checkValues, ContractError, fieldContract, guardFor, isChecked, mintExempt, type Proposed } from "../src/fill/contract.ts";
import { mintOf, proposeFill, type FillScope } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { ScreenModel } from "../src/model.ts";
import { PROTOCOL_VERSION, type GoalProgress } from "../src/protocol.ts";
import { AskAsks, AskRefused, planAsk } from "../src/planner/ask.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { planTask } from "../src/planner/planner.ts";
import { PlannerError, validatePlan } from "../src/planner/validate.ts";
import type { PlanningSnapshot } from "../src/codemode/types.ts";
import type { WriterPort } from "../src/writer/port.ts";
import { GROQ_QWEN_3_8_27B as FAKE_WRITER_ROUTE } from "../src/writer/config.ts";
import { button, cannedProgram, fieldKey, goalScene, line, MAIL, standInJev, SUPPORT, textField, type CannedStep, type GoalScene } from "./goal-desk.ts";
import { field, node, snap } from "./builders.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { FakeCalendar } from "../src/executor/means.ts";
import type { Step } from "../src/executor/schema.ts";
import { executorWindow, FakeApp, K, TITLE, WIN as FA_WIN } from "./fake-app.ts";

beforeEach(() => setGeneratorClock(() => 0));
afterEach(() => setGeneratorClock(null));

const MEMORY = [
  { id: "about-1", label: "Name", text: "Elena Vance", whose: "user" as const },
  { id: "about-2", label: "Email", text: "elena.vance@example.com", whose: "user" as const },
];
const VALUES: Record<string, string> = { Name: "Elena Vance", Email: "elena.vance@example.com" };
const WIN = "signup";
const NAME = "sf/name";
const EMAIL = "sf/email";

function desk(email: { label?: string; value?: string } = {}): ScreenModel {
  const m = new ScreenModel();
  m.apply(
    snap([field(NAME, "", { label: "Name", frame: [10, 10, 200, 20] }), field(EMAIL, email.value ?? "", { label: email.label ?? "Email", frame: [10, 40, 200, 20] }), node("sf/submit", "AXButton", { label: "Submit", frame: [10, 70, 80, 20] })], {
      at: 1000,
      windowId: WIN,
      title: "Sign up",
      app: { pid: 7100, bundleId: "com.example.signup", name: "Signup" },
      focused: true,
      focusedKey: NAME,
    }),
  );
  return m;
}
const win = (m: ScreenModel) => m.windows.get(WIN) ?? (() => { throw new Error("no form"); })();
const scopeOf = (m: ScreenModel, keys: readonly string[], person: string | null = null): AskScope => {
  const w = win(m);
  return askScope(WIN, null, keys, Object.fromEntries([NAME, EMAIL].map((k) => [k, fieldFingerprint(w, k)])), person);
};
const proposed = (m: ScreenModel, key: string, text: string, owner: Proposed["owner"] = "user"): Proposed => {
  const w = win(m);
  return { field: fieldContract(w, w.nodes.get(key) as never), text, display: text, provenance: { kind: "instruction", span: text }, owner };
};

/**
 * Jev for an Ask: heads say `route`, the scope ask says asks for `asks` (unclear for `unclear`), and every value
 * question takes the field's value from VALUES: the widest plan a planner could be talked into.
 */
const jev = (asks: readonly string[], o: { route?: string; unclear?: readonly string[] } = {}): AskJev => async (req: JevRequest) => ({
  model: "jev-test",
  inputTokens: 1,
  latencyMs: 1,
  costUsd: 0,
  answers: Object.fromEntries(
    Object.entries(req.questions).map(([id, q]) => {
      const ins = String(q.instructions);
      const pick = (choice: string) => [id, { choice, confidence: 0.95 }] as const;
      if (req.purpose === "ask.heads") return pick({ route: o.route ?? "plan", why: "nothingToFill", source: "any", whose: "user" }[id] ?? "none");
      if (req.purpose === "ask.scope") {
        const label = /[Tt]he field '([^']+)'/u.exec(ins)?.[1] ?? "";
        return pick((o.unclear ?? []).includes(label) ? "unclear" : asks.includes(label) ? "asks" : "not");
      }
      if (id === "press") return pick("none" in q.criteria ? "none" : (Object.keys(q.criteria).at(-1) ?? "none"));
      const want = Object.entries(VALUES).find(([label]) => ins.includes(`'${label}'`))?.[1];
      const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => String(d).startsWith(`"${want}"`));
      if (hit !== undefined) return pick(hit[0]);
      if ("yes" in q.criteria) return pick("yes");
      if ("user" in q.criteria) return pick("user");
      return pick(Object.keys(q.criteria).find((k) => k !== "keep" && k !== "none") ?? "none");
    }),
  ),
});

describe("the write contract under an Ask's scope", () => {
  it("checkValues mints only fields in the scope, refuses a changed field and a value not the picked person's", async () => {
    const m = desk();
    const scope = scopeOf(m, [NAME]);
    // The suite's stand-in verifier calls every value it is asked about exact (test/setup/verifier.ts).
    const r = await checkValues([proposed(m, NAME, "Elena Vance"), proposed(m, EMAIL, "elena.vance@example.com")], { askJev: jev([]), ledger: null, now: 1, scoped: { scope, documentOf: null } });
    expect(r.results.map((x) => (isChecked(x) ? "minted" : x.why))).toEqual(["minted", "outOfScope"]);
    expect((r.ok[0] as { scope?: AskScope }).scope).toBe(scope);
    const changed = desk({ label: "Work email" });
    const r2 = await checkValues([proposed(changed, EMAIL, "elena.vance@example.com")], { askJev: jev([]), ledger: null, now: 1, scoped: { scope: scopeOf(m, [NAME, EMAIL]), documentOf: null } });
    expect(r2.refused[0]).toMatchObject({ why: "outOfScope", says: "'Work email' changed since Caret asked about it" });
    const person = scopeOf(m, [NAME], "Bea");
    const r3 = await checkValues([proposed(m, NAME, "Elena Vance", "user")], { askJev: jev([]), ledger: null, now: 1, scoped: { scope: person, documentOf: null } });
    expect(r3.refused[0]?.says).toBe("the value for 'Name' is not Bea's, whom you picked");
  });

  it("mintExempt refuses outside the scope, and stamps the scope on what it mints", () => {
    const m = desk();
    const scope = scopeOf(m, [NAME]);
    expect(() => mintExempt(proposed(m, EMAIL, "elena.vance@example.com"), "userTyped", 1, "", { scope, documentOf: null })).toThrow(ContractError);
    expect(mintExempt(proposed(m, NAME, "Elena Vance"), "userTyped", 1, "", { scope, documentOf: null }).scope).toBe(scope);
  });

  it("validatePlan refuses a write minted outside the Ask's scope, and one whose field changed since", () => {
    const m = desk();
    const scope = scopeOf(m, [NAME, EMAIL]);
    const plan = (key: string) => ({ id: "p", title: "t", slots: { v1: "v" }, steps: [{ says: "x", end: { kind: "valueEquals", window: { bundleId: "com.example.signup", title: "Sign up" }, target: { key, describe: "f" }, value: "{{v1}}" } }] });
    const mintFree = mintExempt(proposed(m, EMAIL, "Elena Vance"), "userTyped", 1);
    expect(() => validatePlan(plan(EMAIL), { v1: "Elena Vance" }, { model: m, memory: MEMORY, instruction: "x", scoped: { scope, documentOf: null } }, new Map([["v1", mintFree]]))).toThrow(/not checked under this Ask's scope/u);
    const minted = mintExempt(proposed(m, EMAIL, "Elena Vance"), "userTyped", 1, "", { scope, documentOf: null });
    expect(validatePlan(plan(EMAIL), { v1: "Elena Vance" }, { model: m, memory: MEMORY, instruction: "x", scoped: { scope, documentOf: null } }, new Map([["v1", minted]])).writes).toHaveLength(1);
    // The user types into Email between the plan and its check.
    m.apply(snap([field(NAME, "", { label: "Name" }), field(EMAIL, "typed", { label: "Email" }), node("sf/submit", "AXButton", { label: "Submit" })], { at: 2000, windowId: WIN, title: "Sign up", app: { pid: 7100, bundleId: "com.example.signup", name: "Signup" } }));
    expect(() => validatePlan(plan(EMAIL), { v1: "Elena Vance" }, { model: m, memory: MEMORY, instruction: "x", scoped: { scope, documentOf: null } }, new Map([["v1", minted]]))).toThrow(PlannerError);
  });

  it("the executor's guard refuses a field that changed between the mint and the dispatch", () => {
    const m = desk();
    const scope = scopeOf(m, [EMAIL]);
    const minted = mintExempt(proposed(m, EMAIL, "elena.vance@example.com"), "userTyped", 1, "", { scope, documentOf: null });
    const guard = guardFor(() => m, new Map([[0, minted]]));
    expect(guard(0, "elena.vance@example.com", { windowId: WIN, node: win(m).nodes.get(EMAIL) as never, window: win(m) })).toBeNull();
    const moved = desk({ label: "Backup email" });
    expect(guard(0, "elena.vance@example.com", { windowId: WIN, node: win(moved).nodes.get(EMAIL) as never, window: win(moved) })).toBe("'Email' changed since Caret asked about it");
    // With no window to read, a scoped value is not written.
    expect(guard(0, "elena.vance@example.com", { windowId: WIN, node: win(m).nodes.get(EMAIL) as never })).toMatch(/can't see the field/u);
  });
});

describe("the scope is bound to the page document, read through the owning helper's reader (rulings B, E)", () => {
  it("refuses a field with the same key and the same reading on another document, and with no reader at all", async () => {
    let doc = "doc-1";
    const documentOf = (): string => doc;
    const m = desk();
    const w = win(m);
    const scope = askScope(WIN, documentOf(), [NAME], { [NAME]: fieldFingerprint(w, NAME) }, null);
    const check = (reader: (() => string) | null) => checkValues([proposed(m, NAME, "Elena Vance")], { askJev: jev([]), ledger: null, now: 1, scoped: { scope, documentOf: reader } });
    const before = await check(documentOf);
    expect(before.ok).toHaveLength(1);
    // A page's scope checked by a caller with no reader holds nothing: it cannot tell the document.
    expect((await check(null)).refused[0]?.why).toBe("outOfScope");
    doc = "doc-2";
    expect((await check(documentOf)).refused[0]).toMatchObject({ why: "outOfScope", says: "the page is no longer the one Caret asked about 'Name' on" });
    const minted = before.ok[0] as NonNullable<(typeof before.ok)[number]>;
    const guard = guardFor(() => m, new Map([[0, minted]]), documentOf);
    expect(guard(0, "Elena Vance", { windowId: WIN, node: w.nodes.get(NAME) as never, window: w })).toMatch(/no longer the one/u);
  });
});

describe("every path proposes every field; only the Ask's scope is minted", () => {
  it("fill: a FillScope wider than the Ask's (a path bug) still mints only the Ask's fields", async () => {
    const m = desk();
    const scope = scopeOf(m, [NAME]);
    const wide: FillScope = { fields: [NAME, EMAIL], windows: null, memory: true, instruction: "fill this in", person: null, literals: new Map() };
    const about = MEMORY.map((x, i) => ({ id: `about-${i + 1}`, label: x.label, value: x.text, kind: x.label === "Email" ? ("email" as const) : ("fullName" as const) }));
    const p = await proposeFill(m, jev([]), WIN, NAME, 2000, { about: about as never, scope: wide, scoped: { scope, documentOf: null }, rand: () => 0 });
    // Name, in both scopes, survives with its value and the Ask's scope on its mint; Email is withheld as outside it.
    const name = p.fields.find((f) => f.key === NAME);
    expect(name?.value).toBe("Elena Vance");
    expect(mintOf(name as never)?.scope).toBe(scope);
    const email = p.fields.find((f) => f.key === EMAIL);
    expect(email).toMatchObject({ value: null, withheld: "outOfScope" });
  });

  it("native plan: a planner told nothing of the fields writes only the scope's", async () => {
    const m = desk();
    const scope = scopeOf(m, [NAME]);
    const d = await planTask("fill out this form", m, { values: () => MEMORY }, { askJev: jev([]), offerKey: "n1", windowId: WIN, now: 2000, rand: () => 0, scoped: { scope, documentOf: null } });
    expect(d.checked.writes.map((w) => w.node.key)).toEqual([NAME]);
    expect(d.checked.scope).toBe(scope);
  });

  it("resumed native plan (review reproduction 2): a field that changed after the question is not written", async () => {
    const ask = jev(["Name"], { unclear: ["Email"] });
    const plain = "put my details in and tidy the form up";
    const e = await planAsk(plain, desk(), { values: () => MEMORY }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "r1", windowId: WIN, now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    const email = q.options.find((c) => c.option.kind === "field" && c.option.label === "Email");
    if (email === undefined) throw new Error("no Email option");
    // Email now holds text the user typed while the question was open.
    const after = await planAsk(plain, desk({ value: "typed by the user" }), { values: () => MEMORY }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "r1", windowId: WIN, now: 3000, resume: { ...q.resume, fixed: { ...q.resume.fixed, ...email.fixes } } }).catch((x: unknown) => x);
    expect(after).toBeInstanceOf(AskRefused);
    expect(JSON.stringify((after as AskRefused).detail ?? "")).not.toContain("wrote");
  });

  it("native plan after a picked person (review reproduction 3): no value the planner can't call that person's is written", async () => {
    const ask = jev(["Name"], { unclear: ["Email"] });
    const plain = "put Bea's details in and tidy the form up";
    const e = await planAsk(plain, desk(), { values: () => MEMORY }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "p1", windowId: WIN, now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    const q = (e as AskAsks).question;
    const picked = await planAsk(plain, desk(), { values: () => MEMORY }, [], { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "p1", windowId: WIN, now: 3000, resume: { ...q.resume, fixed: { ...q.resume.fixed, fields: [NAME, EMAIL], person: { kind: "person", name: "Bea" } } } }).catch((x: unknown) => x);
    // The native planner reads no owner, so none of the user's own values is Bea's: nothing is written.
    if (picked instanceof Error) expect(picked).toBeInstanceOf(AskRefused);
    else expect((picked as { checked: { writes: unknown[] } }).checked.writes).toEqual([]);
  });
});

describe("the writer goal (review reproduction 1)", () => {
  const scenes: GoalScene[] = [];
  afterEach(async () => {
    for (const s of scenes.splice(0)) await s.close();
  });
  const NOTE = { windowId: "6161-9", app: MAIL, title: "Notes — me", nodes: [line(MAIL, 0, "Name: Elena Vance"), line(MAIL, 1, "Email: elena.vance@example.com")] };
  const FORM = { windowId: "7171-9", app: SUPPORT, title: "Support — Sign up", nodes: [textField(SUPPORT, "Name"), textField(SUPPORT, "Email"), button(SUPPORT, "Submit")] };
  const STEPS: CannedStep[] = [
    { fill: { window: "Sign up", target: "Name", value: "Elena Vance" } },
    { fill: { window: "Sign up", target: "Email", value: "elena.vance@example.com" } },
  ];
  const writer: WriterPort = {
    route: FAKE_WRITER_ROUTE,
    async write(req) {
      const base = { model: "canned", provider: "canned", inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
      const program = cannedProgram((req.input as { snapshots: PlanningSnapshot[] }).snapshots, STEPS);
      return { ...base, output: { program, reply: program } };
    },
  };

  it("an Ask whose Jev chose only Name gets a goal that writes Name and leaves Email", async () => {
    const values = standInJev();
    const askJev: AskJev = async (req) => (req.purpose === "ask.heads" || req.purpose === "ask.scope" ? jev(["Name"])(req) : values(req));
    const sc = goalScene({ scripts: [STEPS], windows: [NOTE, FORM], userWindow: FORM.windowId, writer, askJev, ask: { maker: "heads" } });
    scenes.push(sc);
    const r = (await sc.helper.handlePlanRequest({ type: "planRequest", v: PROTOCOL_VERSION, requestId: "w1", at: sc.desk.at, instruction: "fill the form and submit it", windowId: FORM.windowId }, sc.session, true, true)) as GoalProgress;
    expect(r.type).toBe("goalProgress");
    const steps = (r as Extract<GoalProgress, { event: "segment" }>).steps.map((s) => s.says);
    expect(steps.some((s) => s.startsWith("Name"))).toBe(true);
    expect(steps.some((s) => s.startsWith("Email"))).toBe(false);
    expect(JSON.stringify(r)).toContain("the Ask did not ask Caret to fill");
    expect(fieldKey(SUPPORT, "Email")).toBeTruthy();
  });
});

describe("the executor rereads each field right before it writes it (re-review blocker 1)", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  /** Runs right before each dispatch, after the step resolved its field (ExecutorDeps.beforeAct). */
  let beforeAct: (step: number) => void = () => {};
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-i2-exec-"));
    store = new Store(join(dir, "data"));
    app = new FakeApp(executorWindow());
    beforeAct = () => {};
    helper = new Helper({ store, askJev: () => Promise.reject(new Error("no Jev in this test")), shadow: false, allowBackgroundFocus: false, publish: () => {}, readerLink: app, calendar: new FakeCalendar(), executorHooks: { beforeAct: async (_t, i) => beforeAct(i) } });
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const heading = (before: string): void => {
    const at = app.nodes.findIndex((n) => n.key === before);
    app.nodes.splice(at, 0, { key: K("heading:work~0"), parent: null, role: "AXHeading", label: "Work contact" });
    app.show();
  };

  it("refuses step 2 when its field moved under a new heading after the step resolved it, right before the dispatch", async () => {
    const nameKey = K("textfield:name~0");
    const emailKey = K("textfield:email~0");
    const w = helper.model.windows.get(FA_WIN);
    if (w === undefined) throw new Error("no executor window");
    const scope = askScope(FA_WIN, null, [nameKey, emailKey], Object.fromEntries([nameKey, emailKey].map((k) => [k, fieldFingerprint(w, k)])), null);
    const mintFor = (key: string, text: string) => mintExempt({ field: fieldContract(w, w.nodes.get(key) as never), text, display: text, provenance: { kind: "instruction", span: text }, owner: "user" }, "userTyped", 1, "", { scope, documentOf: null });
    const mints = new Map([[0, mintFor(nameKey, "Dana Whitfield")], [1, mintFor(emailKey, "dana@example.com")]]);
    beforeAct = (i) => {
      if (i === 1) heading(emailKey);
    };
    const steps: Step[] = [nameKey, emailKey].map((key, i) => ({ says: `${key} holds v${i}`, end: { kind: "valueEquals", window: { titleStartsWith: TITLE }, target: { key, describe: key }, value: i === 0 ? "Dana Whitfield" : "dana@example.com" } }));
    const r = await helper.executor.run("i2-exec2", { id: "i2-exec2", title: "t", slots: {}, steps }, {}, undefined, { guard: guardFor(() => helper.model, mints) });
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(app.node(emailKey)?.value).toBe("old@example.com");
  });

  it("refuses step 2 when step 1's write moved its field under a new heading", async () => {
    const nameKey = K("textfield:name~0");
    const emailKey = K("textfield:email~0");
    const w = helper.model.windows.get(FA_WIN);
    if (w === undefined) throw new Error("no executor window");
    const scope = askScope(FA_WIN, null, [nameKey, emailKey], Object.fromEntries([nameKey, emailKey].map((k) => [k, fieldFingerprint(w, k)])), null);
    const mintFor = (key: string, text: string) => mintExempt({ field: fieldContract(w, w.nodes.get(key) as never), text, display: text, provenance: { kind: "instruction", span: text }, owner: "user" }, "userTyped", 1, "", { scope, documentOf: null });
    const mints = new Map([[0, mintFor(nameKey, "Dana Whitfield")], [1, mintFor(emailKey, "dana@example.com")]]);
    // Writing Name makes the app put a heading right before Email: the field Email is now under 'Work contact'.
    app.normalize = (v) => {
      if (v === "Dana Whitfield" && !app.nodes.some((n) => n.key === K("heading:work~0"))) {
        const at = app.nodes.findIndex((n) => n.key === emailKey);
        app.nodes.splice(at, 0, { key: K("heading:work~0"), parent: null, role: "AXHeading", label: "Work contact" });
      }
      return v;
    };
    const steps: Step[] = [nameKey, emailKey].map((key, i) => ({ says: `${key} holds v${i}`, end: { kind: "valueEquals", window: { titleStartsWith: TITLE }, target: { key, describe: key }, value: i === 0 ? "Dana Whitfield" : "dana@example.com" } }));
    const r = await helper.executor.run("i2-exec", { id: "i2-exec", title: "t", slots: {}, steps }, {}, undefined, { guard: guardFor(() => helper.model, mints) });
    expect(r).toMatchObject({ outcome: "stopped", step: 1 });
    expect(app.node(nameKey)?.value).toBe("Dana Whitfield");
    expect(app.node(emailKey)?.value).toBe("old@example.com");
  });
});
