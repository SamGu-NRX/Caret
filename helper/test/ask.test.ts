// B25: Ask as a scoped fill. The intent's code checks (refs, spans, the pronoun rule, never-typed fields) and the
// person spans have one right answer each and are tested alone; then the scoped fill and planAsk with a stand-in
// Jev and a stand-in maker. All text is synthetic.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill, type FillScope } from "../src/fill/fill.ts";
import type { AskJev, JevRequest, JevResult } from "../src/fill/jev.ts";
import { checkIntent, intentSnapshot, personSpans, type AskIntent, type IntentSnapshot } from "../src/planner/intent.ts";
import { AskAsks, AskRefused, planAsk, type AskDraft } from "../src/planner/ask.ts";
import { asksForWholeForm } from "../src/planner/scope-words.ts";
import { BY_WORD, REVIEWED } from "./b28-reviewed.ts";
import type { IntentMaker } from "../src/planner/intent-makers.ts";
import { intentInput, jevIntentMaker, writerIntentMaker } from "../src/planner/intent-makers.ts";
import { HEAD_FLOOR, headsIntentMaker, headsRequest, readHeads, scopeId, tieLiterals } from "../src/planner/intent-heads.ts";
import { intentResponseFormat, IntentInputSchema } from "../src/writer/intent-prompt.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { SAYS, SaidError } from "../src/planner/says.ts";
import { proposed } from "../src/planner/proposal.ts";
import type { Node } from "../src/protocol.ts";
import { field, node, snap, text, value } from "./builders.ts";
import { devWriterRoute } from "../src/writer/routes.ts";
import type { WriterPort } from "../src/writer/port.ts";

/**
 * H11: a writer that is configured and never called. A plan intent is a goal only when a writer could plan it
 * (planner/ask.ts), so B30's goal hand-off is tested with one; page-panel-h11.test.ts covers the case with none.
 */
const UNCALLED_WRITER: WriterPort = {
  route: devWriterRoute("gateway:inclusionai/ling-3.1-flash-free"),
  write: async () => {
    throw new Error("planAsk asked the writer for something");
  },
};

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
    const named = snapOf("RSVP for me and Bea, use her email address");
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
        // I2 ruling D: Jev's per-field scope question, asked on every route: every field it is asked about.
        if (req.purpose === "ask.scope") return [id, { choice: id === "section" ? "fields" : "asks", confidence: 0.9 }];
        // G2 review: a field that wants the user's details takes only a value both asks call the user's; a landlord's
        // field wants someone else's.
        if (id.endsWith("_whose")) return [id, { choice: /landlord/iu.test(ins) ? "other" : "user", confidence: 0.9 }];
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

  it("Jev: keeps what both asks settled beside the parts it leaves open, in the order they are asked (B29)", async () => {
    // Route unsettled: the fields are open; the agreed source and person stand.
    expect((await make(jevAnswers({ route: "fill", scope: "all", source: "w1", whose: "user" }, {}, { route: "plan" }), "fill this out from my note")).intent).toMatchObject({ route: "ask", why: "whichFields", open: ["fields"], sources: ["w1"], whose: "user" });
    // Source and person both unsettled: both open, the source first.
    expect((await make(jevAnswers({ route: "fill", scope: "all", source: "w1", whose: "p1" }, {}, { source: "w2", whose: "user" }), "use Gary for this")).intent).toMatchObject({ route: "ask", why: "whichSource", open: ["source", "person"], scope: "all" });
    // Someone else's details, unnamed: the person is open, no longer a refusal.
    expect((await make(jevAnswers({ route: "fill", scope: "all", source: "any", whose: "unnamed" }), "add his number")).intent).toMatchObject({ route: "ask", why: "otherPersonUnnamed", open: ["person"] });
  });
});

