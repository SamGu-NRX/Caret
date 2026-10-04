// B25: Ask as a scoped fill. The intent's code checks (refs, spans, the pronoun rule, never-typed fields) and the
// person spans have one right answer each and are tested alone; then the scoped fill and planAsk with a stand-in
// Jev and a stand-in maker. All text is synthetic.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill, type FillScope } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { checkIntent, intentSnapshot, personSpans, type AskIntent, type IntentSnapshot } from "../src/planner/intent.ts";
import { AskRefused, planAsk } from "../src/planner/ask.ts";
import type { IntentMaker } from "../src/planner/intent-makers.ts";
import { intentInput, jevIntentMaker, writerIntentMaker } from "../src/planner/intent-makers.ts";
import { intentResponseFormat, IntentInputSchema } from "../src/writer/intent-prompt.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { SAYS, SaidError } from "../src/planner/says.ts";
import type { Node } from "../src/protocol.ts";
import { field, node, snap, text, value } from "./builders.ts";

describe("personSpans", () => {
  it.each([
    ["use Gary's info for the landlord part", ["Gary"]],
    ["ship this to my sister instead, her address is in my note", ["my sister"]],
    ["RSVP for me and Bea, everything's in her email", ["Bea"]],
    ["fill in my birthday from Morgan's email", ["Morgan"]],
    ["Use Ines for the emergency contact", ["Ines"]],
    ["make my wife the emergency contact", ["my wife"]],
    ["book the slot Chris offered", ["Chris"]],
    ["put his number in too", []],
    ["fill the rest of this from my note", []],
    ["Fill in my LinkedIn on Saturday", []],
  ])("finds the people in %s", (instruction, people) => {
    expect(personSpans(instruction)).toEqual(people);
  });
});

// A Chrome page: name, email, landlord name and phone, an SSN field, a delivery time and a size radio group.
const P = "com.google.Chrome/standard";
const page = (): Node[] => [
  node(`${P}/webarea:~0`, "AXWebArea", { label: "Apply" }),
  field(`${P}/textfield:address bar~0`, "", { label: "Address and search bar" }),
  field(`${P}/textfield:full name~0`, "", { parent: `${P}/webarea:~0`, label: "Full name", frame: [100, 100, 200, 20] }),
  field(`${P}/textfield:email~0`, "", { parent: `${P}/webarea:~0`, label: "Email", frame: [100, 130, 200, 20] }),
  field(`${P}/textfield:landlord name~0`, "", { parent: `${P}/webarea:~0`, label: "Landlord name", frame: [100, 160, 200, 20] }),
  field(`${P}/textfield:landlord phone~0`, "", { parent: `${P}/webarea:~0`, label: "Landlord phone", frame: [100, 190, 200, 20] }),
  field(`${P}/textfield:ssn~0`, "", { parent: `${P}/webarea:~0`, label: "Social Security number", frame: [100, 220, 200, 20] }),
  field(`${P}/textfield:notes~0`, "Leave at the door", { parent: `${P}/webarea:~0`, label: "Notes", frame: [100, 250, 200, 20] }),
  node(`${P}/timefield:delivery time~0`, "AXTimeField", { parent: `${P}/webarea:~0`, label: "Delivery time", frame: [100, 280, 200, 20] }),
  node(`${P}/group:size~0`, "AXGroup", { parent: `${P}/webarea:~0`, subrole: "AXFieldset", label: "Size" }),
  node(`${P}/group:size/radiobutton:small~0`, "AXRadioButton", { parent: `${P}/group:size~0`, label: "Small", frame: [100, 310, 20, 20] }),
  node(`${P}/group:size/radiobutton:large~0`, "AXRadioButton", { parent: `${P}/group:size~0`, label: "Large", frame: [100, 330, 20, 20] }),
  ...Array.from({ length: 30 }, (_, i) => text(`${P}/statictext:terms ${i}~0`, `Terms paragraph ${i}: the landlord may check what you enter, as the lease allows.`, undefined, `${P}/webarea:~0`)),
];
const NOTE = ["Rental notes", "Name: Elena Vance", "Email: elena.vance@example.com", "Landlord: Gary Pruitt", "Landlord phone: (512) 555-0193", "Deliver around 7:30 pm"].join("\n");
const KEY = (s: string): string => `${P}/textfield:${s}~0`;

