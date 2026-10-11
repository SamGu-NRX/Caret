// The HA2 merge cases (~/.caret-run/evidence/screen/ha2/MERGE-CASES.md), over every request of one fill on focus: a
// conversation's limit holds whichever window its text is read from, and what is charged is what is sent. Each request
// goes through the client's seal (fill/jev.ts sealRequest), so its charge is the seal's and the fill's requests are one
// operation (OUTPUT-LEDGER-SPEC section 7). Every name, number and line is invented here.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { heldReason, NOTE_UNSHOWN, proposeFill } from "../src/fill/fill.ts";
import { setTestVerifier } from "../src/fill/contract.ts";
import { sealRequest, wireBody, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { windowBudget } from "../src/privacy.ts";
import { viewInventory } from "../src/privacy/ledger/account.ts";
import { redactWindow } from "../src/fill/redact.ts";
import type { WindowState } from "../src/model.ts";
import { STAND_IN } from "./setup/verifier.ts";
import { refReveal, refUnits } from "./ledger-reference.ts";
import { field, snap, text } from "./builders.ts";

const T0 = 1_000_000;
const PHONE = "555-0412";
const EMAIL = "odile.f@example.com";
const SLACK = { pid: 8300, bundleId: "com.tinyspeck.slackmacgap", name: "Slack" };
const TEXTEDIT = (pid: number) => ({ pid, bundleId: "com.apple.TextEdit", name: "TextEdit" });

/** Chat lines of about `width` characters, distinct, with no value of any kind in them. */
function chatLines(n: number, width: number): string[] {
  const words = ["harbor", "lantern", "meadow", "copper", "willow", "granite", "ember", "thistle", "saffron", "juniper", "cobalt", "orchard"];
  return Array.from({ length: n }, (_, i) => {
    let l = `message ${i + 1}:`;
    for (let k = 0; l.length < width; k++) l += ` ${words[(i * 5 + k * 7) % words.length]}`;
    return l.slice(0, width).trimEnd();
  });
}

/** Chat lines whose characters, with the title, total exactly `total`. */
function chatOf(title: string, n: number, total: number): string[] {
  const lines = chatLines(n, Math.floor((total - title.length) / n));
  const short = total - title.length - lines.reduce((s, l) => s + l.length, 0);
  lines[lines.length - 1] += "x".repeat(short);
  return lines;
}

const inventoryOfView = (w: WindowState): readonly string[] => viewInventory(redactWindow(w)).lines;

/** A Jev that picks the phone (and the email), says every value is the user's, and every value check exact. */
function jev(): AskJev & { reqs: JevRequest[] } {
  const reqs: JevRequest[] = [];
  const f = async (req: JevRequest) => {
    // As the client does: sealed before it is sent, so a refusal here is the seal's.
    sealRequest(req);
    reqs.push(req);
    const answers = Object.fromEntries(
      Object.entries(req.questions).map(([id, q]) => {
        const ins = String(q.instructions);
        if (req.purpose === "fill.verify") return [id, { choice: "exact", confidence: 1 }];
        if (id.endsWith("_whose") || id.endsWith("_owner")) return [id, { choice: "user", confidence: 1 }];
        const want = /Label: 'Phone'/u.test(ins) ? PHONE : /Label: 'Email'/u.test(ins) ? EMAIL : null;
        const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`))?.[0];
        return [id, { choice: hit ?? "none", confidence: 1 }];
      }),
    );
    return { model: "jev-merge", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  return Object.assign(f, { reqs });
}

/** What every request sent reveals of `w`, together, by the reference (test/ledger-reference.ts). */
function revealed(reqs: readonly JevRequest[], w: WindowState): number {
  return refReveal(reqs.flatMap((r) => refUnits(JSON.stringify(wireBody(r)))), [...inventoryOfView(w)]).charged;
}

/** The desk: the chat, notes (the first is the window the user just left) and a form with `labels`. */
function desk(chat: { title: string; lines: string[] }, notes: string[], labels: readonly string[] = ["Phone"], formLines: readonly string[] = []): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap(chat.lines.map((l, i) => text(`slack/${i}`, l)), { at: T0 - 40_000, windowId: "slack", title: chat.title, app: SLACK }));
  notes.forEach((n, i) => m.apply(snap([field(`note${i}/body`, n, { role: "AXTextArea" })], { at: T0 - 30_000 + (notes.length - i) * 1000, windowId: `note${i}`, title: `Note ${i + 1}.txt`, app: TEXTEDIT(7100 + i), focused: true })));
  m.apply(
    snap([...formLines.map((l, i) => text(`form/h${i}`, l)), ...labels.map((l, i) => field(`form/${i}`, "", { label: l, frame: [100, 40 + 40 * i, 200, 24] }))], { at: T0, windowId: "form", title: "Volunteer signup", focused: true, focusedKey: "form/0" }),
  );
  return m;
}

async function fillOn(m: ScreenModel, labels: readonly string[] = ["Phone"]) {
  const j = jev();
  const p = await proposeFill(m, j, "form", "form/0", T0, { about: [], rand: () => 0 });
  const by = (label: string) => p.fields[labels.indexOf(label)];
  return { j, by };
}

beforeEach(() => setTestVerifier(null));
afterEach(() => setTestVerifier(STAND_IN));

describe("a conversation split across two notes (a)", () => {
  it("a1: two notes cannot split one chat's limit; 632 characters give 315, and the phone is withheld", async () => {
    const chat = { title: "Slack | #volunteers", lines: chatOf("Slack | #volunteers", 10, 632) };
    const half = Math.ceil(chat.lines.length / 2);
    const m = desk(chat, [["Signing up as Odile Ferrant.", `Phone: ${PHONE}`, ...chat.lines.slice(0, half)].join("\n"), [...chat.lines.slice(half), `Phone: ${PHONE}`].join("\n")]);
    const slack = m.windows.get("slack")!;
    expect([viewInventory(redactWindow(slack)).total, windowBudget(slack)]).toEqual([632, 315]);
    const { j, by } = await fillOn(m);
    expect(revealed(j.reqs, slack)).toBeLessThanOrEqual(315);
    expect(by("Phone")?.value ?? null).toBeNull();
    expect(heldReason(by("Phone")!)).toBe(`Caret left Phone: ${NOTE_UNSHOWN}.`);
  });

  it("a2: the form's own text that repeats a chat line counts toward the same 496 of 993", async () => {
    const chat = { title: "Slack | #volunteers", lines: chatOf("Slack | #volunteers", 14, 993) };
    const half = Math.ceil(chat.lines.length / 2);
    const m = desk(chat, [["Signing up as Odile Ferrant.", `Phone: ${PHONE}`, ...chat.lines.slice(0, half)].join("\n"), [...chat.lines.slice(half), `Phone: ${PHONE}`].join("\n")], ["Phone"], [chat.lines[0]!]);
    const slack = m.windows.get("slack")!;
    expect([viewInventory(redactWindow(slack)).total, windowBudget(slack)]).toEqual([993, 496]);
    const { j, by } = await fillOn(m);
    expect(revealed(j.reqs, slack)).toBeLessThanOrEqual(496);
    expect(by("Phone")?.value ?? null).toBeNull();
  });
});

describe("chat text quoted in a note (b)", () => {
  it("b1: a passage copied from inside long chat lines is charged to the chat, and the note is refused past 600", async () => {
    const chat = { title: "Slack | #volunteers", lines: chatLines(13, 100) };
    const slack = (m: ScreenModel) => m.windows.get("slack")!;
    // About 650 characters, starting and ending mid-line.
    const passage = chat.lines.slice(2, 9).join(" ").slice(30, 680);
    const m = desk(chat, [[`Phone: ${PHONE}`, `Copied passage: ${passage}`].join("\n")]);
    expect(windowBudget(slack(m))).toBe(600);
    const { j, by } = await fillOn(m);
    expect(revealed(j.reqs, slack(m))).toBeLessThanOrEqual(600);
    expect(by("Phone")?.value ?? null).toBeNull();
    expect(heldReason(by("Phone")!)).toBe(`Caret left Phone: ${NOTE_UNSHOWN}.`);
  });

  it("b2: a value whose third note cannot go sends none of its notes; a note another value needs goes for that value", async () => {
    const chat = { title: "Slack | #volunteers", lines: chatLines(6, 90) };
    // The fill reads the phone's notes in the order second copy, first note, chat note, so two are admitted before the
    // chat note fails.
    const notes = [
      ["Signing up as Odile Ferrant.", `Phone: ${PHONE}`, `Email: ${EMAIL}`].join("\n"),
      // Four of the chat's six lines: more than its limit, so this note can never be shown.
      [`Phone: ${PHONE}`, ...chat.lines.slice(0, 4)].join("\n"),
      ["Second copy, for the front desk.", `Phone: ${PHONE}`].join("\n"),
    ];
    const m = desk(chat, notes, ["Phone", "Email"]);
    const { j, by } = await fillOn(m, ["Phone", "Email"]);
    expect(by("Phone")?.value ?? null).toBeNull();
    expect(by("Email")?.value).toBe(EMAIL);
    const sentNotes = j.reqs.flatMap((r) => Object.values((r.state as { source_notes?: Record<string, string> }).source_notes ?? {}));
    expect(sentNotes).toContain(notes[0]);
    expect(sentNotes).not.toContain(notes[1]);
    expect(sentNotes).not.toContain(notes[2]);
  });
});