describe("the heads intent maker (P1, A3)", () => {
  /** The heads at `conf` (0.9 unless given), each by id, else the first option; the scope ask by `asks`, both wordings at 0.99. */
  const answer = (s: IntentSnapshot, heads: Record<string, string>, conf: Record<string, number> = {}): JevResult => {
    const req = headsRequest(s);
    const answers = Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: heads[id] ?? Object.keys(req.questions[id]?.criteria ?? {})[0] ?? "none", confidence: conf[id] ?? 0.9 }]));
    return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
  };
  const scoped = (s: IntentSnapshot, asks: readonly string[]): [JevResult, JevResult] => {
    // SCP1: the section question, when the form shows a section, names no one section.
    const one: JevResult = { model: "jev-test", answers: { ...Object.fromEntries(s.fields.map((f) => [scopeId(f.ref), { choice: asks.includes(f.name) ? "asks" : "not", confidence: 0.99 }])), section: { choice: "fields", confidence: 0.99 } }, inputTokens: 10, latencyMs: 1, costUsd: 0 };
    return [one, one];
  };
  const everyField = (s: IntentSnapshot): string[] => s.fields.map((f) => f.name);
  const read = (instruction: string, heads: Record<string, string>, asks: (s: IntentSnapshot) => readonly string[] = everyField, conf: Record<string, number> = {}): AskIntent => {
    const s = snapOf(instruction);
    return readHeads(s, answer(s, heads, conf), scoped(s, asks(s)));
  };

  it("reads a plan or a refusal from the route head at its floor", () => {
    // A plan carries Jev's fields, for a page host that fills its form instead (ask.ts).
    expect(read("submit it", { route: "plan" })).toMatchObject({ route: "plan", scope: "list", agreed: true });
    expect(read("pay for it", { route: "refuse", why: "payment" })).toMatchObject({ route: "refuse", why: "payment" });
    // A refusal whose reason is under the floor is said generally; checkIntent still names a never-typed kind itself.
    expect(read("pay for it", { route: "refuse", why: "payment" }, everyField, { why: HEAD_FLOOR - 0.01 })).toMatchObject({ route: "refuse", why: "nothingToFill" });
  });

  it("reads an unsettled source by the instruction's words: every source, the windows it names, or a question when it limits them", () => {
    const low = { source: HEAD_FLOOR - 0.01 };
    expect(read("fill this out", { route: "fill", source: "w2" }, everyField, low)).toMatchObject({ route: "fill", sources: [] });
    const s = snapOf("fill this out from my rental notes");
    const notes = s.windows.find((w) => w.title === "Rental notes.txt");
    expect(s.named.map((n) => n.windowId)).toEqual([notes?.windowId]);
    expect(read("fill this out from my rental notes", { route: "fill", source: "w2" }, everyField, low)).toMatchObject({ route: "fill", sources: [notes?.ref] });
    expect(read("fill this out, only use what I typed", { route: "fill", source: "w1" }, everyField, low)).toMatchObject({ route: "ask", why: "whichSource", open: ["source"] });
  });

  it("puts the instruction's own sources before a settled source head (P1 review)", () => {
    // Named windows stand for "any" or another window, settled or not: checkIntent reads "any" as every window.
    const s = snapOf("fill my email from my rental notes");
    const notes = s.windows.find((w) => w.title === "Rental notes.txt")?.ref;
    const email = (): string[] => ["Email"];
    expect(read("fill my email from my rental notes", { route: "fill", source: "any" }, email)).toMatchObject({ route: "fill", sources: [notes] });
    expect(read("fill my email from my rental notes", { route: "fill", source: s.windows.find((w) => w.title === "Draft.txt")?.ref ?? "" }, email)).toMatchObject({ route: "fill", sources: [notes] });
    // An instruction that keeps Caret to its own words takes only "instruction"; anything else is asked.
    expect(read("fill my email, only use what I typed", { route: "fill", source: "any" }, email)).toMatchObject({ route: "ask", why: "whichSource", open: ["source"] });
    expect(read("fill my email, only use what I typed", { route: "fill", source: "memory" }, email)).toMatchObject({ route: "ask", open: ["source"] });
    expect(read("fill my email, only use what I typed", { route: "fill", source: "instruction" }, email)).toMatchObject({ route: "fill", sources: ["instruction"] });
  });

  it("asks whose details for someone unnamed, or for an unsettled answer when someone is named; the user's own otherwise", () => {
    // A relation with no memory entry is not code's to settle (people.ts): the head decides.
    expect(read("add my sister's number", { route: "fill", source: "any", whose: "unclear" })).toMatchObject({ route: "ask", why: "otherPersonUnnamed", open: ["person"] });
    expect(read("add my sister's number", { route: "fill", source: "any", whose: "p1" }, everyField, { whose: HEAD_FLOOR - 0.01 })).toMatchObject({ route: "ask", why: "whichPerson", open: ["person"] });
    expect(read("add my sister's number", { route: "fill", source: "any", whose: "p1" })).toMatchObject({ route: "fill", whose: "p1" });
    expect(read("fill this out", { route: "fill", source: "any", whose: "user" }, everyField, { whose: HEAD_FLOOR - 0.01 })).toMatchObject({ route: "fill", whose: "user" });
    // A1 decision 2: a name the instruction says is whose details go in, whatever the head; a pronoun is the one other
    // person on screen (the note's landlord line here).
    expect(read("use Gary for this", { route: "fill", source: "any", whose: "p1" }, everyField, { whose: HEAD_FLOOR - 0.01 })).toMatchObject({ route: "fill", whose: "p1" });
    expect(read("add his number", { route: "fill", source: "any", whose: "unclear" })).toMatchObject({ route: "fill", whose: "user", person: "Gary Pruitt" });
  });

  it("ties a spelled-out value to the one field in scope its clause names, and to nothing when two in scope tie", () => {
    const s = snapOf("make the delivery 8:15");
    const scope = s.fields.filter((f) => !f.filled && f.neverTyped === null);
    expect(tieLiterals(s, scope)).toEqual([{ field: refOf(s, "Delivery time"), text: "8:15" }]);
    const two = snapOf("set landlord to Gary Pruitt");
    expect(tieLiterals(two, two.fields.filter((f) => !f.filled && f.neverTyped === null))).toEqual([]);
    const named = snapOf("set landlord phone to 512-555-0193");
    expect(tieLiterals(named, named.fields.filter((f) => !f.filled && f.neverTyped === null))).toEqual([{ field: refOf(named, "Landlord phone"), text: "512-555-0193" }]);
    // Two fields tie and Jev chose one of them: the value goes to that one.
    expect(tieLiterals(two, two.fields.filter((f) => f.name === "Landlord name"))).toEqual([{ field: refOf(two, "Landlord name"), text: "Gary Pruitt" }]);
  });

  it("never ties a value to a field in scope when its clause names another field of the form better (P1 review)", () => {
    const s = snapOf('set Full name to "Alice" and fill landlord name');
    expect(tieLiterals(s, s.fields.filter((f) => f.name === "Landlord name"))).toEqual([]);
    expect(tieLiterals(s, s.fields.filter((f) => f.name === "Full name" || f.name === "Landlord name"))).toEqual([{ field: refOf(s, "Full name"), text: "Alice" }]);
    // A quoted value may hold a comma; its clause is still the one around it.
    const q = snapOf('set landlord name to "Pruitt, Gary"');
    expect(tieLiterals(q, q.fields.filter((f) => !f.filled && f.neverTyped === null))).toEqual([{ field: refOf(q, "Landlord name"), text: "Pruitt, Gary" }]);
    // One value, one field in scope, and a clause that names no field: they tie.
    const one = snapOf("actually make it 8:15");
    expect(tieLiterals(one, one.fields.filter((f) => f.name === "Delivery time"))).toEqual([{ field: refOf(one, "Delivery time"), text: "8:15" }]);
  });

  it("goes through planAsk with no further confirmation of the fields Jev chose", async () => {
    const pick = (q: string): string | null => (q.includes("'Email'") ? "elena.vance@example.com" : q.includes("'Full name'") ? "Elena Vance" : null);
    const rest = jevBy(pick, () => "user", () => "no");
    let headCalls = 0;
    const ask: AskJev = async (req) => {
      const s = snapOf("my email please");
      if ("route" in req.questions) return (headCalls++, answer(s, { route: "fill", source: "any", whose: "user" }));
      if (req.purpose === "ask.scope") return scoped(s, ["Email"])[0];
      return rest.ask(req);
    };
    const d = await planAsk("my email please", desk(), memory, about, { askJev: ask, maker: headsIntentMaker(ask), writer: null, offerKey: "h1", windowId: "form", now: 2000 });
    expect(headCalls).toBe(1);
    expect(d.maker).toMatchObject({ maker: "heads", calls: 3 });
    expect(d.checked.writes.map((w) => w.node.key)).toEqual([KEY("email")]);
    expect(rest.seen.filter((r) => Object.values(r.questions).some((q) => "yes" in q.criteria))).toHaveLength(0);
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
    // H5: the proposal lists the write, then the control as a row of its own that the user sets.
    const fields = (proposed("r1", d, 3000).spec?.blocks ?? []).filter((b) => b.type === "fields");
    expect(fields.map((b) => b.rows.map((r) => [r.destination.text, r.value?.text, r.state]))).toEqual([
      [["Email", "elena.vance@example.com", "ready"]],
      [["Delivery time", "8:15 PM", "yours"]],
    ]);
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
    // A whole-form request sentence (scope-words.ts WHOLE_FORM): "all" stands without Jev's yes.
    const form = await planAsk("fill out the form from my note", desk(), memory, about, { askJev: jevBy(pick, () => "user", () => "no").ask, maker: maker({ scope: "all" }), writer: null, offerKey: "c0", windowId: "form", now: 2000 });
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
    // H5: no press is handed over, so the proposal names none; its one row says what to set.
    const p = proposed("r3", d, 3000);
    expect(p.handoff).toBeNull();
    expect(p.spec?.blocks.map((b) => b.type)).toEqual(["header", "fields", "actions"]);
    expect(p.spec?.blocks[1]).toMatchObject({ type: "fields", rows: [{ destination: { text: "Delivery time" }, value: { text: "8:15 PM" }, state: "yours" }] });
    expect(p.spec?.blocks[2]).toMatchObject({ type: "actions", items: [{ label: "Got it", key: "tab" }] });
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
    // I2: the scope ask (every maker's plan settles its fields) chooses no field: the plan is a press alone.
    const press: AskJev = async (req) => ({ model: "t", answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: req.purpose === "ask.scope" ? (id === "section" ? "fields" : "not") : Object.entries(q.criteria).find(([, d]) => d?.includes("Submit"))?.[0] ?? "none", confidence: 0.9 }])), inputTokens: 1, latencyMs: 1, costUsd: 0 });
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

