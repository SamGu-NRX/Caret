// What a fill offers is admitted once, where it is collected: a candidate goes in with every fact it is described by,
// at the ranges they were read from, or it is cut and the cut rules withhold its kind. Building the requests afterwards
// never shrinks that set. And the wording reserved before any value is admitted is the wording that will be sent.
// Every name and value is invented.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill, type FillScope } from "../src/fill/fill.ts";
import { sealRequest, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import type { Node } from "../src/protocol.ts";
import { field, node, snap, text } from "./builders.ts";

const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const FORM_APP = { pid: 5150, bundleId: "dev.caret.fixture", name: "Fixture" };
const FORM = "5150-7";
const key = (label: string): string => `dev.caret.fixture/standard/textfield:${label.toLowerCase().replace(/ /g, "-")}~0`;

/** A chat, then a form with `labels`, focused on the first. */
function desk(chat: Node[], labels: string[], title = "K"): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap(chat, { at: 1000, windowId: "chat-1", title, app: MESSAGES }));
  m.apply(snap(labels.map((l, i) => field(key(l), "", { label: l, frame: [100, 40 + i * 40, 300, 24] })), { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
  return m;
}

/** Picks, for each field's question, the offered value its label's entry names (by the description's start), else none. */
function picking(want: Record<string, string>, seen: JevRequest[] = []): AskJev {
  return async (req) => {
    seen.push(req);
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      // Whose details a field wants, and whose a value is: the user's.
      if (id.endsWith("_whose") || id.endsWith("_owner")) {
        answers[id] = { choice: "user", confidence: 0.95 };
        continue;
      }
      const label = Object.keys(want).find((l) => String(q.instructions).includes(`'${l}'`));
      const hit = label === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want[label]}"`))?.[0];
      answers[id] = { choice: hit ?? "none", confidence: 0.95 };
    }
    return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  };
}

/** The values a request's question for `label` offers, by their description's quoted text. */
const offered = (req: JevRequest, label: string): string[] =>
  Object.values(req.questions).filter((q) => String(q.instructions).includes(`'${label}'`)).flatMap((q) => Object.values(q.criteria).flatMap((d) => /^"([^"]*)"/.exec(String(d))?.[1] ?? []));

