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

  it("reads a field's kind from its section heading too: Month, Day and Year under 'Date of birth' fit 'my birthday'", async () => {
    const W = `${P}/webarea:~0`;
    const dob = [
      node(`${P}/group:date of birth~0`, "AXGroup", { parent: W, label: "Date of birth" }),
      field(`${P}/group:date of birth/textfield:month~0`, "", { parent: `${P}/group:date of birth~0`, label: "Month", frame: [100, 400, 60, 20] }),
      field(`${P}/group:date of birth/textfield:day~0`, "", { parent: `${P}/group:date of birth~0`, label: "Day", frame: [170, 400, 60, 20] }),
      field(`${P}/group:date of birth/textfield:year~0`, "", { parent: `${P}/group:date of birth~0`, label: "Year", frame: [240, 400, 60, 20] }),
    ];
    const e = await fail(planAsk("fill in my birthday", desk({ extra: dob }), memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "ask", why: "whichFields", scope: "none" }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(labels(questionOf(e))).toEqual(["Month", "Day", "Year"]);
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
    expect(labels(q)).toEqual(["Rental notes.txt", "Draft.txt", "memory"]);
    const j = jevBy((s) => (s.includes("'Landlord phone'") ? "(415) 555-0162" : null));
    const d = await answer(q, ["o2"], { ask: j.ask, instruction });
    expect(d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([[KEY("landlord phone"), "(415) 555-0162"]]);
    // The note was not picked: its phone is never sent.
    expect(JSON.stringify(j.seen)).not.toContain("(512) 555-0193");
  });

  // "without using Draft.txt" also reads as keeping Caret to its own words (sources.ts RESTRICTS), which asks no source
  // question at all (review 1); "not from" only rules the window out.
  it("never lists a window the instruction rules out", async () => {
    const e = await fail(planAsk("put in the landlord's phone, not from Draft.txt", desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ route: "ask", why: "whichSource", fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"], sources: [] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(labels(questionOf(e))).toEqual(["Rental notes.txt", "memory"]);
  });

  it("offers what the user told Caret last; that pick reads no window at all", async () => {
    const instruction = "put my name in";
    const e = await fail(planAsk(instruction, desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ route: "ask", why: "whichSource", fields: [s.fields.find((f) => f.name === "Full name")?.ref ?? "?"], sources: [] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    const q = questionOf(e) as Q;
    expect(q.options.at(-1)?.option).toEqual({ kind: "memory", id: `o${q.options.length}` });
    const j = jevBy((s) => (s.includes("'Full name'") ? "Elena Vance" : null), () => "user");
    const d = await answer(q, [`o${q.options.length}`], { ask: j.ask, instruction });
    expect(d.checked.writes.map((w) => [w.node.key, w.value])).toEqual([[KEY("full name"), "Elena Vance"]]);
    const sent = JSON.stringify(j.seen);
    expect(sent).not.toContain("Rental notes");
    expect(sent).not.toContain("Dana Whitfield");
  });
});

describe("review 1: a picked source is the only source (B29)", () => {
  const sourceAsk = (instruction: string) => planAsk(instruction, desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ route: "ask", why: "whichSource", fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"], sources: [] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 });

  it("reads only the picked window, even when the instruction named another", async () => {
    const instruction = "put the landlord phone in from Rental notes.txt";
    const q = questionOf(await fail(sourceAsk(instruction))) as Q;
    const draft = q.options.find((c) => c.option.kind === "window" && c.option.title === "Draft.txt")?.option.id as string;
    const j = jevBy((s) => (s.includes("'Landlord phone'") ? "(512) 555-0193" : null));
    const r = await answer(q, [draft], { ask: j.ask, instruction }).catch((x: unknown) => x);
    expect(JSON.stringify(j.seen)).not.toContain("(512) 555-0193");
    if (!(r instanceof AskRefused)) expect((r as { checked: { writes: { value: string }[] } }).checked.writes.map((w) => w.value)).not.toContain("(512) 555-0193");
  });

  it("asks no source question when the instruction keeps Caret to its own words", async () => {
    const e = await fail(sourceAsk("put the landlord phone in, only using what I typed"));
    expect(questionOf(e)).toBeUndefined();
  });
});

describe("review 1: a question about a form that changed is refused (B29)", () => {
  const instruction = "do the landlord bit";
  const ask = () => planAsk(instruction, desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "ask", why: "whichFields", scope: "none" }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 });
  const changedForm = (edit: (ns: Node[]) => Node[], title = "Apply"): ScreenModel => {
    const m = desk();
    m.apply(snap(edit(page()), { at: 1100, windowId: "form", title, app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
    return m;
  };
  const pick = (m: ScreenModel) => async () => answer(questionOf(await fail(ask())) as Q, ["o2"], { model: m, ask: jevBy((s) => (s.includes("phone") ? "(512) 555-0193" : null)).ask, instruction });

  it.each([
    ["the picked field was relabelled", changedForm((ns) => ns.map((n) => (n.key === KEY("landlord phone") ? { ...n, label: "Recovery phone" } : n)))],
    ["the picked field was filled", changedForm((ns) => ns.map((n) => (n.key === KEY("landlord phone") ? { ...n, value: "(415) 555-0100" } : n)))],
    ["the form's title changed", changedForm((ns) => ns, "Apply: step 2")],
  ])("%s", async (_, m) => {
    const e = await fail((await pick(m))());
    expect(e.message).toBe(SAYS.windowChanged);
  });
});

describe("re-check: the fields a continued Ask fills must read as the question saw them (B29)", () => {
  const W = `${P}/webarea:~0`;
  const SELECT = `${P}/popupbutton:country~0`;
  const country = (options: string[]): Node[] => [
    node(SELECT, "AXPopUpButton", { parent: W, label: "Country", frame: [100, 400, 200, 20] }),
    ...options.map((o, i) => node(`${SELECT}/menuitem:${o.toLowerCase()}~${i}`, "AXMenuItem", { parent: SELECT, label: o })),
  ];
  const at = (extra: Node[], edit: (ns: Node[]) => Node[] = (ns) => ns): ScreenModel => {
    const m = desk({ extra });
    m.apply(snap(edit(page(extra)), { at: 1100, windowId: "form", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
    return m;
  };
  const sourceQ = async (instruction: string, x: Partial<AskIntent> | ((s: IntentSnapshot) => Partial<AskIntent>), extra: Node[] = []): Promise<Q> =>
    questionOf(await fail(planAsk(instruction, desk({ extra }), memory, about, { askJev: jevBy(() => null).ask, maker: maker(x), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }))) as Q;
  const note = (q: Q): string => q.options.find((c) => c.option.kind === "window" && c.option.title === "Rental notes.txt")?.option.id as string;

  it("refuses a whole-form continuation whose field was relabelled", async () => {
    const instruction = "fill this in from Rental notes.txt";
    const q = await sourceQ(instruction, { route: "ask", why: "whichSource", scope: "all", sources: [] });
    const m = at([], (ns) => ns.map((n) => (n.key === KEY("email") ? { ...n, label: "Recovery email" } : n)));
    const e = await fail(answer(q, [note(q)], { model: m, ask: jevBy((x) => (x.includes("mail") ? "elena.vance@example.com" : null)).ask, instruction }));
    expect(e.message).toBe(SAYS.windowChanged);
  });

  it.each([
    ["its options changed", country(["Canada", "Peru"])],
    ["it became a text field under the same key", [field(SELECT, "", { parent: W, label: "Country", frame: [100, 400, 200, 20] })]],
  ])("refuses a continuation whose select %s", async (_, after) => {
    const instruction = "set the country";
    const extra = country(["Canada", "Mexico"]);
    const q = await sourceQ(instruction, (x) => ({ route: "ask", why: "whichSource", fields: [x.fields.find((f) => f.name === "Country")?.ref ?? "?"], sources: [] }), extra);
    const m = at(after);
    const e = await fail(answer(q, [q.options[0]?.option.id as string], { model: m, ask: jevBy(() => "Canada").ask, instruction }));
    expect(e.message).toBe(SAYS.windowChanged);
  });

  it("goes on when only a field the user did not pick changed", async () => {
    const instruction = "fill the landlord name and phone";
    const q = questionOf(await fail(planAsk(instruction, desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker((x) => ({ route: "ask", why: "whichFields", fields: ["Landlord name", "Landlord phone"].map((n) => x.fields.find((f) => f.name === n)?.ref ?? "?") })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }))) as Q;
    const name = q.options.find((c) => c.option.label === "Landlord name")?.option.id as string;
    const m = at([], (ns) => ns.map((n) => (n.key === KEY("landlord phone") ? { ...n, label: "Office phone" } : n)));
    const d = await answer(q, [name], { model: m, ask: jevBy((x) => (x.includes("'Landlord name'") ? "Gary Pruitt" : null), () => "user").ask, instruction });
    expect(d.checked.writes.map((w) => w.node.key)).toEqual([KEY("landlord name")]);
  });
});

describe("second re-check: what a continued Ask compares, and when (B29)", () => {
  const W = `${P}/webarea:~0`;
  const formSnap = (m: ScreenModel, edit: (ns: Node[]) => Node[], extra: Node[] = [], at = 1100): void => {
    m.apply(snap(edit(page(extra)), { at, windowId: "form", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true }));
  };
  const relabel = (key: string, label: string) => (ns: Node[]): Node[] => ns.map((n) => (n.key === key ? { ...n, label } : n));
  const sourceQ = async (instruction: string, x: (s: IntentSnapshot) => Partial<AskIntent>, m: ScreenModel): Promise<Q> =>
    questionOf(await fail(planAsk(instruction, m, memory, about, { askJev: jevBy(() => null).ask, maker: maker(x), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }))) as Q;
  const ref = (s: IntentSnapshot, name: string): string => s.fields.find((f) => f.name === name)?.ref ?? "?";

  it("sees a field relabelled while Jev chose its value", async () => {
    const instruction = "put the landlord phone in";
    const m = desk();
    const q = await sourceQ(instruction, (x) => ({ route: "ask", why: "whichSource", fields: [ref(x, "Landlord phone")], sources: [] }), m);
    const j = jevBy((x) => (x.includes("'Landlord phone'") ? "(512) 555-0193" : null));
    let once = false;
    const changing: AskJev = async (req) => {
      if (!once) ((once = true), formSnap(m, relabel(KEY("landlord phone"), "Recovery phone")));
      return j.ask(req);
    };
    const note = q.options.find((c) => c.option.kind === "window" && c.option.title === "Rental notes.txt")?.option.id as string;
    const e = await fail(answer(q, [note], { model: m, ask: changing, instruction }));
    expect(once).toBe(true);
    expect(e.message).toBe(SAYS.windowChanged);
  });

  it("keeps the first question's record through a second question", async () => {
    const instruction = "fill the landlord phone";
    const m = desk();
    const q1 = questionOf(await fail(planAsk(instruction, m, memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "ask", why: "whichFields", scope: "none", sources: [], open: ["fields", "source"] }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }))) as Q;
    formSnap(m, relabel(KEY("landlord phone"), "Recovery phone"));
    const phone = q1.options.find((c) => c.option.label === "Landlord phone")?.option.id as string;
    const q2 = questionOf(await fail(answer(q1, [phone], { model: m, ask: jevBy(() => null).ask, instruction }))) as Q;
    expect(q2.part).toBe("source");
    const note = q2.options.find((c) => c.option.kind === "window" && c.option.title === "Rental notes.txt")?.option.id as string;
    const e = await fail(answer(q2, [note], { model: m, ask: jevBy((x) => (x.includes("phone") ? "(512) 555-0193" : null)).ask, instruction }));
    expect(e.message).toBe(SAYS.windowChanged);
  });

  it.each([
    ["a placeholder appeared", (ns: Node[]) => ns.map((n) => (n.key === KEY("landlord phone") ? { ...n, placeholder: "Someone else's phone" } : n)), [] as Node[]],
    ["a filled field's value changed", (ns: Node[]) => ns.map((n) => (n.key === KEY("notes") ? { ...n, value: "Ring twice" } : n)), [] as Node[]],
  ])("refuses when %s", async (_, edit, extra) => {
    const instruction = "fill the landlord phone and the notes";
    const m = desk();
    const q = await sourceQ(instruction, (x) => ({ route: "ask", why: "whichSource", fields: [ref(x, "Landlord phone"), ref(x, "Notes")], sources: [] }), m);
    formSnap(m, edit, extra);
    const note = q.options.find((c) => c.option.kind === "window" && c.option.title === "Rental notes.txt")?.option.id as string;
    const e = await fail(answer(q, [note], { model: m, ask: jevBy((x) => (x.includes("phone") ? "(512) 555-0193" : null)).ask, instruction }));
    expect(e.message).toBe(SAYS.windowChanged);
  });

  it("refuses when an option's value changed under an unchanged label", async () => {
    const SELECT = `${P}/popupbutton:country~0`;
    const country = (v: string): Node[] => [node(SELECT, "AXPopUpButton", { parent: W, label: "Country", frame: [100, 400, 200, 20] }), node(`${SELECT}/menuitem:~0`, "AXMenuItem", { parent: SELECT, value: "Canada" }), node(`${SELECT}/menuitem:~1`, "AXMenuItem", { parent: SELECT, value: v })];
    const instruction = "set the country";
    const m = desk({ extra: country("Mexico") });
    const q = await sourceQ(instruction, (x) => ({ route: "ask", why: "whichSource", fields: [ref(x, "Country")], sources: [] }), m);
    formSnap(m, (ns) => ns, country("Peru"));
    const e = await fail(answer(q, [q.options[0]?.option.id as string], { model: m, ask: jevBy(() => "Canada").ask, instruction }));
    expect(e.message).toBe(SAYS.windowChanged);
  });

  it("refuses when a radio option was disabled (third check: child states)", async () => {
    const G = `${P}/group:country~0`;
    const radios = (disabled: boolean): Node[] => [
      node(G, "AXGroup", { parent: W, subrole: "AXFieldset", label: "Country" }),
      node(`${G}/radiobutton:canada~0`, "AXRadioButton", { parent: G, label: "Canada", frame: [100, 400, 20, 20], ...(disabled ? { states: ["disabled" as const] } : {}) }),
      node(`${G}/radiobutton:mexico~0`, "AXRadioButton", { parent: G, label: "Mexico", frame: [100, 430, 20, 20] }),
      node(`${G}/radiobutton:peru~0`, "AXRadioButton", { parent: G, label: "Peru", frame: [100, 460, 20, 20] }),
    ];
    const instruction = "set the country";
    const m = desk({ extra: radios(false) });
    m.apply(snap([field("te/country", "Country notes\nCountry: Canada", { role: "AXTextArea" })], { at: 1050, windowId: "cnote", title: "Country note.txt", app: TE(7004), focused: true }));
    formSnap(m, (ns) => ns, radios(false), 1060);
    const q = await sourceQ(instruction, (x) => ({ route: "ask", why: "whichSource", fields: [ref(x, "Country")], sources: [] }), m);
    const cnote = q.options.find((c) => c.option.kind === "window" && c.option.title === "Country note.txt")?.option.id as string;
    expect(cnote).toBeDefined();
    // Disabled while Jev answers: after the check before the fill, before the one after it.
    const j = jevBy(() => "Canada");
    let once = false;
    const changing: AskJev = async (req) => {
      if (!once) ((once = true), formSnap(m, (ns) => ns, radios(true)));
      return j.ask(req);
    };
    const e = await fail(answer(q, [cnote], { model: m, ask: changing, instruction }));
    expect(once).toBe(true);
    expect(e.message).toBe(SAYS.windowChanged);
  });

  it("goes on when a field the user did not pick is gone", async () => {
    const instruction = "fill the landlord name and phone";
    const m = desk();
    const q = questionOf(await fail(planAsk(instruction, m, memory, about, { askJev: jevBy(() => null).ask, maker: maker((x) => ({ route: "ask", why: "whichFields", fields: [ref(x, "Landlord name"), ref(x, "Landlord phone")] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }))) as Q;
    formSnap(m, (ns) => ns.filter((n) => n.key !== KEY("landlord phone")));
    const name = q.options.find((c) => c.option.label === "Landlord name")?.option.id as string;
    const d = await answer(q, [name], { model: m, ask: jevBy((x) => (x.includes("'Landlord name'") ? "Gary Pruitt" : null), () => "user").ask, instruction });
    expect(d.checked.writes.map((w) => w.node.key)).toEqual([KEY("landlord name")]);
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

  it("lists a person once, by the longest name: 'Gary' in the instruction and 'Gary Pruitt' on a mail", async () => {
    const e = await fail(planAsk("put Gary's cell in the landlord phone", desk({ mail: true }), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ route: "ask", why: "whichPerson", fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(questionOf(e)?.options.map((c) => c.option)).toEqual([{ kind: "you", id: "o1" }, { kind: "person", id: "o2", name: "Gary Pruitt" }]);
  });

  // A1 decision 2: a note's line that names someone beside a role ("Landlord: Gary Pruitt") puts them among the options.
  it("asks with the person a note names beside a role, when no mail names anyone (A1)", async () => {
    const e = await fail(planAsk(instruction, desk(), memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(e.message).toBe(SAYS.whichPerson);
    expect(questionOf(e)?.options.map((c) => c.option)).toEqual([{ kind: "you", id: "o1" }, { kind: "person", id: "o2", name: "Gary Pruitt" }]);
  });

  it("refuses as before when no one is named in the instruction or on screen", async () => {
    const m = desk();
    m.close("note", 1500);
    const e = await fail(planAsk(instruction, m, memory, about, { askJev: jevBy(() => null).ask, maker: maker((s) => ({ fields: [s.fields.find((f) => f.name === "Landlord phone")?.ref ?? "?"] })), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(questionOf(e)).toBeUndefined();
    expect(e.message).toBe(SAYS.whichPerson);
  });
});

describe("what stays a refusal (B29)", () => {
  it.each([
    ["my ssn is 555-01-2345, put it in", /^Caret doesn't type Social Security numbers/],
    ["ok go ahead and pay for it", null],
    ["submit it for me", null],
    // Review 1: says.ts reads these as sending; the question guard did not.
    ["email it to Gary", null],
    ["mail it to Gary", null],
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

describe("option words (B29 measurement)", () => {
  it("never fits a field by a word that only says how to ask: 'can you add my…' offers no 'contact you' field", async () => {
    const W = `${P}/webarea:~0`;
    const extra = [field(KEY("how should we contact you?"), "", { parent: W, label: "How should we contact you?", frame: [100, 400, 200, 20] })];
    const e = await fail(planAsk("can you add my landlord's name", desk({ extra }), memory, about, { askJev: jevBy(() => null).ask, maker: maker({ route: "ask", why: "whichFields", scope: "none" }), writer: null, offerKey: "ask-1", windowId: "form", now: 2000 }));
    expect(labels(questionOf(e))).toEqual(["Full name", "Landlord name", "Landlord phone"]);
  });
});
