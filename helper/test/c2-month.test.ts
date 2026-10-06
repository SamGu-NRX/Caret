// C2 (lead decision 1): a month and year the user wrote ("August 2022", "Aug '22", "08/2022") fills an <input type=month>
// or a month and year pair of menus. It is a conversion of the user's own date, as a date field's is; a season or a bare
// year stays the user's. Jev is a fake that answers by rule; every name and date is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { monthYear } from "../src/fill/derive.ts";
import { readMonth } from "../src/fill/when.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import { field, jevPickingText, snap } from "./builders.ts";

const ORIGIN = "http://127.0.0.1:4310";
const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const WIN = "page:eng1:7";

const control = (id: string, kind: PageControl["kind"], name: string, extra: Partial<PageControl> = {}): PageControl => ({
  id,
  key: `form[job]/${kind}:${name.toLowerCase()}~0`,
  strongKey: null,
  kind,
  role: kind,
  name,
  form: "form#job",
  rect: [0, 0, 100, 20],
  ...extra,
});
const select = (id: string, name: string, options: string[]): PageControl =>
  control(id, "select", name, { options: [{ value: "", label: "Select...", selected: true }, ...options.map((o) => ({ value: o.toLowerCase(), label: o, selected: false }))] });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function page(controls: PageControl[]): PageSnapshot {
  return {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: ORIGIN, path: "/apply", navGen: 1, title: "Apply", headings: ["Apply"], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [],
    focused: { frameId: 0, id: controls[0]?.id ?? "e1", selection: [0, 0] },
  };
}

/** A note the user just left, and a page form through the page engine. */
function scene(note: string, controls: PageControl[]): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", note, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Job notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
  m.apply(toWindowSnapshot(page(controls), session, 1));
  return m;
}

/** What fill gives each control, by its name: [value, writes] for a hand-off, the text for a text field, or null. */
async function filled(m: ScreenModel, trigger: string, pick: (ins: string) => string | null): Promise<Record<string, [string, boolean] | string | null>> {
  const p = await proposeFill(m, jevPickingText((_id, ins) => pick(ins)), WIN, trigger, Date.UTC(2026, 9, 6));
  return Object.fromEntries(p.fields.map((f) => [f.descriptor.match(/Label: '([^']+)'/u)?.[1] ?? f.key, f.value ?? (f.handoff === null ? null : [f.handoff.value, f.handoff.writes === true])]));
}

describe("a month and year as the user wrote it", () => {
  it("reads the month forms the brief names, and the month of a whole date", () => {
    const table: [string, string | null][] = [
      ["August 2022", "2022-08"],
      ["Aug 2022", "2022-08"],
      ["Aug. 2022", "2022-08"],
      ["Sept 2016", "2016-09"],
      ["Aug '22", "2022-08"],
      ["Aug ’22", "2022-08"],
      ["Dec '98", "1998-12"],
      ["08/2022", "2022-08"],
      ["8/2022", "2022-08"],
      ["2022-08", "2022-08"],
      ["October 18, 2026", "2026-10"],
      ["2026-11-01", "2026-11"],
      // Ambiguous or no month: the user's.
      ["next spring", null],
      ["spring 2022", null],
      ["2022", null],
      ["08/22", null],
      ["13/2022", null],
      ["Aug '55", null],
      ["August 2022 to May 2023", null],
      ["Started in August 2022", null],
      ["2021-2022", null],
      ["Augustine 2022", null],
    ];
    expect(table.map(([t]) => [t, readMonth(t, 2026)?.value ?? null])).toEqual(table);
    expect(readMonth("Aug '22")?.display).toBe("August 2022");
    expect(monthYear("08/2022")).toEqual({ month: 8, year: 2022 });
  });
});

describe("a month field", () => {
  it("writes the month the user wrote into an <input type=month>", async () => {
    const m = scene("Job history\nStarted at Tallgrass Mechatronics: August 2022", [control("e1", "text", "Employer", { value: "" }), control("e2", "month", "Start date", { value: "" })]);
    const got = await filled(m, "f0/form[job]/text:employer~0", (ins) => (ins.includes("'Start date'") ? "August 2022" : null));
    expect(got["Start date"]).toEqual(["2022-08", true]);
  });

  it("leaves a month field to the user for a season or a bare year", async () => {
    const m = scene("Job history\nStarted at Tallgrass: next spring\nGraduated: 2021", [control("e1", "text", "Employer", { value: "" }), control("e2", "month", "Start date", { value: "" }), control("e3", "month", "Graduation", { value: "" })]);
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes("'Start date'") ? "next spring" : ins.includes("'Graduation'") ? "2021" : null)), WIN, "f0/form[job]/text:employer~0", 2000);
    const at = (part: string) => p.fields.find((f) => f.key.includes(part));
    expect(at("month:start date")).toMatchObject({ handoff: null, withheld: "ambiguous" });
    expect(at("month:graduation")).toMatchObject({ handoff: null, withheld: "ambiguous" });
  });
});

describe("a month and year pair of menus", () => {
  it("picks the month and the year from Aug '22 and from 08/2022", async () => {
    for (const said of ["Aug '22", "08/2022"]) {
      const m = scene(`Education\nGraduated: ${said}`, [
        control("e1", "text", "School", { value: "" }),
        select("e2", "Graduation date month", MONTHS),
        select("e3", "Graduation date year", ["2020", "2021", "2022", "2023"]),
      ]);
      const got = await filled(m, "f0/form[job]/text:school~0", (ins) => (ins.includes("'Graduation date month'") || ins.includes("'Graduation date year'") ? said : null));
      expect([said, got["Graduation date month"], got["Graduation date year"]]).toEqual([said, ["August", true], ["2022", true]]);
    }
  });

  it("matches a month menu whose options are numbers, and refuses a month menu with two options for the month", async () => {
    const m = scene("Education\nGraduated: 08/2022", [
      control("e1", "text", "School", { value: "" }),
      select("e2", "Graduation date month", ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]),
      select("e3", "Start date month", ["Aug", "August", "Sep"]),
    ]);
    const got = await filled(m, "f0/form[job]/text:school~0", (ins) => (ins.includes("date month'") ? "08/2022" : null));
    expect(got["Graduation date month"]).toEqual(["08", true]);
    expect(got["Start date month"]).toBeNull();
  });

  it("gives a year menu nothing from a month alone", async () => {
    const m = scene("Education\nGraduated: in August", [control("e1", "text", "School", { value: "" }), select("e3", "Graduation date year", ["2020", "2021", "2022"])]);
    const got = await filled(m, "f0/form[job]/text:school~0", (ins) => (ins.includes("'Graduation date year'") ? "in August" : null));
    expect(got["Graduation date year"]).toBeNull();
  });
});
