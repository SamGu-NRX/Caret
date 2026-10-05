// Offers to the host, piece by piece: the registry and its accept checks, the fill pop-up builder, and
// "Open <app>" for pending watches. The socket-level acceptance test is offers-socket.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { Desk, PEOPLE, grid, roster } from "./scene.ts";
import { ScreenModel } from "../src/model.ts";
import { describeField } from "../src/fill/descriptor.ts";
import { HelperMessage, PROTOCOL_VERSION, type FillField, type FillProposal, type OfferAccept, type OfferAction, type OfferPopup } from "../src/protocol.ts";
import { parsePopupSpec } from "../src/popup.ts";
import { HostOfferRegistry, acceptRefusal } from "../src/offers/registry.ts";
import { buildFillPopup, fillPlan, fillPopupEligible, recheckFill, type GroundedProposal } from "../src/offers/fill-popup.ts";
import { OpenAppOffers } from "../src/offers/open-app.ts";
import { OfferGate } from "../src/offers/settings.ts";
import { offerField } from "../src/offers/field.ts";
import { fillSlots, Plan } from "../src/executor/schema.ts";
import { FIXTURE_APP, MAIL_APP, field, focus, snap, text, value } from "./builders.ts";

const accept = (offerId: string, actionId: string, overrides: Record<string, number> = {}): OfferAccept => ({ type: "offerAccept", v: PROTOCOL_VERSION, offerId, actionId, overrides, at: 1 });
const FIELD = { pid: 5150, windowId: "5150-2", key: "k", frame: null, window: { number: null, title: "Checkout" } };
const ref = { node: "5150-1/a" };

function popup(blocks: OfferPopup["spec"]["blocks"]): OfferPopup {
  return { type: "popup", v: PROTOCOL_VERSION, offerKey: "p1", at: 1, field: FIELD, spec: { v: 1, id: "p1", figure: "offering", blocks } };
}

describe("offerField", () => {
  it("carries the window's number from the reader, or null, and its title", () => {
    const m = new ScreenModel();
    const s = snap([{ key: "k", parent: null, role: "AXTextField", editable: true, frame: [1, 2, 3, 4] }], { at: 1, windowId: "1-1", title: "Seating" });
    m.apply({ ...s, window: { ...s.window, number: 4421 } });
    m.apply(snap([{ key: "k", parent: null, role: "AXTextField", editable: true }], { at: 2, windowId: "1-2", title: "Seating" }));
    expect(offerField(m.windows.get("1-1")!, "k")).toEqual({ pid: 5150, windowId: "1-1", key: "k", frame: [1, 2, 3, 4], window: { number: 4421, title: "Seating" } });
    expect(offerField(m.windows.get("1-2")!, "k").window).toEqual({ number: null, title: "Seating" });
  });
});