function desk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/draft", "Draft for Thursday\nDana Whitfield, (415) 555-0162", { role: "AXTextArea" })], { at: 100, windowId: "draft", title: "Draft.txt", app: { pid: 7000, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [value("phone", "(415) 555-0162", "te/draft")] }));
  m.apply(snap([field("te/note", NOTE, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Rental notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [value("email", "elena.vance@example.com", "te/note"), value("phone", "(512) 555-0193", "te/note")] }));
  m.apply(snap(page(), { at: 1000, windowId: "form", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: KEY("full name") }));
  return m;
}
const MEMORY = [{ id: "about-1", label: "Name", text: "Elena Vance", whose: "user" as const }];
const snapOf = (instruction: string, m = desk()): IntentSnapshot => intentSnapshot(instruction, m, m.windows.get("form") as never, MEMORY);
const intent = (x: Partial<AskIntent>): AskIntent => ({ route: "fill", why: "none", scope: "list", section: "none", fields: [], sources: ["any"], whose: "user", literals: [], ...x });
const refOf = (s: IntentSnapshot, name: string): string => (s.fields.find((f) => f.name === name) ?? { ref: "missing" }).ref;
const codeOf = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof PlannerError ? e.code : String(e);
  }
};

describe("intentSnapshot", () => {
  it("lists the page's fields and controls, never the browser's, and the other windows by title", () => {
    const s = snapOf("fill this out");
    expect(s.fields.map((f) => f.name)).toEqual(["Full name", "Email", "Landlord name", "Landlord phone", "Social Security number", "Notes", "Delivery time", "Size"]);
    expect(s.fields.find((f) => f.name === "Notes")?.filled).toBe(true);
    expect(s.fields.find((f) => f.name === "Social Security number")?.neverTyped).toBe("governmentId");
    expect(s.windows.map((w) => w.title)).toEqual(["Rental notes.txt", "Draft.txt"]);
    expect(s.memory).toEqual(["Name"]);
  });

  it("gives the writer a strict schema that enumerates the snapshot's refs", () => {
    const s = snapOf("use Gary's info for the landlord part");
    const input = IntentInputSchema.parse(intentInput(s));
    const f = intentResponseFormat(input) as { json_schema: { strict: boolean; schema: { properties: Record<string, { enum?: string[]; items?: { enum?: string[] } }> } } };
    expect(f.json_schema.strict).toBe(true);
    expect(f.json_schema.schema.properties.fields?.items?.enum).toEqual(s.fields.map((x) => x.ref));
    expect(f.json_schema.schema.properties.whose?.enum).toEqual(["user", "unnamed", "p1"]);
    expect(f.json_schema.schema.properties.sources?.items?.enum).toEqual(["any", "memory", "instruction", "w1", "w2"]);
    // Field names and titles go to the writer; no value does.
    expect(JSON.stringify(input)).not.toContain("Gary Pruitt");
  });
});

describe("checkIntent", () => {
  it("turns a list, a source, a person and a value into the fill's scope", () => {
    const s = snapOf("use Gary for the landlord part, his number is (512) 555-0193");
    const c = checkIntent(intent({ fields: [refOf(s, "Landlord phone"), refOf(s, "Landlord name")], sources: ["w1"], whose: "p1", literals: [{ field: refOf(s, "Landlord phone"), text: "(512) 555-0193" }] }), s);
    if (c.route !== "fill") throw new Error(c.route);
    expect(c.scope.fields).toEqual([KEY("landlord name"), KEY("landlord phone")]);
    expect([...(c.scope.windows ?? [])]).toEqual(["note"]);
    expect(c.scope.memory).toBe(false);
    expect(c.scope.person).toBe("Gary");
    expect([...c.scope.literals]).toEqual([[KEY("landlord phone"), "(512) 555-0193"]]);
    expect(c.trigger).toBe(KEY("landlord name"));
  });

  it("takes every empty field for all, and leaves the SSN field to the user", () => {
    const s = snapOf("fill this out");
    const c = checkIntent(intent({ scope: "all" }), s);
    if (c.route !== "fill") throw new Error(c.route);
    expect(c.fields.map((f) => f.name)).toEqual(["Full name", "Email", "Landlord name", "Landlord phone", "Delivery time", "Size"]);
    expect(c.leftToYou.map((f) => f.name)).toEqual(["Social Security number"]);
    expect(c.scope.windows).toBeNull();
    expect(c.scope.memory).toBe(true);
  });

  it("refuses what the maker cannot name, loudly", () => {
    const s = snapOf("put 8:15 in the delivery time");
    expect(codeOf(() => checkIntent(intent({ fields: ["f99"] }), s))).toBe("schema");
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(s, "Email")], sources: ["w9"] }), s))).toBe("schema");
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(s, "Email")], whose: "p3" }), s))).toBe("schema");
    // A value must be a span of the instruction, for a field in scope.
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(s, "Delivery time")], literals: [{ field: refOf(s, "Delivery time"), text: "8:30" }] }), s))).toBe("schema");
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(s, "Email")], literals: [{ field: refOf(s, "Delivery time"), text: "8:15" }] }), s))).toBe("schema");
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(s, "Delivery time")], literals: [{ field: refOf(s, "Delivery time"), text: "8:15" }] }), s))).toBeNull();
  });

  it("refuses an SSN, a pronoun with no one named, a payment and a submit, whatever the fill would do", () => {
    const ssn = snapOf("put my social security number in");
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(ssn, "Social Security number")] }), ssn))).toBe("notEditable");
    const his = snapOf("put his number in too");
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(his, "Landlord phone")] }), his))).toBe("unsure");
    expect(codeOf(() => checkIntent(intent({ route: "refuse", why: "payment" }), snapOf("pay with my card")))).toBe("unsupportedStep");
    expect(codeOf(() => checkIntent(intent({ route: "refuse", why: "pressOrSend" }), snapOf("hit submit")))).toBe("unsupportedStep");
    expect(codeOf(() => checkIntent(intent({ whose: "unnamed", fields: [refOf(his, "Email")] }), his))).toBe("unsure");
    // "her" with someone named is that person: no refusal.
    const named = snapOf("RSVP for me and Bea, everything's in her email");
    expect(checkIntent(intent({ scope: "all" }), named).route).toBe("fill");
  });
});

