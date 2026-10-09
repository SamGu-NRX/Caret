// What the user told Caret as a fill source (B17): a typed Name or Email fills a field that asks for
// exactly that, with no other window open, and the offer says it came from "what you told Caret".
// Jev is a fake that answers by rule; every name and address here is invented.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { aboutKind, aboutValues, fieldAsksFor, ABOUT_SAYS, type AboutValue } from "../src/fill/about.ts";
import { FILL_CUTOFF, FillError, MEMORY_CUTOFF, proposeFill, WHOSE_CUTOFF, type Whose } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { buildFillPopup, fillPlan, fillPopupEligible, recheckFill, writtenFields } from "../src/offers/fill-popup.ts";
import { Helper } from "../src/helper.ts";
import { HelperServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { FillProposal, PROTOCOL_VERSION, type MemoryEntry, type OfferPopup } from "../src/protocol.ts";
import { SAYS } from "../src/planner/says.ts";
import { MAIL_APP, field, focus, jevPickingText, snap, text, value } from "./builders.ts";
import { LineClient, SocketReader, until } from "./socket-reader.ts";

const NAME: AboutValue = { id: "about-name", label: "Name", value: "Sam Rivera", kind: "name" };
const EMAIL: AboutValue = { id: "about-email", label: "Email", value: "sam.rivera@example.com", kind: "email" };
const F = (s: string): string => `dev.caret.fixture/standard/${s}`;
const FORM = "5150-7";

describe("which values and fields About entries fit", () => {
  it("reads an email by its shape and a name by its label and shape", () => {
    expect(aboutKind("Email", "sam.rivera@example.com")).toBe("email");
    expect(aboutKind("Work email", " sam@work.example ")).toBe("email");
    expect(aboutKind("Name", "Sam Rivera")).toBe("name");
    expect(aboutKind("Full name", "Ana de la Cruz")).toBe("name");
    expect(aboutKind("Name", "J. O'Neil-Park")).toBe("name");
    expect(aboutKind("Nickname", "Sam")).toBeNull();
    expect(aboutKind("Name", "Sam Rivera 2")).toBeNull();
    expect(aboutKind("Company", "Lumen Labs")).toBeNull();
    // C1: a city is a kind of its own (test/c1-about-kinds.test.ts).
    expect(aboutKind("Home city", "Porto")).toBe("city");
  });

  it("keeps typed entries only, trimmed, with their kinds", () => {
    const e = (id: string, label: string, v: string, source: "typed" | "edit" | "contacts") => ({ id, fields: { label, value: v, source } });
    expect(aboutValues([e("a", "Name", "Sam Rivera ", "typed"), e("b", "Guest", "Marcus Lowe", "edit"), e("c", "Email", "x@y.example", "contacts"), e("d", "Home city", "Porto", "typed"), e("f", "Nickname", "Sam", "typed")])).toEqual([
      { id: "a", label: "Name", value: "Sam Rivera", kind: "name" },
      { id: "d", label: "Home city", value: "Porto", kind: "city" },
    ]);
  });

  const table: [AboutValue, string | null, boolean][] = [
    [NAME, "Name", true],
    [NAME, "Full name", true],
    [NAME, "Your name", true],
    [NAME, "Name (required)", true],
    [NAME, "Legal name", true],
    [NAME, "First name", false],
    [NAME, "Last name", false],
    [NAME, "Guest name", false],
    [NAME, "Company name", false],
    [NAME, "Username", false],
    [NAME, "Email", false],
    [NAME, null, false],
    [EMAIL, "Email", true],
    [EMAIL, "E-mail", true],
    [EMAIL, "Email address", true],
    [EMAIL, "Your email", true],
    [EMAIL, "Recipient email", false],
    // B24: a user who gave one email gets it in "Work email"; a qualified entry only in its own qualifier's field.
    [EMAIL, "Work email", true],
    [EMAIL, "Name", false],
    [EMAIL, "Mail", false],
    [{ ...EMAIL, label: "Work email" }, "Work email", true],
    [{ ...EMAIL, label: "Work email" }, "Email", true],
    [{ ...EMAIL, label: "Work email" }, "Personal email", false],
  ];
  it.each(table)("%o fits a field named %s: %s", (a, name, fits) => {
    expect(fieldAsksFor(a, name)).toBe(fits);
  });
});

/** A form of the named fields in a window of its own, the first focused. */
function form(m: ScreenModel, labels: readonly string[], at = 2000): void {
  m.apply(
    snap(
      labels.map((l, i) => field(F(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * i, 200, 24] })),
      { at, windowId: FORM, title: "Sign up", focused: true, focusedKey: F(`textfield:${labels[0]?.toLowerCase()}~0`) },
    ),
  );
}
const key = (label: string): string => F(`textfield:${label.toLowerCase()}~0`);

