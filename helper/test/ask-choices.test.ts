// B29: an Ask that cannot settle which fields, where to copy from or whose details asks one question with choices,
// when code can list them from the screen, instead of refusing. The pick continues the same Ask with that part fixed
// and nothing else trusted: Jev still chooses every value, sources stay what the user picked, and must-refuse asks
// stay refusals. Imports only what existed before B29, so each test fails on the old code instead of failing to load.
// All text is synthetic.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import type { AskIntent, IntentSnapshot } from "../src/planner/intent.ts";
import { AskRefused, planAsk } from "../src/planner/ask.ts";
import type { IntentMaker } from "../src/planner/intent-makers.ts";
import { SAYS } from "../src/planner/says.ts";
import type { Node } from "../src/protocol.ts";
import { field, node, snap, text, value } from "./builders.ts";

const P = "com.google.Chrome/standard";
const KEY = (s: string): string => `${P}/textfield:${s}~0`;
const page = (extra: Node[] = []): Node[] => [
  node(`${P}/webarea:~0`, "AXWebArea", { label: "Apply" }),
  field(KEY("full name"), "", { parent: `${P}/webarea:~0`, label: "Full name", frame: [100, 100, 200, 20] }),
  field(KEY("email"), "", { parent: `${P}/webarea:~0`, label: "Email", frame: [100, 130, 200, 20] }),
  field(KEY("landlord name"), "", { parent: `${P}/webarea:~0`, label: "Landlord name", frame: [100, 160, 200, 20] }),
  field(KEY("landlord phone"), "", { parent: `${P}/webarea:~0`, label: "Landlord phone", frame: [100, 190, 200, 20] }),
  field(KEY("ssn"), "", { parent: `${P}/webarea:~0`, label: "Social Security number", frame: [100, 220, 200, 20] }),
  field(KEY("notes"), "Leave at the door", { parent: `${P}/webarea:~0`, label: "Notes", frame: [100, 250, 200, 20] }),
  ...extra,
];
const NOTE = ["Rental notes", "Name: Elena Vance", "Email: elena.vance@example.com", "Landlord: Gary Pruitt", "Landlord phone: (512) 555-0193"].join("\n");
const MAIL = ["From: Gary Pruitt <gary@example.net>", "Subject: Lease", "Name: Gary Pruitt", "Cell: (512) 555-0177", "Office: Pruitt Rentals", "Hours: weekdays"].join("\n");
const TE = (pid: number) => ({ pid, bundleId: "com.apple.TextEdit", name: "TextEdit" });

