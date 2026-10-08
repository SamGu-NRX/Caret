// W2: a checked value's provenance travels from the check to the write. The lead's G2 round-3 gaps and the W2 review's
// findings, each reproduced: a source field relabelled after the check, a source sentence changed after acceptance
// and before the first write, a value changed while the verifier was asked, a mint used in another window, a field
// whose autocomplete changed, a source line whose labels changed around a value that stayed. All text is synthetic.
import { TEST_AUTHORITY } from "./mint.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { checkValues, ContractError, fieldContract, guardFor, isChecked, makeFieldContract, mintExempt, provenanceStale, requireChecked, windowProvenance, type Proposed } from "../src/fill/contract.ts";
import { recheckFields, writtenFields } from "../src/offers/fill-popup.ts";
import { PlannerError, validatePlan } from "../src/planner/validate.ts";
import { fieldKinds } from "../src/fill/kinds.ts";
import { PROTOCOL_VERSION, type HelperMessage, type Node, type TaskProgress } from "../src/protocol.ts";
import { field, jevPickingText, MAIL_APP, snap, text } from "./builders.ts";
import { executorWindow, FakeApp, K, TITLE, WIN, wireButtons } from "./fake-app.ts";

const T0 = 1_790_000_000_000;
const SRC = "6161-1";
const opts = { askJev: async () => { throw new Error("the suite's stand-in verifier answers"); }, ledger: null, now: T0, authority: TEST_AUTHORITY } as const;

describe("an editable source field's label is part of its value's provenance (lead, G2 round 3 a)", () => {
  /** A form with Phone, and a window whose editable field labelled `label` holds the number. */
  const desk = (label: string): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap([field("src/mobile", "555-0164", { label })], { at: T0 - 20_000, windowId: SRC, title: "Contact card", app: MAIL_APP, focused: true }));
    m.apply(snap([field("form/phone", "", { label: "Phone" }), field("form/name", "", { label: "Name" })], { at: T0, windowId: "form", title: "Order", focused: true, focusedKey: "form/phone" }));
    return m;
  };

  it("refuses the value once the field it was read from is relabelled 'Do not use'", async () => {
    const m = desk("Mobile");
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes("'Phone'") ? "555-0164" : null), 0.95), "form", "form/phone", T0, { rand: () => 0 });
    const g = writtenFields(p, m.windows.get("form"));
    expect(g.fields.map((f) => [f.key, f.value])).toEqual([["form/phone", "555-0164"]]);
    const unchanged = recheckFields(m, g, () => null);
    expect("proposal" in unchanged && unchanged.proposal.fields.length).toBe(1);
    m.apply(snap([field("src/mobile", "555-0164", { label: "Do not use" })], { at: T0 + 1000, windowId: SRC, title: "Contact card", app: MAIL_APP }));
    const after = recheckFields(m, g, () => null);
    expect("proposal" in after && after.proposal.fields.map((f) => f.key)).toEqual([]);
    expect("proposal" in after && after.dropped.map((d) => d.log)).toEqual([expect.stringContaining("the label it was read beside changed")]);
  });
});