/** Picks by field label from a table, recording each request. */
function recording(byLabel: Record<string, string>): { ask: AskJev; requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  const inner = jevPickingText((_, ins) => byLabel[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.92);
  return { requests, ask: (req) => (requests.push(req), inner(req)) };
}

describe("proposeFill with values the user told Caret", () => {
  it("fills Name and Email with no other window open, sourced to memory, and asks nothing about Phone", async () => {
    const m = new ScreenModel();
    form(m, ["Name", "Email", "Phone"]);
    const { ask, requests } = recording({ Name: "Sam Rivera", Email: "sam.rivera@example.com" });
    const p = FillProposal.parse(await proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] }));
    const by = Object.fromEntries(p.fields.map((f) => [f.key, f]));
    expect(by[key("Name")]).toMatchObject({ value: "Sam Rivera", source: null, memory: { id: NAME.id, label: "Name", says: ABOUT_SAYS }, withheld: null });
    expect(by[key("Email")]).toMatchObject({ value: "sam.rivera@example.com", source: null, memory: { id: EMAIL.id, label: "Email", says: ABOUT_SAYS } });
    expect(by[key("Phone")]).toMatchObject({ value: null, memory: null, withheld: null, asks: [] });
    // Each value is offered only in the question of the field that asks for it, and is declared as memory. Since
    // B24 the whose-details questions go first, in two requests of their own; then the two value requests.
    expect(requests).toHaveLength(4);
    expect(requests.slice(0, 2).map((r) => Object.keys(r.questions).sort())).toEqual([["f1_whose", "f2_whose"], ["f1_whose", "f2_whose"]]);
    for (const r of requests.slice(2)) {
      // A value question for each of Name and Email; none for Phone.
      expect(Object.keys(r.questions).sort()).toEqual(["f1", "f2"]);
      const crit = ["f1", "f2"].map((id) => Object.values(r.questions[id]?.criteria ?? {}).filter((c) => c?.includes("which the user told Caret")));
      expect(crit.map((c) => c.length)).toEqual([1, 1]);
      // Values and their labels both go into the question, so both are declared (review B17 #1).
      expect(r.snippets.filter((s) => s.windowId === "memory").map((s) => s.text).sort()).toEqual(["Email", "Name", "Sam Rivera", "sam.rivera@example.com"]);
    }
  });

  it("offers First name only the first name split from Name, and Guest email or Company name nothing (B24)", async () => {
    const m = new ScreenModel();
    form(m, ["First name", "Guest email", "Company name"]);
    const { ask, requests } = recording({ "First name": "Sam" });
    const p = await proposeFill(m, ask, FORM, key("First name"), 3000, { about: [NAME, EMAIL] });
    expect(p.fields.find((f) => f.key === key("First name"))).toMatchObject({ value: "Sam", memory: { id: NAME.id }, source: null });
    expect(p.fields.find((f) => f.key === key("Guest email"))?.value).toBeNull();
    expect(p.fields.find((f) => f.key === key("Company name"))?.value).toBeNull();
    for (const r of requests.filter((x) => x.questions.f1 !== undefined)) {
      const offered = (id: string) => Object.values(r.questions[id]?.criteria ?? {}).join(" ");
      expect(offered("f1")).toContain('"Sam" (the first name in "Sam Rivera"');
      expect(offered("f2")).not.toContain("sam.rivera@example.com");
      expect(offered("f3")).not.toContain("Sam");
    }
  });

  it("offers a window's copy of the same address as that window's candidate, not as memory", async () => {
    const m = new ScreenModel();
    const SRC = "6160-3";
    const mk = "dev.caret.mail/standard/statictext:sam~0";
    m.apply(snap([text(mk, "sam.rivera@example.com")], { at: 1000, windowId: SRC, title: "Thread", app: MAIL_APP, values: [value("email", "sam.rivera@example.com", mk)] }));
    form(m, ["Name", "Email"]);
    const { ask, requests } = recording({ Email: "sam.rivera@example.com", Name: "Sam Rivera" });
    const p = await proposeFill(m, ask, FORM, key("Email"), 3000, { about: [NAME, EMAIL] });
    const email = p.fields.find((f) => f.key === key("Email"));
    expect(email).toMatchObject({ value: "sam.rivera@example.com", memory: null, source: { windowId: SRC } });
    expect(p.fields.find((f) => f.key === key("Name"))).toMatchObject({ value: "Sam Rivera", memory: { id: NAME.id } });
    // G2: the window's copy is exactly the user's own email, so its description says so, quoting memory's label, which
    // is declared as memory.
    const asked = requests.find((r) => r.questions.f1 !== undefined);
    expect(asked?.snippets.filter((s) => s.windowId === "memory").map((s) => s.text)).toEqual(["Sam Rivera", "Name", "Email"]);
    expect(Object.values(asked?.questions ?? {}).some((q) => Object.values(q.criteria).some((d) => d?.startsWith(`"sam.rivera@example.com" (email; the user's own Email, which the user told Caret;`)))).toBe(true);
  });

  it("charges a window that shows a memory value inside a line, as sending the value reveals it", async () => {
    const m = new ScreenModel();
    m.apply(snap([text("dev.caret.mail/standard/statictext:sig~0", "Thanks, Sam Rivera")], { at: 1000, windowId: "6160-4", title: "Note", app: MAIL_APP }));
    form(m, ["Name", "Email"]);
    const { ask, requests } = recording({});
    await proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME] });
    expect(requests[0]?.charged["6160-4"]).toBeGreaterThanOrEqual("Sam Rivera".length);
  });

  it("refuses an answer that picks a memory value for a field it was not offered to", async () => {
    const m = new ScreenModel();
    form(m, ["Name", "Email"]);
    // Answers every question with the first memory id it has seen anywhere in the request.
    const ask: AskJev = async (req) => {
      const ids = Object.values(req.questions).flatMap((q) => Object.keys(q.criteria).filter((k) => /^[mn]\d+$/.test(k)));
      return { model: "jev-test", answers: Object.fromEntries(Object.keys(req.questions).map((id) => [id, { choice: ids[0] ?? "none", confidence: 0.9 }])), inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    await expect(proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] })).rejects.toThrow(/not a candidate id for f/);
  });

  it("makes a pop-up from memory alone, sourced 'what you told Caret', which a forgotten entry makes stale", async () => {
    const m = new ScreenModel();
    form(m, ["Name", "Email"]);
    const { ask } = recording({ Name: "Sam Rivera", Email: "sam.rivera@example.com" });
    const proposal = await proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] });
    expect(fillPopupEligible(proposal)).toBe(true);
    const p = writtenFields(proposal);
    const popup = buildFillPopup(m, p);
    const source = popup.spec.blocks.find((b) => b.type === "source");
    expect(source).toEqual({ type: "source", value: { text: ABOUT_SAYS, ref: { rule: "sources", derived: [{ memory: NAME.id }, { memory: EMAIL.id }] } } });
    const fields = popup.spec.blocks.find((b) => b.type === "fields");
    expect(fields?.type === "fields" ? fields.rows.map((r) => r.value) : null).toEqual([
      { text: "Sam Rivera", ref: { memory: NAME.id } },
      { text: "sam.rivera@example.com", ref: { memory: EMAIL.id } },
    ]);
    expect(popup.sourceApps).toBeUndefined();
    const held = new Map<string, AboutValue>([[NAME.id, NAME], [EMAIL.id, EMAIL]]);
    expect(recheckFill(m, p, (id) => held.get(id) ?? null)).toBeNull();
    // Renamed with the same value: the label decided where it was offered, so the offer ends.
    held.set(NAME.id, { ...NAME, label: "Organization" });
    expect(recheckFill(m, p, (id) => held.get(id) ?? null)).toBe("what you told Caret as Name changed");
    held.set(NAME.id, NAME);
    held.delete(EMAIL.id);
    expect(recheckFill(m, p, (id) => held.get(id) ?? null)).toBe("what you told Caret as Email changed");
    // Each write from memory names its entry, for the executor's check right before it writes.
    expect(fillPlan(m, p).plan.steps.map((s) => s.memory)).toEqual([NAME.id, EMAIL.id]);
  });
});

