// SnippetLedger charges a window for every character of it a request reveals, whichever window the text
// was taken from, so the conversation cap holds at runtime and not only in privacy.test.ts. All text is
// synthetic.
import { Disclosure, LedgerRefused, measureBytes } from "../src/privacy/disclosure.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { AppRef } from "../src/protocol.ts";
import { CONVERSATION_CHARS, WINDOW_CHARS, windowBudget } from "../src/privacy.ts";
import { snap, text } from "./builders.ts";
import { nodePart, type SourceAt } from "../src/privacy/ledger/source.ts";
import { collectCandidates, mintCandidate, sourceOf } from "../src/fill/candidates.ts";
import { seal, sendable } from "../src/privacy/send.ts";

const MESSAGES: AppRef = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const NOTES: AppRef = { pid: 6161, bundleId: "dev.caret.notes", name: "Notes" };

function screen(chat: string[], card: string[]): { m: ScreenModel; chat: WindowState; card: WindowState } {
  const m = new ScreenModel();
  m.apply(snap(chat.map((l, i) => text(`c${i}`, l)), { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
  m.apply(snap(card.map((l, i) => text(`k${i}`, l)), { at: 2, windowId: "card-1", title: "Contact", app: NOTES }));
  return { m, chat: m.windows.get("chat-1") as WindowState, card: m.windows.get("card-1") as WindowState };
}

const CHAT = ["Dana Whitfield", "my email is dana.whitfield@example.com", "see you at the review on Thursday", "bring the printed deck please"];
const CARD = ["Dana Whitfield", "dana.whitfield@example.com", "Lumen Labs"];

describe("the ledger charges every window a text reveals", () => {
  it("charges a chat for its line that a text taken from a card reads the same as", () => {
    const { m, chat, card } = screen(CHAT, CARD);
    const ledger = new Disclosure(m);
    expect(ledger.take(card, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 14, "chat-1": 14 });
    // Taken again from the chat, it is already paid for there.
    expect(ledger.take(chat, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(ledger.chars(chat.window.windowId)).toBe(14);
  });

  it("charges a chat for a text taken from a card that one of its messages quotes", () => {
    const { m, card } = screen(CHAT, CARD);
    const ledger = new Disclosure(m);
    expect(ledger.take(card, "candidate", ["dana.whitfield@example.com"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 26, "chat-1": 26 });
  });

  it("takes nothing from a card when the chat it reveals has no budget left", () => {
    const { m, chat, card } = screen(CHAT, CARD);
    const budget = windowBudget(chat);
    expect(budget).toBeLessThan(CONVERSATION_CHARS);
    const ledger = new Disclosure(m);
    // Spend the chat down to less than the 26 characters the email would cost it.
    expect(ledger.take(chat, "candidate", ["see you at the review on Thursday"])).toBe(true);
    const left = budget - ledger.chars(chat.window.windowId);
    expect(left).toBeLessThan(26);
    expect(ledger.take(card, "candidate", ["dana.whitfield@example.com"])).toBe(false);
    expect(ledger.chars(card.window.windowId)).toBe(0);
    // A value the chat does not show still goes.
    expect(ledger.take(card, "candidate", ["Lumen Labs"])).toBe(true);
  });

  it("charges the lines inside a taken text in a window past twice WINDOW_CHARS", () => {
    // Seven parent lines, each joining ten child labels that are lines of their own, and padding that
    // takes the window past 2 * WINDOW_CHARS, where B12's ledger stopped reading the window's lines.
    const children = Array.from({ length: 70 }, (_, i) => `w${String(i).padStart(2, "0")}xyz`);
    const parents = Array.from({ length: 7 }, (_, p) => children.slice(p * 10, p * 10 + 10).join(" "));
    const pad = Array.from({ length: 40 }, (_, i) => `padding line ${i} that no request takes ${"z".repeat(40)}`);
    const m = new ScreenModel();
    m.apply(snap([...parents, ...children, ...pad].map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "big-1", title: "Thread", app: MESSAGES }));
    const w = m.windows.get("big-1") as WindowState;
    expect(windowBudget(w)).toBe(CONVERSATION_CHARS);
    const ledger = new Disclosure(m);
    const first = parents[0] as string;
    expect(ledger.take(w, "candidate", [first])).toBe(true);
    // The parent's 69 characters and its ten 6-character children.
    expect(ledger.chars("big-1")).toBe(first.length + 60);
    let taken = 1;
    while (taken < parents.length && ledger.take(w, "candidate", [parents[taken] as string])) taken++;
    expect(ledger.chars("big-1")).toBeLessThanOrEqual(CONVERSATION_CHARS);
    expect(taken).toBeLessThan(parents.length);
  });

  it("charges plan text for the window lines it quotes, and refuses past a budget", () => {
    const { m, chat } = screen(CHAT, CARD);
    const ledger = new Disclosure(m);
    expect(ledger.plan(["The Notes field holds see you at the review on Thursday"])).toBe(true);
    expect(ledger.chars(chat.window.windowId)).toBe(33);
    // The plan text, and the chat's line it holds declared under the chat, so the request names the chat (B17).
    expect(ledger.snippets).toEqual([
      { windowId: "plan", kind: "candidate", text: "The Notes field holds see you at the review on Thursday" },
      { windowId: chat.window.windowId, kind: "candidate", text: "see you at the review on Thursday" },
    ]);
    const tight = new Disclosure(m);
    expect(tight.take(chat, "candidate", ["bring the printed deck please"])).toBe(true);
    expect(tight.plan(["The Notes field holds see you at the review on Thursday"])).toBe(false);
    expect(tight.snippets.filter((s) => s.windowId === "plan")).toEqual([]);
  });

  it("leaves a card that is not a conversation its whole budget for a value a chat does not show", () => {
    const { m, card } = screen(CHAT, CARD);
    expect(windowBudget(card)).toBe(WINDOW_CHARS);
    const ledger = new Disclosure(m);
    expect(ledger.take(card, "candidate", ["Lumen Labs"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 10 });
  });
});

describe("the positions a request reveals: every occurrence, each position once", () => {
  const LINES = ["Rental notes", "Phone: (512) 555-0147", "Call (512) 555-0147 after six", "Landlord: Gary Pruitt"];
  const card = (): { m: ScreenModel; w: WindowState; id: string } => {
    const m = new ScreenModel();
    m.apply(snap(LINES.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-2", title: "Rental notes.txt", app: NOTES }));
    return { m, w: m.windows.get("note-2") as WindowState, id: "note-2" };
  };
  const PHONE = "(512) 555-0147";

  it("charges a value in every line that shows it, then a line holding it only its other characters", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m);
    expect(ledger.take(w, "candidate", [PHONE])).toBe(true);
    expect(ledger.chars(id)).toBe(2 * PHONE.length);
    expect(ledger.take(w, "candidate", ["Phone: (512) 555-0147"])).toBe(true);
    // The whole Phone line, and in the Call line the run they share, " (512) 555-0147".
    expect(ledger.chars(id)).toBe("Phone: (512) 555-0147".length + " (512) 555-0147".length);
  });

  it("charges two lines joined by a space as both lines, and refuses a text with a word no line shows", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m);
    expect(ledger.take(w, "candidate", ["Rental notes Landlord: Gary Pruitt"])).toBe(true);
    // Both lines, and the same 12-scalar run in the title "Rental notes.txt".
    expect(ledger.chars(id)).toBe(2 * "Rental notes".length + "Landlord: Gary Pruitt".length);
    expect(ledger.take(w, "candidate", ["Landlord: Gary Pruitt, unpaid"])).toBe(false);
  });

  it("charges a cut text the run a line shows", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m);
    expect(ledger.take(w, "candidate", ["Call (512) 555-0147 aft\u2026"])).toBe(true);
    // The run in the Call line, and in the Phone line the run they share, " (512) 555-0147".
    expect(ledger.chars(id)).toBe("Call (512) 555-0147 aft".length + " (512) 555-0147".length);
  });
});

describe("plan text that quotes part of a line", () => {
  const LONG = "Deliver around 7:30 pm, and please use the side door and ring twice because the front bell is broken since May";
  const note = (): { m: ScreenModel; w: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap(["Pizza order", "Name: Jordan Reyes", LONG].map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Order note.txt", app: NOTES }));
    return { m, w: m.windows.get("note-1") as WindowState };
  };

  it("charges the window for the part it quotes, declared under the window", () => {
    const some = new Disclosure(note().m);
    const quote = LONG.slice(0, 30);
    expect(some.plan([`Put "${quote}" in Notes`])).toBe(true);
    expect(some.chars("note-1")).toBe(quote.length);
    expect(some.declared().snippets).toContainEqual({ windowId: "note-1", kind: "candidate", text: quote.trim() });
  });

  it("does not charge for a few words any page might hold", () => {
    const l = new Disclosure(note().m);
    // No run of 12 scalars in common ("ring twice " is 11).
    expect(l.plan(["ring twice at the side"])).toBe(true);
    expect(l.chars("note-1")).toBe(0);
  });
});

describe("the B26 review's undercharges", () => {
  it("charges a cut line to every window that shows the line, not only the one it was taken from", () => {
    const LINE = "Deliver around 7:30 pm, and please use the side door and ring twice because the front bell is broken since May";
    const m = new ScreenModel();
    m.apply(snap([text("n0", "Order"), text("n1", LINE)], { at: 1, windowId: "note-4", title: "Order note.txt", app: NOTES }));
    m.apply(snap([text("c0", "Kofi: running late"), text("c1", LINE)], { at: 2, windowId: "chat-4", title: "Chat", app: { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" } }));
    const note = m.windows.get("note-4") as WindowState;
    const ledger = new Disclosure(m);
    // The chat is a conversation held under half of its text, so 99 characters of its line do not fit.
    expect(ledger.take(note, "candidate", [`${LINE.slice(0, 99)}…`])).toBe(false);
    expect(ledger.chars("chat-4")).toBe(0);
  });
});

// OUTPUT-LEDGER-SPEC section 5: every copy of a text a window shows is charged, and a conversation's limit is under half
// of all its lines, repeated ones included.
describe("repeated text at seal", () => {
  const chat = (lines: string[]): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i) => text(`c${i}`, l)), { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    return m;
  };
  /** The chat's charge at seal, or the refusal's message. */
  const seal = (m: ScreenModel, units: string[]): number | string => {
    try {
      return new Disclosure(m).measureSent("test", units).charged["chat-1"] ?? 0;
    } catch (e) {
      if (e instanceof LedgerRefused) return e.message;
      throw e;
    }
  };

  it("refuses lines A, A, A, B sent whole: a repeated line is one line, so that is all of the chat but its title", () => {
    const [a, b] = ["the deposit is due on the sixteenth", "and the venue holds the date until then"];
    // T = 4 + 35 + 39 = 78, limit floor(77 / 2) = 38.
    expect(seal(chat([a, a, a, b]), [a, b])).toBe("test: it reveals 74 characters of window chat-1, over its limit of 38; it was not sent");
  });

  it("refuses 'see you at five tomorrow' three times and 'bring the deposit', sent as one sentence", () => {
    // Both lines are whole in the unit: 24 + 17 = 41 of T = 45, limit 22.
    expect(seal(chat(["see you at five tomorrow", "see you at five tomorrow", "see you at five tomorrow", "bring the deposit"]), ["see you at five tomorrow, bring the deposit"])).toBe(
      "test: it reveals 41 characters of window chat-1, over its limit of 22; it was not sent",
    );
  });

  it("charges each quoted copy of a 500-character message: 250 of it costs 750 when it is quoted at two levels", () => {
    const msg = Array.from({ length: 84 }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ").slice(0, 500);
    expect(msg.length).toBe(500);
    const half = msg.slice(100, 350);
    // Unquoted, T = 504 and the limit is 251: 250 fits.
    expect(seal(chat([msg]), [half])).toBe(250);
    // Quoted at two levels, T = 4 + 500 + 502 + 504 = 1510 and the limit is 600: 250 is charged in each copy.
    const quoted = chat([msg, `> ${msg}`, `> > ${msg}`]);
    expect(seal(quoted, [half])).toBe("test: it reveals 750 characters of window chat-1, over its limit of 600; it was not sent");
    expect(seal(quoted, [msg])).toBe("test: it reveals 1500 characters of window chat-1, over its limit of 600; it was not sent");
  });
});

// OUTPUT-LEDGER-SPEC section 7: the requests sent through one Disclosure are one operation.
describe("one operation's requests together", () => {
  const LINES = ["the deposit is due on the sixteenth of the month", "and the venue holds the date for us until then", "bring the signed contract to the front desk"];
  const chat = (): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap(LINES.map((l, i) => text(`c${i}`, l)), { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    return m;
  };
  const refusal = (f: () => unknown): string | null => {
    try {
      f();
      return null;
    } catch (e) {
      if (e instanceof LedgerRefused) return e.message;
      throw e;
    }
  };

  it("cannot take a conversation past its limit by two requests that each fit", () => {
    // T = 4 + 48 + 46 + 43 = 141, limit 70: each of the first two lines fits alone, not both.
    const d = new Disclosure(chat());
    expect(d.measureSent("first", [LINES[0]!]).charged["chat-1"]).toBe(48);
    expect(refusal(() => d.measureSent("second", [LINES[1]!]))).toBe("second: with the requests sent before it, it reveals 94 characters of window chat-1, over its limit of 70; it was not sent");
    // A refused request keeps nothing: one that adds within the limit still goes, and the first, sent again, adds nothing.
    expect(d.measureSent("third", ["the deposit is due on"]).charged["chat-1"]).toBe(21);
    expect(d.measureSent("first again", [LINES[0]!]).charged["chat-1"]).toBe(48);
  });

  it("gives a new Disclosure, a new operation, its own share", () => {
    const m = chat();
    new Disclosure(m).measureSent("first", [LINES[0]!]);
    expect(new Disclosure(m).measureSent("other", [LINES[1]!]).charged["chat-1"]).toBe(46);
  });
});

// OUTPUT-LEDGER-SPEC section 8: a whole owner note counts against its window's owner-note allotment, only where it
// stands whole in state.source_notes.
describe("owner notes at seal", () => {
  const TE = { pid: 7100, bundleId: "com.apple.TextEdit", name: "TextEdit" };
  /** Line i of a note: about 90 characters that share no 12-character run with any other line. */
  const line = (i: number): string => {
    let x = i * 7919 + 17;
    const word = (): string => Array.from({ length: 6 }, () => String.fromCharCode(97 + ((x = (x * 1103515245 + 12345) % 2147483648) % 26))).join("");
    return `Reminder ${i}: ${Array.from({ length: 12 }, word).join(" ")}`;
  };
  const noteOf = (n: number, from = 0): string => Array.from({ length: n }, (_, i) => line(from + i)).join("\n");
  const desk = (note: string, app: AppRef = TE): { m: ScreenModel; view: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap([{ key: "note/body", parent: null, role: "AXTextArea", value: note, editable: true }], { at: 1, windowId: "note-1", title: "Notes.txt", app }));
    return { m, view: redactWindow(m.windows.get("note-1") as WindowState) };
  };
  const seal = (d: Disclosure, body: unknown): number | string => {
    try {
      return measureBytes({ purpose: "fill.whose", disclosure: d }, JSON.stringify(body)).charged["note-1"] ?? 0;
    } catch (e) {
      if (e instanceof LedgerRefused) return e.message;
      throw e;
    }
  };

  it("admits a note past its window's limit, whole in source_notes; the same text anywhere else is held to the limit", () => {
    const note = noteOf(15);
    expect(note.length).toBeGreaterThan(1200);
    const { m, view } = desk(note);
    const d = new Disclosure(m);
    expect(d.ownerNote(view, note)).toBe(note);
    // Its characters as the window's lines count them, line breaks aside.
    const chars = note.replaceAll("\n", "").length;
    expect(seal(d, { state: { source_notes: { note_1: note } } })).toBe(chars);
    expect(seal(d, { state: { task: note } })).toBe(`fill.whose: it reveals ${chars} characters of window note-1, over its limit of 1200; it was not sent`);
    // The rest of the request is held to the limit apart from the note.
    expect(seal(d, { state: { source_notes: { note_1: note }, task: line(0) } })).toBe(chars);
  });

  it("holds a window's notes together to 2,000: a second note that would pass it is not minted", () => {
    const a = noteOf(12);
    const b = noteOf(12, 12);
    const m = new ScreenModel();
    m.apply(snap([0, 1].map((i) => ({ key: `note/${i}`, parent: null, role: "AXTextArea", value: [a, b][i], editable: true })), { at: 1, windowId: "note-1", title: "Notes.txt", app: TE }));
    const view = redactWindow(m.windows.get("note-1") as WindowState);
    const d = new Disclosure(m);
    expect(d.ownerNote(view, a)).toBe(a);
    expect(d.ownerNote(view, b)).toBeNull();
    expect(seal(d, { state: { source_notes: { note_1: a } } })).toBe(a.replaceAll("\n", "").length);
  });

  it("charges every other window that shows a note's lines in full: a chat quoting three of them refuses it", () => {
    const note = noteOf(15);
    const { m, view } = desk(note);
    const d = new Disclosure(m);
    expect(d.ownerNote(view, note)).toBe(note);
    // A chat that quotes three of the note's lines opens after the note was minted; the seal measures it too.
    m.apply(snap([0, 1, 2].map((i) => text(`c${i}`, line(i))), { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    expect(() => measureBytes({ purpose: "fill.whose", disclosure: d }, JSON.stringify({ state: { source_notes: { note_1: note } } }))).toThrow(/window chat-1, over its limit/u);
  });

  it("gives no note of a conversation the allotment", () => {
    const note = noteOf(15);
    const { m, view } = desk(note, { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" });
    const d = new Disclosure(m);
    expect(d.ownerNote(view, note)).toBeNull();
  });
});

// OUTPUT-LEDGER-SPEC section 4: a minted unit is charged its declared span, wherever it stands in the output.
describe("declared spans at mint and at seal", () => {
  const LINES = ["Alice, Bob", "Cedar, Elm", "Paris, Rome"];
  const VALUES = ["Alice", "Bob", "Cedar", "Elm", "Paris", "Rome"];
  /** Where each value was read: its line, and its offset there. */
  const READ: SourceAt[] = VALUES.map((v, i) => ({ part: nodePart(`c${Math.floor(i / 2)}`, "label"), start: LINES[Math.floor(i / 2)]!.indexOf(v), end: LINES[Math.floor(i / 2)]!.indexOf(v) + v.length }));
  const chat = (): { m: ScreenModel; view: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap(LINES.map((l, i) => text(`c${i}`, l)), { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    return { m, view: redactWindow(m.windows.get("chat-1") as WindowState) };
  };

  it("refuses the fifth of six short values a chat shows: 16 of its limit of 17 are taken, and Paris is 5 more", () => {
    const { m, view } = chat();
    const d = new Disclosure(m);
    const minted = VALUES.map((v, i) => d.candidate(view, v, READ[i]));
    expect(minted.map((x) => x !== null)).toEqual([true, true, true, true, false, false]);
    // The seal charges the four it holds, 16, by their declared spans.
    const sent = minted.filter((x): x is NonNullable<typeof x> => x !== null);
    expect(d.measureSent("test", sent).charged["chat-1"]).toBe(16);
  });

  it("charges a composition its parts' spans: the values joined in one sentence cost what they cost apart", () => {
    const { m, view } = chat();
    const d = new Disclosure(m);
    const [a, b] = [d.candidate(view, "Alice", READ[0]), d.candidate(view, "Bob", READ[1])];
    const said = d.t`Meet ${a!} and ${b!}.`;
    expect(d.measureSent("test", [said]).charged["chat-1"]).toBe(8);
  });
});

// Inside the promise's scope: a minted unit is charged every source position of its recorded range, punctuation,
// ellipses and combining marks included, and a derivation its whole basis.
describe("what a minted unit takes from its window", () => {
  const note = (lines: string[]): { m: ScreenModel; d: Disclosure; view: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Note", app: NOTES }));
    return { m, d: new Disclosure(m), view: redactWindow(m.windows.get("note-1") as WindowState) };
  };

  it("charges a value read with interior ellipses its whole recorded range: 'a……b' from 'a……b.' is 4", () => {
    const { d, view } = note(["a\u2026\u2026b."]);
    const v = d.candidate(view, "a\u2026\u2026b", { part: nodePart("n0", "label"), start: 0, end: 4 });
    expect(d.measureSent("test", [v!]).charged["note-1"]).toBe(4);
  });

  it("charges a derivation the whole basis it read, punctuation and combining marks included", () => {
    const e = "\u00e9\u0300\u0302";
    const { d, view } = note(["(1), (2).", `${e}.`]);
    const paren = d.derived(d.basis(view, "(1), (2).", { part: nodePart("n0", "label"), start: 0, end: 9 })!, "(1), (2)");
    expect(d.measureSent("test", [paren!]).charged["note-1"]).toBe(9);
    const marked = d.derived(d.basis(view, `${e}.`, { part: nodePart("n1", "label"), start: 0, end: 4 })!, e);
    expect(d.measureSent("test", [marked!]).charged["note-1"]).toBe(4);
  });
});

// A mint charges the exact source range its producer recorded, read by the one reader the
// inventory uses.
describe("a recorded source range", () => {
  const desk = (lines: string[], o: { title?: string; chat?: boolean } = {}): { d: Disclosure; view: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i) => text(`c${i}`, l)), { at: 1, windowId: "w-1", title: o.title ?? "Kofi", app: o.chat === false ? NOTES : MESSAGES }));
    return { d: new Disclosure(m), view: redactWindow(m.windows.get("w-1") as WindowState) };
  };
  const label = (key: string, start: number, end: number): SourceAt => ({ part: nodePart(key, "label"), start, end });

  it("charges a mint across a bare CR the 18 characters it read: over a chat's limit of 11", () => {
    const { d, view } = desk(["abcdefghij\rklmnopqrst"]);
    expect(d.candidate(view, "bcdefghij\rklmnopqrs", label("c0", 1, 20))).toBeNull();
    const note = desk(["abcdefghij\rklmnopqrst"], { chat: false });
    const v = note.d.candidate(note.view, "bcdefghij\rklmnopqrs", label("c0", 1, 20));
    expect(note.d.measureSent("test", [v!]).charged["w-1"]).toBe(18);
  });

  it("charges a derivation the whole basis it read: '1/1/2/2/3' from '1122334455' takes 10, over a limit of 6", () => {
    const { d, view } = desk(["1122334455"]);
    expect(d.derived(d.basis(view, "1122334455", label("c0", 0, 10))!, "1/1/2/2/3")).toBeNull();
    const note = desk(["1122334455"], { chat: false });
    const v = note.d.derived(note.d.basis(note.view, "1122334455", label("c0", 0, 10))!, "1/1/2/2/3");
    expect(note.d.measureSent("test", [v!]).charged["w-1"]).toBe(10);
  });

  it("charges a mint from the body, not a title that normalizes alike: '\u682a\u5f0f\u4f1a\u793e' takes 4 of a limit of 2", () => {
    const { d, view } = desk(["\u682a\u5f0f\u4f1a\u793ex"], { title: "\u337f" });
    expect(d.candidate(view, "\u682a\u5f0f\u4f1a\u793e", label("c0", 0, 4))).toBeNull();
  });

  it("charges the source's own ellipses: '\u2026a\u2026' from '\u2026a\u2026.' takes 3", () => {
    const { d, view } = desk(["\u2026a\u2026."], { chat: false });
    const v = d.candidate(view, "\u2026a\u2026", label("c0", 0, 3));
    expect(d.measureSent("test", [v!]).charged["w-1"]).toBe(3);
  });

  it("with no recorded range, charges every line holding the text, whole", () => {
    const { d, view } = desk(["abcdefghij\rklmnopqrst"], { chat: false });
    const v = d.candidate(view, "bcdefghij\rklmnopqrs");
    expect(d.measureSent("test", [v!]).charged["w-1"]).toBe(20);
  });

  it("throws on a range that does not hold the text", () => {
    const { d, view } = desk(["abcdefghij"], { chat: false });
    expect(() => d.candidate(view, "bcdefghij", label("c0", 0, 5))).toThrow(/does not hold its text/u);
  });
});

// The early check charges what the seal will: a short chat line that Caret's wording holds ("You" in "can you not tell?")
// is charged at seal, so values admitted up to the limit without it lost the whole request there.
describe("the early check and the seal agree on Caret's wording", () => {
  const LINE = "abcdefghij klmnopqrst";
  // T = 4 ("Kofi") + 3 + 21 = 28, limit 13.
  const desk = (): { d: Disclosure; view: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap([text("c0", "You"), text("c1", LINE)], { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    return { d: new Disclosure(m), view: redactWindow(m.windows.get("chat-1") as WindowState) };
  };
  const twelve: SourceAt = { part: nodePart("c1", "label"), start: 0, end: 12 };

  it("keeps a sealed request's charge: after one that charged 'You', 12 more characters are refused at mint", () => {
    const { d, view } = desk();
    expect(measureBytes({ purpose: "test", disclosure: d }, JSON.stringify({ q: d.own("can you not tell?") })).charged["chat-1"]).toBe(3);
    expect(d.candidate(view, LINE.slice(0, 12), twelve), "3 + 12 is over 13").toBeNull();
  });

  it("charges reserved wording before any value: 12 characters are refused at mint after 'can you not tell?' is reserved", () => {
    const { d, view } = desk();
    expect(d.candidate(view, LINE.slice(0, 12), twelve)).not.toBeNull();
    const fresh = desk();
    fresh.d.reserveWording(["can you not tell?"]);
    expect(fresh.d.candidate(fresh.view, LINE.slice(0, 12), twelve), "3 + 12 is over 13").toBeNull();
  });
});

// No producer relies on rule E alone: plan text has no single source, so the lines it shows a piece of are its spans,
// charged whole (OUTPUT-LEDGER-SPEC section 4, the fallback).
describe("plan text", () => {
  it("charges the whole line a short piece of it comes from: 'due friday' takes the 25-character line", () => {
    const m = new ScreenModel();
    m.apply(snap([text("n0", "the deposit is due friday"), text("n1", "bring the contract")], { at: 1, windowId: "note-1", title: "Note", app: NOTES }));
    const d = new Disclosure(m);
    const said = d.planText("due friday");
    expect(said).not.toBeNull();
    // Rule E alone: 10 scalars and not a whole line, 0.
    expect(d.measureSent("test", [said!]).charged["note-1"], "the line the plan quotes, whole").toBe(25);
  });
});

// Astra's recheck of 1d7b7bf2, through the production paths: no search for where a value was read, no length floor on
// the fallback, and an operation's union that a snapshot refresh or a send-time measure cannot reset.
describe("where a value was read, and what an operation keeps", () => {
  const LINES = ["the deposit is due on the sixteenth of the month", "and the venue holds the date for us until then", "bring the signed contract to the front desk"];

  it("records a labelled value where its reader found it, not the first place its text stands: 'Bob' at [11, 14)", () => {
    const m = new ScreenModel();
    m.apply(snap([text("c0", "Alice Bob: Bob"), text("c1", "zxqvjkprt")], { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    m.apply(snap([text("f0", "Form")], { at: 2, windowId: "form-1", title: "Form", app: NOTES }));
    const d = new Disclosure(m);
    const c = collectCandidates(m, "form-1", { now: 3 }).candidates.find((x) => x.text === "Bob");
    expect(c).toBeDefined();
    expect(sourceOf(c!).text).toEqual({ part: nodePart("c0", "label"), start: 11, end: 14 });
    // The value, its label and the title take 16 of the chat's 27, over its limit of 13.
    expect(mintCandidate(d, m, c!), "16 of a limit of 13").toBeNull();
  });

  it("charges plan and held text's lines whatever the length of the pieces: 'ab', 'cd' and 'ef' take the line 'abcdef'", () => {
    const m = new ScreenModel();
    m.apply(snap([text("c0", "abcdef")], { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    const d = new Disclosure(m);
    // T = 10, limit 4: the whole line is 6.
    expect(d.heldText("ab\ncd\nef"), "6 of a limit of 4").toBeNull();
    expect(d.planText("ab\ncd\nef"), "6 of a limit of 4").toBeNull();
    const note = new ScreenModel();
    note.apply(snap([text("n0", "abcdef")], { at: 1, windowId: "note-1", title: "Note", app: NOTES }));
    const n = new Disclosure(note);
    expect(n.measureSent("test", [n.heldText("ab\ncd\nef")!]).charged["note-1"]).toBe(6);
  });

  it("keeps held text's source lines after an identical snapshot refresh: 31, as before it", () => {
    const m = new ScreenModel();
    const lines = ["Alice, Bob", "Cedar, Elm", "Paris, Rome"];
    m.apply(snap(lines.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Note", app: NOTES }));
    const d = new Disclosure(m);
    const said = d.heldText("Alice\nCedar\nParis")!;
    m.apply(snap(lines.map((l, i) => text(`n${i}`, l)), { at: 2, windowId: "note-1", title: "Note", app: NOTES }));
    // The state it was read from is still measured, as a retained one (note-1@1) beside the refreshed note-1.
    const charged = d.measureSent("test", [said]).charged;
    expect(Math.max(0, ...Object.entries(charged).filter(([k]) => k.startsWith("note-1")).map(([, v]) => v))).toBe(31);
  });

  it("holds the operation's union across an identical snapshot refresh: 48 and then 46 of a limit of 70 refuses", () => {
    const m = new ScreenModel();
    m.apply(snap(LINES.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Notes", app: NOTES }));
    const d = new Disclosure(m);
    const said = LINES.map((l) => d.heldText(l)!);
    const chat = (at: number): void => void m.apply(snap(LINES.map((l, i) => text(`c${i}`, l)), { at, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    chat(2);
    expect(d.measureSent("test", [said[0]!]).charged["chat-1"]).toBe(48);
    chat(3);
    expect(() => d.measureSent("test", [said[1]!])).toThrow(/with the requests sent before it, it reveals 94 characters of window chat-1, over its limit of 70/u);
  });

  it("commits what a send measures: a chat opened after the seal is charged at send, and the next request is held to it", () => {
    const m = new ScreenModel();
    m.apply(snap(LINES.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Notes", app: NOTES }));
    const d = new Disclosure(m);
    const said = LINES.map((l) => d.heldText(l)!);
    const ask = (i: number) => ({ req: { purpose: "route.task", disclosure: d }, wire: { state: { offer: { found: said[i]! } }, questions: {} } });
    const first = seal(ask(0));
    expect(first.charged["chat-1"]).toBeUndefined();
    m.apply(snap(LINES.map((l, i) => text(`c${i}`, l)), { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    sendable(first);
    expect(() => seal(ask(1))).toThrow(/with the requests sent before it, it reveals 94 characters of window chat-1, over its limit of 70/u);
  });
});

// A reader's value is placed only where its text stands once in the node's raw text, and a window keeps the strictest
// classification and the lowest limit the operation measured it with.
describe("a unique place, and a window's strictest limit", () => {
  it("does not place a reader's value its node shows twice: '555-0101' in '.555-0101' and '555-0101.' takes both lines", () => {
    const m = new ScreenModel();
    // T = 4 + 9 + 9 + 5 = 27, limit 13. The reader kept the first phone; the helper's extractor sees only the second.
    m.apply(snap([text("c0", ".555-0101\n555-0101."), { key: "c1", parent: null, role: "AXButton", label: "QQQQQ" }], { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES, values: [{ kind: "phone", text: "555-0101", nodeKey: "c0" }] }));
    m.apply(snap([text("f0", "Form")], { at: 2, windowId: "form-1", title: "Form", app: NOTES }));
    const d = new Disclosure(m);
    const all = collectCandidates(m, "form-1", { now: 3 }).candidates.find((x) => x.text === "555-0101");
    expect(all, "offered without a ledger").toBeDefined();
    expect(sourceOf(all!).text, "no place: it stands twice").toBeUndefined();
    // With the ledger, its two lines (18) and the title are over 13: it is cut, not placed at one of them.
    const r = collectCandidates(m, "form-1", { now: 3, ledger: d });
    expect(r.candidates.map((c) => c.text)).not.toContain("555-0101");
    expect(r.cut).toContain("chat-1");
  });

  it("keeps a closed mail a conversation at its first limit, though redaction took the headers that made it one", () => {
    const m = new ScreenModel();
    const body = ["see you at five tomorrow", "and the venue holds the date for us"];
    m.apply(snap(body.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Note", app: NOTES }));
    const d = new Disclosure(m);
    const said = body.map((l, i) => d.candidate(redactWindow(m.windows.get("note-1") as WindowState), l, { part: nodePart(`n${i}`, "label"), start: 0, end: l.length })!);
    // A mail in Chrome: "From:" and "Subject:" make it a conversation; redaction removes the Subject line (it names a
    // password), so the redacted view alone would not read as one. T = 14 + 10 + 24 + 35 = 83, limit 41.
    const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
    m.apply(snap([text("h0", "From: Dana"), text("h1", "Subject: my password is violet-orchard-seven"), ...body.map((l, i) => text(`b${i}`, l))], { at: 2, windowId: "mail-1", title: "Inbox - Chrome", app: chrome }));
    expect(d.measureSent("test", [said[1]!]).charged["mail-1"]).toBe(35);
    m.close("mail-1", 3);
    expect(() => d.measureSent("test", [said[0]!])).toThrow(/with the requests sent before it, it reveals 59 characters of window mail-1, over its limit of 41/u);
  });

  it("counts what a tab sent as a page once it becomes a mail: 29 then 29 more is 58 of a limit of 43, refused", () => {
    const m = new ScreenModel();
    const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
    const a = "abcdefghijklmnopqrstuvwxyzABC";
    const b = "0123456789zyxwvutsrqponmlkjih";
    m.apply(snap([text("a", a), text("b", b)], { at: 1, windowId: "tab", title: "Tab", app: chrome }));
    const d = new Disclosure(m);
    const view = redactWindow(m.windows.get("tab") as WindowState);
    const said = [a, b].map((t, i) => d.candidate(view, t, { part: nodePart(i === 0 ? "a" : "b", "label"), start: 0, end: t.length })!);
    const send = (t: string): Readonly<Record<string, number>> => {
      const s = seal({ req: { purpose: "route.task", disclosure: d }, wire: { state: { offer: { found: t } }, questions: {} } });
      sendable(s);
      return s.charged;
    };
    expect(send(said[0]!)["tab"], "a page: no conversation limit").toBe(29);
    // The tab now shows a mail, so it is a conversation, at the limit of every line its states showed:
    // T = 3 + 29 + 29 + 10 + 16 = 87, limit 43.
    m.apply(snap([text("h", "From: Dana"), text("s", "Subject: booking"), text("a", a), text("b", b)], { at: 2, windowId: "tab", title: "Tab", app: chrome }));
    expect(() => send(said[1]!), "the page's 29 count toward the mail's limit").toThrow(/with the requests sent before it, it reveals 58 characters of window tab\S*, over its limit of 43/u);
  });

  it("holds a promoted conversation's union to its limit on a request that charges it nothing new", () => {
    const m = new ScreenModel();
    const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
    const a = "abcdefghijklmnopqrstuvwxyzABC";
    const b = "0123456789zyxwvutsrqponmlkjih";
    m.apply(snap([text("a", a), text("b", b)], { at: 1, windowId: "tab", title: "Tab", app: chrome }));
    const d = new Disclosure(m);
    const view = redactWindow(m.windows.get("tab") as WindowState);
    const said = d.candidate(view, `${a}\n${b}`)!;
    const send = (t: string): void => void sendable(seal({ req: { purpose: "route.task", disclosure: d }, wire: { state: { offer: { found: t } }, questions: {} } }));
    send(said);
    // The tab shows a mail: a conversation now, at a limit of 43 (every line its states showed), with 58 already sent.
    m.apply(snap([text("h", "From: Dana"), text("s", "Subject: booking"), text("a", a), text("b", b)], { at: 2, windowId: "tab", title: "Tab", app: chrome }));
    expect(() => send(d.own("nothing at all")), "the union is over the limit whatever this request adds").toThrow(/with the requests sent before it, it reveals 58 characters of window tab\S*, over its limit of 43/u);
  });

  it("keeps a tab that became a mail a conversation after it closes: 59 is refused at send against 46, not taken against 1200", () => {
    const m = new ScreenModel();
    const body = ["see you at five tomorrow", "and the venue holds the date for us"];
    const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
    // The operation first measures the tab as a web page, before it shows the mail.
    m.apply(snap([text("a", "Web page")], { at: 1, windowId: "mail-1", title: "Tab", app: chrome }));
    m.apply(snap(body.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Note", app: NOTES }));
    const d = new Disclosure(m);
    const said = body.map((l, i) => d.candidate(redactWindow(m.windows.get("note-1") as WindowState), l, { part: nodePart(`n${i}`, "label"), start: 0, end: l.length })!);
    // Then the same tab shows the mail: with the page's "Tab" and "Web page", T = 3 + 8 + 14 + 10 + 24 + 35 = 94, limit 46
    // (the Subject line is redacted away, and still read as the conversation it made the tab).
    m.apply(snap([text("h0", "From: Dana"), text("h1", "Subject: my password is violet-orchard-seven"), ...body.map((l, i) => text(`b${i}`, l))], { at: 2, windowId: "mail-1", title: "Inbox - Chrome", app: chrome }));
    const send = (t: string): Readonly<Record<string, number>> => {
      const s = seal({ req: { purpose: "route.task", disclosure: d }, wire: { state: { offer: { found: t } }, questions: {} } });
      sendable(s);
      return s.charged;
    };
    expect(send(said[1]!)["mail-1"]).toBe(35);
    m.close("mail-1", 3);
    expect(() => send(d.join(said, "\n"))).toThrow(/it reveals 59 characters of window mail-1, over its limit of 46/u);
  });
});

// The promise's scope (OUTPUT-LEDGER-SPEC section 4): a request is charged what it takes from a conversation's window.
// Text equal to the chat's that came from elsewhere is not taken from it, so each of these charges the chat nothing.
describe("text a chat shows that the request did not take from it", () => {
  const LINES = ["Alice, Bob", "Cedar, Elm", "Paris, Rome", "none!", "room 4412 at noon", "Alix"];
  const desk = (noteLines: string[]): { d: Disclosure; noteView: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap(LINES.map((l, i) => text(`c${i}`, l)), { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    m.apply(snap(noteLines.map((l, i) => text(`n${i}`, l)), { at: 2, windowId: "note-1", title: "Note", app: NOTES }));
    return { d: new Disclosure(m), noteView: redactWindow(m.windows.get("note-1") as WindowState) };
  };

  it("the same six names minted from a note: the note pays 25, the chat 0", () => {
    const { d, noteView } = desk(["Alice, Bob", "Cedar, Elm", "Paris, Rome"]);
    const lines = ["Alice, Bob", "Cedar, Elm", "Paris, Rome"];
    const names = ["Alice", "Bob", "Cedar", "Elm", "Paris", "Rome"].map((v, i) => {
      const line = lines[Math.floor(i / 2)]!;
      return d.candidate(noteView, v, { part: nodePart(`n${Math.floor(i / 2)}`, "label"), start: line.indexOf(v), end: line.indexOf(v) + v.length })!;
    });
    const c = d.measureSent("test", names).charged;
    expect([c["note-1"], c["chat-1"] ?? 0]).toEqual([25, 0]);
  });

  it("the user's own instruction: 0", () => {
    const { d } = desk(["x"]);
    expect(d.measureSent("test", [d.instruction("Alice and Bob, then Paris")]).charged["chat-1"] ?? 0).toBe(0);
  });

  it("Caret's own wording 'none' against the chat line 'none!': 0", () => {
    const { d } = desk(["x"]);
    expect(d.measureSent("test", [d.own("none")]).charged["chat-1"] ?? 0).toBe(0);
  });

  it("a number code wrote that the chat also shows: 0", () => {
    const { d } = desk(["x"]);
    expect(measureBytes({ purpose: "test", disclosure: d }, JSON.stringify({ state: { count: 4412 } })).charged["chat-1"] ?? 0).toBe(0);
  });

  it("'Al' and 'ix' minted from a note as separate units, against the chat line 'Alix': 0", () => {
    const { d, noteView } = desk(["Al", "ix"]);
    const c = d.measureSent("test", [d.candidate(noteView, "Al")!, d.candidate(noteView, "ix")!]).charged;
    expect([c["note-1"], c["chat-1"] ?? 0]).toEqual([4, 0]);
  });
});

// A declared nested JSON text is measured as the text it decodes to.
describe("a JSON state at seal", () => {
  it("measures the strings a JSON state holds, not its escaped spelling", () => {
    // Quotes every few characters: escaped, they would cut every run under 12.
    const line = `say "abcdefghij" then "klmnopqrs" ok`;
    const m = new ScreenModel();
    m.apply(snap([text("n0", line)], { at: 1, windowId: "note-1", title: "Note", app: NOTES }));
    const d = new Disclosure(m);
    const said = d.candidate(redactWindow(m.windows.get("note-1") as WindowState), line);
    expect(said).not.toBeNull();
    const state = d.jsonText({ said: said! });
    // A chat that shows the same line opens after it was minted; the seal measures it. T = 4 + 36 + 1, limit 20.
    m.apply(snap([text("c0", line), text("c1", "x")], { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    expect(() => measureBytes({ purpose: "test", disclosure: d }, JSON.stringify({ state }))).toThrow(/reveals 36 characters of window chat-1, over its limit of 20/u);
  });
});

// A window line the ledger cannot measure refuses, rather than leaving the measure.
describe("a window with an unpaired surrogate", () => {
  it("refuses a request that carries the line's valid prefix", () => {
    const prefix = "the deposit is due friday";
    const m = new ScreenModel();
    m.apply(snap([text("n0", "Shared note")], { at: 1, windowId: "note-1", title: "Note", app: NOTES }));
    const d = new Disclosure(m);
    const said = d.candidate(redactWindow(m.windows.get("note-1") as WindowState), "Shared note");
    m.apply(snap([text("c0", `${prefix}\uD800`), text("c1", "ok")], { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    const leak = d.t`${said!}: the deposit is due friday` as string;
    expect(() => measureBytes({ purpose: "test", disclosure: d }, JSON.stringify({ state: { said: leak } }))).toThrow(/window chat-1 shows text the ledger cannot measure/u);
  });
});

describe("a window's limit across its states", () => {
  it("takes a tab's limit from all it showed, not from its 4-character live walk: the read mail's lines count", () => {
    const m = new ScreenModel();
    const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
    // The live walk of the tab the user left is its title alone; the text read from it is a mail.
    m.apply(snap([], { at: 1, windowId: "page:eng1:3", title: "Mail", app: chrome, kind: "page" }));
    const mail = ["From: Dana Whitfield <dana@example.com>", "Subject: Saturday", "see you at five tomorrow at the venue"];
    const view = m.withNodes(new Map([["page:eng1:3", { nodes: mail.map((l, i) => ({ key: `t${i}`, parent: null, role: "AXStaticText", label: l })), title: null }]]));
    const ws = new Disclosure(view).measuredWindows().filter((w) => w.windowId === "page:eng1:3");
    // The union of its inventories: "Mail" and the mail's three lines, T = 4 + 38 + 17 + 36 = 95, limit 47, a conversation.
    const total = 4 + mail.reduce((n, l) => n + l.length, 0);
    expect(ws.map((w) => [w.conversation, w.limit])).toEqual(ws.map(() => [true, Math.floor((total - 1) / 2)]));
  });
});

describe("a view's window states, kept whatever the live screen does", () => {
  const line = "see you at five tomorrow at the venue";
  /** Kofi's chat, T = 4 + 37 + 1 = 42, limit 20, and a view of the screen made before `then`. */
  const run = (then: (m: ScreenModel) => void): string => {
    const m = new ScreenModel();
    m.apply(snap([text("c0", line), text("c1", "x")], { at: 1, windowId: "chat-1", title: "Kofi", app: MESSAGES }));
    const view = m.withNodes(new Map());
    const d = new Disclosure(view);
    then(m);
    const said = d.heldText(line);
    if (said === null) return "refused at mint";
    try {
      sendable(seal({ req: { purpose: "route.task", disclosure: d }, wire: { state: { offer: { found: said } }, questions: {} } }));
      return "sent";
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  // The early check holds the view's state as the seal does, so the line is refused at mint, before any request.
  it("measures a state the view held after the live window closes: 37 of a limit of 20 is refused", () => {
    expect(run((m) => void m.close("chat-1", 2))).toBe("refused at mint");
  });
  it("measures a state the view held after the live window refreshes to other text: 37 of a limit of 20 is refused", () => {
    expect(run((m) => void m.apply(snap([text("c9", "something else entirely now")], { at: 2, windowId: "chat-1", title: "Kofi", app: MESSAGES })))).toBe("refused at mint");
  });
});