describe("host-offer registry", () => {
  it("keeps a record however old until it is removed: only a withdrawal ends an offer", () => {
    let now = 1000;
    const r = new HostOfferRegistry(() => now);
    r.record(popup([{ type: "header", title: { text: "T", ref } }, { type: "actions", items: [{ id: "go", label: "Go", key: "tab" }] }]), null);
    now += 24 * 60 * 60 * 1000;
    expect(r.get("p1")?.kind).toBe("popup");
    r.remove("p1");
    expect(r.get("p1")).toBeUndefined();
    r.record(popup([{ type: "header", title: { text: "T", ref } }, { type: "actions", items: [{ id: "go", label: "Go", key: "tab" }] }]), null);
    r.remove("p1");
    expect(r.size).toBe(0);
  });

  const choices = (id?: string) => ({ type: "choices" as const, ...(id === undefined ? {} : { id }), rows: [{ label: { text: "A", ref } }, { label: { text: "B", ref } }], selected: 0 });
  // One choices block per pop-up, so the picker behind the reveal replaces a facts block.
  const withReveal = popup([
    { type: "header", title: { text: "T", ref } },
    { type: "facts", id: "more", rows: [{ value: { text: "x", ref } }] },
    {
      type: "actions",
      items: [
        { id: "go", label: "Go", key: "tab" },
        { id: "pick", label: "Pick a time", key: "down", reveal: { replace: "more", with: { ...choices("times"), rows: [{ label: { text: "3:00", ref } }] } } },
      ],
    },
  ]);
  const picker = popup([{ type: "header", title: { text: "T", ref } }, choices(), { type: "actions", items: [{ id: "go", label: "Go", key: "tab" }] }]);

  it("accepts an action the pop-up has, with rows of any choices block it can reach", () => {
    for (const m of [withReveal, picker]) expect(HelperMessage.safeParse(m).success).toBe(true);
    const r = new HostOfferRegistry().record(withReveal, null);
    expect(acceptRefusal(r, accept("p1", "go"))).toBeNull();
    expect(acceptRefusal(r, accept("p1", "go", { times: 0 }))).toBeNull();
    // A choices block without an id is overridden by the key "choices".
    expect(acceptRefusal(new HostOfferRegistry().record(picker, null), accept("p1", "go", { choices: 1 }))).toBeNull();
    expect(acceptRefusal(new HostOfferRegistry().record(picker, null), accept("p1", "go", { choices: 2 }))).toBe("choices row 2 does not exist; there are 2");
  });

  it.each([
    [accept("p1", "nope"), "the offer has no action nope"],
    [accept("p1", "pick"), "action pick changes the pop-up; it does not finish it"],
    [accept("p1", "go", { choices: 0 }), "the offer has no choices block choices"],
    [accept("p1", "go", { times: 1 }), "times row 1 does not exist; there are 1"],
    [accept("p1", "go", { dates: 0 }), "the offer has no choices block dates"],
    [accept("p1", "go", { variants: 0 }), "the offer has no variants to pick from"],
  ])("refuses %j", (m, reason) => {
    expect(acceptRefusal(new HostOfferRegistry().record(withReveal, null), m)).toBe(reason);
  });

  it("checks an accept against the pop-up as the reveal left it", () => {
    const row = (t: string) => ({ label: { text: t, ref } });
    // A one-row picker that a reveal swaps for three rows of the same id.
    const grows = popup([
      { type: "header", title: { text: "T", ref } },
      { type: "choices", id: "times", rows: [row("3:00")], selected: 0 },
      { type: "actions", items: [{ id: "go", label: "Go", key: "tab" }, { id: "more", label: "More times", key: "down", reveal: { replace: "times", with: { type: "choices", id: "times", rows: [row("2:30"), row("3:00"), row("3:30")], selected: 1 } } }] },
    ]);
    // A reveal that swaps the whole bar for one whose Tab action finishes the pop-up.
    const newBar = popup([
      { type: "header", title: { text: "T", ref } },
      { type: "actions", id: "bar", items: [{ id: "go", label: "Go", key: "tab" }, { id: "edit", label: "Edit", key: "cmd-2", reveal: { replace: "bar", with: { type: "actions", items: [{ id: "save", label: "Save", key: "tab" }] } } }] },
    ]);
    for (const m of [grows, newBar]) expect(HelperMessage.safeParse(m).success).toBe(true);
    expect(acceptRefusal(new HostOfferRegistry().record(grows, null), accept("p1", "go", { times: 2 }))).toBeNull();
    expect(acceptRefusal(new HostOfferRegistry().record(grows, null), accept("p1", "go", { times: 3 }))).toBe("times row 3 does not exist; there are 3");
    expect(acceptRefusal(new HostOfferRegistry().record(newBar, null), accept("p1", "save"))).toBeNull();
    expect(acceptRefusal(new HostOfferRegistry().record(newBar, null), accept("p1", "edit"))).toBe("action edit changes the pop-up; it does not finish it");
  });

  it("checks variants against an action line's picker, and refuses any accept of alternatives", () => {
    const line: OfferAction = {
      type: "action",
      v: PROTOCOL_VERSION,
      offerKey: "a1",
      at: 1,
      field: FIELD,
      app: "Calendar Fixture",
      endState: { text: "Coffee with Dana", ref },
      actions: [{ id: "add", label: "Add", key: "tab" }],
      variants: { v: 1, id: "v", figure: "needsYou", blocks: [{ type: "header", title: { text: "When", ref } }, choices(), { type: "actions", items: [{ id: "ok", label: "OK", key: "tab" }] }] },
    };
    const reg = new HostOfferRegistry();
    expect(acceptRefusal(reg.record(line, null), accept("a1", "add", { variants: 1 }))).toBeNull();
    expect(acceptRefusal(reg.record(line, null), accept("a1", "add", { variants: 2 }))).toBe("variants row 2 does not exist; there are 2");
    expect(acceptRefusal(reg.record(line, null), accept("a1", "add", { choices: 0 }))).toBe("the offer has no choices block choices");
    const alts = reg.record({ type: "alternatives", v: PROTOCOL_VERSION, offerKey: "x", at: 1, field: FIELD, candidates: [{ text: "a", ref }], quoted: false }, null);
    expect(acceptRefusal(alts, accept("x", "tab"))).toBe("the host inserts alternatives itself; there is nothing to accept");
  });
});