describe("a checked value's source is rechecked right before each write (lead, G2 round 3 b)", () => {
  let dir: string;
  let store: Store;
  let app: FakeApp;
  let helper: Helper;
  let published: HelperMessage[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-w2-prov-"));
    store = new Store(join(dir, "data"));
    app = new FakeApp(executorWindow());
    wireButtons(app);
    published = [];
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: (m) => published.push(m), readerLink: app });
    app.helper = helper;
    app.show();
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const progress = (taskId: string): TaskProgress[] => published.filter((m): m is TaskProgress => m.type === "taskProgress" && m.taskId === taskId);
  const writes = () => app.verbs.filter((v) => v.kind === "write");
  const showSource = (line: string): void => void helper.handleReader(snap([text("src/line", line)], { at: Date.now(), windowId: SRC, title: "Notes", app: MAIL_APP }));
  const run = (taskId: string, guard?: (step: number, value: string) => string | null) =>
    (helper as unknown as { executor: { run: (id: string, plan: unknown, slots: Record<string, string>, expect?: unknown, o?: object) => Promise<unknown> } }).executor.run(
      taskId,
      { id: taskId, title: "t", slots: {}, steps: [{ says: "Name holds Dana Reyes", end: { kind: "valueEquals", window: { titleStartsWith: TITLE }, target: { key: K("textfield:name~0"), describe: "Name" }, value: "Dana Reyes" } }] },
      {},
      undefined,
      guard === undefined ? {} : { guard },
    );

  it("writes nothing, and stops as changed, when the source says 'Do not use' after the value was accepted (a name here, since the fixture's free field is Name)", async () => {
    showSource("Contact: Dana Reyes");
    const w = helper.model.windows.get(WIN) as NonNullable<ReturnType<typeof helper.model.windows.get>>;
    const prov = windowProvenance(helper.model.windows.get(SRC), { text: "Dana Reyes", context: "Contact", labelled: true, source: { windowId: SRC, nodeKey: "src/line", appName: "Mail Fixture", windowTitle: "Notes" } });
    const [mint] = (await checkValues([{ field: fieldContract(w, w.nodes.get(K("textfield:name~0")) as Node), text: "Dana Reyes", display: "Dana Reyes", provenance: prov, owner: null }], opts)).ok;
    if (mint === undefined) throw new Error("not minted");
    // Accepted: the source still says what it said.
    expect(provenanceStale(helper.model, mint.provenance)).toBeNull();
    showSource("Do not use: Dana Reyes");
    // Before W2 nothing carried the provenance to the executor: the run wrote the value and reported done.
    await run("t-before");
    expect(writes().map((v) => v.kind === "write" && v.value)).toEqual(["Dana Reyes"]);
    expect(progress("t-before").at(-1)?.phase).toBe("done");
    // With the guard every accepted fill and plan now passes (contract.ts guardFor), the step is not dispatched.
    app.verbs.length = 0;
    const name = app.node(K("textfield:name~0"));
    if (name !== undefined) delete name.value;
    app.show();
    await run("t-after", guardFor(() => helper.model, new Map([[0, mint]]), TEST_AUTHORITY, null));
    expect(writes()).toEqual([]);
    expect(progress("t-after").at(-1)?.stopReason).toBe("changed");
  });
});

describe("the W2 review's contract findings", () => {
  const fc = (key: string, windowId = "form", autocomplete?: Node["autocomplete"]) =>
    makeFieldContract({ windowId, node: { key, parent: null, role: "AXTextField", label: "Full name", ...(autocomplete === undefined ? {} : { autocomplete }) }, descriptor: "Text field. Label: 'Full name'.", name: "Full name", labelWords: ["Full name"], control: "text", kinds: fieldKinds(["Full name"]), part: "full" });

  it("mints what the verifier was asked about, though the caller changes its object meanwhile (finding 2)", async () => {
    const p: { -readonly [K in keyof Proposed]: Proposed[K] } = { field: fc("k1"), text: "Kenji Watanabe", display: "Kenji Watanabe", provenance: { kind: "instruction", span: "Kenji Watanabe" }, owner: null };
    const pending = checkValues([p], opts);
    p.text = "REFUSED OR UNVERIFIED";
    const r = await pending;
    expect(r.ok.map((c) => c.text)).toEqual(["Kenji Watanabe"]);
    expect(Object.isFrozen(r.ok[0]?.provenance)).toBe(true);
  });

  it("refuses a mint made for the same key in another window (finding 5)", async () => {
    const [c] = (await checkValues([{ field: fc("k1", "one"), text: "Kenji Watanabe", display: "Kenji Watanabe", provenance: { kind: "instruction", span: "Kenji Watanabe" }, owner: null }], opts)).ok;
    expect(isChecked(c)).toBe(true);
    expect(() => requireChecked(c, "Kenji Watanabe", "k1", "two", "x")).toThrow(ContractError);
    expect(requireChecked(c, "Kenji Watanabe", "k1", "one", "x")).toBe(c);
  });

  /** A form whose Full name field the page marks `ac`, beside a note whose line is `line`. */
  const desk = (ac: Node["autocomplete"], line: string): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap([text("note/l", line)], { at: T0 - 10_000, windowId: "note", title: "Notes", app: MAIL_APP }));
    m.apply(snap([field("form/full", "", { label: "Full name", ...(ac === undefined ? {} : { autocomplete: ac }) })], { at: T0, windowId: "form", title: "Apply", focused: true }));
    return m;
  };
  const plan = { id: "p", title: "p", slots: { v1: "the name" }, steps: [{ says: "Full name", end: { kind: "valueEquals", window: { bundleId: "dev.caret.fixture", title: "Apply" }, target: { key: "form/full", describe: "Full name" }, value: "{{v1}}" } }] };
  const code = (f: () => unknown): string => {
    try {
      f();
      return "passed";
    } catch (e) {
      return e instanceof PlannerError ? e.code : String(e);
    }
  };
  const minted = async (m: ScreenModel) => {
    const w = m.windows.get("form") as NonNullable<ReturnType<typeof m.windows.get>>;
    const prov = windowProvenance(m.windows.get("note"), { text: "Mary Ann", context: "First name", labelled: true, source: { windowId: "note", nodeKey: "note/l", appName: "Mail Fixture", windowTitle: "Notes" } });
    const [c] = (await checkValues([{ field: fieldContract(w, w.nodes.get("form/full") as Node), text: "Mary Ann", display: "Mary Ann", provenance: prov, owner: null }], opts)).ok;
    if (c === undefined) throw new Error("not minted");
    return c;
  };

  it("refuses at acceptance a field whose autocomplete changed since its value was checked (finding 6)", async () => {
    const m = desk("name", "First name: Mary Ann");
    const c = await minted(m);
    expect(code(() => validatePlan(plan, { v1: "Mary Ann" }, { origin: TEST_AUTHORITY, model: m, memory: [], instruction: "" }, new Map([["v1", c]])))).toBe("passed");
    m.apply(snap([field("form/full", "", { label: "Full name", autocomplete: "given-name" })], { at: T0 + 1000, windowId: "form", title: "Apply", focused: true }));
    expect(code(() => validatePlan(plan, { v1: "Mary Ann" }, { origin: TEST_AUTHORITY, model: m, memory: [], instruction: "" }, new Map([["v1", c]])))).toBe("unknownTarget");
  });

  it("refuses at acceptance a value whose source line changed around it (finding 7)", async () => {
    const m = desk(undefined, "First name: Mary Ann");
    const c = await minted(m);
    expect(code(() => validatePlan(plan, { v1: "Mary Ann" }, { origin: TEST_AUTHORITY, model: m, memory: [], instruction: "" }, new Map([["v1", c]])))).toBe("passed");
    m.apply(snap([text("note/l", "First name: Mary; Last name: Ann; Full name: Mary Ann")], { at: T0 + 1000, windowId: "note", title: "Notes", app: MAIL_APP }));
    expect(code(() => validatePlan(plan, { v1: "Mary Ann" }, { origin: TEST_AUTHORITY, model: m, memory: [], instruction: "" }, new Map([["v1", c]])))).toBe("untracedValue");
  });

  it("keeps the executor's guard to the mint's own text (finding 1)", async () => {
    const [c] = (await checkValues([{ field: fc("k1"), text: "Kenji Watanabe", display: "Kenji Watanabe", provenance: { kind: "instruction", span: "Kenji Watanabe" }, owner: null }], opts)).ok;
    const guard = guardFor(() => new ScreenModel(), new Map([[0, c as NonNullable<typeof c>]]), TEST_AUTHORITY, null);
    expect(guard(0, "Kenji Watanabe")).toBeNull();
    expect(guard(0, "REFUSED OR UNVERIFIED")).toMatch(/not the one Caret checked/u);
    expect(guard(1, "anything")).toMatch(/no check/u);
  });
});

