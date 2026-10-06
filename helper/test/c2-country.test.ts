// C2 (lead decision 2): a dropdown or menu of a field that asks where may take the one option that is the user's place
// plus its country ("San Diego, California" names "San Diego, California, United States"), when the country follows
// from the place by a closed list (a US state or its code, a Canadian province or its code). The decision also allows
// the user's About country; C2's review left it out (derive.ts placeWithCountry). The page engine still picks only an
// option named exactly that, once the list has loaded for it; every other prefix match stays the user's ("Portland"
// never becomes "Portland, Oregon"). Jev is a fake that answers by rule; every place is invented or public.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { placeWithCountry } from "../src/fill/derive.ts";
import { aboutValues } from "../src/fill/about.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";

describe("a place's country", () => {
  it("follows from a US state or a Canadian province, and from nothing else", () => {
    const table: [string, string | null][] = [
      ["San Diego, California", "San Diego, California, United States"],
      ["Portland, Maine", "Portland, Maine, United States"],
      ["Portland, ME", "Portland, ME, United States"],
      ["Toronto, Ontario", "Toronto, Ontario, Canada"],
      ["Halifax, NS", "Halifax, NS, Canada"],
      // Georgia is a state and a country.
      ["Tbilisi, Georgia", null],
      ["Atlanta, Georgia", null],
      // A region no closed list knows.
      ["Bengaluru, Karnataka", null],
      // Already a country, a bare city, a remark, a list of places: nothing is added.
      ["Oakland, California, United States", null],
      ["Portland", null],
      ["San Diego, California (from November)", null],
      ["Austin, Denver, Boston", null],
    ];
    expect(table.map(([t]) => [t, placeWithCountry(t)])).toEqual(table);
  });
});

const ORIGIN = "http://127.0.0.1:4310";
const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const WIN = "page:eng1:7";
const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({ id, key: `form[a]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#a", rect: [0, 0, 100, 20], ...extra });
const select = (id: string, name: string, options: string[]): PageControl =>
  control(id, "select", name, { options: [{ value: "", label: "Select...", selected: true }, ...options.map((o, i) => ({ value: `o${i}`, label: o, selected: false }))] });

function scene(note: string, controls: PageControl[]): ScreenModel {
  const page: PageSnapshot = {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/apply", navGen: 1, title: "Apply", headings: [], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [],
    focused: { frameId: 0, id: "e1", selection: [0, 0] },
  };
  const m = new ScreenModel();
  m.apply(snap([field("te/note", note, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
  m.apply(toWindowSnapshot(page, session, 1));
  return m;
}

async function fill(m: ScreenModel, pick: (ins: string) => string | null, about: { label: string; value: string }[] = []) {
  const p = await proposeFill(m, jevPickingText((_id, ins) => pick(ins)), WIN, "f0/form[a]/text:name~0", 2000, { about: aboutValues(about.map((a, i) => ({ id: `about-${i}`, fields: { ...a, source: "typed" as const } }))) });
  return Object.fromEntries(p.fields.map((f) => [f.descriptor.match(/(?:Label|Nearest label): '([^']+)'/u)?.[1] ?? f.key, f.value ?? (f.handoff === null ? null : [f.handoff.value, f.handoff.writes === true])]));
}

describe("a dropdown whose options name a place with its country", () => {
  it("asks the page engine for the place with its country, from the user's own place", async () => {
    const m = scene("Name: Dmitri\nLocation: Portland, Maine", [control("e1", "text", "Name", { value: "" }), control("e2", "combobox", "Location (City)", { value: "" })]);
    const got = await fill(m, (ins) => (ins.includes("'Name'") ? "Dmitri" : ins.includes("'Location (City)'") ? "Portland, Maine" : null));
    expect(got["Location (City)"]).toEqual(["Portland, Maine, United States", true]);
  });

  it("asks for a bare city as written, which the engine picks only if an option is named exactly that", async () => {
    const m = scene("Name: Dmitri\nLocation: Portland", [control("e1", "text", "Name", { value: "" }), control("e2", "combobox", "Location (City)", { value: "" })]);
    expect((await fill(m, (ins) => (ins.includes("'Location (City)'") ? "Portland" : null)))["Location (City)"]).toEqual(["Portland", true]);
    // An About country does not make "Portland" anyone's Portland.
    expect((await fill(m, (ins) => (ins.includes("'Location (City)'") ? "Portland" : null), [{ label: "Country", value: "United States" }]))["Location (City)"]).toEqual(["Portland", true]);
  });
});

describe("a menu whose options name places with their country", () => {
  const places = ["Portland, Oregon, United States", "Portland, Maine, United States", "Toronto, Ontario, Canada", "Dublin, Ireland"];
  it("picks the one option that is the place plus its country", async () => {
    const m = scene("Name: Dmitri\nLocation: Portland, Maine\nOffice: Toronto, ON", [control("e1", "text", "Name", { value: "" }), select("e2", "Location", places), select("e3", "Office", places)]);
    const got = await fill(m, (ins) => (ins.includes("'Location'") ? "Portland, Maine" : ins.includes("'Office'") ? "Toronto, ON" : null));
    expect(got.Location).toEqual(["Portland, Maine, United States", true]);
    // "ON" is Ontario, but the option says Ontario: no option is "Toronto, ON, Canada", so the user picks.
    expect(got.Office).toBeNull();
  });

  it("never turns a bare city into one of its places", async () => {
    const m = scene("Name: Dmitri\nLocation: Portland", [control("e1", "text", "Name", { value: "" }), select("e2", "Location", places)]);
    expect((await fill(m, (ins) => (ins.includes("'Location'") ? "Portland" : null)))["Location"]).toBeNull();
  });

  it("gives a region no closed list knows no country, About country or not", async () => {
    const m = scene("Name: Dmitri\nLocation: Bengaluru, Karnataka", [control("e1", "text", "Name", { value: "" }), select("e2", "Location", ["Bengaluru, Karnataka, India", "Mysuru, Karnataka, India"])]);
    const pick = (ins: string): string | null => (ins.includes("'Location'") ? "Bengaluru, Karnataka" : null);
    expect((await fill(m, pick))["Location"]).toBeNull();
    expect((await fill(m, pick, [{ label: "Country", value: "India" }]))["Location"]).toBeNull();
  });
});
