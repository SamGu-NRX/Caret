// SnippetLedger charges a window for every character of it a request reveals, whichever window the text
// was taken from, so the conversation cap holds at runtime and not only in privacy.test.ts. All text is
// synthetic.
import { Disclosure, LedgerRefused } from "../src/privacy/disclosure.ts";
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

// Run-level dedupe (N_w) was measured and dropped (~/.caret-run/evidence/screen/pv2/simplify/NW-DECISION.md): it lost
// held-16. So every copy of a text a window shows is charged, and a conversation's limit is under half of all its lines.
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
