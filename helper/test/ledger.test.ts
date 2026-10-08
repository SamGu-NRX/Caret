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
    // Distinct padding: repeated text counts once (section 5), so padding that repeated itself would add little.
    let x = 7;
    const letters = (n: number): string => Array.from({ length: n }, () => String.fromCharCode(97 + ((x = (x * 1103515245 + 12345) % 2147483648) % 26))).join("");
    const pad = Array.from({ length: 40 }, (_, i) => `padding line ${i} ${letters(50)}`);
    const m = new ScreenModel();
    m.apply(snap([...parents, ...children, ...pad].map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "big-1", title: "Thread", app: MESSAGES }));
    const w = m.windows.get("big-1") as WindowState;
    expect(windowBudget(w)).toBe(CONVERSATION_CHARS);
    const ledger = new Disclosure(m);
    const first = parents[0] as string;
    expect(ledger.take(w, "candidate", [first])).toBe(true);
    // The parent's 69 characters; its ten children stand whole in it, so they are the same text, counted once.
    expect(ledger.chars("big-1")).toBe(first.length);
    let taken = 1;
    while (taken < parents.length && ledger.take(w, "candidate", [parents[taken] as string])) taken++;
    // Seven parents of 69 are 483, within 600.
    expect([taken, ledger.chars("big-1")]).toEqual([parents.length, 7 * first.length]);
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

describe("the positions a request reveals: every occurrence, each position once, repeated text once", () => {
  const LINES = ["Rental notes", "Phone: (512) 555-0147", "Call (512) 555-0147 after six", "Landlord: Gary Pruitt"];
  const card = (): { m: ScreenModel; w: WindowState; id: string } => {
    const m = new ScreenModel();
    m.apply(snap(LINES.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-2", title: "Rental notes.txt", app: NOTES }));
    return { m, w: m.windows.get("note-2") as WindowState, id: "note-2" };
  };
  const PHONE = "(512) 555-0147";

  // Repeated text counts once (section 5): the window's lines in canonical order (longest first) are the Call line, the
  // Landlord line, the Phone line and the title; the Phone line's " (512) 555-0147" repeats the Call line's and is not
  // counted, and the line "Rental notes" stands whole in the title "Rental notes.txt" and is not counted either.
  it("charges a value once however many lines show it, then a line holding it only its other characters", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m);
    expect(ledger.take(w, "candidate", [PHONE])).toBe(true);
    expect(ledger.chars(id)).toBe(PHONE.length);
    expect(ledger.take(w, "candidate", ["Phone: (512) 555-0147"])).toBe(true);
    // The Phone line's own "Phone:", and in the Call line the space before the number, which the run they share holds.
    expect(ledger.chars(id)).toBe(PHONE.length + "Phone:".length + 1);
  });

  it("charges two lines joined by a space as both lines, and refuses a text with a word no line shows", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m);
    expect(ledger.take(w, "candidate", ["Rental notes Landlord: Gary Pruitt"])).toBe(true);
    // The title's "Rental notes", which the line of that text repeats, and the Landlord line.
    expect(ledger.chars(id)).toBe("Rental notes".length + "Landlord: Gary Pruitt".length);
    expect(ledger.take(w, "candidate", ["Landlord: Gary Pruitt, unpaid"])).toBe(false);
  });

  it("charges a cut text the run a line shows", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m);
    expect(ledger.take(w, "candidate", ["Call (512) 555-0147 aft\u2026"])).toBe(true);
    // The run in the Call line; the Phone line's copy of " (512) 555-0147" is a repeat.
    expect(ledger.chars(id)).toBe("Call (512) 555-0147 aft".length);
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

// Repeated text counts once (OUTPUT-LEDGER-SPEC section 5, N_w), in the charge and in a conversation's limit alike.
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

  it("counts a 500-character message quoted at two levels once: 250 of it is admitted, all 500 refused", () => {
    const msg = Array.from({ length: 84 }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ").slice(0, 500);
    expect(msg.length).toBe(500);
    const half = msg.slice(100, 350);
    // Quoted at two levels the chat has T = 4 + 500 + 502 + 504 = 1510 characters, but its distinct text is the deepest
    // quote, "> > " and the message (504), and the title (4): 508, so its limit is 253. The quotes repeat the message.
    const quoted = chat([msg, `> ${msg}`, `> > ${msg}`]);
    expect(seal(quoted, [half])).toBe(250);
    expect(seal(quoted, [msg])).toBe("test: it reveals 500 characters of window chat-1, over its limit of 253; it was not sent");
    // Unquoted, T = 504 and the limit is 251: the same 250 fits.
    expect(seal(chat([msg]), [half])).toBe(250);
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
