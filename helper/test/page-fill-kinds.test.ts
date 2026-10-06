// I2: a Chrome form seen through the page engine reads as the same fill controls as Chrome's Accessibility shows
// it (B24 capture-2), and a native select seen through the page engine has its options, so its hand-off names one.
// All text is synthetic.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { formControls } from "../src/fill/controls.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PROTOCOL_VERSION, type Node, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { field, jevPickingText, node, snap } from "./builders.ts";

const ORIGIN = "http://127.0.0.1:4310";
const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);

const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({
  id,
  key: `form[order]/${kind}:${name.toLowerCase()}~0`,
  strongKey: null,
  kind,
  role: kind,
  name,
  form: "form#order",
  rect: [0, 0, 100, 20],
  ...extra,
});
const radio = (id: string, group: string, name: string): PageControl =>
  control(id, "radio", name, { strongKey: JSON.stringify([ORIGIN, "form#order", `name=${group}`, "radio"]), checked: false });

/** One order form: a text field, two radio groups, a box, a select with a placeholder, a date, a time and a custom combobox. */
function pageSnapshot(): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Order",
    frames: [{
      frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/order", navGen: 1, title: "Order", headings: ["Order"], iframes: [], excluded: {}, truncated: false,
      controls: [
        control("e1", "text", "Customer name", { value: "" }),
        radio("e2", "size", "Small"),
        radio("e3", "size", "Large"),
        radio("e4", "crust", "Thin"),
        radio("e5", "crust", "Thick"),
        control("e6", "checkbox", "Mushroom", { checked: false }),
        control("e7", "select", "Degree", {
          options: [
            { value: "", label: "Select...", selected: true },
            { value: "ba", label: "Bachelor's", selected: false },
            { value: "ms", label: "Master's", selected: false },
            { value: "phd", label: "PhD", selected: false },
          ],
        }),
        control("e8", "date", "Date of birth", { value: "" }),
        control("e9", "time", "Delivery time", { value: "" }),
        control("e10", "combobox", "School", { value: "" }),
      ],
    }],
    missing: [],
    focused: { frameId: 0, id: "e1", selection: [0, 0] },
  };
}

/** The same form as Chrome's Accessibility shows it (the shape of B24's capture-2 and realfill.test.ts). */
function axNodes(): Node[] {
  const P = "com.google.Chrome/standard";
  const web = `${P}/webarea:~0`;
  return [
    node(web, "AXWebArea", { label: "Order" }),
    field(`${P}/textfield:customer name~0`, "", { parent: web, label: "Customer name" }),
    node(`${P}/group:size~0`, "AXGroup", { parent: web, subrole: "AXFieldset" }),
    node(`${P}/group:size/radiobutton:small~0`, "AXRadioButton", { parent: `${P}/group:size~0`, label: "Small" }),
    node(`${P}/group:size/radiobutton:large~0`, "AXRadioButton", { parent: `${P}/group:size~0`, label: "Large" }),
    node(`${P}/group:crust~0`, "AXGroup", { parent: web, subrole: "AXFieldset" }),
    node(`${P}/group:crust/radiobutton:thin~0`, "AXRadioButton", { parent: `${P}/group:crust~0`, label: "Thin" }),
    node(`${P}/group:crust/radiobutton:thick~0`, "AXRadioButton", { parent: `${P}/group:crust~0`, label: "Thick" }),
    node(`${P}/checkbox:mushroom~0`, "AXCheckBox", { parent: web, label: "Mushroom" }),
    node(`${P}/popupbutton:degree~0`, "AXPopUpButton", { parent: web, label: "Degree", value: "Select..." }),
    node(`${P}/datefield:date of birth~0`, "AXDateField", { parent: web, label: "Date of birth" }),
    node(`${P}/timefield:delivery time~0`, "AXTimeField", { parent: web, label: "Delivery time" }),
    field(`${P}/combobox:school~0`, "", { parent: web, role: "AXComboBox", label: "School" }),
  ];
}

const WIN = "page:eng1:7";
function pageModel(): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", ["Pizza order", "Name: Jordan Reyes", "Degree: Master's", "Large, thin crust", "Deliver around 7:30 pm"].join("\n"), { role: "AXTextArea" })], {
    at: 900, windowId: "note", title: "Order note.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true,
  }));
  m.apply(toWindowSnapshot(pageSnapshot(), session, 1));
  return m;
}

describe("a page form through the page engine, read by fill", () => {
  it("has the same fill controls as Chrome's Accessibility shows, one per radio group, and a time as a time", () => {
    const ax = new ScreenModel();
    ax.apply(snap(axNodes(), { at: 1, windowId: "ax", app: chrome }));
    const fromAx = formControls(ax.windows.get("ax")!).map((c) => [c.control, c.options]);
    const fromPage = formControls(pageModel().windows.get(WIN)!).map((c) => [c.control, c.options]);
    // Chrome's Accessibility shows only a select's chosen item, so only the page engine knows its options.
    expect(fromAx).toEqual([["radio", ["Small", "Large"]], ["radio", ["Thin", "Thick"]], ["checkbox", null], ["select", null], ["date", null], ["time", null]]);
    expect(fromPage).toEqual([["radio", ["Small", "Large"]], ["radio", ["Thin", "Thick"]], ["checkbox", null], ["select", ["Bachelor's", "Master's", "PhD"]], ["date", null], ["time", null]]);
  });

  it("keeps a radio without an author-chosen name out of every other group", () => {
    const s = pageSnapshot();
    const f = s.frames[0]!;
    f.controls = [...f.controls, control("e11", "radio", "Pickup"), control("e12", "radio", "Delivery")];
    const m = new ScreenModel();
    m.apply(toWindowSnapshot(s, session, 1));
    expect(formControls(m.windows.get(WIN)!).filter((c) => c.control === "radio").map((c) => c.options)).toEqual([["Small", "Large"], ["Thin", "Thick"]]);
  });

  it("names a select's option in its hand-off, sets each radio group apart, and reads the time", async () => {
    const pick = (_: string, ins: string): string | null =>
      ins.includes("'Degree'") ? "Master's" : ins.includes("'Small'") || ins.includes("'Thin'") ? "Large, thin crust" : ins.includes("'Delivery time'") ? "Deliver around 7:30 pm" : null;
    const p = await proposeFill(pageModel(), jevPickingText(pick), WIN, "f0/form[order]/text:customer name~0", 2000);
    const at = (part: string) => p.fields.find((f) => f.key.includes(part));
    expect(at("select:degree")).toMatchObject({ control: "select", value: null, handoff: { value: "Master's", source: { windowId: "note" } } });
    expect(at("radiogroup:form#order/name=size")).toMatchObject({ control: "radio", handoff: { value: "Large" } });
    expect(at("radiogroup:form#order/name=crust")).toMatchObject({ control: "radio", handoff: { value: "Thin" } });
    expect(at("time:delivery time")).toMatchObject({ control: "time", handoff: { value: "19:30" } });
  });
});