// MARK: - fill pop-up

const SRC = "6160-1";
const SRC2 = "7170-1";
const FORM = "5150-2";
const MK = (s: string): string => `dev.caret.mail/standard/${s}`;
const FK = (s: string): string => `dev.caret.fixture/standard/${s}`;
const DIRECTORY = { pid: 7170, bundleId: "dev.caret.directory", name: "Directory Fixture" };
const LABELS = ["Name", "Email", "Phone", "City", "Zip", "Country"];

function desk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(
    snap([text(MK("statictext:dana whitfield~0"), "Dana Whitfield"), text(MK("statictext:phone: +# (#) #-#~0"), "Phone: +1 (512) 555-0142")], {
      at: 1000,
      windowId: SRC,
      title: "Order confirmation",
      app: MAIL_APP,
      values: [value("phone", "+1 (512) 555-0142", MK("statictext:phone: +# (#) #-#~0"))],
    }),
  );
  m.apply(snap([text("dev.caret.directory/standard/statictext:austin~0", "Austin")], { at: 1100, windowId: SRC2, title: "Directory Fixture", app: DIRECTORY }));
  m.apply(
    snap(
      LABELS.map((l, i) => field(FK(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })),
      { at: 2000, windowId: FORM, title: "Checkout {{x}}", focused: true, focusedKey: FK("textfield:name~0") },
    ),
  );
  return m;
}

function grounded(key: string, v: string, src: { windowId: string; nodeKey: string; appName: string; windowTitle: string }): FillField {
  return {
    key,
    control: "text",
    handoff: null,
    frame: null,
    descriptor: "",
    choice: "c1",
    confidence: 0.9,
    value: v,
    source: { pid: 1, bundleId: "b", kind: null, ...src },
    memory: null,
    withheld: null,
    asks: [{ choice: "c1", confidence: 0.9, value: v }, { choice: "c1", confidence: 0.9, value: v }],
  };
}

function proposal(fields: FillField[]): FillProposal {
  return {
    type: "fillProposal",
    v: PROTOCOL_VERSION,
    id: "prop-1",
    at: 3000,
    pid: FIXTURE_APP.pid,
    windowId: FORM,
    bundleId: FIXTURE_APP.bundleId,
    triggerKey: FK("textfield:name~0"),
    fields,
    candidates: 3,
    jev: { model: "jev-test", latencyMs: 1, inputTokens: 1, costUsd: 0 },
    cutoff: 0.75,
  };
}

const mail = { windowId: SRC, appName: "Mail Fixture", windowTitle: "Order confirmation" };
const nameField = grounded(FK("textfield:name~0"), "Dana Whitfield", { ...mail, nodeKey: MK("statictext:dana whitfield~0") });
const phoneField = grounded(FK("textfield:phone~0"), "+1 (512) 555-0142", { ...mail, nodeKey: MK("statictext:phone: +# (#) #-#~0") });