/** A stand-in Jev: value questions answered by the text a pick names, owner questions by `owner`, every whose question "user"; both asks alike. */
function jevBy(pick: (q: string) => string | null, owner: (d: string) => string = () => "unclear", confirm: (q: string) => "yes" | "no" = () => "yes"): { ask: AskJev; seen: JevRequest[] } {
  const seen: JevRequest[] = [];
  const ask: AskJev = async (req) => {
    seen.push(req);
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        if (id.endsWith("_whose")) return [id, { choice: "user", confidence: 0.9 }];
        if (id.endsWith("_owner")) return [id, { choice: owner(ins), confidence: 0.9 }];
        if ("yes" in q.criteria) return [id, { choice: confirm(ins), confidence: 0.9 }];
        const want = pick(ins);
        const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
        return [id, { choice: hit?.[0] ?? "none", confidence: 0.9 }];
      }),
    );
    return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
  };
  return { ask, seen };
}
const scopeOf = (x: Partial<FillScope>): FillScope => ({ fields: [], windows: null, memory: true, instruction: "do it", person: null, literals: new Map(), ...x });

describe("the scoped fill", () => {
  it("asks only about the fields in scope, reads only the named sources, and quotes the instruction", async () => {
    const j = jevBy((q) => (q.includes("'Landlord phone'") ? "(512) 555-0193" : null));
    const p = await proposeFill(desk(), j.ask, "form", KEY("landlord phone"), 2000, { scope: scopeOf({ fields: [KEY("landlord phone")], windows: new Set(["note"]), instruction: "the landlord's phone from my note" }) });
    expect(p.fields.map((f) => f.key)).toEqual([KEY("landlord phone")]);
    expect(p.fields[0]?.value).toBe("(512) 555-0193");
    const sent = JSON.stringify(j.seen.map((r) => [r.state, r.questions]));
    expect(sent).toContain("the landlord's phone from my note");
    // The draft window was not a source: its phone is never offered.
    expect(sent).not.toContain("(415) 555-0162");
  });

  it("never moves a value's description to the window just left when the Ask's sources leave it out", async () => {
    // The note is the window just left and also shows the email; the Ask names only the draft, which shows it too.
    const m = desk();
    m.apply(snap([field("te/draft", "Draft for Thursday\nEmail: elena.vance@example.com", { role: "AXTextArea" })], { at: 100, windowId: "draft", title: "Draft.txt", app: { pid: 7000, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: false, values: [value("email", "elena.vance@example.com", "te/draft")] }));
    const j = jevBy((q) => (q.includes("'Email'") ? "elena.vance@example.com" : null), () => "user");
    const p = await proposeFill(m, j.ask, "form", KEY("email"), 2000, { scope: scopeOf({ fields: [KEY("email")], windows: new Set(["draft"]), instruction: "my email from the draft" }) });
    expect(p.fields[0]?.source?.windowId ?? null).not.toBe("note");
    expect(JSON.stringify(j.seen.map((r) => [r.state, r.questions]))).not.toContain("Rental notes.txt");
  });

  it("offers a spelled-out value only to its field, and leaves a time with no am or pm to a question", async () => {
    const j = jevBy((q) => (q.includes("'Delivery time'") ? "8:15" : null));
    const p = await proposeFill(desk(), j.ask, "form", `${P}/timefield:delivery time~0`, 2000, { scope: scopeOf({ fields: [`${P}/timefield:delivery time~0`, KEY("email")], windows: new Set(), memory: false, instruction: "make the delivery 8:15", literals: new Map([[`${P}/timefield:delivery time~0`, "8:15"]]) }) });
    expect(p.fields.find((f) => f.control === "time")).toMatchObject({ withheld: "ambiguous", handoff: null });
    const email = j.seen.flatMap((r) => Object.entries(r.questions)).filter(([, q]) => String(q.instructions).includes("'Email'"));
    for (const [, q] of email) expect(Object.values(q.criteria).some((d) => d?.includes("8:15"))).toBe(false);
    const pm = await proposeFill(desk(), jevBy((q) => (q.includes("'Delivery time'") ? "8:15 pm" : null)).ask, "form", `${P}/timefield:delivery time~0`, 2000, { scope: scopeOf({ fields: [`${P}/timefield:delivery time~0`], windows: new Set(), memory: false, instruction: "make the delivery 8:15 pm", literals: new Map([[`${P}/timefield:delivery time~0`, "8:15 pm"]]) }) });
    expect(pm.fields[0]?.handoff).toMatchObject({ value: "20:15" });
  });

  it("gives a named person's fields only that person's values, and never the user's", async () => {
    const pick = (q: string): string | null => (q.includes("'Landlord name'") ? "Gary Pruitt" : q.includes("'Full name'") ? "Elena Vance" : null);
    const ownerGary = (d: string): string => (d.includes("Gary") || d.includes("(512)") ? "person" : d.includes("Elena") ? "user" : "unclear");
    const fields = [KEY("full name"), KEY("landlord name")];
    const p = await proposeFill(desk(), jevBy(pick, ownerGary).ask, "form", fields[0] as string, 2000, { scope: scopeOf({ fields, person: "Gary", instruction: "use Gary for the landlord" }) });
    expect(p.fields.find((f) => f.key === KEY("landlord name"))?.value).toBe("Gary Pruitt");
    // Full name takes a person's name too, and Elena's is the user's, not Gary's.
    expect(p.fields.find((f) => f.key === KEY("full name"))).toMatchObject({ value: null });
    // With the owner unsettled, Gary's name is not proposed either.
    const unsettled = await proposeFill(desk(), jevBy(pick).ask, "form", fields[0] as string, 2000, { scope: scopeOf({ fields: [KEY("landlord name")], person: "Gary", instruction: "use Gary for the landlord" }) });
    expect(unsettled.fields[0]?.value).toBeNull();
  });
});

describe("a named person's several values", () => {
  const mail = ["Hi love,", "Put me down as your emergency contact, my cell is (617) 555-0129.", "Ines", "Senior Architect", "(617) 555-0166 (office)"].join("\n");
  const ec = `${P}/textfield:emergency contact phone~0`;
  const deskWith = (): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap([field("mail/body", mail, { role: "AXTextArea" })], { at: 900, windowId: "mail", title: "Clinic form", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: [value("phone", "(617) 555-0129", "mail/body"), value("phone", "(617) 555-0166", "mail/body")] }));
    m.apply(snap([node(`${P}/webarea:~0`, "AXWebArea", { label: "Clinic" }), field(ec, "", { parent: `${P}/webarea:~0`, label: "Emergency contact phone", frame: [100, 100, 200, 20] })], { at: 1000, windowId: "form", title: "Clinic", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: ec }));
    return m;
  };
  const ines = (d: string): string => (d.includes("(617)") ? "person" : "unclear");
  const scope = scopeOf({ fields: [ec], person: "Ines", instruction: "use Ines for the emergency contact" });

  it("takes the one her own line ties to the field, and not the other", async () => {
    const office = await proposeFill(deskWith(), jevBy((q) => (q.includes("'Emergency contact phone'") ? "(617) 555-0166" : null), ines).ask, "form", ec, 2000, { scope });
    expect(office.fields[0]).toMatchObject({ value: null, withheld: "ambiguous" });
    const cell = await proposeFill(deskWith(), jevBy((q) => (q.includes("'Emergency contact phone'") ? "(617) 555-0129" : null), ines).ask, "form", ec, 2000, { scope });
    expect(cell.fields[0]).toMatchObject({ value: "(617) 555-0129", withheld: null });
  });
});