describe("what B26's blind held-out-2 run found", () => {
  it("does not read a source's pronoun as someone's details, and names a sender typed in lower case", () => {
    const m = desk();
    m.apply(snap([text("h1", "From: Ines Lindqvist <ines@example.org>"), text("h2", "To: Theo"), text("b", "my cell is (617) 555-0129")], { at: 950, windowId: "mail-ines", title: "Clinic form", app: { pid: 7009, bundleId: "com.apple.mail", name: "Mail" } }));
    const s = snapOf("fill the landlord phone, everything's in her email", m);
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(s, "Landlord phone")] }), s))).toBeNull();
    const t = snapOf("emergency contact is ines, use what she sent", m);
    expect(t.persons.map((p) => p.span)).toContain("ines");
    expect(t.named.map((n) => n.windowId)).toEqual(["mail-ines"]);
  });

  it("confirms a writer's list of every empty field as the whole form, with one question", async () => {
    const pick = (q: string): string | null => (q.includes("'Landlord name'") ? "Gary Pruitt" : q.includes("'Landlord phone'") ? "(512) 555-0193" : null);
    // G2 review: the landlord's name and phone are someone else's, as the landlord's fields want.
    const jev = jevBy(pick, () => "other", () => "yes");
    const every = (s: IntentSnapshot): string[] => s.fields.filter((f) => !f.filled && f.neverTyped === null).map((f) => f.ref);
    const d = await planAsk("fill out the landlord application from my note", desk(), memory, about, { askJev: jev.ask, maker: maker((s) => ({ fields: every(s) })), writer: null, offerKey: "h2-1", windowId: "form", now: 2000 });
    const confirms = jev.seen.filter((r) => Object.values(r.questions).some((q) => "yes" in q.criteria));
    expect(confirms.every((r) => Object.keys(r.questions).join() === "all")).toBe(true);
    expect(confirms.length).toBe(2);
    expect(d.checked.writes.length).toBeGreaterThan(0);
  });

  it("says a missing source is not on screen when the maker asked where to copy from", () => {
    const s = snapOf("grab my company and title off my LinkedIn");
    expect(() => checkIntent(intent({ route: "ask", why: "whichSource", scope: "none" }), s)).toThrow(SAYS.notOnScreen);
    // A specific refusal keeps its own sentence.
    expect(() => checkIntent(intent({ route: "refuse", why: "payment", scope: "none" }), snapOf("pay with the card off my LinkedIn"))).toThrow(SAYS.payment);
  });

  it("refuses a fill from a source that is not open with the plain sentence", () => {
    const s = snapOf("grab the landlord phone off my LinkedIn");
    try {
      checkIntent(intent({ fields: [refOf(s, "Landlord phone")] }), s);
      throw new Error("no refusal");
    } catch (e) {
      expect((e as Error).message).toBe(SAYS.notOnScreen);
    }
  });
});