describe("fill pop-up", () => {
  it("is offered only when two or more fields all carry a value and its source", () => {
    expect(fillPopupEligible(proposal([nameField]))).toBe(false);
    expect(fillPopupEligible(proposal([nameField, { ...phoneField, value: null, source: null, choice: "none" }]))).toBe(false);
    expect(fillPopupEligible(proposal([nameField, phoneField]))).toBe(true);
  });

  it("builds a valid spec in which every shown value names the node it came from", () => {
    const m = desk();
    const msg = buildFillPopup(m, proposal([nameField, phoneField]) as GroundedProposal);
    expect(msg).toEqual({
      type: "popup",
      v: PROTOCOL_VERSION,
      offerKey: "prop-1",
      at: 3000,
      field: { pid: 5150, windowId: FORM, key: FK("textfield:name~0"), frame: [100, 40, 200, 24], window: { number: null, title: "Checkout {{x}}" } },
      spec: {
        v: 1,
        id: "prop-1",
        figure: "offering",
        blocks: [
          { type: "header", title: { text: "Fill 2 fields", ref: { rule: "count", derived: [{ node: `${FORM}/${FK("textfield:name~0")}` }, { node: `${FORM}/${FK("textfield:phone~0")}` }] } } },
          { type: "source", value: { text: "Mail Fixture, Order confirmation", ref: { node: `${SRC}/${MK("statictext:dana whitfield~0")}` } } },
          {
            type: "fields",
            rows: [
              {
                destination: { text: "Name", ref: { rule: "fieldLabel", derived: [{ node: `${FORM}/${FK("textfield:name~0")}` }] } },
                value: { text: "Dana Whitfield", ref: { node: `${SRC}/${MK("statictext:dana whitfield~0")}`, quote: "Dana Whitfield" } },
                state: "ready",
              },
              {
                destination: { text: "Phone", ref: { rule: "fieldLabel", derived: [{ node: `${FORM}/${FK("textfield:phone~0")}` }] } },
                value: { text: "+1 (512) 555-0142", ref: { node: `${SRC}/${MK("statictext:phone: +# (#) #-#~0")}`, quote: "+1 (512) 555-0142" } },
                state: "ready",
              },
            ],
          },
          { type: "actions", items: [{ id: "fillAll", label: "Fill all", key: "tab" }] },
        ],
      },
      sourceApps: ["Mail Fixture"],
    });
    expect(parsePopupSpec(msg.spec)).toEqual(msg.spec);
    expect(HelperMessage.safeParse(msg).success).toBe(true);
  });

  it("lists a control Caret never writes as a row the user sets, after the rows it fills (H5)", () => {
    const m = desk();
    const size: FillField = {
      ...nameField,
      key: FK("popupbutton:pizza size~0"),
      control: "select",
      value: null,
      source: null,
      choice: "c2",
      handoff: { value: "Large", display: "Large", source: { pid: 1, bundleId: "b", kind: null, ...mail, nodeKey: MK("statictext:large pizza~0") }, memory: null },
    };
    const msg = buildFillPopup(m, proposal([nameField, phoneField]) as GroundedProposal, [size]);
    expect(msg.spec.blocks.map((b) => b.type)).toEqual(["header", "source", "fields", "fields", "actions"]);
    expect(msg.spec.blocks[0]).toMatchObject({ title: { text: "Fill 2 fields" } });
    expect(msg.spec.blocks[3]).toEqual({
      type: "fields",
      rows: [
        {
          destination: { text: "Field", ref: { rule: "fieldLabel", derived: [{ node: `${FORM}/${FK("popupbutton:pizza size~0")}` }] } },
          value: { text: "Large", ref: { rule: "handoffValue", derived: [{ node: `${SRC}/${MK("statictext:large pizza~0")}` }] } },
          state: "yours",
        },
      ],
    });
    expect(parsePopupSpec(msg.spec)).toEqual(msg.spec);
    expect(HelperMessage.safeParse(msg).success).toBe(true);
    // A control with no value to set, and a text field, add no row.
    const none = buildFillPopup(m, proposal([nameField, phoneField]) as GroundedProposal, [{ ...size, handoff: null }, nameField]);
    expect(none.spec.blocks.map((b) => b.type)).toEqual(["header", "source", "fields", "actions"]);
  });

  it("lists five rows and counts the rest, and names every source window when there are several", () => {
    const m = desk();
    const fields = LABELS.map((l, i) =>
      i === 3
        ? grounded(FK(`textfield:${l.toLowerCase()}~0`), "Austin", { windowId: SRC2, nodeKey: "dev.caret.directory/standard/statictext:austin~0", appName: "Directory Fixture", windowTitle: "Directory Fixture" })
        : { ...nameField, key: FK(`textfield:${l.toLowerCase()}~0`) },
    );
    const spec = buildFillPopup(m, proposal(fields) as GroundedProposal).spec;
    const [header, source, rows] = spec.blocks;
    expect(header).toMatchObject({ title: { text: "Fill 6 fields" } });
    expect(source).toEqual({
      type: "source",
      value: {
        // The directory window's title repeats its app name, so it is left out.
        text: "Mail Fixture, Order confirmation and Directory Fixture",
        ref: { rule: "sources", derived: [{ node: `${SRC}/${MK("statictext:dana whitfield~0")}` }, { node: `${SRC2}/dev.caret.directory/standard/statictext:austin~0` }] },
      },
    });
    expect(rows).toMatchObject({ type: "fields", more: 1 });
    expect(rows?.type === "fields" && rows.rows.map((r) => r.destination.text)).toEqual(LABELS.slice(0, 5));
    expect(() => parsePopupSpec(spec)).not.toThrow();
  });

  it("rechecks every destination and source before it fills", () => {
    const m = desk();
    // Each field as fill describes it, which recheckFill compares with the form as it is now.
    const form = m.windows.get(FORM)!;
    const p = proposal([nameField, phoneField].map((f) => ({ ...f, descriptor: describeField(form, form.nodes.get(f.key)!).text }))) as GroundedProposal;
    expect(recheckFill(m, p, () => null)).toBeNull();
    m.apply(snap([text(MK("statictext:dana whitfield~0"), "Dana W.")], { at: 4000, windowId: SRC, title: "Order confirmation", app: MAIL_APP, root: MK("statictext:dana whitfield~0") }));
    expect(recheckFill(m, p, () => null)).toBe(`the source ${MK("statictext:dana whitfield~0")} changed`);
    const filled = desk();
    filled.apply(snap([field(FK("textfield:phone~0"), "555")], { at: 4000, windowId: FORM, title: "Checkout {{x}}", root: FK("textfield:phone~0") }));
    expect(recheckFill(filled, p, () => null)).toBe(`the field ${FK("textfield:phone~0")} is no longer empty`);
  });

  it("writes each field by its exact key, with every screen string a slot", () => {
    const { plan, slots } = fillPlan(desk(), proposal([nameField, phoneField]) as GroundedProposal);
    const filled = fillSlots(Plan.parse(plan), slots);
    expect(filled.steps.map((s) => [s.says, s.end.kind === "valueEquals" && s.end.target.key, s.end.kind === "valueEquals" && s.end.window.title])).toEqual([
      ["Name holds Dana Whitfield", FK("textfield:name~0"), "Checkout {{x}}"],
      ["Phone holds +1 (512) 555-0142", FK("textfield:phone~0"), "Checkout {{x}}"],
    ]);
    // Each value is charged to the window it was copied from, each label and the title to the form.
    expect(plan.sources).toEqual({ title: FORM, l0: FORM, l1: FORM, v0: SRC, v1: SRC });
    expect(() => fillSlots(Plan.parse({ ...plan, sources: { ...plan.sources, nope: SRC } }), slots)).toThrow(/nope, which is not a declared slot/);
  });
});