describe("the intent makers", () => {
  const fakeWriter = (out: () => unknown) => ({
    route: { provider: "groq", baseUrl: "", keyName: "", model: "fake", maxTokensParam: "max_tokens", extraBody: {}, pricing: { inputUsdPerMTok: 0, outputUsdPerMTok: 0, source: "" } } as const,
    write: async () => {
      const json = out();
      return { model: "fake", provider: "groq", output: { program: null, reply: JSON.stringify(json), json }, inputTokens: 10, outputTokens: 5, reasoningTokens: 0, latencyMs: 1, costUsd: 0 };
    },
  });
  it("takes the writer's JSON as the intent, and fails loudly on anything else", async () => {
    const s = snapOf("my email please");
    const good = { route: "fill", why: "none", scope: "list", section: "none", fields: ["f2"], sources: ["any"], whose: "user", literals: [] };
    expect((await writerIntentMaker(fakeWriter(() => good), () => "k").make(s)).intent).toEqual(good);
    const bad = await writerIntentMaker(fakeWriter(() => ({ route: "fill" })), () => "k").make(s).catch((e: unknown) => e);
    expect((bad as PlannerError).code).toBe("schema");
    const down = await writerIntentMaker({ ...fakeWriter(() => good), write: async () => { throw new Error("groq HTTP 429"); } }, () => "k").make(s).catch((e: unknown) => e);
    expect((down as PlannerError).code).toBe("unavailable");
  });

  /** Jev answering each stage-one question by id, the same in both asks unless `second` says otherwise; nouls by id. */
  const jevAnswers = (first: Record<string, string>, nouls: Record<string, number> = {}, second: Record<string, string> = {}): AskJev => {
    let n = 0;
    return async (req) => {
      const which = n++ % 2 === 1 ? { ...first, ...second } : first;
      const answers = Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: which[id] ?? Object.keys(req.questions[id]?.criteria ?? {})[0] ?? "none", confidence: 0.9 }]));
      return { model: "jev-test", answers, ...(req.nouls === undefined ? {} : { nouls: Object.fromEntries(Object.keys(req.nouls).map((id) => [id, nouls[id] ?? 0])) }), inputTokens: 100, latencyMs: 1, costUsd: 0 };
    };
  };
  const make = (ask: AskJev, instruction: string) => jevIntentMaker(ask, { rand: () => 0 }).make(snapOf(instruction));

  it("Jev: a list is the fields both Noul asks confirm at the floor, from the agreed source", async () => {
    const s = snapOf("use Gary for the landlord part from my note");
    const ref = (name: string) => refOf(s, name);
    const r = await make(jevAnswers({ route: "fill", scope: "list", source: "w1", whose: "p1" }, { [`n_${ref("Landlord name")}`]: 0.97, [`n_${ref("Landlord phone")}`]: 0.96, [`n_${ref("Email")}`]: 0.6 }), "use Gary for the landlord part from my note");
    expect(r.intent).toMatchObject({ route: "fill", scope: "list", fields: [ref("Landlord name"), ref("Landlord phone")], sources: ["w1"], whose: "p1" });
    expect(r.use.calls).toBe(4);
  });

  it("Jev: asks rather than widen when the route, the source or the person is unsettled, and refuses what both asks refuse", async () => {
    expect((await make(jevAnswers({ route: "fill" }, {}, { route: "plan" }), "fill this out")).intent).toMatchObject({ route: "ask" });
    expect((await make(jevAnswers({ route: "fill", scope: "all", source: "w1" }, {}, { source: "w2" }), "fill this out from my note")).intent).toMatchObject({ route: "ask", why: "whichSource" });
    expect((await make(jevAnswers({ route: "fill", scope: "all", source: "any", whose: "p1" }, {}, { whose: "user" }), "use Gary for this")).intent).toMatchObject({ route: "ask", why: "whichPerson" });
    expect((await make(jevAnswers({ route: "refuse", why: "payment" }), "pay for it")).intent).toMatchObject({ route: "refuse", why: "payment" });
    expect((await make(jevAnswers({ route: "fill", scope: "list", source: "any" }), "my email please")).intent).toMatchObject({ route: "ask", why: "whichFields" });
  });
});

