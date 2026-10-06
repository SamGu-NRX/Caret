// C2 review (astra, foreground): each finding as a test that failed on the reviewed head (c246be9). Jev is a fake that
// answers by rule; every name, address and date is invented.
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { aboutValues, fieldAsksForPart } from "../src/fill/about.ts";
import { memoryRefOf, memoryWrites, parseMemoryRef, proposeFill } from "../src/fill/fill.ts";
import { asksPlace, fieldPart, monthYear, placeWithCountry } from "../src/fill/derive.ts";
import { planPage } from "../src/goals/page-planner.ts";
import { macClock } from "../src/offers/event-time.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { GoalProgress, PROTOCOL_VERSION, type PageControl, type PageSnapshot } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { field, jevPickingText, snap } from "./builders.ts";
import { c, WIN as RIG_WIN } from "./fake-page.ts";
import { closeRigs, goalMessages, rig, type Segment } from "./page-rig.ts";

afterEach(closeRigs);

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
  const p = await proposeFill(m, jevPickingText((_id, ins) => pick(ins)), WIN, "f0/form[a]/text:name~0", Date.UTC(2026, 9, 6), { about: aboutValues(about.map((a, i) => ({ id: `about-${i}`, fields: { ...a, source: "typed" as const } }))) });
  return Object.fromEntries(p.fields.map((f) => [f.descriptor.match(/(?:Label|Nearest label): '([^']+)'/u)?.[1] ?? f.key, f.value ?? (f.handoff === null ? null : [f.handoff.value, f.handoff.writes === true])]));
}

describe("finding 1: a country is added only for a field that asks where", () => {
  it("never adds one to a name that reads 'Last, State'", async () => {
    const m = scene("Name: Smith, Virginia", [control("e1", "text", "Name", { value: "" }), select("e2", "Full name", ["Smith, Virginia, United States", "Other"]), control("e3", "combobox", "Applicant name", { value: "" })]);
    const got = await fill(m, (ins) => (ins.includes("'Full name'") || ins.includes("'Applicant name'") ? "Smith, Virginia" : null));
    expect(got["Full name"]).toBeNull();
    expect(got["Applicant name"]).not.toEqual(["Smith, Virginia, United States", true]);
  });
});

describe("finding 2: a memory step's check is exact for text, and loose only for an option", () => {
  it("refuses a text value whose entry changed case, and keeps an option's case-only match", () => {
    expect(memoryWrites("https://example.test/Profile", undefined, "https://example.test/profile", "exact")).toBe(false);
    expect(memoryWrites("yes", undefined, "Yes", "option")).toBe(true);
    expect(memoryWrites("yes", undefined, "Yes", "exact")).toBe(false);
    expect(memoryWrites("March 14, 1990", undefined, "1990-03-14", "date")).toBe(true);
    expect(memoryWrites("March 14, 1990", undefined, "1990-03-14", "option")).toBe(false);
    for (const conv of ["option", "date"] as const) expect(parseMemoryRef(memoryRefOf({ id: "about-3", part: "month" }, conv))).toEqual({ id: "about-3", part: "month", conv });
    expect(parseMemoryRef(memoryRefOf({ id: "about-3" }))).toEqual({ id: "about-3", part: undefined, conv: "exact" });
  });

  it("stops a page goal before writing a text value whose entry changed case after the preview", async () => {
    const r = await rig({ controls: () => [c("e1", "text", "LinkedIn profile", { value: "" })], note: "Signup", picks: { "LinkedIn profile": "https://www.linkedin.com/in/example-jo" } });
    const added = r.helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "m1", op: "add", kind: "about", fields: { label: "LinkedIn", value: "https://www.linkedin.com/in/example-jo", source: "typed" } });
    const preview = (await r.ask("fill out this form")) as Segment;
    expect(preview.steps.map((s) => s.says)).toContain("LinkedIn profile: https://www.linkedin.com/in/example-jo");
    r.helper.handleMemory({ type: "memoryRequest", v: 1, requestId: "m2", op: "edit", id: added.entries?.[0]?.id as string, fields: { label: "LinkedIn", value: "https://www.linkedin.com/in/example-Jo" } });
    expect(await r.accept(preview)).toBeNull();
    await r.helper.goals.idle();
    expect(goalMessages(r).find((m) => m.event === "stopped")).toMatchObject({ reason: "sourceChanged" });
    expect(r.page.shown("e1")).toBe("");
  });
});

