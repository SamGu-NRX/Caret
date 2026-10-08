// V4: menus whose options never reached fill (G3: 30 of the 35 Ask fields with no candidate; brief V4). Chrome's
// Accessibility shows a closed menu's selected option only, so the reader's window of a form has no option list; the
// page engine's walk has every option. With the options, a value a source states that names an option without being
// it ("Texas" for "TX") is offered as that option, in that menu's question only; Jev picks among the offers and the
// verifier checks the pick with the reading said. An option equal to the picked value mints under optionLabel. Every
// name and value is from the synthetic realfill corpus or invented.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, Snapshot, type Node, type PageControl, type PageSnapshot, type TypedValue } from "../src/protocol.ts";
import { ScreenModel } from "../src/model.ts";
import { isConversation } from "../src/conversation.ts";
import { formControls, labelTies, optionLink } from "../src/fill/controls.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { mintOf, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { AskRefused, planAsk, type AskDraft } from "../src/planner/ask.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { saysOptionsUnseen } from "../src/planner/says.ts";
import { buildDesk, loadCorpus, normLabel, pageForm, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { field, jevPickingText, scopeLabel, snap, optionIs } from "./builders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const corpus = loadCorpus(join(here, "../../fixtures/realfill"));
const snaps = readFileSync(join(here, "../fixtures/recorded/realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => Snapshot.parse(JSON.parse(l)));
const formOf = (id: string) => corpus.forms.find((f) => f.id === id) ?? (() => { throw new Error(`no form ${id}`); })();
const readerDesk = (id: string): Desk => buildDesk(corpus, snaps, formOf(id));
const pageDesk = (id: string): Desk => buildDesk(corpus, snaps, formOf(id), pageForm(formOf(id)));
const menuOptions = (d: Desk, label: string): string[] | null | undefined => formControls(d.form).find((c) => c.control === "select" && normLabel(c.label ?? "") === normLabel(label))?.options;

afterEach(() => setTestVerifier(STAND_IN));

describe("where a menu's options were lost (G3's menus)", () => {
  // Each form and menu G3 counted, with an option its answer key wants.
  const MENUS: [string, string, string][] = [
    ["airline-passenger", "Month", "April"],
    ["rental-application", "State", "TX"],
    ["rental-application", "Number of occupants (including you)", "2"],
    ["course-enrollment", "Course", "CIS 140 - Intro to Web Development"],
    ["course-enrollment", "Term", "Spring 2027"],
    ["course-enrollment", "Highest level of education completed", "Some college, no degree"],
    ["checkout-shipping", "State", "California"],
    ["job-application", "How did you hear about this role?", "Employee referral"],
    ["job-application", "Reference relationship", "Manager"],
    ["clinic-intake", "Relationship to patient", "Spouse or partner"],
    ["greenhouse-apply", "Degree", "Bachelor's Degree"],
    ["support-ticket", "Product area", "Billing"],
    ["car-service-booking", "Year", "2019"],
    ["car-service-booking", "Model", "Outback"],
    ["event-rsvp", "How many in your party?", "2"],
    ["event-rsvp", "Guest's meal choice", "Wild mushroom risotto (vegetarian)"],
  ];

  it("the reader's window of each form shows no options for any of them; the page engine's walk shows the one the key wants", () => {
    for (const [form, label] of MENUS) expect([form, label, menuOptions(readerDesk(form), label)]).toEqual([form, label, null]);
    for (const [form, label, want] of MENUS) expect([form, label, menuOptions(pageDesk(form), label)?.includes(want)]).toEqual([form, label, true]);
  });

  it("the page's options leave out its placeholder (value '')", () => {
    expect(menuOptions(pageDesk("airline-passenger"), "Month")).toEqual(["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]);
  });
});

describe("optionLink: the one option a source text names without being it", () => {
  const STATES = ["AL", "AK", "AZ", "CA", "IN", "MA", "ME", "OR", "TX"];
  const ROLES = ["Manager", "Colleague", "Direct report", "Professor", "Other"];
  const COURSES = ["CIS 120 - Computer Literacy", "CIS 140 - Intro to Web Development", "CIS 155 - Python Programming I", "ACC 101 - Bookkeeping Basics"];
  it("links by the option's words in the text, the same words, the text's words in the option, or a state's postal code", () => {
    const table: [readonly string[], string, boolean, ReturnType<typeof optionLink>][] = [
      [ROLES, "Dr. Simone Achebe, my manager at Ridgeline", false, { option: "Manager", how: "inText" }],
      [COURSES, "Intro to Web Development (CIS 140)", false, { option: "CIS 140 - Intro to Web Development", how: "sameWords" }],
      [COURSES, "Intro to Web Development", false, { option: "CIS 140 - Intro to Web Development", how: "inOption" }],
      [STATES, "Texas", true, { option: "TX", how: "stateCode" }],
      [["Alabama", "California", "North Carolina"], "CA", true, { option: "California", how: "stateCode" }],
      [["Ascent", "Outback", "WRX"], "60k service for your Outback", false, { option: "Outback", how: "inText" }],
    ];
    expect(table.map(([o, t, us]) => [o, t, us, optionLink(o, t, us)])).toEqual(table);
  });

  it("links nothing for an equal option, two options, a negation or alternative, a prompt or fallback, a bare number, or a word that only looks like a code", () => {
    const table: [readonly string[], string][] = [
      // The text is the option: no link, its pick mints under optionLabel.
      [["Bachelor's Degree", "Master's Degree"], "Bachelor's Degree"],
      [["Bachelor's Degree", "Master's Degree"], "bachelor's degree"],
      // Two options named.
      [ROLES, "my manager, also a colleague"],
      [COURSES, "CIS"],
      // Negated, excluded or left open.
      [ROLES, "not my manager"],
      [ROLES, "my manager or a professor"],
      // A prompt or fallback option is never named.
      [["Select...", "Manager"], "Select..."],
      [ROLES, "some other contact"],
      // A number inside other words counts something else as easily.
      [["1", "2", "3", "4", "5 or more"], "finished high school, then did 2 semesters"],
      // "in" and "ca" are not codes; a whole sentence is not a state's name.
      [STATES, "I live in Austin, Texas"],
      [["Alabama", "California"], "ca"],
      // One word inside an option says too little.
      [["Spouse or partner", "Parent", "Child"], "spouse"],
      // V4 reviews: the same numbers in another order are another date, the same hours another shift.
      [["2026-01-02", "2026-03-04"], "2026-02-01"],
      [["9am-5pm", "10am-6pm"], "5pm-9am"],
    ];
    expect(table.map(([o, t]) => [t, optionLink(o, t, true)])).toEqual(table.map(([, t]) => [t, null]));
  });

  it("ties a source line to a menu by a word that says what the menu is for, never by a kind word alone (V4 re-review)", () => {
    expect([
      labelTies("Reference", ["Reference relationship", null, null]),
      labelTies("Move-in date", ["Graduation date month", null, "Education"]),
      labelTies("Emergency contact", ["Relationship to patient", null, "Emergency contact"]),
      labelTies("Phone", ["Mobile phone number", null, null]),
    ]).toEqual([true, false, true, false]);
  });

  it("reads a state's postal code only for a menu that asks for a US state (V4 review: a country menu's GA is Gabon)", () => {
    expect([optionLink(["US", "GE", "GA"], "Georgia"), optionLink(["US", "GE", "GA"], "Georgia", true)]).toEqual([null, { option: "GA", how: "stateCode" }]);
  });
});

describe("a menu's option named by a source, through fill (G3's examples)", () => {
  /** A whole-form fill of the page desk whose Jev picks each field's value by its label, recording every offer per label. */
  const fill = async (form: string, want: Record<string, string>, scope?: (d: Desk) => FillScope) => {
    const d = pageDesk(form);
    const offered: string[] = [];
    const pick = jevPickingText((_id, ins) => Object.entries(want).find(([l]) => ins.includes(`Label: '${l}'`))?.[1] ?? null);
    const jev: AskJev = async (req) => {
      for (const q of Object.values(req.questions)) for (const desc of Object.values(q.criteria)) if (typeof desc === "string") offered.push(`${/Label: '([^']+)'/u.exec(String(q.instructions))?.[1] ?? ""} <- ${desc}`);
      return pick(req);
    };
    const p = await proposeFill(d.model, jev, d.form.window.windowId, d.trigger.key, T0, { about: d.about, ...(scope === undefined ? {} : { scope: scope(d) }) });
    const at = (label: string) => p.fields.find((f) => normLabel(d.form.nodes.get(f.key)?.label ?? "") === normLabel(label));
    return { p, at, offered };
  };

  it("held-07: offers Course its option for the note's 'Intro to Web Development (CIS 140)', checked by the verifier with the reading said", async () => {
    const { at } = await fill("course-enrollment", { Course: "CIS 140 - Intro to Web Development" });
    const course = at("Course");
    expect(course?.handoff?.value).toBe("CIS 140 - Intro to Web Development");
    const m = mintOf(course as NonNullable<typeof course>);
    expect(m?.verdict.by).toBe("verifier");
    expect(m?.provenance).toMatchObject({ kind: "derived", base: { kind: "window" } });
    expect((m?.provenance as { says?: string }).says).toMatch(/^Caret took "Intro to Web Development(?: \(CIS 140\))?" to name the option 'CIS 140 - Intro to Web Development'/u);
  });

  it("held-09: offers Reference relationship 'Manager' for 'my manager at Ridgeline'", async () => {
    const { at } = await fill("job-application", { "Reference relationship": "Manager" });
    const rel = at("Reference relationship");
    expect(rel?.handoff?.value).toBe("Manager");
    expect(mintOf(rel as NonNullable<typeof rel>)?.verdict.by).toBe("verifier");
  });

  /**
   * An Ask's scope of the one menu, as B24 ask-07's settled scope holds State (the form has more fields than one fill takes).
   * HA2: an owner question shows the whole note, which fits its window's limit; a note it could not show whole would
   * withhold its address.
   */
  // An Ask that names the windows that are no conversation as its sources. From any source (the first test below), the
  // desks' bystander mail's address does not fit beside its own facts and is cut, so the state is withheld: the cut
  // address may be the one meant.
  const only = (label: string) => (d: Desk): FillScope => ({ fields: formControls(d.form).filter((c) => normLabel(c.label ?? "") === normLabel(label)).map((c) => c.node.key), windows: new Set([...d.model.windows.values()].filter((w) => w.window.windowId !== d.form.window.windowId && !isConversation(w)).map((w) => w.window.windowId)), memory: false, instruction: "fill in everything you can from my notes", person: null, literals: new Map(), consented: new Set([...d.model.windows.keys()].filter((id) => id !== d.form.window.windowId)) });

  it("B24 ask-07 from any source: withholds State, since an address the bystander mail's cut left out may be the one meant", async () => {
    const any = (d: Desk): FillScope => ({ ...only("State")(d), windows: null });
    const { at } = await fill("rental-application", { State: "TX" }, any);
    expect([at("State")?.handoff, at("State")?.withheld]).toEqual([null, "sourceCut"]);
  });

  it("B24 ask-07: offers State 'TX' for the state of the note's Austin, Texas address", async () => {
    const { at } = await fill("rental-application", { State: "TX" }, only("State"));
    const state = at("State");
    expect(state?.handoff?.value).toBe("TX");
    const m = mintOf(state as NonNullable<typeof state>);
    expect(m?.verdict.by).toBe("verifier");
    // V4 review: said as the option code named, not as "a part of the address", to the verifier.
    expect(m?.provenance).toMatchObject({ kind: "derived", how: "optionNamed", base: { kind: "window" } });
    expect((m?.provenance as { says?: string }).says).toBe(`Caret took "Texas" to name the option 'TX' (a US state's name and its postal code)`);
  });

  it("links a value the user's instruction spells out for the menu, and the verifier checks it", async () => {
    const said = (d: Desk): FillScope => {
      const s = only("State")(d);
      return { ...s, instruction: "put Texas for the state", literals: new Map(s.fields.map((k) => [k, "Texas"])) };
    };
    const { at } = await fill("rental-application", { State: "TX" }, said);
    const state = at("State");
    expect(state?.handoff?.value).toBe("TX");
    expect(mintOf(state as NonNullable<typeof state>)).toMatchObject({ verdict: { by: "verifier" }, provenance: { kind: "derived", base: { kind: "instruction", span: "Texas" } } });
  });

  it("held-16: a value equal to an option needs no link and mints under optionLabel", async () => {
    const { at, offered } = await fill("greenhouse-apply", { Degree: "Bachelor's Degree" });
    const degree = at("Degree");
    expect(degree?.handoff?.value).toBe("Bachelor's Degree");
    expect(mintOf(degree as NonNullable<typeof degree>)?.verdict).toEqual({ by: "exempt", rule: "optionLabel" });
    expect(offered.filter((o) => o.startsWith("Degree <- \"Bachelor's Degree\" (the option"))).toEqual([]);
  });

  it("never offers an option no source names, so Jev cannot pick one from the menu alone", async () => {
    const { at, offered } = await fill("course-enrollment", { "Highest level of education completed": "Some college, no degree" });
    expect(offered.filter((o) => o.startsWith("Highest level of education completed <- ") && /\(the option /u.test(o))).toEqual([]);
    expect(at("Highest level of education completed")?.handoff).toBeNull();
  });

  it("withholds a linked option the verifier does not call exact, as it would a typed value", async () => {
    setTestVerifier(async (req) => ({ model: "verify-stand-in", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "other", confidence: 0.95 }])), inputTokens: 0, latencyMs: 0, costUsd: 0 }));
    const { at } = await fill("rental-application", { State: "TX" }, only("State"));
    const state = at("State");
    expect([state?.handoff, state?.withheld]).toEqual([null, "notExact"]);
    expect(mintOf(state as NonNullable<typeof state>)).toBeUndefined();
  });
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

describe("V4 review: what a linked option must not do", () => {
  const F = (k: string): string => `com.google.Chrome/standard/${k}`;
  const web: Node = { key: F("webarea"), parent: null, role: "AXWebArea", label: "Form" };
  const menu = (key: string, label: string, options: string[], y: number): Node[] => [
    { key: F(key), parent: web.key, role: "AXPopUpButton", label, editable: true, frame: [100, y, 200, 24] },
    ...options.map((o, i): Node => ({ key: F(`${key}/item${i}`), parent: F(key), role: "AXMenuItem", label: o })),
  ];
  const desk = (note: string[], form: Node[], values: TypedValue[] = []): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap([field("te/note", note.join("\n"), { role: "AXTextArea" })], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    m.apply(snap(form, { at: 2000, windowId: "5150-7", title: "Intake", app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, values }));
    return m;
  };
  const first: Node = { key: F("first"), parent: web.key, role: "AXTextField", label: "First name", editable: true, frame: [100, 20, 200, 24] };
  const offeredFor = async (m: ScreenModel, label: string, want: string) => {
    const offered: string[] = [];
    const pick = jevPickingText((_id, ins) => (ins.includes(`Label: '${label}'`) ? want : null));
    const p = await proposeFill(m, async (req) => {
      for (const q of Object.values(req.questions)) if (String(q.instructions).includes(`Label: '${label}'`)) for (const d of Object.values(q.criteria)) if (typeof d === "string") offered.push(d);
      return pick(req);
    }, "5150-7", F("first"), 3000);
    return { offered, field: p.fields.find((f) => f.key.endsWith(`/${label.toLowerCase().replace(/\W+/gu, "")}`) || f.descriptor.includes(`'${label}'`)) };
  };

  it("never treats a pop-up's option, or text inside one, as a value the window states", () => {
    const inside: Node = { key: F("when/item1/text"), parent: F("when/item1"), role: "AXStaticText", label: "Oct 18, 2026" };
    const form = [web, first, ...menu("when", "Delivery", ["Oct 17, 2026", "Oct 18, 2026"], 60), inside];
    const m = desk([], form, [{ kind: "date", text: "Oct 17, 2026", nodeKey: F("when/item0") }, { kind: "date", text: "Oct 18, 2026", nodeKey: inside.key }]);
    const w = m.windows.get("5150-7");
    expect(w?.values).toEqual([]);
    expect([w?.nodes.has(F("when/item1")), w?.nodes.has(inside.key)]).toEqual([true, false]);
  });

  it("still gives a birthday's month whose date the kind check reads as a phone (re-review: oneOfSeveral judges links only)", async () => {
    const note = ["Date of birth: 04-22-1990", "Phone: (512) 555-0147"];
    const form: Node[] = [web, first, { key: F("dob"), parent: web.key, role: "AXGroup", subrole: "AXFieldset", label: "Date of birth" }, { key: F("dobm"), parent: F("dob"), role: "AXPopUpButton", label: "Month", editable: true, frame: [100, 60, 200, 24] }, ...MONTHS.map((o, i): Node => ({ key: F(`dobm/item${i}`), parent: F("dobm"), role: "AXMenuItem", label: o }))];
    const m = new ScreenModel();
    m.apply(snap([field("te/note", note.join("\n"), { role: "AXTextArea" })], { at: 1000, windowId: "7001-1", title: "Notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [{ kind: "date", text: "04-22-1990", nodeKey: "te/note" }] }));
    m.apply(snap(form, { at: 2000, windowId: "5150-7", title: "Intake", app: { pid: 5150, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes("Label: 'Month'") ? "April" : null)), "5150-7", F("first"), 3000);
    expect(p.fields.find((f) => f.key === F("dobm"))?.handoff?.value).toBe("April");
  });

  it("sends an option that matches only by case to the verifier, never minting it as the option's own label (re-review)", async () => {
    const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
    const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
    const control = (id: string, kind: PageControl["kind"], name: string, options?: string[]): PageControl => ({ id, key: `form[f]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#f", rect: [0, 0, 100, 20], value: "", ...(options === undefined ? {} : { options: [{ value: "", label: "Select...", selected: true }, ...options.map((o) => ({ value: o, label: o, selected: false }))] }) });
    const page: PageSnapshot = {
      type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
      frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/apply", navGen: 1, title: "Apply", headings: ["Apply"], iframes: [], excluded: {}, truncated: false, controls: [control("e1", "text", "First name"), control("e2", "select", "Portfolio", ["https://example.org/Profile", "https://example.org/work"])] }],
      missing: [],
      focused: { frameId: 0, id: "e1", selection: [0, 0] },
    };
    const m = new ScreenModel();
    m.apply(snap([field("te/note", "Portfolio: https://example.org/profile", { role: "AXTextArea" })], { at: 900, windowId: "7001-1", title: "Notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
    m.apply(toWindowSnapshot(page, session, 1));
    const p = await proposeFill(m, jevPickingText((_id, ins) => (ins.includes("Label: 'Portfolio'") ? "https://example.org/profile" : null)), "page:eng1:7", "f0/form[f]/text:first name~0", 3000);
    const portfolio = p.fields.find((f) => f.key.includes("portfolio")) as (typeof p.fields)[number];
    expect(portfolio.handoff?.value).toBe("https://example.org/Profile");
    const minted = mintOf(portfolio);
    expect(minted?.verdict.by).toBe("verifier");
    expect((minted?.provenance as { says?: string }).says).toBe(`Caret took "https://example.org/profile" to be the option 'https://example.org/Profile', written differently`);
  });

  it("offers no option for a word in an untied line ('a friend referred me' for Relationship)", async () => {
    const m = desk(["A friend referred me to the clinic last spring."], [web, first, ...menu("rel", "Relationship", ["Spouse or partner", "Parent", "Friend", "Other"], 60)]);
    const { offered, field: rel } = await offeredFor(m, "Relationship", "Friend");
    expect(offered.filter((d) => d.startsWith('"Friend"'))).toEqual([]);
    expect(rel?.handoff ?? null).toBeNull();
  });

  it("withholds a linked option of one of several labelled emails whose label names another purpose", async () => {
    const note = ["Personal email: jordan.reyes@example.org", "Work email: j.reyes@brightline.example.com"];
    const m = desk(note, [web, first, ...menu("we", "Work email", ["jordan.reyes@example.org (on file)", "j.reyes@brightline.example.com (on file)"], 60)]);
    const { field: we } = await offeredFor(m, "Work email", "jordan.reyes@example.org (on file)");
    expect([we?.handoff ?? null, we?.withheld]).toEqual([null, "ambiguous"]);
  });
});

describe("an Ask about a menu whose options the window does not show", () => {
  const values: Record<string, string> = { Phone: "(512) 555-0147", Degree: "Bachelor's Degree" };
  const jev: AskJev = async (req) => {
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        if (id === "route") return [id, { choice: "some", confidence: 0.9 }];
        if (id === "source") return [id, { choice: "any", confidence: 0.9 }];
        if (id === "why") return [id, { choice: "nothingToFill", confidence: 0.9 }];
        if (id === "whose" || id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user" in q.criteria ? "user" : (Object.keys(q.criteria)[0] ?? "none"), confidence: 0.9 }];
        if (id === "section") return [id, { choice: "fields", confidence: 0.99 }];
        if (id.startsWith("s_")) return [id, { choice: /^(?:Phone|Degree)/u.test(scopeLabel(ins)) ? "asks" : "not", confidence: 0.99 }];
        if ("yes" in q.criteria) return [id, { choice: "yes", confidence: 0.9 }];
        const want = Object.entries(values).find(([label]) => ins.includes(`'${label}'`))?.[1];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => optionIs(d, want));
        return [id, { choice: hit?.[0] ?? "none", confidence: 0.9 }];
      }),
    );
    return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
  };
  const ask = (d: Desk) => planAsk("just the degree and my phone number", d.model, { values: () => d.memory }, d.about, { askJev: jev, maker: headsIntentMaker(jev), writer: null, offerKey: "v4", windowId: d.form.window.windowId, now: T0 });

  // B25 held-16 is an accepted loss (lead, Sol's round 4): windows are read by recency, the bystander venue mail before
  // the note, and each candidate goes in with all its facts; the mail then takes the room the note's phone and degree
  // need in it. Its sentence about the menu still differs by window.
  it("B25 held-16 on the reader's window: finds nothing to fill, and still says Degree's menu is the user's to set", async () => {
    const e = await ask(readerDesk("greenhouse-apply")).catch((x: unknown) => x);
    expect(String(e), "held-16 is an accepted loss").toBe("Error: Caret found nothing to put in Phone. Caret can't see the choices in Degree without opening the menu, so Degree is yours to set.");
  });

  it("B25 held-16 on the page's window: finds nothing to fill, with no sentence about the menu", async () => {
    const e = await ask(pageDesk("greenhouse-apply")).catch((x: unknown) => x);
    expect(String(e), "held-16 is an accepted loss").toBe("Error: Caret found nothing to put in Phone or Degree.");
  });

  it("names a menu once, as the user's, when it is all the Ask was about", async () => {
    // The scope ask settles Degree alone.
    const degreeOnly: AskJev = async (req) => {
      const r = await jev(req);
      if (req.purpose !== "ask.scope") return r;
      return { ...r, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: id === "section" ? "fields" : scopeLabel(String(q.instructions)).startsWith("Degree") ? "asks" : "not", confidence: 0.99 }])) };
    };
    const d = readerDesk("greenhouse-apply");
    const e = await planAsk("just the degree", d.model, { values: () => d.memory }, d.about, { askJev: degreeOnly, maker: headsIntentMaker(degreeOnly), writer: null, offerKey: "v4", windowId: d.form.window.windowId, now: T0 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
    expect((e as AskRefused).message).toBe("Caret can't see the choices in Degree without opening the menu, so Degree is yours to set.");
  });

  it("never names a menu the redacted view left out, so its sentence repeats no secret (I4 review)", async () => {
    // The Degree menu's own label holds a password's line, so PV1's redacted view drops the menu. The scope ask settles
    // it anyway (as "a field Caret leaves to the user", its name in requests), beside Phone.
    const SECRET = "violet-orchard-seven";
    const relabelled = snaps.map((s) => ({ ...s, nodes: s.nodes.map((n) => (n.role === "AXPopUpButton" && n.label === "Degree *" ? { ...n, label: `Password:\n${SECRET}` } : n)) }));
    const d = buildDesk(corpus, relabelled, formOf("greenhouse-apply"));
    const settles: AskJev = async (req) => {
      const r = await jev(req);
      if (req.purpose !== "ask.scope") return r;
      return { ...r, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: id === "section" ? "fields" : /^(?:Phone|a field Caret leaves to the user)/u.test(scopeLabel(String(q.instructions))) ? "asks" : "not", confidence: 0.99 }])) };
    };
    const out = await planAsk("just the degree and my phone number", d.model, { values: () => d.memory }, d.about, { askJev: settles, maker: headsIntentMaker(settles), writer: null, offerKey: "v4", windowId: d.form.window.windowId, now: T0 }).catch((x: unknown) => x);
    // What the user reads: the refusal, or the draft's left-to-you sentence. (The Ask scope's local fingerprints of the
    // field, ask-scope.ts, are not a sentence and predate V4.)
    const said = out instanceof AskRefused ? out.message : ((out as AskDraft).leftToYou ?? "");
    expect(said).not.toContain(SECRET);
    expect(said).not.toMatch(/can't see the choices/u);
  });

  it("says one menu and several the way a sentence does", () => {
    expect([saysOptionsUnseen([]), saysOptionsUnseen(["Month"]), saysOptionsUnseen(["State *", "Term"])]).toEqual([
      null,
      "Caret can't see the choices in Month without opening the menu, so Month is yours to set.",
      "Caret can't see the choices in State and Term without opening those menus, so they are yours to set.",
    ]);
  });
});
