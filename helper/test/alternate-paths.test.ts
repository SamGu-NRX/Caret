// V6: the alternate-field veto (fill/alternate.ts) on every write path: across a page plan's parts, in goal lowering,
// against a primary that changes after the proposal, and against primaries Caret can read but not write. Every name
// and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { guardFor, setCheckObserver } from "../src/fill/contract.ts";
import { fillPlan, recheckFill, writtenFields } from "../src/offers/fill-popup.ts";
import { buildInventory } from "../src/goals/inventory.ts";
import { lowerGoal } from "../src/goals/lower.ts";
import { planPage } from "../src/goals/page-planner.ts";
import { macClock } from "../src/offers/event-time.ts";
import type { DraftPlan } from "../src/codemode/types.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { Node, PageControl } from "../src/protocol.ts";
import { field, jevPickingText, node, snap, text, value } from "./builders.ts";
import { c } from "./fake-page.ts";
import { closeRigs, rig, WIN } from "./page-rig.ts";
import { standInJev } from "./goal-desk.ts";
import { mintWrites } from "../src/planner/planner.ts";

afterEach(() => {
  closeRigs();
  setCheckObserver(null);
});

const FORM = "5150-1";
const SOURCE = "6160-1";
const EMAIL = "person@example.test";

/** A source window holding EMAIL, and the form `form` in front of it. */
function desk(form: Node[], source = `Email: ${EMAIL}`): ScreenModel {
  const model = new ScreenModel();
  model.apply(snap([text("source", source, [0, 0, 300, 20])], { at: 1000, windowId: SOURCE, values: [value("email", EMAIL, "source")] }));
  model.apply(snap(form, { at: 2000, windowId: FORM, focused: true }));
  return model;
}

const alternate = (): Node => field("alternate", "", { label: "Alternate email", frame: [100, 40, 200, 24] });

describe("B1: a page plan's parts see each other's proposals before the verifier", () => {
  it("withholds an Alternate email in the second part that repeats the Email proposed in the first", async () => {
    // 21 empty fields, so the page planner asks in two parts (MAX_FIELDS is 20): Email first, Alternate email last.
    const controls = (): PageControl[] => [
      c("e0", "email", "Email", { value: "" }),
      ...Array.from({ length: 19 }, (_, i) => c(`e${i + 1}`, "text", `Field ${i + 1}`, { value: "" })),
      c("e20", "email", "Alternate email", { value: "" }),
    ];
    const r = await rig({ controls, note: `Email: ${EMAIL}`, picks: { Email: EMAIL, "Alternate email": EMAIL } });
    const verified: string[] = [];
    setCheckObserver((p) => verified.push(p.field.name));
    const ask: AskJev = jevPickingText((_, ins) => (/Label: '(?:Alternate email|Email)'/u.test(ins) ? EMAIL : null), 0.95);
    const plan = await planPage(r.helper.model, { goalId: "g-parts", instruction: "fill out this form", windowId: WIN, scope: null, kind: "all", section: null, about: [], askJev: ask, now: Date.now(), clock: macClock(new Date()), readerSession: 0, pageDocument: (id) => r.host.registry.documentOf(id) });
    const says = plan.segments.flatMap((s) => s.steps.map((x) => x.says));
    expect(says).toContain(`Email: ${EMAIL}`);
    expect(says.some((s) => s.startsWith("Alternate email"))).toBe(false);
    expect(plan.warnings).toContain("Caret left Alternate email: it would repeat your Email.");
    // Vetoed before the write contract was asked about it, not after.
    expect(verified).toContain("Email");
    expect(verified).not.toContain("Alternate email");
  });
});

describe("B2: goal lowering meets the same check", () => {
  it("drops a writer's Alternate email that repeats its own Email write, before anything is minted", async () => {
    const model = desk([field("email", "", { label: "Email", frame: [100, 40, 200, 24] }), field("alternate", "", { label: "Alternate email", frame: [100, 80, 200, 24] })]);
    const inv = buildInventory(model, { instruction: "copy my email into the form", windows: [FORM, SOURCE], memory: [], calendar: null, clock: macClock(new Date(3000)), now: 3000, readerSession: 1 });
    const target = (label: string): string => [...inv.inventory.targets.values()].find((t) => t.label === label)?.ref ?? "";
    const v = [...inv.inventory.values.values()].find((x) => x.text === EMAIL)?.ref ?? "";
    expect([target("Email"), target("Alternate email"), v].every((x) => x !== "")).toBe(true);
    const verified: string[] = [];
    setCheckObserver((p) => verified.push(p.field.name));
    const draft: DraftPlan = { basedOn: inv.inventory.revisions.get(FORM) ?? "", window: FORM, steps: [{ ref: "a", kind: "fill", target: target("Email"), value: v }, { ref: "b", kind: "fill", target: target("Alternate email"), value: v }], choices: [], drafts: [], programDigest: "a".repeat(64) };
    const plan = await lowerGoal("g-writer", "copy my email into the form", draft, inv.inventory, { askJev: standInJev(), ledger: inv.ledger });
    const writes = plan.segments.flatMap((s) => s.steps.filter((x) => x.kind === "write").map((x) => x.target.label));
    expect(writes).toEqual(["Email"]);
    expect(plan.warnings).toContain("Caret left 'Alternate email' empty: it would repeat your Email.");
    expect(verified).not.toContain("Alternate email");
  });

  it("drops a writer's Alternate email that repeats a read-only Email the form already shows", async () => {
    const model = desk([node("email", "AXTextField", { label: "Email", value: EMAIL, frame: [100, 40, 200, 24] }), field("alternate", "", { label: "Alternate email", frame: [100, 80, 200, 24] })]);
    const inv = buildInventory(model, { instruction: "copy my email into the form", windows: [FORM, SOURCE], memory: [], calendar: null, clock: macClock(new Date(3000)), now: 3000, readerSession: 1 });
    const t = [...inv.inventory.targets.values()].find((x) => x.label === "Alternate email")?.ref ?? "";
    const v = [...inv.inventory.values.values()].find((x) => x.text === EMAIL)?.ref ?? "";
    const draft: DraftPlan = { basedOn: inv.inventory.revisions.get(FORM) ?? "", window: FORM, steps: [{ ref: "b", kind: "fill", target: t, value: v }], choices: [], drafts: [], programDigest: "a".repeat(64) };
    await expect(lowerGoal("g-writer", "copy my email into the form", draft, inv.inventory, { askJev: standInJev(), ledger: inv.ledger })).rejects.toThrow(/would repeat your Email/);
  });
});