describe("finding 3: Address line 2 is the unit, never the street", () => {
  it("reads the second address line as the unit, and offers it the entry's unit only", () => {
    const home = aboutValues([{ id: "e", fields: { label: "Home address", value: "2210 Willow Bend Drive, Apt 5B, Portland, Oregon 97214", source: "typed" } }])[0];
    if (home === undefined) throw new Error("no kind");
    expect([fieldPart("Address line 2"), fieldPart("Address 2"), fieldPart("Address line 1")]).toEqual(["unit", "unit", "street"]);
    expect([fieldAsksForPart(home, "Address line 2", "street"), fieldAsksForPart(home, "Address line 2", "unit"), fieldAsksForPart(home, "Address line 1", "street"), fieldAsksForPart(home, "Address line 1", "unit")]).toEqual([false, true, true, false]);
  });
});

describe("finding 4: a two-digit year is read only where it names one year", () => {
  it("reads '00 to '36 and '76 to '99 around 2026, and nothing between", () => {
    const at = (t: string): number | null => monthYear(t, 2026)?.year ?? null;
    expect([at("Aug '22"), at("Aug '36"), at("Aug '37"), at("Aug '75"), at("Dec '76"), at("Dec '98")]).toEqual([2022, 2036, null, null, 1976, 1998]);
  });
});

describe("finding 5: no About country, so no memory the protocol could not name", () => {
  it("adds a country by the closed lists only", () => {
    expect([placeWithCountry("Bengaluru, Karnataka"), placeWithCountry("Atlanta, Georgia"), placeWithCountry("San Diego, California")]).toEqual([null, null, "San Diego, California, United States"]);
  });
});