describe("what B26's second review found", () => {
  it("never takes an ordinary lower-case word for a sender's name", () => {
    const m = desk();
    m.apply(snap([text("h1", "From: Candace Wells <candace@example.com>"), text("h2", "To: Theo"), text("b", "hi")], { at: 950, windowId: "mail-candace", title: "Hi", app: { pid: 7010, bundleId: "com.apple.mail", name: "Mail" } }));
    const s = snapOf("can you fill my phone", m);
    expect(s.persons).toEqual([]);
    expect(s.named).toEqual([]);
    expect(codeOf(() => checkIntent(intent({ fields: [refOf(s, "Landlord phone")] }), snapOf("can you put his number in", m)))).toBe("unsure");
  });

  it("asks Jev before a writer's list of every empty field becomes the whole form, even when no field is named", async () => {
    const every = (s: IntentSnapshot): string[] => s.fields.filter((f) => !f.filled && f.neverTyped === null).map((f) => f.ref);
    const no = jevBy(() => "elena.vance@example.com", () => "user", () => "no");
    const e = await planAsk("fill only the first box", desk(), memory, about, { askJev: no.ask, maker: maker((s) => ({ fields: every(s) })), writer: null, offerKey: "r2-1", windowId: "form", now: 2000 }).catch((x: unknown) => x);
    expect((e as AskRefused).message).toBe(SAYS.whichFields);
    expect(no.seen.some((r) => "all" in r.questions)).toBe(true);
  });

  it("does not call a source missing when a note's title names its person", () => {
    const m = desk();
    m.apply(snap([field("dn", "Dana: (415) 555-0162", { role: "AXTextArea" })], { at: 960, windowId: "dana-note", title: "Dana notes.txt", app: { pid: 7011, bundleId: "com.apple.TextEdit", name: "TextEdit" } }));
    const s = snapOf("use what Dana wrote for the landlord phone", m);
    expect(s.missing).toBe(false);
    expect(s.named.map((n) => n.windowId)).toEqual(["dana-note"]);
  });
});