// MARK: - Open <app>

describe("Open <app> for a watched window", () => {
  const JOB = "5150-3";
  const STATUS = FK("statictext:done. # of # tests passed.~0");
  const COMPOSE = "6160-4";
  const TO = MK("textfield:to~0");

  function setup(composeFocused: boolean) {
    const model = new ScreenModel();
    const sent: HelperMessage[] = [];
    const offers = new OpenAppOffers({ model, gate: new OfferGate(), publish: (m) => (sent.push(m), true), run: async () => ({ taskId: "", outcome: "done", step: null, detail: null, acted: 1, skipped: 0, jevCalls: 0 }) });
    model.apply(snap([text(FK("statictext:test suite~0"), "Test suite"), text(STATUS, "Done. 48 of 48 tests passed.")], { at: 1000, windowId: JOB, title: "Test run" }));
    model.apply(snap([field(TO, "", { frame: [100, 40, 300, 24] })], { at: 1100, windowId: COMPOSE, title: "New message", app: MAIL_APP, focused: composeFocused, focusedKey: composeFocused ? TO : null }));
    return { model, sent, offers };
  }

  it("binds to the field the user is in and quotes the node that shows the status", () => {
    const { sent, offers } = setup(true);
    offers.resolved({ state: "done", watchId: "watch-1", windowId: JOB, status: "Done. 48 of 48 tests passed." });
    expect(sent).toEqual([
      {
        type: "action",
        v: PROTOCOL_VERSION,
        offerKey: "open-watch-1.1",
        at: expect.any(Number),
        field: { pid: MAIL_APP.pid, windowId: COMPOSE, key: TO, frame: [100, 40, 300, 24], window: { number: null, title: "New message" } },
        app: "Caret Fixture",
        endState: { text: "Done. 48 of 48 tests passed.", ref: { node: `${JOB}/${STATUS}`, quote: "Done. 48 of 48 tests passed." } },
        actions: [{ id: "open", label: "Open Caret Fixture", key: "tab" }],
      },
    ]);
  });

  it("offers nothing without a status line, or when no node on screen holds it", () => {
    const { sent, offers } = setup(true);
    offers.resolved({ state: "done", watchId: "watch-1", windowId: JOB, status: null });
    offers.resolved({ state: "done", watchId: "watch-2", windowId: JOB, status: "[button] Approve" });
    expect(sent).toEqual([]);
    expect(offers.pending()).toEqual([]);
  });

  it("holds the offer until focus lands in an editable field of another window", () => {
    const { sent, offers } = setup(false);
    offers.resolved({ state: "done", watchId: "watch-1", windowId: JOB, status: "Done. 48 of 48 tests passed." });
    expect(offers.pending()).toEqual([{ offerKey: "open-watch-1.1", published: false }]);
    offers.onFocus(focus(COMPOSE, TO, 2000, { app: MAIL_APP, editable: false }));
    expect(sent).toEqual([]);
    offers.onFocus(focus(COMPOSE, TO, 2100, { app: MAIL_APP }));
    expect(sent).toMatchObject([{ type: "action", field: { windowId: COMPOSE, key: TO } }]);
  });

  it("gives each resolution of a watch its own key, so each can run as its own task", () => {
    const { sent, offers } = setup(true);
    offers.resolved({ state: "done", watchId: "watch-1", windowId: JOB, status: "Done. 48 of 48 tests passed." });
    offers.resolved({ state: "done", watchId: "watch-1", windowId: JOB, status: "Done. 48 of 48 tests passed." });
    expect(sent.map((m) => [m.type, "offerKey" in m ? m.offerKey : (m as { id: string }).id])).toEqual([
      ["action", "open-watch-1.1"],
      ["offerWithdrawn", "open-watch-1.1"],
      ["action", "open-watch-1.2"],
    ]);
  });

  it("ignores focus in the watched window while its app is in the background", () => {
    const { sent, offers } = setup(true);
    offers.resolved({ state: "done", watchId: "watch-1", windowId: JOB, status: "Done. 48 of 48 tests passed." });
    offers.onFocus({ ...focus(JOB, null, 2000, { editable: false }), frontmost: false });
    expect(sent.map((m) => m.type)).toEqual(["action"]);
  });

  it("drops a held offer, and withdraws a shown one as taken, when the user goes to the watched window first", () => {
    const held = setup(false);
    held.offers.resolved({ state: "done", watchId: "watch-1", windowId: JOB, status: "Done. 48 of 48 tests passed." });
    held.offers.onFocus(focus(JOB, null, 2000, { editable: false }));
    held.offers.onFocus(focus(COMPOSE, TO, 2100, { app: MAIL_APP }));
    expect(held.sent).toEqual([]);

    const shown = setup(true);
    shown.offers.resolved({ state: "done", watchId: "watch-1", windowId: JOB, status: "Done. 48 of 48 tests passed." });
    shown.offers.onFocusedWindow(JOB);
    expect(shown.sent.map((m) => m.type)).toEqual(["action", "offerWithdrawn"]);
    expect(shown.sent[1]).toMatchObject({ id: "open-watch-1.1", reason: "taken" });
  });
});