const maker = (x: Partial<AskIntent> | ((s: IntentSnapshot) => Partial<AskIntent>)): IntentMaker => ({
  name: "writer",
  async make(s) {
    return { intent: intent(typeof x === "function" ? x(s) : x), use: { maker: "writer", model: "test", calls: 1, inputTokens: 1000, outputTokens: 50, costUsd: 0, latencyMs: 1 } };
  },
});
const memory = { values: () => MEMORY };
const about = [{ id: "about-1", label: "Name", value: "Elena Vance", kind: "name" as const }];

describe("planAsk", () => {
  it("turns the scoped fill's text values into a checked plan and lists its controls", async () => {
    const pick = (q: string): string | null => (q.includes("'Email'") ? "elena.vance@example.com" : q.includes("'Size'") ? "8:15 pm" : q.includes("'Delivery time'") ? "8:15 pm" : null);
    const d = await planAsk("my email, and the delivery at 8:15 pm", desk(), memory, about, {
      askJev: jevBy(pick, () => "user").ask,
      maker: maker((s) => ({ fields: [refOf(s, "Email"), refOf(s, "Delivery time")], literals: [{ field: refOf(s, "Delivery time"), text: "8:15 pm" }] })),
      writer: null,
      offerKey: "ask-1",
      windowId: "form",
      now: 2000,
    });
    expect(d.route).toBe("fill");
    expect(d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([[KEY("email"), "elena.vance@example.com"]]);
    expect(d.controls).toEqual([{ key: `${P}/timefield:delivery time~0`, name: "Delivery time", value: "20:15", display: "8:15 PM" }]);
  });

  it("asks about a time with no am or pm instead of proposing anything", async () => {
    const e = await planAsk("make the delivery 8:15", desk(), memory, about, {
      askJev: jevBy((q) => (q.includes("'Delivery time'") ? "8:15" : null)).ask,
      maker: maker((s) => ({ fields: [refOf(s, "Delivery time")], sources: ["instruction"], literals: [{ field: refOf(s, "Delivery time"), text: "8:15" }] })),
      writer: null,
      offerKey: "ask-2",
      windowId: "form",
      now: 2000,
    }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
    expect((e as AskRefused).code).toBe("unsure");
    expect((e as AskRefused).message).toContain("morning or the evening");
  });

  it("confirms a writer's fields the instruction does not name, and a whole-form scope it does not ask for", async () => {
    const pick = (q: string): string | null => (q.includes("'Email'") ? "elena.vance@example.com" : q.includes("'Full name'") ? "Elena Vance" : null);
    // The reviewer's case: the instruction rules Full name out; a writer's scope of every field is not taken on its word.
    const all = await planAsk("Fill only Email; do not change Full name", desk(), memory, about, { askJev: jevBy(pick, () => "user", () => "no").ask, maker: maker({ scope: "all" }), writer: null, offerKey: "c1", windowId: "form", now: 2000 }).catch((x: unknown) => x);
    expect((all as AskRefused).code).toBe("unsure");
    // An instruction that names no field asks for nothing narrower than the form: "all" stands without Jev's yes.
    const form = await planAsk("fill this out from my note", desk(), memory, about, { askJev: jevBy(pick, () => "user", () => "no").ask, maker: maker({ scope: "all" }), writer: null, offerKey: "c0", windowId: "form", now: 2000 });
    expect(form.checked.writes.length).toBeGreaterThan(0);
    // A listed field the instruction does not name, which Jev does not confirm, is dropped; the named one stays.
    const list = await planAsk("my email please", desk(), memory, about, {
      askJev: jevBy(pick, () => "user", (q) => (q.includes("'Full name'") ? "no" : "yes")).ask,
      maker: maker((s) => ({ fields: [refOf(s, "Email"), refOf(s, "Full name")] })),
      writer: null,
      offerKey: "c2",
      windowId: "form",
      now: 2000,
    });
    expect(list.checked.writes.map((w) => w.node.key)).toEqual([KEY("email")]);
  });

  it("hands over controls alone as one hand-off step, and refuses what the intent refuses", async () => {
    const d = await planAsk("delivery at 8:15 pm", desk(), memory, about, {
      askJev: jevBy((q) => (q.includes("'Delivery time'") ? "8:15 pm" : null)).ask,
      maker: maker((s) => ({ fields: [refOf(s, "Delivery time")], literals: [{ field: refOf(s, "Delivery time"), text: "8:15 pm" }] })),
      writer: null,
      offerKey: "ask-3",
      windowId: "form",
      now: 2000,
    });
    expect(d.checked.writes).toEqual([]);
    expect(d.checked.handoff?.node.key).toBe(`${P}/timefield:delivery time~0`);
    expect(d.controls?.[0]?.value).toBe("20:15");
    const e = await planAsk("pay for it", desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "refuse", why: "payment" }), writer: null, offerKey: "ask-4", windowId: "form", now: 2000 }).catch((x: unknown) => x);
    expect((e as AskRefused).code).toBe("unsupportedStep");
    expect((e as AskRefused).intent?.why).toBe("payment");
  });
});