describe("the W2 second opinion's findings", () => {
  const field = (autocomplete?: Node["autocomplete"]) => makeFieldContract({ windowId: "form", node: { key: "k1", parent: null, role: "AXTextField", label: "Name", ...(autocomplete === undefined ? {} : { autocomplete }) }, descriptor: "Text field. Label: 'Name'.", name: "Name", labelWords: ["Name"], control: "text", kinds: new Set(), part: "full" });

  it("rechecks at dispatch that the resolved element is the field checked, still asking the same (finding 3)", async () => {
    const [c] = (await checkValues([{ field: field("name"), text: "Mary Ann", display: "Mary Ann", provenance: { kind: "instruction", span: "Mary Ann" }, owner: null }], opts)).ok;
    const guard = guardFor(() => new ScreenModel(), new Map([[0, c as NonNullable<typeof c>]]), TEST_AUTHORITY, null);
    const node = (extra: Partial<Node>): Node => ({ key: "k1", parent: null, role: "AXTextField", label: "Name", autocomplete: "name", ...extra });
    expect(guard(0, "Mary Ann", { windowId: "form", node: node({}) })).toBeNull();
    expect(guard(0, "Mary Ann", { windowId: "other", node: node({}) })).toMatch(/not the one Caret checked/u);
    expect(guard(0, "Mary Ann", { windowId: "form", node: node({ autocomplete: "given-name" }) })).toMatch(/asks for something else/u);
  });

  it("freezes an exemption's value before judging it, so the caller's object cannot change the mint (finding 2)", () => {
    const provenance = { kind: "instruction" as const, span: "Canada" };
    const c = mintExempt({ field: field(), text: "Canada", display: "Canada", provenance, owner: null }, "optionLabel", 0, "", TEST_AUTHORITY);
    provenance.span = "Mexico";
    expect(c.provenance).toEqual({ kind: "instruction", span: "Canada" });
    expect(Object.isFrozen(c.provenance)).toBe(true);
  });
});

void PROTOCOL_VERSION;