describe("the native planner's mints meet the same check", () => {
  it("refuses a plan's Alternate email that repeats the plan's own Email write", async () => {
    const model = desk([field("email", "", { label: "Email", frame: [100, 40, 200, 24] }), alternate()]);
    const w = model.windows.get(FORM);
    if (w === undefined) throw new Error("no form");
    const write = (key: string, name: string) => ({ key, w, node: w.nodes.get(key) as Node, name, text: EMAIL, provenance: { kind: "instruction" as const, span: EMAIL }, owner: null });
    const r = await mintWrites([write("email", "Email"), write("alternate", "Alternate email")], { askJev: jevPickingText(() => null), ledger: null, now: 3000, authority: { kind: "plan", offerKey: "o1" } });
    expect([...r.mints.keys()]).toEqual(["email"]);
    expect(r.refused).toEqual([{ key: "alternate", name: "Alternate email", says: "it would repeat your Email", why: "notExact" }]);
  });
});

describe("B3: a primary that changes after the proposal", () => {
  const form = (primary: string): Node[] => [field("email", primary, { label: "Email", frame: [100, 80, 200, 24] }), alternate()];

  it("withholds when the Email changes while the value asks are out", async () => {
    const model = desk(form("first@example.test"));
    const pick = jevPickingText((_, ins) => (/Alternate email/u.test(ins) ? EMAIL : null));
    let changed = false;
    const ask: AskJev = async (req) => {
      if (!changed) {
        changed = true;
        model.apply(snap(form(EMAIL), { at: 2500, windowId: FORM, focused: true }));
      }
      return pick(req);
    };
    const p = await proposeFill(model, ask, FORM, "alternate", 3000, { derive: false });
    expect(changed).toBe(true);
    expect(p.fields.find((f) => f.key === "alternate")?.value).toBeNull();
  });

  it("refuses at acceptance and right before dispatch when the Email changes after the preview", async () => {
    const model = desk(form("first@example.test"));
    const p = await proposeFill(model, jevPickingText((_, ins) => (/Alternate email/u.test(ins) ? EMAIL : null)), FORM, "alternate", 3000, { derive: false });
    expect(p.fields.find((f) => f.key === "alternate")?.value).toBe(EMAIL);
    const grounded = writtenFields(p, model.windows.get(FORM));
    const { checks } = fillPlan(model, grounded);
    expect(recheckFill(model, grounded, () => null)).toBeNull();
    model.apply(snap(form(EMAIL), { at: 4000, windowId: FORM, focused: true }));
    expect(recheckFill(model, grounded, () => null)).toMatch(/repeat/);
    const w = model.windows.get(FORM);
    const target = w === undefined ? undefined : { windowId: FORM, node: w.nodes.get("alternate") as Node, window: w };
    expect(guardFor(() => model, checks, { kind: "fill", proposalId: p.id }, null)(0, EMAIL, target)).toMatch(/repeat/);
  });

  it("does not write a page's Alternate email when the Email changes to the same value mid-run", async () => {
    const controls = (): PageControl[] => [c("e1", "text", "Full name", { value: "" }), c("e2", "email", "Email", { value: "first@example.test" }), c("e3", "email", "Alternate email", { value: "" })];
    const r = await rig({ controls, note: `Full name: Robin Vale\nEmail: ${EMAIL}`, picks: { "Full name": "Robin Vale", "Alternate email": EMAIL } });
    const preview = await r.ask("fill out this form from my note");
    expect(preview.event === "segment" && preview.steps.map((s) => s.says)).toContain(`Alternate email: ${EMAIL}`);
    r.page.onAct = (v, p) => {
      if (v.kind === "pageWrite" && v.id === "e1") p.find("e2").value = EMAIL;
      return null;
    };
    if (preview.event !== "segment") throw new Error("no preview");
    // The run's own expectations of the page stop it here too (executor: a field changed since the plan started); the
    // write contract's guard (the test above) is the check that holds when they do not cover the primary.
    expect((await r.accept(preview))?.outcome).toBe("stopped");
    await r.helper.goals.idle();
    expect(r.page.shown("e1")).toBe("Robin Vale");
    expect(r.page.shown("e3")).toBe("");
  });
});

describe("B4: primaries Caret can read but not write", () => {
  it.each([
    ["a read-only Email", node("email", "AXTextField", { label: "Email", value: EMAIL, frame: [100, 80, 200, 24] })],
    ["an Email dropdown", node("email", "AXPopUpButton", { label: "Email", value: EMAIL, frame: [100, 80, 200, 24] })],
  ])("withholds an Alternate email equal to %s", async (_, primary) => {
    const model = desk([primary, alternate()]);
    const p = await proposeFill(model, jevPickingText((_, ins) => (/Alternate email/u.test(ins) ? EMAIL : null)), FORM, "alternate", 3000, { derive: false });
    expect(p.fields.find((f) => f.key === "alternate")?.value).toBeNull();
  });
});