describe("what an Ask says when it refuses or asks (B26 lead decision 3)", () => {
  const said = (f: () => unknown): string | null => {
    try {
      f();
      return null;
    } catch (e) {
      return e instanceof SaidError ? e.message : `not a sentence: ${String(e)}`;
    }
  };

  it("refuses an SSN as an SSN, whatever reason the maker gave", () => {
    const s = snapOf("my SSN goes in there too");
    expect(said(() => checkIntent(intent({ route: "refuse", why: "payment", scope: "none" }), s))).toBe("Caret doesn't type Social Security numbers. Type it yourself.");
    // A list of only the SSN field says the same, from the field's label.
    const t = snapOf("put that number in");
    expect(said(() => checkIntent(intent({ fields: [refOf(t, "Social Security number")] }), t))).toBe("Caret doesn't type Social Security numbers. Type it yourself.");
  });

  it("asks whose details with a plain question, and says what pressing means by the instruction's verb", () => {
    expect(said(() => checkIntent(intent({ whose: "unnamed" }), snapOf("put his number in too")))).toBe(SAYS.whichPerson);
    expect(said(() => checkIntent(intent({ route: "refuse", why: "pressOrSend", scope: "none" }), snapOf("ok that all looks right, hit submit")))).toBe(SAYS.submit);
    expect(said(() => checkIntent(intent({ route: "refuse", why: "pressOrSend", scope: "none" }), snapOf("send it now")))).toBe(SAYS.send);
  });

  it("says a plan that only hands the user a press, rather than offering it", async () => {
    const m = desk();
    const form = m.windows.get("form") as never as { nodes: Map<string, Node> };
    const page2 = [...form.nodes.values(), node(`${P}/button:submit~0`, "AXButton", { parent: `${P}/webarea:~0`, label: "Submit application", frame: [100, 400, 100, 20] })];
    m.apply(snap(page2, { at: 1100, windowId: "form", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: KEY("full name") }));
    const press: AskJev = async (req) => ({ model: "t", answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: Object.entries(q.criteria).find(([, d]) => d?.includes("Submit"))?.[0] ?? "none", confidence: 0.9 }])), inputTokens: 1, latencyMs: 1, costUsd: 0 });
    const e = await planAsk("ok that all looks right, hit submit", m, memory, about, { askJev: press, maker: maker({ route: "plan", scope: "none" }), writer: null, offerKey: "s1", windowId: "form", now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
    expect((e as AskRefused).code).toBe("unsupportedStep");
    expect((e as AskRefused).message).toBe(SAYS.submit);
    expect((e as AskRefused).detail).toContain("Submit application");
  });

  it("never shows a window id when nothing on screen fits, and keeps it in the detail", async () => {
    const m = new ScreenModel();
    m.apply(snap(page(), { at: 1000, windowId: "form-92930-1791134677668311-2-15", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: KEY("full name") }));
    const e = await planAsk("add the landlord's phone", m, memory, [], { askJev: jevBy(() => null).ask, maker: maker((s) => ({ fields: [refOf(s, "Landlord phone")] })), writer: null, offerKey: "s2", windowId: "form-92930-1791134677668311-2-15", now: 2000 }).catch((x: unknown) => x);
    expect((e as AskRefused).message).toBe(SAYS.nothingOnScreen);
    expect((e as AskRefused).message).not.toContain("92930");
    expect((e as AskRefused).detail).toContain("92930");
  });

  it("names the fields it found nothing for, as their labels read", async () => {
    const e = await planAsk("add the landlord's phone", desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ fields: [refOf(s, "Landlord phone")] })), writer: null, offerKey: "s3", windowId: "form", now: 2000 }).catch((x: unknown) => x);
    expect((e as AskRefused).message).toBe("Caret found nothing to put in Landlord phone.");
  });

  it("turns a model's failure into a plain sentence and keeps the provider's text in the detail", async () => {
    const failing: IntentMaker = { name: "writer", make: async () => { throw new PlannerError("unavailable", "the intent writer failed: groq HTTP 429 tokens per day"); } };
    const e = await planAsk("fill this out", desk(), memory, about, { askJev: jevBy(() => null).ask, maker: failing, writer: null, offerKey: "s4", windowId: "form", now: 2000 }).catch((x: unknown) => x);
    expect((e as AskRefused).message).toBe(SAYS.unreachable);
    expect((e as AskRefused).detail).toContain("429");
  });
});