// MARK: - offerAccept in the helper

describe("offerAccept in the helper", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  let desk: Desk;
  let sent: HelperMessage[];
  const errors = (): string[] => sent.flatMap((m) => (m.type === "error" ? [m.message] : []));
  const phases = (taskId: string): string[] => sent.flatMap((m) => (m.type === "taskProgress" && m.taskId === taskId ? [m.phase] : []));

  const make = (shadow: boolean): void => {
    sent = [];
    desk = new Desk();
    helper = new Helper({ store, askJev: null, shadow, allowBackgroundFocus: false, publish: (m) => sent.push(m), readerLink: desk });
    desk.attach(helper);
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-offer-accept-"));
    store = new Store(dir);
    make(false);
  });
  afterEach(() => {
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two rows typed from the roster: a loopNext offer with one alternatives message for row 3. */
  const startLoop = (): ReturnType<typeof grid> => {
    const dst = grid();
    desk.showList(roster());
    desk.advance(1000);
    desk.showGrid(dst);
    desk.fill(dst, 0, 0, PEOPLE[0]!);
    desk.fill(dst, 1, 0, PEOPLE[1]!);
    return dst;
  };

  it("refuses alternatives and an action the offer does not have, each with a stopped taskProgress", async () => {
    startLoop();
    expect(sent.filter((m) => m.type === "alternatives").map((m) => m.type === "alternatives" && [m.offerKey, m.candidates.length, m.quoted])).toEqual([["offer-1.0", 1, true]]);
    expect(await helper.handleOfferAccept(accept("offer-1.0", "tab"))).toBeNull();
    expect(errors().at(-1)).toBe("offer offer-1.0: the host inserts alternatives itself; there is nothing to accept");
    expect(sent.at(-1)).toMatchObject({ type: "taskProgress", taskId: "offer-1.0", phase: "stopped", detail: "the host inserts alternatives itself; there is nothing to accept" });
    expect(await helper.handleOfferAccept(accept("offer-1", "take"))).toBeNull();
    expect(errors().at(-1)).toBe("offer offer-1: no such offer, or it expired");
  });

  it("runs an accepted loop finish once: a second accept while it runs is refused and does not end its working line", async () => {
    const dst = startLoop();
    desk.fill(dst, 2, 0, PEOPLE[2]!);
    const action = sent.find((m) => m.type === "action");
    expect(action).toMatchObject({ offerKey: "offer-2", app: "Mail Fixture", actions: [{ id: "finish", label: "Finish", key: "tab" }] });
    expect(await helper.handleOfferAccept(accept("offer-2", "nope"))).toBeNull();
    expect(errors().at(-1)).toBe("offer offer-2: the offer has no action nope");

    const first = helper.handleOfferAccept(accept("offer-2", "finish"));
    expect(await helper.handleOfferAccept(accept("offer-2", "finish"))).toBeNull();
    expect(errors().at(-1)).toBe("offer offer-2: no such offer, or it expired");
    expect((await first)?.outcome).toBe("done");
    // The refused "nope" ended its line before any run; nothing from the second accept falls inside the run.
    expect(phases("offer-2")).toEqual(["stopped", "started", "acting", "verified", "acting", "verified", "acting", "verified", "done"]);
    expect(helper.tasks.get("offer-2")).toMatchObject({ kind: "loopFinish", state: "done" });
  });

  it("refuses every accept in shadow mode", async () => {
    make(true);
    expect(await helper.handleOfferAccept(accept("offer-1", "finish"))).toBeNull();
    expect(errors()).toEqual(["offer offer-1: the helper is in shadow mode and does not act"]);
  });
});