// B28 lead decision 1: a writer's whole form stands only on a whole-form request sentence (scope-words.ts) or Jev's two yeses.
// G1's blind run: "just do my contact info up top" on the Greenhouse page, the local maker said "whole form", and
// Graduation Date and LinkedIn were filled.
describe("a grounded whole-form scope (B28)", () => {
  const G = "com.google.Chrome/greenhouse";
  const GKEY = (s: string): string => `${G}/textfield:${s}~0`;
  /** The Greenhouse replica's text fields, under `groups` headings when given ({ heading: labels }), else under none. */
  const greenhouse = (groups: Record<string, string[]> | null = null, title = "Apply: Software Engineer Intern", labels = ["First Name", "Last Name", "Email", "Phone", "Graduation Date (MM/YYYY)", "LinkedIn Profile"]): ScreenModel => {
    // A group's key is its heading; "Outer > Inner" nests Inner's group in Outer's, and "Heading #2" is a second
    // group with the same heading.
    const groupKey = (g: string): string => `${G}/group:${g.toLowerCase()}~0`;
    const headingOf = (g: string): string => (g.split(" > ").at(-1) as string).replace(/ #\d+$/u, "");
    const parentOf = (label: string): string => {
      const g = groups === null ? undefined : Object.entries(groups).find(([, ls]) => ls.includes(label))?.[0];
      return g === undefined ? `${G}/webarea:~0` : groupKey(g);
    };
    const outers = [...new Set(Object.keys(groups ?? {}).filter((g) => g.includes(" > ")).map((g) => g.split(" > ")[0] as string))];
    const nodes: Node[] = [
      node(`${G}/webarea:~0`, "AXWebArea", { label: "Apply" }),
      ...outers.map((o) => node(groupKey(o), "AXGroup", { parent: `${G}/webarea:~0`, label: o })),
      ...Object.keys(groups ?? {}).map((g) => node(groupKey(g), "AXGroup", { parent: g.includes(" > ") ? groupKey(g.split(" > ")[0] as string) : `${G}/webarea:~0`, label: headingOf(g) })),
      ...labels.map((l, i) => field(GKEY(l.toLowerCase()), "", { parent: parentOf(l), label: l, frame: [100, 100 + 30 * i, 200, 20] })),
    ];
    const m = new ScreenModel();
    const note = ["First name: Jordan", "Last name: Reyes", "Email: jordan.reyes@example.org", "Phone: (512) 555-0147", "Graduation: 05/2027", "LinkedIn: https://www.linkedin.com/in/jordan-reyes-dev"].join("\n");
    const vals = [value("email", "jordan.reyes@example.org", "te/jr"), value("phone", "(512) 555-0147", "te/jr"), value("date", "05/2027", "te/jr"), value("url", "https://www.linkedin.com/in/jordan-reyes-dev", "te/jr")];
    m.apply(snap([field("te/jr", note, { role: "AXTextArea" })], { at: 900, windowId: "jr-note", title: "Jordan notes.txt", app: { pid: 7020, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true, values: vals }));
    m.apply(snap(nodes, { at: 1000, windowId: "gh", title, app: { pid: 7021, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: GKEY("first name") }));
    return m;
  };
  const VALUES: Record<string, string> = { "'First Name'": "Jordan", "'Last Name'": "Reyes", "'Email'": "jordan.reyes@example.org", "'Phone'": "(512) 555-0147", "'Graduation Date (MM/YYYY)'": "05/2027", "'LinkedIn Profile'": "https://www.linkedin.com/in/jordan-reyes-dev" };
  const pickG = (q: string): string | null => Object.entries(VALUES).find(([k]) => q.includes(k))?.[1] ?? null;
  const askG = (instruction: string, m: ScreenModel, confirm: (q: string) => "yes" | "no" = () => "yes", scope: Partial<AskIntent> = { scope: "all" }) => {
    const jev = jevBy(pickG, () => "user", confirm);
    return { jev, run: planAsk(instruction, m, { values: () => [] }, [], { askJev: jev.ask, maker: maker(scope), writer: null, offerKey: "b28", windowId: "gh", now: 2000 }) };
  };
  const written = (d: AskDraft): string[] => d.checked.writes.map((w) => w.node.key);
  const CONTACT = ["first name", "last name", "email", "phone"].map(GKEY);

  it("heldout2-04: a maker's 'whole form' for 'just do my contact info up top' never fills past the contact fields", async () => {
    // No section on the page means contact info: Caret asks, even though this stand-in Jev would say yes to anything.
    const { jev, run } = askG("just do my contact info up top", greenhouse());
    const e = await run.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskRefused);
    expect((e as AskRefused).message).toBe(SAYS.whichFields);
    expect((e as AskRefused).detail).toContain("contact info");
    expect(jev.seen.some((r) => "all" in r.questions)).toBe(false);
  });

  it("heldout2-04 on a page with a contact section fills that section and nothing under another heading", async () => {
    const m = greenhouse({ "Contact information": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)"], Links: ["LinkedIn Profile"] });
    const d = await askG("just do my contact info up top", m).run;
    expect(written(d)).toEqual(CONTACT);
  });

  it("maps 'up top' to the section the form starts with, and asks when the first field sits under no heading", async () => {
    const m = greenhouse({ "About you": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    expect(written(await askG("just fill in up top", m).run)).toEqual(CONTACT);
    const flat = greenhouse({ Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    expect(((await askG("just fill in up top", flat).run.catch((x: unknown) => x)) as AskRefused).message).toBe(SAYS.whichFields);
  });

  it("maps 'my details' to a details section, and asks when two sections could be it", async () => {
    const m = greenhouse({ "Your details": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    expect(written(await askG("fill in my details", m).run)).toEqual(CONTACT);
    const two = greenhouse({ "Your details": ["First Name", "Last Name"], "Personal details": ["Email", "Phone", "Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    expect(((await askG("fill in my details", two).run.catch((x: unknown) => x)) as AskRefused).message).toBe(SAYS.whichFields);
  });

  it("asks when the instruction rules the section out or names a field besides it (B28 review)", async () => {
    const m = () => greenhouse({ "Contact information": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    for (const instruction of ["skip my contact info, do the rest", "only my email in contact info"]) {
      const e = await askG(instruction, m()).run.catch((x: unknown) => x);
      expect((e as AskRefused).message).toBe(SAYS.whichFields);
    }
  });

  it("takes a whole-form word beside a named field to Jev, and narrows to the field when Jev says no to the whole form (B28 review)", async () => {
    const { jev, run } = askG("just fill my email on this form", greenhouse(), (q) => (q.includes("'Email'") ? "yes" : "no"));
    expect(written(await run)).toEqual([GKEY("email")]);
    expect(jev.seen.filter((r) => "all" in r.questions).length).toBe(2);
  });

  it("never takes someone else's contact or details section for the user's (B28 review 6)", async () => {
    const theirs = greenhouse({ "About you": ["First Name", "Last Name"], "Emergency contact": ["Email", "Phone"], Education: ["Graduation Date (MM/YYYY)"], Links: ["LinkedIn Profile"] });
    const e = await askG("fill in my contact info only", theirs, () => "no").run.catch((x: unknown) => x);
    expect((e as AskRefused).message).toBe(SAYS.whichFields);
    const ref = greenhouse({ "Reference details": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    const r = await askG("fill in my details", ref, () => "no").run.catch((x: unknown) => x);
    expect((r as AskRefused).message).toBe(SAYS.whichFields);
  });

  it("asks when the matching heading sits inside another heading (B28 review 6 re-check)", async () => {
    const nested = greenhouse({ "About you": ["First Name", "Last Name"], "Emergency contact > Contact information": ["Email", "Phone"], Education: ["Graduation Date (MM/YYYY)"], Links: ["LinkedIn Profile"] });
    const e = await askG("fill in my contact info only", nested, () => "no").run.catch((x: unknown) => x);
    expect((e as AskRefused).message).toBe(SAYS.whichFields);
    expect((e as AskRefused).detail).toContain("Emergency contact");
  });

  it("asks when two parts of the form share the matching heading (B28 review 6 re-check)", async () => {
    const twice = greenhouse({ "Contact information": ["First Name", "Last Name"], "Contact information #2": ["Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    const d = await askG("just do my contact info up top", twice, () => "no").run.catch((x: unknown) => x);
    expect((d as AskRefused).message).toBe(SAYS.whichFields);
    expect((d as AskRefused).detail).toContain("more than one part");
  });

  it("asks which fields for a section phrase in any sentence but a section request, even when Jev would say yes", async () => {
    const m = greenhouse({ "Contact information": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    const { jev, run } = askG("fill in everything in my contact info", m);
    expect(((await run.catch((x: unknown) => x)) as AskRefused).message).toBe(SAYS.whichFields);
    expect(jev.seen.some((r) => "all" in r.questions)).toBe(false);
  });

  it("asks Jev about a whole form the instruction does not ask for in words, even when no field is named", async () => {
    // Jev says no to the whole form: no field is named, so Caret asks which.
    const { jev, run } = askG("sort this out for me please", greenhouse(), () => "no");
    expect(((await run.catch((x: unknown) => x)) as AskRefused).message).toBe(SAYS.whichFields);
    expect(jev.seen.filter((r) => "all" in r.questions).length).toBe(2);
    // Jev's two yeses let it stand.
    expect(written(await askG("sort this out for me please", greenhouse(), () => "yes").run).length).toBe(6);
  });

  it("narrows an unconfirmed whole form to the fields the instruction names that Jev confirms", async () => {
    const { run } = askG("my email and phone, leave the rest", greenhouse(), (q) => (q.includes("whole form") || q.includes("every field") ? "no" : "yes"));
    expect(written(await run)).toEqual([GKEY("email"), GKEY("phone")]);
    // A named field Jev says the instruction rules out is dropped too.
    const out = askG("Fill only Email; do not change Phone", greenhouse(), (q) => (q.includes("'Email'") ? "yes" : "no"));
    expect(written(await out.run)).toEqual([GKEY("email")]);
  });

  const LAYOUTS: [string, Record<string, string[]> | null][] = [
    ["no sections", null],
    ["a contact section", { "Contact information": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)"], Links: ["LinkedIn Profile"] }],
    ["a details section", { "Your details": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] }],
  ];
  it.each(REVIEWED)("never lets %j stand as a whole form or section when Jev confirms nothing (B28 reviews)", async (instruction, title) => {
    for (const [, groups] of LAYOUTS) {
      const e = await askG(instruction, greenhouse(groups, title), () => "no").run.catch((x: unknown) => x);
      expect(e, `${instruction} wrote ${e instanceof AskRefused ? "" : written(e as AskDraft).join(", ")}`).toBeInstanceOf(AskRefused);
    }
  });

  it.each(["please fill the entire form", "fill out the form from my note", "fill in everything you can", "do the whole form from my note", "complete this form", "Can you fill out this application for me?", "fill the rest using my notes"])(
    "lets the whole form stand on the whole-form request %j without asking Jev",
    async (instruction) => {
      expect(asksForWholeForm(instruction)).toBe(true);
      const { jev, run } = askG(instruction, greenhouse(), () => "no");
      expect(written(await run).length).toBe(6);
      expect(jev.seen.some((r) => "all" in r.questions)).toBe(false);
    },
  );

  // What failing closed costs: requests the earlier recognizer trusted now take Jev's two asks first.
  it.each(["fill out the form please", "fill it out", "fill out from my note", "finish this application", "fill out the software engineer intern application", "all of it from my note", "everything's in my note", "just do everything for me"])(
    "asks Jev about %j, which is not a whole-form request sentence",
    async (instruction) => {
      expect(asksForWholeForm(instruction)).toBe(false);
      const yes = askG(instruction, greenhouse(), () => "yes");
      expect(written(await yes.run).length).toBe(6);
      expect(yes.jev.seen.filter((r) => "all" in r.questions).length).toBe(2);
      const no = askG(instruction, greenhouse(), () => "no");
      expect(((await no.run.catch((x: unknown) => x)) as AskRefused).message).toBe(SAYS.whichFields);
    },
  );

  // B28b: two holes B28's probes found, where words that name a field or a section were trusted without Jev, and a
  // section phrase trusted every field under its heading. Each test uses a Jev that confirms nothing unless told.
  const askWith = (instruction: string, m: ScreenModel, confirm: (q: string) => "yes" | "no", x: (s: IntentSnapshot) => Partial<AskIntent>) => {
    const jev = jevBy(pickG, () => "user", confirm);
    return { jev, run: planAsk(instruction, m, { values: () => [] }, [], { askJev: jev.ask, maker: maker(x), writer: null, offerKey: "b28b", windowId: "gh", now: 2000 }) };
  };
  const listOf = (...names: string[]) => (s: IntentSnapshot): Partial<AskIntent> => ({ scope: "list", fields: names.map((n) => refOf(s, n)) });
  const sectionNamed = (name: string) => (s: IntentSnapshot): Partial<AskIntent> => ({ scope: "section", section: s.sections.find((x) => x.name === name)?.ref ?? "missing" });
  const refusal = async (run: Promise<AskDraft>): Promise<AskRefused> => {
    const e = await run.catch((x: unknown) => x);
    expect(e, e instanceof AskRefused ? "" : `wrote ${written(e as AskDraft).join(", ")}`).toBeInstanceOf(AskRefused);
    return e as AskRefused;
  };
  const confirmed = (jev: { seen: JevRequest[] }): string[] =>
    jev.seen.flatMap((r) => Object.values(r.questions).flatMap((q) => (("yes" in q.criteria) ? [/'([^']+)'/u.exec(String(q.instructions))?.[1] ?? "all"] : [])));
  const CONTACT_SECTION = { "Contact information": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)"], Links: ["LinkedIn Profile"] };

  it("B28b: a writer's list for 'fill out the email and not phone' is confirmed by Jev field by field, not trusted for naming them", async () => {
    expect((await refusal(askWith("fill out the email and not phone", greenhouse(), () => "no", listOf("Email", "Phone")).run)).message).toBe(SAYS.whichFields);
    const { jev, run } = askWith("fill out the email and not phone", greenhouse(), (q) => (q.includes("'Email'") ? "yes" : "no"), listOf("Email", "Phone"));
    expect(written(await run)).toEqual([GKEY("email")]);
    expect(new Set(confirmed(jev))).toEqual(new Set(["Email", "Phone"]));
  });

  it("B28b: a writer's section for 'do the contact section except phone' is confirmed by Jev field by field, not trusted for naming it", async () => {
    expect((await refusal(askWith("do the contact section except phone", greenhouse(CONTACT_SECTION), () => "no", sectionNamed("Contact information")).run)).message).toBe(SAYS.whichFields);
    const { run } = askWith("do the contact section except phone", greenhouse(CONTACT_SECTION), (q) => (q.includes("'Phone'") ? "no" : "yes"), sectionNamed("Contact information"));
    expect(written(await run)).toEqual(["first name", "last name", "email"].map(GKEY));
  });

  // One sentence per exclusion word of the lead decision (b28-reviewed.ts); the writer lists the three fields the
  // sentence names, all of which naming used to trust.
  it.each(BY_WORD)("B28b: the exclusion word %j makes every named field Jev's to confirm: %j", async (_, instruction) => {
    expect((await refusal(askWith(instruction, greenhouse(), () => "no", listOf("Email", "Phone", "LinkedIn Profile")).run)).message).toBe(SAYS.whichFields);
  });

  // P2 (P1's review): a word two fields share names neither. "Personal email" counted as named by "fill Work email" and
  // was written without Jev's confirmation.
  it("P2: 'fill Work email' names only Work email; Personal email stands only on Jev's yes", async () => {
    // A third field, so the list is not every field (which would be read as the whole form).
    const m = greenhouse(null, "Apply: Software Engineer Intern", ["Work email", "Personal email", "Phone"]);
    const both = (q: string): string | null => (/email'/iu.test(q) ? "jordan.reyes@example.org" : null);
    const jev = jevBy(both, () => "user", () => "no");
    const d = await planAsk("fill Work email", m, { values: () => [] }, [], { askJev: jev.ask, maker: maker(listOf("Work email", "Personal email")), writer: null, offerKey: "p2-names", windowId: "gh", now: 2000 });
    expect(written(d)).toEqual([GKEY("work email")]);
    expect(confirmed(jev)).toEqual(["Personal email", "Personal email"]);
  });

  it("P2: a field whose every word another field shares is named by all of them, unless the longer field is named too", async () => {
    const m = greenhouse(null, "Apply: Software Engineer Intern", ["Email", "Work email", "Phone"]);
    const both = (q: string): string | null => (/email'/iu.test(q) ? "jordan.reyes@example.org" : null);
    const one = jevBy(both, () => "user", () => "no");
    expect(written(await planAsk("fill my email", m, { values: () => [] }, [], { askJev: one.ask, maker: maker(listOf("Email", "Work email")), writer: null, offerKey: "p2-a", windowId: "gh", now: 2000 }))).toEqual([GKEY("email")]);
    const two = jevBy(both, () => "user", () => "no");
    expect(written(await planAsk("fill my work email", m, { values: () => [] }, [], { askJev: two.ask, maker: maker(listOf("Email", "Work email")), writer: null, offerKey: "p2-b", windowId: "gh", now: 2000 }))).toEqual([GKEY("work email")]);
  });

  it("B28b: names still stand without Jev when the instruction has no exclusion word", async () => {
    const { jev, run } = askWith("fill in the email and phone", greenhouse(), () => "no", listOf("Email", "Phone"));
    expect(written(await run)).toEqual([GKEY("email"), GKEY("phone")]);
    expect(jev.seen.some((r) => Object.values(r.questions).some((q) => "yes" in q.criteria))).toBe(false);
  });

  // B28b lead decision 2: "contact info" trusts only the contact fields of its section. The re-check of 8ca77f5 put
  // Graduation Date and LinkedIn under a "Contact information" heading, and both were filled.
  const GRAD_LAYOUT = { "About you": ["First Name", "Last Name"], "Contact information": ["Email", "Phone", "Graduation Date (MM/YYYY)", "LinkedIn Profile"] };
  it("B28b: 'do my contact info' on a Contact information heading holding Graduation Date and LinkedIn fills only the contact fields without Jev", async () => {
    const { jev, run } = askG("do my contact info", greenhouse(GRAD_LAYOUT), () => "no");
    expect(written(await run)).toEqual([GKEY("email"), GKEY("phone")]);
    expect(new Set(confirmed(jev))).toEqual(new Set(["Graduation Date (MM/YYYY)", "LinkedIn Profile"]));
    // What Jev confirms joins them.
    const yes = askG("do my contact info", greenhouse(GRAD_LAYOUT), (q) => (q.includes("'LinkedIn Profile'") ? "yes" : "no"));
    expect(written(await yes.run)).toEqual([GKEY("email"), GKEY("phone"), GKEY("linkedin profile")]);
  });

  it("B28b: a contact section of only contact fields still fills without a question", async () => {
    const { jev, run } = askG("just do my contact info up top", greenhouse(CONTACT_SECTION), () => "no");
    expect(written(await run)).toEqual(CONTACT);
    expect(confirmed(jev)).toEqual([]);
  });

  it("B28b: 'my details' and 'up top' have no kind of their own, so every field of their section is Jev's to confirm", async () => {
    const details = greenhouse({ "Your details": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    expect((await refusal(askG("fill in my details", details, () => "no").run)).message).toBe(SAYS.whichFields);
    const top = greenhouse({ "About you": ["First Name", "Last Name", "Email", "Phone"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    expect((await refusal(askG("just fill in up top", top, () => "no").run)).message).toBe(SAYS.whichFields);
    expect(written(await askG("just fill in up top", top, (q) => (q.includes("'Email'") ? "yes" : "no")).run)).toEqual([GKEY("email")]);
  });

  // B28b review (astra a8c4698935cbcfab0) on 37e2978.
  it("B28b review: a writer's section intent for a section phrase trusts only the fields of the phrase's meaning", async () => {
    const { jev, run } = askWith("do my contact info", greenhouse(GRAD_LAYOUT), () => "no", sectionNamed("Contact information"));
    expect(written(await run)).toEqual([GKEY("email"), GKEY("phone")]);
    expect(new Set(confirmed(jev))).toEqual(new Set(["Graduation Date (MM/YYYY)", "LinkedIn Profile"]));
    const details = greenhouse({ "Your details": ["First Name", "Last Name", "Email"], Education: ["Graduation Date (MM/YYYY)", "LinkedIn Profile"] });
    expect((await refusal(askWith("fill in my details", details, () => "no", sectionNamed("Your details")).run)).message).toBe(SAYS.whichFields);
    // A writer's section the phrase does not mean is asked about.
    expect((await refusal(askWith("do my contact info", greenhouse(CONTACT_SECTION), () => "yes", sectionNamed("Education")).run)).message).toBe(SAYS.whichFields);
  });

  it("B28b review: 'n't' apart from its verb still voids name trust", async () => {
    for (const instruction of ["fill in the email and phone, linkedin is n't needed", "fill in the email and phone, do n’t fill linkedin"]) {
      expect((await refusal(askWith(instruction, greenhouse(), () => "no", listOf("Email", "Phone", "LinkedIn Profile")).run)).message, instruction).toBe(SAYS.whichFields);
    }
  });

  it.each(["Emergency contact phone", "Family size"])("B28b review: 'do my contact info' asks Jev about %j under a Contact information heading", async (label) => {
    const m = greenhouse({ "Contact information": ["Email", label] }, undefined, ["Email", label]);
    const { jev, run } = askG("do my contact info", m, () => "no");
    const d = await run;
    expect(written(d)).toEqual([GKEY("email")]);
    expect(d.fill?.fields.map((f) => f.key)).toEqual([GKEY("email")]);
    expect(confirmed(jev)).toEqual([label, label]);
  });

  it.each([
    ["only email, phone later", ["Email", "Phone"]],
    ["fill everything bar phone", ["Phone"]],
    ["fill in the email, phone is optional", ["Email", "Phone"]],
  ] as const)("B28b review: %j voids name trust", async (instruction, names) => {
    expect((await refusal(askWith(instruction, greenhouse(), () => "no", listOf(...names)).run)).message).toBe(SAYS.whichFields);
  });

  // B28b re-check (astra a289e1777901b58d1) on 4ecb59c.
  it("B28b re-check: a section named by words is not trusted when the instruction names a field in it", async () => {
    const m = greenhouse({ "Contact information": ["Email", "Phone", "Graduation Date (MM/YYYY)"] }, undefined, ["Email", "Phone", "Graduation Date (MM/YYYY)"]);
    const { jev, run } = askWith("fill only Email in the contact section", m, (q) => (q.includes("'Email'") ? "yes" : "no"), sectionNamed("Contact information"));
    expect(written(await run)).toEqual([GKEY("email")]);
    expect(new Set(confirmed(jev))).toEqual(new Set(["Email", "Phone", "Graduation Date (MM/YYYY)"]));
  });

  it("B28b re-check: a label that reads as both a name and a phone is not contact info", async () => {
    const label = "Name of your mobile phone";
    const m = greenhouse({ "Contact information": ["Email", label] }, undefined, ["Email", label]);
    const { jev, run } = askG("do my contact info", m, () => "no");
    expect((await run).fill?.fields.map((f) => f.key)).toEqual([GKEY("email")]);
    expect(confirmed(jev)).toEqual([label, label]);
  });

  it.each(["fill in the email, defer phone", "fill in the email, phone tomorrow"])("B28b re-check: %j voids name trust", async (instruction) => {
    const m = greenhouse({ "Contact information": ["Email", "Phone", "Graduation Date (MM/YYYY)"] }, undefined, ["Email", "Phone", "Graduation Date (MM/YYYY)"]);
    expect((await refusal(askWith(instruction, m, () => "no", listOf("Email", "Phone")).run)).message).toBe(SAYS.whichFields);
  });
});

// B30: a host that runs goal plans gets Ask's plan route as a goal, through D2-06's path; the other routes are as they were.
describe("planAsk for a goal-planning host", () => {
  const goals = (maker_: IntentMaker, ask: AskJev = jevBy(() => null).ask) => ({ askJev: ask, maker: maker_, writer: UNCALLED_WRITER, offerKey: "g-1", windowId: "form", now: 2000, goals: true as const });

  it("hands a plan intent to the goal path and plans nothing itself", async () => {
    const j = jevBy(() => null);
    const d = await planAsk("add the meeting to my calendar and draft a reply saying I'm in", desk(), memory, about, goals(maker({ route: "plan", scope: "none" }), j.ask));
    expect(d).toMatchObject({ route: "goal", windowId: "form", intent: { route: "plan" } });
    // The single-window planner and the code-mode writer are not a second path: Jev was asked only the scope ask that
    // settles the goal's fields (I2 ruling: every maker's plan is held to a scope).
    expect(j.seen.map((r) => r.purpose)).toEqual(["ask.scope", "ask.scope"]);
  });

  it("keeps a fill intent a scoped fill", async () => {
    const pick = (q: string): string | null => (q.includes("'Email'") ? "elena.vance@example.com" : null);
    const d = await planAsk("my email please", desk(), memory, about, goals(maker((s) => ({ fields: [refOf(s, "Email")] })), jevBy(pick, () => "user").ask));
    expect(d.route).toBe("fill");
    expect("checked" in d && d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([[KEY("email"), "elena.vance@example.com"]]);
  });

  it("keeps a must-refuse intent a refusal with B26's sentence, a plan route included", async () => {
    const pay = await planAsk("pay for it", desk(), memory, about, goals(maker({ route: "refuse", why: "payment" }))).catch((x: unknown) => x);
    expect((pay as AskRefused).message).toBe(SAYS.payment);
    // A plan that names a kind Caret never types is refused for it, as a refusal or a question is: no goal is planned.
    const ssn = await planAsk("put my SSN in and submit it", desk(), memory, about, goals(maker({ route: "plan", scope: "none" }))).catch((x: unknown) => x);
    expect(ssn).toBeInstanceOf(AskRefused);
    expect((ssn as AskRefused).message).toBe("Caret doesn't type Social Security numbers. Type it yourself.");
    // A plan that copies from a source no open window could be is said as such.
    const away = await planAsk("add the meeting from my LinkedIn to my calendar", desk(), memory, about, goals(maker({ route: "plan", scope: "none" }))).catch((x: unknown) => x);
    expect((away as AskRefused).message).toBe(SAYS.notOnScreen);
  });

  it("asks B29's question with choices for an unclear part", async () => {
    const e = await planAsk("do the thing", desk(), memory, about, goals(maker({ route: "ask", why: "whichFields", scope: "none" }))).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AskAsks);
    expect((e as AskAsks).question.part).toBe("fields");
  });
});

// B30: an Ask from a window with no field (the email the user reads) can only be about other windows.
describe("planAsk from a window with no field, for a goal-planning host", () => {
  const reading = (): ScreenModel => {
    const m = desk();
    m.apply(snap([text("mail/l0", "From: Priya Raman <priya@example.com>"), text("mail/l1", "Can you come Thursday?")], { at: 1100, windowId: "mail", title: "Thursday", app: { pid: 7003, bundleId: "dev.caret.mailfixture", name: "Mail" }, focused: true }));
    return m;
  };
  const opts = (intent: Partial<AskIntent>, goals: boolean) => ({ askJev: jevBy(() => null).ask, maker: maker(intent), writer: UNCALLED_WRITER, offerKey: "g-2", windowId: "mail", now: 2000, goals });

  it("reads an unsettled or fill intent as a plan, since nothing there can be filled", async () => {
    for (const intent of [{ route: "ask" as const, why: "whichFields" as const, scope: "none" as const }, { route: "fill" as const, scope: "all" as const }]) {
      expect(await planAsk("reply saying I'm in", reading(), memory, about, opts(intent, true))).toMatchObject({ route: "goal", windowId: "mail" });
    }
  });

  it("still refuses what code refuses, and changes nothing for a host without goal plans", async () => {
    const ssn = await planAsk("reply with my SSN", reading(), memory, about, opts({ route: "ask", why: "whichFields", scope: "none" }, true)).catch((x: unknown) => x);
    expect((ssn as AskRefused).message).toBe("Caret doesn't type Social Security numbers. Type it yourself.");
    const pay = await planAsk("pay her", reading(), memory, about, opts({ route: "refuse", why: "payment" }, true)).catch((x: unknown) => x);
    expect((pay as AskRefused).message).toBe(SAYS.payment);
    const old = await planAsk("reply saying I'm in", reading(), memory, about, opts({ route: "ask", why: "whichFields", scope: "none" }, false)).catch((x: unknown) => x);
    expect(old).toBeInstanceOf(AskRefused);
  });
});