describe("where an Ask copies from (B26: source words never scope, a named window is read with consent)", () => {
  it("reads the window the instruction names when the maker said only 'instruction', with consent", () => {
    // "Rental notes.txt" is the note; "from my note" names it whatever source the maker chose.
    const s = snapOf("fill in the landlord phone from my note");
    expect(s.named.map((n) => n.windowId)).toEqual(["note"]);
    const c = checkIntent(intent({ fields: [refOf(s, "Landlord phone")], sources: ["instruction"] }), s);
    expect(c.route === "fill" && [...(c.scope.windows ?? [])]).toEqual(["note"]);
    expect(c.route === "fill" && [...(c.scope.consented ?? [])]).toEqual(["note"]);
  });

  it("reads every source when the maker said only 'instruction' and nothing is named, unless every field has a spelled-out value", () => {
    const s = snapOf("make my wife the landlord contact");
    const c = checkIntent(intent({ fields: [refOf(s, "Landlord phone")], sources: ["instruction"] }), s);
    expect(c.route === "fill" && c.scope.windows).toBeNull();
    expect(c.route === "fill" && c.scope.memory).toBe(true);
    expect(c.route === "fill" && c.scope.consented?.size).toBe(0);
    const t = snapOf("delivery at 8:15 pm");
    const d = checkIntent(intent({ fields: [refOf(t, "Delivery time")], sources: ["instruction"], literals: [{ field: refOf(t, "Delivery time"), text: "8:15 pm" }] }), t);
    expect(d.route === "fill" && d.scope.windows?.size).toBe(0);
  });

  it("never widens an instruction that keeps Caret to its own words, and never reads a window it rules out (B26 review)", () => {
    const s = snapOf("fill the landlord phone using only this instruction; do not read other windows");
    const c = checkIntent(intent({ fields: [refOf(s, "Landlord phone")], sources: ["instruction"] }), s);
    expect(c.route === "fill" && c.scope.windows?.size).toBe(0);
    expect(c.route === "fill" && c.scope.memory).toBe(false);
    const t = snapOf("fill the landlord phone without using my note");
    expect(t.excluded).toEqual(["note"]);
    const d = checkIntent(intent({ fields: [refOf(t, "Landlord phone")], sources: ["any"] }), t);
    expect(d.route === "fill" && d.scope.windows !== null && [...d.scope.windows]).toEqual(["draft"]);
    expect(d.route === "fill" && d.scope.consented?.size).toBe(0);
  });

  it("keeps the source as whose details when the instruction asks for them by a pronoun (B26 review)", () => {
    const s = snapOf("fill in the landlord phone from Gary's note with his number");
    const p = s.persons.find((x) => x.span === "Gary")?.ref ?? "missing";
    const c = checkIntent(intent({ fields: [refOf(s, "Landlord phone")], whose: p }), s);
    expect(c.route === "fill" && c.scope.person).toBe("Gary");
  });

  it("does not take a person named only as the source as whose details go in", () => {
    const s = snapOf("fill in the landlord phone from Gary's note");
    const p = s.persons.find((x) => x.span === "Gary")?.ref ?? "missing";
    const c = checkIntent(intent({ fields: [refOf(s, "Landlord phone")], whose: p }), s);
    expect(c.route === "fill" && c.scope.person).toBeNull();
    const t = snapOf("use Gary for the landlord part");
    const q = t.persons.find((x) => x.span === "Gary")?.ref ?? "missing";
    const d = checkIntent(intent({ fields: [refOf(t, "Landlord phone")], whose: q }), t);
    expect(d.route === "fill" && d.scope.person).toBe("Gary");
  });

  it("asks Jev about a field whose name only shares a word with the source ('note' in Notes), as about any unnamed field", async () => {
    const pick = (q: string): string | null => (q.includes("'Email'") ? "elena.vance@example.com" : null);
    const jev = jevBy(pick, () => "user", (q) => (q.includes("'Notes'") ? "no" : "yes"));
    const d = await planAsk("fill in my email from my note", desk(), memory, about, { askJev: jev.ask, maker: maker((s) => ({ fields: [refOf(s, "Email"), refOf(s, "Notes")] })), writer: null, offerKey: "src-1", windowId: "form", now: 2000 });
    const confirms = jev.seen.flatMap((r) => Object.values(r.questions).map((q) => String(q.instructions))).filter((t) => t.includes("Does that ask to fill in or change the field"));
    expect(confirms.some((t) => t.includes("'Notes'"))).toBe(true);
    expect(confirms.some((t) => t.includes("'Email'"))).toBe(false);
    expect(d.checked.writes.map((w) => w.node.key)).toEqual([KEY("email")]);
  });

  it("reads an empty list for an instruction that names no field as the whole form, once Jev confirms it", async () => {
    const pick = (q: string): string | null => (q.includes("'Email'") ? "elena.vance@example.com" : q.includes("'Landlord name'") ? "Gary Pruitt" : null);
    const yes = jevBy(pick, () => "user", () => "yes");
    const d = await planAsk("can you get this done from what I jotted down", desk(), memory, about, { askJev: yes.ask, maker: maker({ scope: "list", fields: [] }), writer: null, offerKey: "src-2", windowId: "form", now: 2000 });
    expect(yes.seen.some((r) => "all" in r.questions)).toBe(true);
    expect(d.checked.writes.length).toBeGreaterThan(0);
    const no = await planAsk("can you get this done from what I jotted down", desk(), memory, about, { askJev: jevBy(pick, () => "user", () => "no").ask, maker: maker({ scope: "list", fields: [] }), writer: null, offerKey: "src-3", windowId: "form", now: 2000 }).catch((x: unknown) => x);
    expect((no as AskRefused).message).toBe(SAYS.whichFields);
  });
});
