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
import { Snapshot, type Node, type TypedValue } from "../src/protocol.ts";
import { ScreenModel } from "../src/model.ts";
import { formControls, optionLink } from "../src/fill/controls.ts";
import { mintOf, proposeFill, type FillScope } from "../src/fill/fill.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { AskRefused, planAsk, type AskDraft } from "../src/planner/ask.ts";
import { headsIntentMaker } from "../src/planner/intent-heads.ts";
import { saysOptionsUnseen } from "../src/planner/says.ts";
import { buildDesk, loadCorpus, normLabel, pageForm, T0, type Desk } from "../scripts/realfill-corpus.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { field, jevPickingText, snap } from "./builders.ts";

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
      // V4 review: the same numbers in another order are another date.
      [["2026-01-02", "2026-03-04"], "2026-02-01"],
    ];
    expect(table.map(([o, t]) => [t, optionLink(o, t, true)])).toEqual(table.map(([, t]) => [t, null]));
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

  /** An Ask's scope of the one menu, as B24 ask-07's settled scope holds State (the form has more fields than one fill takes). */
  const only = (label: string) => (d: Desk): FillScope => ({ fields: formControls(d.form).filter((c) => normLabel(c.label ?? "") === normLabel(label)).map((c) => c.node.key), windows: null, memory: false, instruction: "fill in everything you can from my notes", person: null, literals: new Map() });

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

  it("never treats a pop-up's option as a value the window states", () => {
    const form = [web, first, ...menu("when", "Delivery", ["Oct 17, 2026", "Oct 18, 2026"], 60)];
    const m = desk([], form, [{ kind: "date", text: "Oct 17, 2026", nodeKey: F("when/item0") }, { kind: "date", text: "Oct 18, 2026", nodeKey: F("when/item1") }]);
    expect(m.windows.get("5150-7")?.values).toEqual([]);
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
        if (id.startsWith("s_")) return [id, { choice: /[Tt]he field '(?:Phone|Degree)/u.test(ins) ? "asks" : "not", confidence: 0.99 }];
        if ("yes" in q.criteria) return [id, { choice: "yes", confidence: 0.9 }];
        const want = Object.entries(values).find(([label]) => ins.includes(`'${label}'`))?.[1];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
        return [id, { choice: hit?.[0] ?? "none", confidence: 0.9 }];
      }),
    );
    return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
  };
  const ask = (d: Desk) => planAsk("just the degree and my phone number", d.model, { values: () => d.memory }, d.about, { askJev: jev, maker: headsIntentMaker(jev), writer: null, offerKey: "v4", windowId: d.form.window.windowId, now: T0 });

  it("B25 held-16 on the reader's window: fills Phone and says Degree is the user's, since Caret never opens a menu to read it", async () => {
    const d = (await ask(readerDesk("greenhouse-apply"))) as AskDraft;
    expect(d.checked.writes.map((w) => w.value)).toEqual(["(512) 555-0147"]);
    expect(d.controls).toEqual([]);
    expect(d.leftToYou).toBe("Caret can't see the choices in Degree without opening the menu, so Degree is yours to set.");
  });

  it("B25 held-16 on the page's window: sets Degree to its option, with no such sentence", async () => {
    const d = (await ask(pageDesk("greenhouse-apply"))) as AskDraft;
    expect((d.controls ?? []).map((c) => [c.name, c.value])).toEqual([["Degree", "Bachelor's Degree"]]);
    expect(d.leftToYou ?? "").not.toMatch(/can't see the choices/u);
  });

  it("names a menu once, as the user's, when it is all the Ask was about", async () => {
    // The scope ask settles Degree alone.
    const degreeOnly: AskJev = async (req) => {
      const r = await jev(req);
      if (req.purpose !== "ask.scope") return r;
      return { ...r, answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: /[Tt]he field 'Degree/u.test(String(q.instructions)) ? "asks" : "not", confidence: 0.99 }])) };
    };
    const d = readerDesk("greenhouse-apply");
    const e = await planAsk("just the degree", d.model, { values: () => d.memory }, d.about, { askJev: degreeOnly, maker: headsIntentMaker(degreeOnly), writer: null, offerKey: "v4", windowId: d.form.window.windowId, now: T0 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
    expect((e as AskRefused).message).toBe("Caret can't see the choices in Degree without opening the menu, so Degree is yours to set.");
  });

  it("says one menu and several the way a sentence does", () => {
    expect([saysOptionsUnseen([]), saysOptionsUnseen(["Month"]), saysOptionsUnseen(["State *", "Term"])]).toEqual([
      null,
      "Caret can't see the choices in Month without opening the menu, so Month is yours to set.",
      "Caret can't see the choices in State and Term without opening those menus, so they are yours to set.",
    ]);
  });
});