// B18: a value from memory needs both asks to say the field wants the user's own details (fill.ts WHOSE_CUTOFF),
// and its value pick is held to MEMORY_CUTOFF, not FILL_CUTOFF. A window's value is judged as before.
describe("whose details a field offered a value from memory wants", () => {
  /** Answers like `recording`, then sets the value answers' and the whose answers' confidences apart, per ask. */
  function answering(byLabel: Record<string, string>, o: { value: number; whose: number; who?: [Whose, Whose] | Whose; owner?: Whose }): { ask: AskJev; requests: JevRequest[] } {
    const requests: JevRequest[] = [];
    let n = 0;
    const ask: AskJev = async (req) => {
      requests.push(req);
      const k = n++;
      const who = Array.isArray(o.who) ? o.who[k % 2] : (o.who ?? "user");
      const r = await jevPickingText((_, ins) => byLabel[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null, 0.9, () => who as Whose, () => o.owner ?? "user")(req);
      for (const [id, a] of Object.entries(r.answers)) a.confidence = id.endsWith("_whose") ? o.whose : o.value;
      return r;
    };
    return { ask, requests };
  }
  const fill = async (ask: AskJev, opts: { whose?: boolean } = {}) => {
    const m = new ScreenModel();
    form(m, ["Name", "Email"]);
    const p = await proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL], ...opts });
    return p.fields.find((f) => f.key === key("Name"));
  };
  const SAM = { Name: "Sam Rivera" };

  it("fills from memory under the window cutoff when both asks say the user's", async () => {
    expect(MEMORY_CUTOFF).toBeLessThan(FILL_CUTOFF);
    const f = await fill(answering(SAM, { value: 0.55, whose: 0.6 }).ask);
    expect(f).toMatchObject({ value: "Sam Rivera", memory: { id: NAME.id }, withheld: null, confidence: 0.55 });
  });

  it("withholds a value from memory when the field wants someone else's details, however sure the pick", async () => {
    const f = await fill(answering(SAM, { value: 0.95, whose: 0.95, who: "other" }).ask);
    expect(f).toMatchObject({ value: null, memory: null, withheld: "lowConfidence", choice: "none" });
    expect(f?.asks.map((a) => a.value)).toEqual(["Sam Rivera", "Sam Rivera"]);
  });

  it("withholds when whose is unclear, when the asks disagree on it, or when 'the user's' is under the whose cutoff", async () => {
    expect((await fill(answering(SAM, { value: 0.9, whose: 0.9, who: "unclear" }).ask))?.withheld).toBe("lowConfidence");
    expect((await fill(answering(SAM, { value: 0.9, whose: 0.9, who: ["user", "unclear"] }).ask))?.withheld).toBe("lowConfidence");
    expect((await fill(answering(SAM, { value: 0.9, whose: WHOSE_CUTOFF - 0.01 }).ask))?.withheld).toBe("lowConfidence");
    expect((await fill(answering(SAM, { value: 0.9, whose: WHOSE_CUTOFF }).ask))?.value).toBe("Sam Rivera");
  });

  it("holds the value pick to the memory cutoff", async () => {
    expect((await fill(answering(SAM, { value: MEMORY_CUTOFF - 0.01, whose: 0.99 }).ask))?.withheld).toBe("lowConfidence");
    expect((await fill(answering(SAM, { value: MEMORY_CUTOFF, whose: 0.99 }).ask))?.value).toBe("Sam Rivera");
  });

  it("asks whose beside fields offered a value from memory and fields that take a person's details, in both wordings", async () => {
    const m = new ScreenModel();
    form(m, ["Name", "Phone", "Guest name"]);
    m.apply(snap([text("dev.caret.mail/standard/statictext:p~0", "+1 (415) 555-0199")], { at: 1000, windowId: "6160-5", title: "Note", app: MAIL_APP, values: [value("phone", "+1 (415) 555-0199", "dev.caret.mail/standard/statictext:p~0")] }));
    const { ask, requests } = answering(SAM, { value: 0.9, whose: 0.9 });
    await proposeFill(m, ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] });
    // B24: the whose-details questions go first, in two requests of their own.
    expect(requests).toHaveLength(4);
    const whoseAsks = requests.filter((r) => r.questions.f1_whose !== undefined);
    expect(whoseAsks).toHaveLength(2);
    for (const r of whoseAsks) {
      // B24: Phone and Guest name take a person's details too, for the owner veto (fill.ts otherPerson).
      expect(Object.keys(r.questions).filter((id) => id.endsWith("_whose"))).toEqual(["f1_whose", "f2_whose", "f3_whose"]);
      expect(Object.keys(r.questions.f1_whose?.criteria ?? {})).toEqual(["user", "other", "unclear"]);
      expect(String(r.questions.f1_whose?.instructions)).toContain("Label: 'Name'");
    }
    expect(whoseAsks[0]?.questions.f1_whose?.instructions).not.toEqual(whoseAsks[1]?.questions.f1_whose?.instructions);
  });

  it("refuses a reply that leaves a whose question unanswered", async () => {
    const inner = answering(SAM, { value: 0.9, whose: 0.9 }).ask;
    const ask: AskJev = async (req) => {
      const r = await inner(req);
      delete r.answers.f1_whose;
      return r;
    };
    await expect(fill(ask)).rejects.toThrow(/no answer about whose details f1/);
  });

  it("judges a window's value as before: no memory whose gate, FILL_CUTOFF; B24's owner veto only when the two whose answers conflict", async () => {
    const m = new ScreenModel();
    const mk = "dev.caret.mail/standard/statictext:dana~0";
    m.apply(snap([text(mk, "Dana Whitfield")], { at: 1000, windowId: "6160-6", title: "Contact", app: MAIL_APP }));
    form(m, ["Name", "Email"]);
    const p = await proposeFill(m, answering({ Name: "Dana Whitfield" }, { value: 0.8, whose: 0.95, who: "other", owner: "other" }).ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] });
    expect(p.fields.find((f) => f.key === key("Name"))).toMatchObject({ value: "Dana Whitfield", memory: null, source: { windowId: "6160-6" } });
    const vetoed = await proposeFill(m, answering({ Name: "Dana Whitfield" }, { value: 0.8, whose: 0.95, who: "other", owner: "user" }).ask, FORM, key("Name"), 3000, { about: [NAME, EMAIL] });
    // Both stage-one asks put the field on someone else and the value on the user, so the value stage never offers it.
    expect(vetoed.fields.find((f) => f.key === key("Name"))).toMatchObject({ value: null });
  });

  it("with whose off (the eval's other option), asks no whose question and holds memory to FILL_CUTOFF", async () => {
    const { ask, requests } = answering(SAM, { value: FILL_CUTOFF - 0.01, whose: 0.99 });
    expect((await fill(ask, { whose: false }))?.withheld).toBe("lowConfidence");
    expect(requests.flatMap((r) => Object.keys(r.questions)).filter((id) => id.endsWith("_whose"))).toEqual([]);
    expect((await fill(answering(SAM, { value: FILL_CUTOFF, whose: 0.99 }).ask, { whose: false }))?.value).toBe("Sam Rivera");
  });

  // B27: a part of the user's Name (fill.ts derived, base memory) passes the same two gates as the whole Name. B26's
  // "wrong" m21 fills were "Sam" and "Rivera" under "Your details", both whose asks saying the user's at 0.77 to 0.92.
  describe("a part of the user's Name from memory", () => {
    /** Sections of fields, as the reader sends a form: each section a labelled group, the first field focused. */
    const sectioned = (m: ScreenModel, sections: readonly [string, readonly string[]][]): string[] => {
      const nodes = [];
      const keys: string[] = [];
      let i = 0;
      for (const [section, labels] of sections) {
        const g = F(`group:${section.toLowerCase()}~0`);
        nodes.push({ key: g, parent: null, role: "AXGroup", label: section });
        for (const l of labels) {
          const k = `${g}/textfield:f${i}~0`;
          keys.push(k);
          nodes.push(field(k, "", { parent: g, label: l, frame: [100, 40 + 40 * i++, 200, 24] }));
        }
      }
      m.apply(snap(nodes, { at: 2000, windowId: FORM, title: "Booking", focused: true, focusedKey: keys[0] as string }));
      return keys;
    };
    const PARTS = { "First name": "Sam", "Last name": "Rivera" };
    const parts = async (ask: AskJev) => {
      const m = new ScreenModel();
      const [first, last] = sectioned(m, [["Your details", ["First name", "Last name"]]]);
      const p = await proposeFill(m, ask, FORM, first as string, 3000, { about: [NAME, EMAIL] });
      return [first, last].map((k) => p.fields.find((f) => f.key === k));
    };

    it("fills First name and Last name with the user's parts when both asks say the user's at the whose cutoff", async () => {
      const [first, last] = await parts(answering(PARTS, { value: MEMORY_CUTOFF, whose: WHOSE_CUTOFF }).ask);
      expect(first).toMatchObject({ value: "Sam", source: null, memory: { id: NAME.id, part: "first", says: ABOUT_SAYS }, withheld: null });
      expect(last).toMatchObject({ value: "Rivera", source: null, memory: { id: NAME.id, part: "last", says: ABOUT_SAYS }, withheld: null });
    });

    it.each<[string, { value: number; whose: number; who?: [Whose, Whose] | Whose }]>([
      ["someone else's", { value: 0.95, whose: 0.95, who: "other" }],
      ["unclear", { value: 0.95, whose: 0.95, who: "unclear" }],
      ["split between the asks", { value: 0.95, whose: 0.95, who: ["user", "other"] }],
      ["the user's under the whose cutoff", { value: 0.95, whose: WHOSE_CUTOFF - 0.01 }],
      ["the user's, the pick under the memory cutoff", { value: MEMORY_CUTOFF - 0.01, whose: 0.99 }],
    ])("withholds the parts when whose is %s", async (_, o) => {
      for (const f of await parts(answering(PARTS, o).ask)) {
        expect(f).toMatchObject({ value: null, memory: null, withheld: "lowConfidence", choice: "none" });
        // Both asks did agree on the user's part: only the gates kept it out.
        expect(f?.asks.map((a) => a.value)).toEqual(f?.key.includes("f0") ? ["Sam", "Sam"] : ["Rivera", "Rivera"]);
      }
    });

    it("fills the user's section and leaves an emergency contact's identical labels blank, however sure the picks", async () => {
      const m = new ScreenModel();
      const keys = sectioned(m, [
        ["Your details", ["First name", "Last name"]],
        ["Emergency contact", ["First name", "Last name"]],
      ]);
      const ask = jevPickingText((_, ins) => PARTS[/Label: '([^']+)'/.exec(ins)?.[1] as keyof typeof PARTS] ?? null, 0.95, (ins) => (ins.includes("Emergency contact") ? "other" : "user"));
      const p = await proposeFill(m, ask, FORM, keys[0] as string, 3000, { about: [NAME, EMAIL] });
      expect(keys.map((k) => p.fields.find((f) => f.key === k)?.value ?? null)).toEqual(["Sam", "Rivera", null, null]);
      expect(keys.slice(2).map((k) => p.fields.find((f) => f.key === k)?.withheld)).toEqual(["lowConfidence", "lowConfidence"]);
    });
  });
});