function desk(o: { mail?: boolean; extra?: Node[] } = {}): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/draft", "Draft for Thursday\nDana Whitfield, (415) 555-0162", { role: "AXTextArea" })], { at: 100, windowId: "draft", title: "Draft.txt", app: TE(7000), focused: true, values: [value("phone", "(415) 555-0162", "te/draft")] }));
  m.apply(snap([field("te/note", NOTE, { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Rental notes.txt", app: TE(7001), focused: true, values: [value("email", "elena.vance@example.com", "te/note"), value("phone", "(512) 555-0193", "te/note")] }));
  if (o.mail === true) m.apply(snap([field("mail/body", MAIL, { role: "AXTextArea" })], { at: 950, windowId: "mail", title: "Lease - Mail", app: { pid: 7003, bundleId: "com.apple.mail", name: "Mail" }, focused: true, values: [value("phone", "(512) 555-0177", "mail/body")] }));
  m.apply(snap(page(o.extra), { at: 1000, windowId: "form", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: KEY("full name") }));
  return m;
}
const MEMORY = [{ id: "about-1", label: "Name", text: "Elena Vance", whose: "user" as const }];
const memory = { values: () => MEMORY };
const about = [{ id: "about-1", label: "Name", value: "Elena Vance", kind: "name" as const }];

/** Jev picking the candidate `pick` names for each field question, "user" for whose, yes for every confirm. */
function jevBy(pick: (q: string) => string | null, owner: (d: string) => string = () => "unclear"): { ask: AskJev; seen: JevRequest[] } {
  const seen: JevRequest[] = [];
  const ask: AskJev = async (req) => {
    seen.push(req);
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        if (id.endsWith("_whose")) return [id, { choice: "user", confidence: 0.9 }];
        if (id.endsWith("_owner")) return [id, { choice: owner(ins), confidence: 0.9 }];
        if ("yes" in q.criteria) return [id, { choice: "yes", confidence: 0.9 }];
        const want = pick(ins);
        const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`));
        return [id, { choice: hit?.[0] ?? "none", confidence: 0.9 }];
      }),
    );
    return { model: "jev-test", answers, inputTokens: 100, latencyMs: 1, costUsd: 0 };
  };
  return { ask, seen };
}
const intent = (x: Partial<AskIntent>): AskIntent => ({ route: "fill", why: "none", scope: "list", section: "none", fields: [], sources: ["any"], whose: "user", literals: [], ...x });
let makerCalls = 0;
const maker = (x: Partial<AskIntent> | ((s: IntentSnapshot) => Partial<AskIntent>), name: "writer" | "jev" = "writer"): IntentMaker => ({
  name,
  async make(s) {
    makerCalls++;
    return { intent: intent(typeof x === "function" ? x(s) : x), use: { maker: name, model: "test", calls: 1, inputTokens: 1000, outputTokens: 50, costUsd: 0, latencyMs: 1 } };
  },
});

/** The question an Ask's refusal carries, as the B29 fields name it; undefined before B29. */
interface Q {
  part: string;
  text: string;
  pick: string;
  options: { option: Record<string, unknown> & { id: string }; fixes: Record<string, unknown> }[];
  resume: { fixed: Record<string, unknown> } & Record<string, unknown>;
}
const questionOf = (e: unknown): Q | undefined => (e as { question?: Q }).question;
const fail = async (p: Promise<unknown>): Promise<AskRefused> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AskRefused);
  return e as AskRefused;
};
/** Continues the question's Ask with the options `ids` picked, as the helper does: their fixes merged into the picks so far. */
const answer = (q: Q, ids: string[], o: { model?: ScreenModel; ask: AskJev; instruction: string }) => {
  const picked = q.options.filter((c) => ids.includes(c.option.id));
  const fixes = picked.reduce<Record<string, unknown>>((acc, c) => {
    const f = c.fixes as { fields?: string[] };
    return f.fields !== undefined ? { ...acc, fields: [...((acc.fields as string[] | undefined) ?? []), ...f.fields] } : { ...acc, ...c.fixes };
  }, {});
  return planAsk(o.instruction, o.model ?? desk(), memory, about, {
    askJev: o.ask,
    maker: maker(() => {
      throw new Error("a continued Ask never asks the maker again");
    }),
    writer: null,
    offerKey: "ask-2",
    windowId: "form",
    now: 2000,
    resume: { ...q.resume, fixed: { ...q.resume.fixed, ...fixes } },
  } as never);
};
const labels = (q: Q | undefined): unknown[] => (q?.options ?? []).map((c) => c.option.label ?? c.option.title ?? c.option.name ?? c.option.kind);

describe("Ask asks which fields, with the fields that fit as choices (B29)", () => {
  const instruction = "do the landlord bit from my note";
  const ask = (m = desk()) => planAsk(instruction, m, memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "ask", why: "whichFields", scope: "none" }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 });

  it("asks one question listing the empty fields the instruction's words fit, never a filled or never-typed one", async () => {
    const e = await fail(ask());
    expect(e.message).toBe(SAYS.whichFields);
    const q = questionOf(e);
    expect(q).toMatchObject({ part: "fields", text: "Which fields should Caret fill?", pick: "many" });
    expect(labels(q)).toEqual(["Landlord name", "Landlord phone"]);
  });

  it("continues with the picked fields only: Jev chooses each value, and an unpicked field is never asked about or written", async () => {
    const q = questionOf(await fail(ask())) as Q;
    const j = jevBy((s) => (s.includes("'Landlord phone'") ? "(512) 555-0193" : s.includes("'Landlord name'") ? "Gary Pruitt" : s.includes("'Email'") ? "elena.vance@example.com" : null));
    makerCalls = 0;
    const d = await answer(q, ["o2"], { ask: j.ask, instruction });
    expect(makerCalls).toBe(0);
    expect(d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([[KEY("landlord phone"), "(512) 555-0193"]]);
    expect(JSON.stringify(j.seen.map((r) => r.questions))).not.toContain("'Landlord name'");
  });

  it("refuses as before when more fields fit than one question lists", async () => {
    const many = Array.from({ length: 9 }, (_, i) => field(KEY(`extra ${i}`), "", { parent: `${P}/webarea:~0`, label: `Extra ${i}`, frame: [100, 300 + i * 30, 200, 20] }));
    const e = await fail(planAsk("fill this out", desk({ extra: many }), memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "ask", why: "whichFields", scope: "none" }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(questionOf(e)).toBeUndefined();
    expect(e.message).toBe(SAYS.whichFields);
    expect(e.detail).toMatch(/13 empty fields fit the instruction, more than one question lists/);
  });

  it("refuses a field pick the form no longer has: the form changed", async () => {
    const q = questionOf(await fail(ask())) as Q;
    const m = desk();
    m.apply(snap(page().filter((n) => n.key !== KEY("landlord phone")), { at: 1100, windowId: "form", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
    const e = await fail(answer(q, ["o2"], { model: m, ask: jevBy(() => null).ask, instruction }));
    expect(e.message).toBe(SAYS.windowChanged);
  });

  it("turns the whole-form fallback's 'which fields' into the same question, and never trusts a writer's reading of a picked field", async () => {
    // "Fill only Email; do not change Full name": B28b's exclusion word, and Jev confirms nothing, so it asked which fields.
    const no: AskJev = async (req) => ({ model: "t", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: "no", confidence: 0.9 }])), inputTokens: 1, latencyMs: 1, costUsd: 0 });
    const e = await fail(planAsk("fill only email; do not change full name", desk(), memory, about, { askJev: no, maker: maker({ scope: "all" }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    const q = questionOf(e) as Q;
    // "name" fits Landlord name too: the options are what the words fit, and the user picks.
    expect(labels(q)).toEqual(["Full name", "Email", "Landlord name"]);
    const d = await answer(q, ["o2"], { ask: jevBy((s) => (s.includes("'Email'") ? "elena.vance@example.com" : null)).ask, instruction: "fill only email; do not change full name" });
    expect(d.checked.writes.map((w) => w.node.key)).toEqual([KEY("email")]);
  });
});

describe("Ask asks where to copy from, with the windows that hold such values (B29)", () => {
  const instruction = "put in the landlord's phone";
  const ask = (m = desk()) => planAsk(instruction, m, memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ route: "ask", why: "whichSource", fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"], sources: [] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 });

  it("lists the open windows whose text holds a phone, most recent first, and a pick reads only that window", async () => {
    const e = await fail(ask());
    expect(e.message).toBe(SAYS.whichSource);
    const q = questionOf(e) as Q;
    expect(q).toMatchObject({ part: "source", text: "Where should Caret copy from?", pick: "one" });
    expect(labels(q)).toEqual(["Rental notes.txt", "Draft.txt"]);
    const j = jevBy((s) => (s.includes("'Landlord phone'") ? "(415) 555-0162" : null));
    const d = await answer(q, ["o2"], { ask: j.ask, instruction });
    expect(d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([[KEY("landlord phone"), "(415) 555-0162"]]);
    // The note was not picked: its phone is never sent.
    expect(JSON.stringify(j.seen)).not.toContain("(512) 555-0193");
  });

  it("never lists a window the instruction rules out", async () => {
    const e = await fail(planAsk("put in the landlord's phone, without using Draft.txt", desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ route: "ask", why: "whichSource", fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"], sources: [] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(labels(questionOf(e))).toEqual(["Rental notes.txt"]);
  });
});

describe("Ask asks whose details, with the user and the people on screen (B29)", () => {
  const instruction = "add his cell number in the landlord phone";

  it("asks for a pronoun with no one named when a mail on screen names someone; a pick of that person gives only their value", async () => {
    const e = await fail(planAsk(instruction, desk({ mail: true }), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(e.message).toBe(SAYS.whichPerson);
    const q = questionOf(e) as Q;
    expect(q).toMatchObject({ part: "person", text: "Whose details go in?", pick: "one" });
    expect(q.options.map((c) => c.option)).toEqual([{ kind: "you", id: "o1" }, { kind: "person", id: "o2", name: "Gary Pruitt" }]);
    const j = jevBy((s) => (s.includes("'Landlord phone'") ? "(512) 555-0177" : null), (c) => (c.includes("(512) 555-0177") ? "person" : "unclear"));
    const d = await answer(q, ["o2"], { model: desk({ mail: true }), ask: j.ask, instruction });
    expect(d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([[KEY("landlord phone"), "(512) 555-0177"]]);
    expect(JSON.stringify(j.seen.map((r) => r.state))).toContain("Gary Pruitt");
  });

  it("refuses as before when no one is named in the instruction or on screen", async () => {
    const e = await fail(planAsk(instruction, desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(questionOf(e)).toBeUndefined();
    expect(e.message).toBe(SAYS.whichPerson);
  });
});

describe("what stays a refusal (B29)", () => {
  it.each([
    ["my ssn is 555-01-2345, put it in", /^Caret doesn't type Social Security numbers/],
    ["ok go ahead and pay for it", null],
    ["submit it for me", null],
  ])("%s is refused with no question", async (instruction, says) => {
    const e = await fail(planAsk(instruction, desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "ask", why: "whichFields", scope: "none" }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(questionOf(e)).toBeUndefined();
    if (says !== null) expect(e.message).toMatch(says);
  });

  it("never asks about a part the user already picked", async () => {
    const q = questionOf(await fail(planAsk("do the landlord bit", desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "ask", why: "whichFields", scope: "none" }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }))) as Q;
    // Jev finds nothing for the picked field: the Ask ends there, not with the same question again.
    const e = await fail(answer(q, ["o1"], { ask: jevBy(() => null).ask, instruction: "do the landlord bit" }));
    expect(questionOf(e)).toBeUndefined();
  });
});