describe("a fill's candidates, admitted once with their facts", () => {
  it("cuts a value whose facts do not fit, so a field is not handed the other one as if it were the only one", async () => {
    // T = 1 + 9 + 9 + 11 = 30, limit 14. AB01 with its label and the title is 8; AB02 and its own label 7 more.
    const m = desk([text("c0", "Ref: AB01"), text("c1", "Ref: AB02"), { key: "c2", parent: null, role: "AXButton", label: "ZZZZZZZZZZZ" }], ["Reference"]);
    const seen: JevRequest[] = [];
    const p = await proposeFill(m, picking({ Reference: "AB01" }, seen), FORM, key("Reference"), 3000);
    const f = p.fields.find((x) => x.key === key("Reference"))!;
    // AB02 did not fit: the window is cut, and a pick under the label the cut value shares is withheld, not filled.
    expect(seen.flatMap((r) => offered(r, "Reference"))).not.toContain("AB02");
    expect(f.value, "AB01 is not the only value the chat shows").toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("reserves only the wording the requests will carry: a chat line 'country' does not cost AB01 its description", async () => {
    // T = 1 + 9 + 7 = 17, limit 8: AB01, its label and the title take 8. The derived-values sentence names "country",
    // and no value here is derived, so it is not sent and not reserved.
    const m = desk([text("c0", "Ref: AB01"), text("c1", "country")], ["Reference"]);
    const p = await proposeFill(m, picking({ Reference: "AB01" }), FORM, key("Reference"), 3000);
    expect(p.fields.find((x) => x.key === key("Reference"))?.value).toBe("AB01");
  });

  it("derives a part from its base where the base was read: 'Austin' from an address on a long chat line", async () => {
    const line = `Address: 123 Main St, Austin, TX 78701 ${"Z".repeat(80)}`;
    // T = 4 + 120 = 124, limit 61: the address at its range, its label and the title fit; the whole line does not.
    const m = new ScreenModel();
    m.apply(snap([text("c0", line)], { at: 1000, windowId: "chat-1", title: "Kofi", app: MESSAGES, values: [{ kind: "address", text: "123 Main St, Austin, TX 78701", nodeKey: "c0" }] }));
    m.apply(snap([field(key("City"), "", { label: "City", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    // No whose questions: a conversation's value is never owner-judged (HA2 rule c), which is not what this case is about.
    const p = await proposeFill(m, picking({ City: "Austin" }), FORM, key("City"), 3000, { whose: false });
    expect(p.fields.find((x) => x.key === key("City"))?.value).toBe("Austin");
  });
});

const NOTES = { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" };

describe("Sol's round 4: collection order, associations, one membership, kept ranges", () => {
  it("reads the windows by recency: a note's eighty dates do not crowd out the date of the chat the user just left", async () => {
    const m = new ScreenModel();
    const day = (i: number): string => new Date(Date.UTC(2026, 0, 1 + i)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    m.apply(snap(Array.from({ length: 80 }, (_, i) => text(`n${i}`, day(i))), { at: 500, windowId: "note-1", title: "Orders", app: NOTES }));
    m.apply(snap([text("c0", "Date: 2026-10-08"), text("c1", "see you at the venue tomorrow morning")], { at: 1000, windowId: "chat-1", title: "K", app: MESSAGES, focused: true }));
    m.apply(snap([field(key("Date"), "", { label: "Date", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const seen: JevRequest[] = [];
    // A Jev that takes the note's first date whenever it is offered.
    const p = await proposeFill(m, picking({ Date: "Jan 1, 2026" }, seen), FORM, key("Date"), 3000);
    const f = p.fields.find((x) => x.key === key("Date"))!;
    // The chat is read first, so its date is offered; the note's dates then reach the generator's cap partway, the date
    // kind is cut, and the field is withheld rather than filled with a date that was not the only one.
    expect(seen.flatMap((r) => offered(r, "Date")).concat(f.withheld === "sourceCut" ? ["2026-10-08"] : [])).toContain("2026-10-08");
    expect(f.value, "never the note's first date as if the chat's were not there").not.toBe("Jan 1, 2026");
  });

  it("keeps a chat's 'Ref' association whose text a newer note offered: AB01 is not the only Ref value", async () => {
    const m = new ScreenModel();
    m.apply(snap([text("c0", "Ref: AB01"), text("c1", "Ref: AB02")], { at: 1000, windowId: "chat-1", title: "K", app: MESSAGES }));
    m.apply(snap([text("n0", "Other: AB02")], { at: 1500, windowId: "note-1", title: "N", app: NOTES }));
    m.apply(snap([field(key("Reference"), "", { label: "Reference", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const p = await proposeFill(m, picking({ Reference: "AB01" }), FORM, key("Reference"), 3000);
    const f = p.fields.find((x) => x.key === key("Reference"))!;
    expect(f.value, "the chat's other Ref value was offered only as the note's 'Other'").toBeNull();
    expect(f.withheld).toBe("sourceCut");
  });

  it("omits at collection a name its line does not spell, rather than failing the fill when the request is built", async () => {
    const m = desk([text("c0", "From: Dana (Whitfield) <dana@example.com>"), text("c1", "see you then")], ["Full name"]);
    const p = await proposeFill(m, picking({ "Full name": "Dana Whitfield" }), FORM, key("Full name"), 3000);
    expect(p.fields.find((x) => x.key === key("Full name"))?.value).not.toBe("Dana Whitfield");
  });

  it("keeps a value's ranges across an identical refresh of its window during the fill: 'Austin' is still verified", async () => {
    const line = `Address: 123 Main St, Austin, TX 78701 ${"Z".repeat(80)}`;
    const m = new ScreenModel();
    const chat = (at: number): void => void m.apply(snap([text("c0", line)], { at, windowId: "chat-1", title: "Kofi", app: MESSAGES, values: [{ kind: "address", text: "123 Main St, Austin, TX 78701", nodeKey: "c0" }] }));
    chat(1000);
    m.apply(snap([field(key("City"), "", { label: "City", frame: [100, 40, 300, 24] })], { at: 2000, windowId: FORM, title: "Form", app: FORM_APP, focused: true }));
    const pick = picking({ City: "Austin" });
    let refreshed = false;
    const ask: AskJev = async (req) => {
      if (!refreshed) {
        refreshed = true;
        chat(2500);
      }
      return pick(req);
    };
    const p = await proposeFill(m, ask, FORM, key("City"), 3000, { whose: false });
    expect(p.fields.find((x) => x.key === key("City"))?.value).toBe("Austin");
  });

  it("does not count a Backup 'Ref' cut against a Primary 'Ref': they are other associations", async () => {
    // T = 1 + 7 + 9 + 6 + 9 + 11 = 43, limit 21: AB01 with its label, section and the title is 15; AB02's 13 more do not fit.
    const m = desk(
      [node("g0", "AXGroup", { label: "Primary" }), text("c0", "Ref: AB01", undefined, "g0"), node("g1", "AXGroup", { label: "Backup" }), text("c1", "Ref: AB02", undefined, "g1"), { key: "c2", parent: null, role: "AXButton", label: "ZZZZZZZZZZZ" }],
      ["Reference"],
    );
    const p = await proposeFill(m, picking({ Reference: "AB01" }), FORM, key("Reference"), 3000);
    expect(p.fields.find((x) => x.key === key("Reference"))?.value).toBe("AB01");
  });
});

describe("value settlement's wording, reserved when settlement decides to ask", () => {
  it("does not lose the settlement request at seal to a chat line its task sentence holds: 'evidence'", async () => {
    // T = 1 + 9 + 8 = 18, limit 8: AB01, its label and the title take 8. VALUE_TASK holds "evidence", the chat's other line.
    const m = desk([text("c0", "Ref: AB01"), text("c1", "evidence")], ["Reference"]);
    const scope: FillScope = { fields: [key("Reference")], windows: null, memory: false, instruction: "put the ref in", person: null, literals: new Map() };
    // The base question's two wordings disagree (AB01 against none), so the field goes on to value settlement.
    const seen: JevRequest[] = [];
    // Each request is sealed as the Jev client seals it (jev.ts sealRequest), so the seal's measure applies.
    const ask: AskJev = async (req) => {
      sealRequest(req);
      seen.push(req);
      const answers: Record<string, { choice: string; confidence: number }> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        const hit = Object.entries(q.criteria).find(([, d]) => d?.startsWith('"AB01"') || d?.startsWith('Proposed value: "AB01"'))?.[0];
        const second = String(q.instructions).startsWith("Instruction from the user:");
        answers[id] = { choice: second ? "none" : (hit ?? "none"), confidence: 0.95 };
      }
      return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
    };
    const p = await proposeFill(m, ask, FORM, key("Reference"), 3000, { scope, whose: false });
    expect(seen.filter((r) => r.purpose === "fill.values").length, "the base question's two wordings were asked").toBeGreaterThanOrEqual(2);
    expect(p.jev.model, "settlement was not refused at seal").not.toMatch(/value settlement unavailable/u);
    // Settlement's wording does not fit beside AB01 in the chat, so it is not asked: the field stays as the base left it.
    expect(seen.filter((r) => r.purpose === "fill.values").length, "no settlement request").toBe(2);
    expect(p.fields.find((x) => x.key === key("Reference"))?.withheld).toBe("disagree");
  });
});