describe("finding 6: a long form's preview stays within the protocol's limits", () => {
  it("keeps the warnings at 24 with the parts' note among them", async () => {
    const fifty = (): PageControl[] => Array.from({ length: 50 }, (_, i) => c(`t${i + 1}`, "text", `Q${i + 1}`, { value: "" }));
    // Three fields of each of the first two parts agreed at 0.95; the rest at 0.5, under the cutoff, so each is left
    // with a sentence: 44 of them.
    const unsure = (inner: AskJev): AskJev => async (req) => {
      const r = await inner(req);
      for (const [id, q] of Object.entries(req.questions)) {
        const n = Number(/Label: 'Q(\d+)'/u.exec(String(q.instructions))?.[1] ?? "0");
        if ((n > 3 && n < 21) || n > 23) if (r.answers[id] !== undefined) r.answers[id] = { ...r.answers[id], confidence: 0.5 };
      }
      return r;
    };
    const r = await rig({ controls: fifty, note: Array.from({ length: 50 }, (_, i) => `Q${i + 1}: a${i + 1}`).join("\n"), picks: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`Q${i + 1}`, `a${i + 1}`])), jev: unsure });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(GoalProgress.safeParse(preview).success).toBe(true);
    expect(preview.warnings.length).toBeLessThanOrEqual(24);
    expect(preview.warnings[0]).toBe("Caret fills this form in 2 parts of up to 20 fields, each with its own preview and Tab.");
  });

  it("keeps every part within 24 rows when file controls join the last part", async () => {
    const forty = (): PageControl[] => [...Array.from({ length: 40 }, (_, i) => c(`t${i + 1}`, "text", `Q${i + 1}`, { value: "" })), ...[1, 2, 3, 4].map((i) => c(`f${i}`, "file", `File ${i}`, { value: "" }))];
    const r = await rig({ controls: forty, note: Array.from({ length: 40 }, (_, i) => `Q${i + 1}: a${i + 1}`).join("\n"), picks: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Q${i + 1}`, `a${i + 1}`])), goalFiles: true });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(GoalProgress.safeParse(preview).success).toBe(true);
    const plan = r.helper.goals.planOf(preview.goalId);
    expect(plan?.segments.map((s) => s.steps.length).every((n) => n <= 24)).toBe(true);
    expect(plan?.segments.flatMap((s) => s.steps).filter((s) => s.kind === "write")).toHaveLength(40);
  });
});

describe("finding 7: a Canadian place reaches the dropdown with its country", () => {
  it("asks the page engine for 'Toronto, Ontario, Canada'", async () => {
    const m = scene("Name: Priya\nLocation: Toronto, Ontario", [control("e1", "text", "Name", { value: "" }), control("e2", "combobox", "Location", { value: "" })]);
    expect((await fill(m, (ins) => (ins.includes("'Location'") ? "Toronto, Ontario" : null)))["Location"]).toEqual(["Toronto, Ontario, Canada", true]);
  });
});

describe("finding 8: an ISO date entry's month fills a menu of month names", () => {
  it("picks March for 03 from a remembered 1990-03-14", async () => {
    const m = scene("Signup", [control("e1", "text", "Name", { value: "" }), select("e2", "Date of birth month", ["January", "February", "March", "April"])]);
    const got = await fill(m, (ins) => (ins.includes("'Date of birth month'") ? "03" : null), [{ label: "Date of birth", value: "1990-03-14" }]);
    expect(got["Date of birth month"]).toEqual(["March", true]);
  });
});

describe("finding 9: with no Ask scope, each part's fill asks about exactly that part", () => {
  it("writes all 40 of 40 equally named fields, 20 in each part", async () => {
    const forty = (): PageControl[] => Array.from({ length: 40 }, (_, i) => c(`t${i + 1}`, "text", `Name ${i + 1}`, { value: "" }));
    // A person's name each, of letters only and no surname particle ("Pat Zaa", "Pat Zab"...), as a name field takes one.
    const who = (i: number): string => `Pat Z${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))}`;
    const r = await rig({ controls: forty, note: Array.from({ length: 40 }, (_, i) => `Name ${i + 1}: ${who(i)}`).join("\n"), picks: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`Name ${i + 1}`, who(i)])) });
    const plan = await planPage(r.helper.model, { goalId: "g-null", instruction: "fill out this form", windowId: RIG_WIN, scope: null, kind: "all", section: null, about: [], askJev: jevPickingText((_, ins) => { const n = /Label: 'Name (\d+)'/u.exec(ins)?.[1]; return n === undefined ? null : who(Number(n) - 1); }, 0.95), now: Date.now(), clock: macClock(new Date()), readerSession: 0, pageDocument: (id) => r.host.registry.documentOf(id) });
    expect(plan.segments.map((s) => s.steps.filter((x) => x.kind === "write").length)).toEqual([20, 20]);
  });
});

// Fix-check review (astra, foreground) on 937a731: each finding failed there.
describe("fix-check 1: Address line #2 is the unit too", () => {
  it("reads '#2' as the second line", () => {
    expect([fieldPart("Address line #2"), fieldPart("Address #2")]).toEqual(["unit", "unit"]);
  });
});

describe("fix-check 2: a number the instruction spells out is no month", () => {
  it("leaves a month-name menu to the user for a literal '03'", async () => {
    const m = scene("Signup", [control("e1", "text", "Name", { value: "" }), select("e2", "Start date month", ["January", "February", "March"])]);
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes("'Start date month'") ? "03" : null)), WIN, "f0/form[a]/text:name~0", Date.UTC(2026, 9, 6), {
      scope: { fields: ["f0/form[a]/text:name~0", "f0/form[a]/select:start date month~0"], windows: null, memory: true, instruction: "put 03 as the start month", person: null, literals: new Map([["f0/form[a]/select:start date month~0", "03"]]) },
    });
    expect(p.fields.find((f) => f.key.includes("start date month"))?.handoff).toBeNull();
  });
});

describe("fix-check 3: a field asks where only in so many words", () => {
  it("reads location questions, and not a school, a phone or a code", () => {
    const table: [string, boolean][] = [
      ["Location", true],
      ["Location (City)", true],
      ["City", true],
      ["Where are you based?", true],
      ["Where do you plan on working from (for payroll tax purposes)?", true],
      ["Where did you go to school?", false],
      ["Office phone", false],
      ["Area code", false],
      ["Full name", false],
    ];
    expect(table.map(([l]) => [l, asksPlace(l)])).toEqual(table);
  });
});

describe("fix-check 4: a sentence is no place", () => {
  it("gives no country to 'I used to live in Toronto, Ontario'", () => {
    expect([placeWithCountry("I used to live in Toronto, Ontario"), placeWithCountry("Sault Ste. Marie, Ontario"), placeWithCountry("St. John's, NL")]).toEqual([null, "Sault Ste. Marie, Ontario, Canada", "St. John's, NL, Canada"]);
  });
});

describe("fix-check 5: many file controls never push a preview past 24 rows", () => {
  it("offers at most 22 attach rows and names the rest as the user's", async () => {
    const files = (): PageControl[] => [c("t1", "text", "Q1", { value: "" }), ...Array.from({ length: 24 }, (_, i) => c(`f${i + 1}`, "file", `File ${i + 1}`, { value: "" }))];
    const r = await rig({ controls: files, note: "Q1: a1", picks: { Q1: "a1" }, goalFiles: true });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(GoalProgress.safeParse(preview).success).toBe(true);
    expect(preview.warnings.some((w) => /File 24/.test(w))).toBe(true);
  });
});

describe("fix-check 6: a part's fields keep a fill on focus's rules", () => {
  it("asks no filled text field and no control with controls off", async () => {
    const m = scene("Name: Jo\nDegree: PhD", [control("e1", "text", "Name", { value: "" }), control("e2", "text", "Nickname", { value: "Jojo" }), select("e3", "Degree", ["BA", "PhD"])]);
    const p = await proposeFill(m, jevPickingText(() => null), WIN, "f0/form[a]/text:name~0", Date.UTC(2026, 9, 6), { only: ["f0/form[a]/text:name~0", "f0/form[a]/text:nickname~0", "f0/form[a]/select:degree~0"], controls: false });
    expect(p.fields.map((f) => f.key)).toEqual(["f0/form[a]/text:name~0"]);
  });
});