// Acceptance (B17 brief, 2): over the real socket, the host adds a name and an email, a fresh form's Name
// and Email fields get offers sourced "what you told Caret", and Forget removes them.
describe("typed name and email over the socket, as the host sends them", () => {
  let dir: string;
  let store: Store;
  let server: HelperServer;
  let helper: Helper;
  let host: LineClient;
  let reader: SocketReader;
  const hooks = { applied: (w: string, at: number) => helper.model.windows.get(w)?.updatedAt === at, tick: (at: number) => helper.tick(at) };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "caret-about-"));
    store = new Store(join(dir, "data"));
    let n = 0;
    const own: HelperServer = new HelperServer(join(dir, "screen.sock"), () => mine, () => {});
    const mine: Helper = new Helper({
      store,
      // Answers like a careful Jev would for these labels: the user's own value, if offered.
      askJev: jevPickingText((_, ins) => ({ Name: "Sam Rivera", Email: "sam.rivera@example.com" })[/Label: '([^']+)'/.exec(ins)?.[1] ?? ""] ?? null),
      shadow: false,
      allowBackgroundFocus: false,
      newId: () => `id-${++n}`,
      publish: (m) => own.publish(m),
      sendToReader: (cmd) => own.sendToReader(cmd),
    });
    helper = mine;
    server = own;
    await server.listen();
    host = await LineClient.connect(join(dir, "screen.sock"));
    host.send({ type: "hello", v: PROTOCOL_VERSION, role: "consumer", mode: "live", pid: 1, version: "host-test" });
    reader = await SocketReader.connect(join(dir, "screen.sock"));
    reader.enforceGrants = true;
  });

  afterEach(async () => {
    host.close();
    reader.close();
    helper.shutdown();
    await server.close();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const memory = async (requestId: string, body: Record<string, unknown>): Promise<{ error: string | null; entries: MemoryEntry[] }> => {
    host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId, ...body });
    return (await host.waitFor((m) => m.type === "memoryReply" && m.requestId === requestId)) as unknown as { error: string | null; entries: MemoryEntry[] };
  };
  /** A fresh form in its own window, focused on its first field. */
  const openForm = async (windowId: string, labels: readonly string[], at: number): Promise<void> => {
    const nodes = labels.map((l, i) => field(F(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * i, 200, 24] }));
    await reader.replay([snap(nodes, { at, windowId, title: "Sign up", focused: true, focusedKey: key(labels[0] as string) }), focus(windowId, key(labels[0] as string), at + 10)], hooks);
  };

  it("adds a name and an email, offers them on a fresh form as 'what you told Caret', fills them on accept, and Forget removes them", async () => {
    const name = await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    const email = await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    expect([name.error, email.error]).toEqual([null, null]);
    const nameId = name.entries[0]?.id as string;
    const emailId = email.entries[0]?.id as string;

    // A Name and Email form: every field grounded, so one pop-up.
    await openForm("5150-11", ["Name", "Email"], 3000);
    const popup = (await host.waitFor((m) => m.type === "popup")) as unknown as OfferPopup;
    expect(popup.spec.blocks.find((b) => b.type === "source")).toMatchObject({ value: { text: "what you told Caret" } });
    const rows = popup.spec.blocks.find((b) => b.type === "fields");
    expect(rows?.type === "fields" ? rows.rows.map((r) => [r.destination.text, r.value?.text, r.value?.ref]) : null).toEqual([
      ["Name", "Sam Rivera", { memory: nameId }],
      ["Email", "sam.rivera@example.com", { memory: emailId }],
    ]);
    host.send({ type: "offerAccept", v: PROTOCOL_VERSION, offerId: popup.offerKey, actionId: "fillAll", overrides: {}, at: 1 });
    await host.waitFor((m) => m.type === "taskProgress" && m.taskId === popup.offerKey && m.phase === "done");
    expect([reader.value("5150-11", key("Name")), reader.value("5150-11", key("Email"))]).toEqual(["Sam Rivera", "sam.rivera@example.com"]);

    // The filled form now shows both values, and a window's copy is offered as that window's; close it.
    reader.send({ type: "windowClosed", v: PROTOCOL_VERSION, at: 8000, windowId: "5150-11" });
    await until(() => !helper.model.windows.has("5150-11"));
    // A form with a field memory cannot fill: per-field offers, Name and Email from memory.
    await openForm("5150-12", ["Name", "Email", "Phone"], 9000);
    const proposal = FillProposal.parse(await host.waitFor((m) => m.type === "fillProposal" && m.windowId === "5150-12"));
    expect(proposal.fields.map((f) => [f.key, f.value, f.memory?.says ?? null])).toEqual([
      [key("Name"), "Sam Rivera", "what you told Caret"],
      [key("Email"), "sam.rivera@example.com", "what you told Caret"],
      [key("Phone"), null, null],
    ]);

    // Forget both: a fresh form gets nothing from memory, so nothing is offered at all.
    expect((await memory("forget-name", { op: "forget", id: nameId })).error).toBeNull();
    expect((await memory("forget-email", { op: "forget", id: emailId })).error).toBeNull();
    const before = host.received.length;
    await openForm("5150-13", ["Name", "Email"], 20_000);
    // The fill ran and found nothing to offer: no window shows a value, and memory holds none. The host reads a
    // sentence with no window id (B27); the check's own text goes to the log.
    const said = await host.waitFor<{ message: string }>((m) => m.type === "error");
    expect(said.message).toBe(SAYS.fillNothing);
    expect(said.message).not.toContain("5150-13");
    const after = host.received.slice(before).map((m) => (m as { type: string }).type);
    expect(after.filter((t) => t === "popup" || t === "fillProposal")).toEqual([]);
  });

  it("withdraws a first look's fill offer when an entry it shows is paused, and refuses a write from memory once it is gone", async () => {
    const name = await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    // The form arrives without focus, so only the first look offers it.
    const nodes = ["Name", "Email"].map((l, i) => field(F(`textfield:${l.toLowerCase()}~0`), "", { label: l, frame: [100, 40 + 40 * i, 200, 24] }));
    await reader.replay([snap(nodes, { at: 3000, windowId: "5150-31", title: "Sign up" })], hooks);
    const look = await helper.handleFirstLook({ type: "firstLook", v: PROTOCOL_VERSION, requestId: "look", at: 3100, families: ["fill"], level: "eager", deadlineMs: 4000 });
    expect(look.found?.family).toBe("fill");
    const key = look.found?.offerKey as string;
    await memory("pause-name", { op: "pause", id: name.entries[0]?.id });
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === key)).toMatchObject({ reason: "stale" });
  });

  it("offers a name and email added while a form is focused within 1 s, inside the form's repeat window and with no new focus (B21)", async () => {
    // Another window shows a value, so the form's first ask, before Caret knows the user, runs and answers none.
    await reader.replay([snap([text(F("statictext:order ord-#-#~0"), "Order ORD-2026-48213")], { at: 1000, windowId: "5150-40", title: "Order" })], hooks);
    await openForm("5150-41", ["Name", "Email"], 2000);
    const first = FillProposal.parse(await host.waitFor((m) => m.type === "fillProposal" && m.windowId === "5150-41"));
    expect(first.fields.map((f) => f.value)).toEqual([null, null]);
    const sentByReader = reader.client.sent;
    const before = host.received.length;
    // Onboarding's Continue sends both adds at once; the second arrives while the first one's ask is still out.
    host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "add-name", op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    host.send({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: "add-email", op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    await host.waitFor((m) => m.type === "memoryReply" && m.requestId === "add-email");
    const t0 = performance.now();
    const popup = (await host.waitFor((m) => m.type === "popup" && (m as unknown as OfferPopup).field.windowId === "5150-41", 1000)) as unknown as OfferPopup;
    expect(performance.now() - t0).toBeLessThan(1000);
    const rows = popup.spec.blocks.find((b) => b.type === "fields");
    expect(rows?.type === "fields" ? rows.rows.map((r) => [r.destination.text, r.value?.text]) : null).toEqual([
      ["Name", "Sam Rivera"],
      ["Email", "sam.rivera@example.com"],
    ]);
    // Nothing came from the reader in between: no focus, no walk.
    expect(reader.client.sent).toBe(sentByReader);
    expect(host.received.slice(before).some((m) => (m as { type: string }).type === "error")).toBe(false);
  });

  it("re-proposes for the frontmost app's form after a background app's request walk moved the model's focused window (B21 review)", async () => {
    await reader.replay([snap([text(F("statictext:order ord-#-#~0"), "Order ORD-2026-48213")], { at: 1000, windowId: "5150-60", title: "Order" })], hooks);
    await openForm("5150-61", ["Name", "Email"], 2000);
    await host.waitFor((m) => m.type === "fillProposal" && m.windowId === "5150-61");
    // A request walk of a background app's window arrives marked focused, as the reader's walks for the executor do.
    await reader.replay([snap([field("dev.caret.mail/standard/textfield:to~0", "", { label: "To" })], { at: 2500, windowId: "6160-1", title: "Compose", app: MAIL_APP, focused: true, focusedKey: "dev.caret.mail/standard/textfield:to~0", reason: "request" })], hooks);
    expect(helper.model.focusedWindowId).toBe("6160-1");
    await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    const p = FillProposal.parse(await host.waitFor((m) => m.type === "fillProposal" && m.windowId === "5150-61" && (m.fields as { value: unknown }[]).some((f) => f.value !== null), 1000));
    expect(p.fields.find((f) => f.key === key("Name"))?.value).toBe("Sam Rivera");
    expect(host.received.some((m) => (m as { windowId?: string }).windowId === "6160-1" && (m as { type: string }).type === "fillProposal")).toBe(false);
  });

  it("does not ask again inside the repeat window when the added entry fits no field of the focused form (B21)", async () => {
    await reader.replay([snap([text(F("statictext:order ord-#-#~0"), "Order ORD-2026-48213")], { at: 1000, windowId: "5150-50", title: "Order" })], hooks);
    await openForm("5150-51", ["Phone", "Company"], 2000);
    await host.waitFor((m) => m.type === "fillProposal" && m.windowId === "5150-51");
    const before = host.received.length;
    await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    await new Promise((r) => setTimeout(r, 300));
    const later = host.received.slice(before).map((m) => (m as { type: string }).type);
    expect(later).toEqual(["memoryReply"]);
  });

  it("withdraws an open pop-up when the entry it offers is forgotten", async () => {
    const name = await memory("add-name", { op: "add", kind: "about", fields: { label: "Name", value: "Sam Rivera", source: "typed" } });
    await memory("add-email", { op: "add", kind: "about", fields: { label: "Email", value: "sam.rivera@example.com", source: "typed" } });
    await openForm("5150-21", ["Name", "Email"], 3000);
    const popup = (await host.waitFor((m) => m.type === "popup")) as unknown as OfferPopup;
    await memory("forget-name", { op: "forget", id: name.entries[0]?.id });
    expect(await host.waitFor((m) => m.type === "offerWithdrawn" && m.id === popup.offerKey)).toMatchObject({ reason: "stale" });
  });
});
