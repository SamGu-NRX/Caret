// SnippetLedger charges a window for every character of it a request reveals, whichever window the text
// was taken from, so the conversation cap holds at runtime and not only in privacy.test.ts. All text is
// synthetic.
import { Disclosure } from "../src/privacy/disclosure.ts";
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
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.take(card, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 14, "chat-1": 14 });
    // Taken again from the chat, it is already paid for there.
    expect(ledger.take(chat, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(ledger.chars(chat.window.windowId)).toBe(14);
  });

  it("charges a chat for a text taken from a card that one of its messages quotes", () => {
    const { m, card } = screen(CHAT, CARD);
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.take(card, "candidate", ["dana.whitfield@example.com"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 26, "chat-1": 26 });
  });

  it("takes nothing from a card when the chat it reveals has no budget left", () => {
    const { m, chat, card } = screen(CHAT, CARD);
    const budget = windowBudget(chat);
    expect(budget).toBeLessThan(CONVERSATION_CHARS);
    const ledger = new Disclosure(m.windows.values());
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
    const ledger = new Disclosure(m.windows.values());
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
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.plan(["The Notes field holds see you at the review on Thursday"])).toBe(true);
    expect(ledger.chars(chat.window.windowId)).toBe(33);
    // The plan text, and the chat's line it holds declared under the chat, so the request names the chat (B17).
    expect(ledger.snippets).toEqual([
      { windowId: "plan", kind: "candidate", text: "The Notes field holds see you at the review on Thursday" },
      { windowId: chat.window.windowId, kind: "candidate", text: "see you at the review on Thursday" },
    ]);
    const tight = new Disclosure(m.windows.values());
    expect(tight.take(chat, "candidate", ["bring the printed deck please"])).toBe(true);
    expect(tight.plan(["The Notes field holds see you at the review on Thursday"])).toBe(false);
    expect(tight.snippets.filter((s) => s.windowId === "plan")).toEqual([]);
  });

  it("leaves a card that is not a conversation its whole budget for a value a chat does not show", () => {
    const { m, card } = screen(CHAT, CARD);
    expect(windowBudget(card)).toBe(WINDOW_CHARS);
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.take(card, "candidate", ["Lumen Labs"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 10 });
  });
});

describe("a mixed note's budget (B25 lead decision 3)", () => {
  const LONG = "Deliver around 7:30 pm, and please use the side door and ring twice because the front bell is broken";
  const note = (lines: readonly string[]): { m: ScreenModel; w: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Order note.txt", app: NOTES }));
    return { m, w: m.windows.get("note-1") as WindowState };
  };
  const SHORT = ["Pizza order", "Name: Jordan Reyes", "Phone: (512) 555-0147"];

  it("is the short lines' characters plus just under half the prose's, at most WINDOW_CHARS", () => {
    const { w } = note([...SHORT, LONG]);
    const short = ["Order note.txt", ...SHORT].join("").length;
    expect(LONG.length).toBeGreaterThan(80);
    expect(windowBudget(w)).toBe(short + Math.floor((LONG.length - 1) / 2));
    // Thirty short lines and no prose: no card (over 24 lines), not large, so every line may go.
    const many = note(Array.from({ length: 30 }, (_, i) => `Item ${i}: a value`)).w;
    expect(windowBudget(many)).toBe(["Order note.txt", ...Array.from({ length: 30 }, (_, i) => `Item ${i}: a value`)].join("").length);
    // Past WINDOW_CHARS of short lines it is capped.
    const big = note(Array.from({ length: 40 }, (_, i) => `Line number ${i} of a long list of values here`)).w;
    expect(windowBudget(big)).toBe(WINDOW_CHARS);
  });

  it("takes every labelled line, and never half the prose, however much budget is left", () => {
    const { m, w } = note([...SHORT, LONG]);
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.take(w, "candidate", SHORT)).toBe(true);
    // Under half the sentence fits; the rest of it does not, though the total budget has room.
    const half = Math.floor((LONG.length - 1) / 2);
    expect(ledger.take(w, "candidate", [LONG.slice(0, half)])).toBe(true);
    expect(ledger.take(w, "candidate", [LONG.slice(half, half + 5)])).toBe(false);
    expect(ledger.chars(w.window.windowId)).toBeLessThan(windowBudget(w));
    // A whole sentence is refused on its own as well.
    const fresh = new Disclosure(m.windows.values());
    expect(fresh.take(w, "candidate", [LONG])).toBe(false);
  });

  it("counts a value inside the sentence as prose, once, and a value on its own line as not", () => {
    const { m, w } = note([...SHORT, LONG]);
    const id = w.window.windowId;
    const ledger = new Disclosure(m.windows.values());
    // "Jordan Reyes" sits in a short line, so it spends none of the prose share.
    expect(ledger.take(w, "candidate", ["Jordan Reyes"])).toBe(true);
    const half = Math.floor((LONG.length - 1) / 2);
    expect(ledger.take(w, "candidate", [LONG.slice(0, half)])).toBe(true);
    // "7:30 pm" is inside the part of the sentence already taken: it reveals nothing more (B26 lead decision 2).
    const before = ledger.chars(id);
    expect(ledger.take(w, "candidate", ["7:30 pm"])).toBe(true);
    expect(ledger.chars(id)).toBe(before);
    // The sentence's last word was not revealed, and the prose share is spent.
    expect(ledger.take(w, "candidate", ["broken"])).toBe(false);
  });
});

describe("the distinct characters a request reveals (B26 lead decision 2)", () => {
  const LINES = ["Rental notes", "Phone: (512) 555-0147", "Call (512) 555-0147 after six", "Landlord: Gary Pruitt"];
  const card = (): { m: ScreenModel; w: WindowState; id: string } => {
    const m = new ScreenModel();
    m.apply(snap(LINES.map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-2", title: "Rental notes.txt", app: NOTES }));
    return { m, w: m.windows.get("note-2") as WindowState, id: "note-2" };
  };
  const PHONE = "(512) 555-0147";

  it("charges a value, then the line holding it only its other characters", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.take(w, "candidate", [PHONE])).toBe(true);
    expect(ledger.chars(id)).toBe(PHONE.length);
    expect(ledger.take(w, "candidate", ["Phone: (512) 555-0147"])).toBe(true);
    expect(ledger.chars(id)).toBe("Phone: (512) 555-0147".length);
  });

  it("charges a value inside a line already taken nothing", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.take(w, "candidate", ["Phone: (512) 555-0147"])).toBe(true);
    expect(ledger.take(w, "candidate", [PHONE])).toBe(true);
    expect(ledger.chars(id)).toBe("Phone: (512) 555-0147".length);
  });

  it("charges two distinct lines that hold one value in full, the value once", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.take(w, "candidate", [PHONE, "Phone: (512) 555-0147", "Call (512) 555-0147 after six"])).toBe(true);
    expect(ledger.chars(id)).toBe("Phone: (512) 555-0147".length + "Call (512) 555-0147 after six".length);
  });

  it("charges a text no one line shows by the runs of it the lines show, and refuses one with a word no line shows", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m.windows.values());
    // Two lines joined by a space: both lines in full; the space between them shows nothing of the window (PV2: a text
    // is located where it is cut, as runs of its words that lines show).
    expect(ledger.take(w, "candidate", ["Rental notes Landlord: Gary Pruitt"])).toBe(true);
    expect(ledger.chars(id)).toBe("Rental notes".length + "Landlord: Gary Pruitt".length);
    // A word no line shows: the text is no cut of the window, and nothing is taken.
    expect(ledger.take(w, "candidate", ["Landlord: Gary Pruitt, unpaid"])).toBe(false);
  });

  it("charges a cut text the part a line shows", () => {
    const { m, w, id } = card();
    const ledger = new Disclosure(m.windows.values());
    expect(ledger.take(w, "candidate", ["Call (512) 555-0147 aft…"])).toBe(true);
    expect(ledger.chars(id)).toBe("Call (512) 555-0147 aft".length);
  });
});

describe("plan text that quotes part of a line (B25 review)", () => {
  const LONG = "Deliver around 7:30 pm, and please use the side door and ring twice because the front bell is broken since May";
  const note = (): { m: ScreenModel; w: WindowState } => {
    const m = new ScreenModel();
    m.apply(snap(["Pizza order", "Name: Jordan Reyes", LONG].map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-1", title: "Order note.txt", app: NOTES }));
    return { m, w: m.windows.get("note-1") as WindowState };
  };

  it("charges the window for the part it quotes, and refuses more than the prose share", () => {
    const { m } = note();
    const most = new Disclosure(m.windows.values());
    expect(most.plan([`Copy this: ${LONG.slice(0, 100)}`])).toBe(false);
    const some = new Disclosure(m.windows.values());
    const quote = LONG.slice(0, 30);
    expect(some.plan([`Put "${quote}" in Notes`])).toBe(true);
    expect(some.chars("note-1")).toBe(quote.length);
    // The quoted part is declared under the window it came from.
    expect(some.declared().snippets).toContainEqual({ windowId: "note-1", kind: "candidate", text: quote });
  });

  it("does not charge for a few words any page might hold", () => {
    const { m } = note();
    const l = new Disclosure(m.windows.values());
    expect(l.plan(["ring at the side door please"])).toBe(true);
    expect(l.chars("note-1")).toBe(0);
  });
});

describe("the B26 review's undercharges", () => {
  it("charges a plan text joining two sentences' ends to each sentence's prose share", () => {
    const m = new ScreenModel();
    const a = `left-only-start ${"x".repeat(65)}ABCDEFGHIJKLMNOP`;
    const b = `ABCDEFGHIJKLMNOP${"y".repeat(65)} right-only-end`;
    const shorts = Array.from({ length: 8 }, (_, i) => `Short value ${i}: sample information here`);
    m.apply(snap([a, b, ...shorts].map((l, i) => text(`n${i}`, l)), { at: 1, windowId: "note-3", title: "Notes.txt", app: NOTES }));
    const joined = `${"x".repeat(65)}ABCDEFGHIJKLMNOP${"y".repeat(65)}`;
    expect(new Disclosure(m.windows.values()).plan([joined])).toBe(false);
    expect(new Disclosure(m.windows.values()).memory([joined])).toBe(false);
  });

  it("charges a cut line to every window that shows the line, not only the one it was taken from", () => {
    const LINE = "Deliver around 7:30 pm, and please use the side door and ring twice because the front bell is broken since May";
    const m = new ScreenModel();
    m.apply(snap([text("n0", "Order"), text("n1", LINE)], { at: 1, windowId: "note-4", title: "Order note.txt", app: NOTES }));
    m.apply(snap([text("c0", "Kofi: running late"), text("c1", LINE)], { at: 2, windowId: "chat-4", title: "Chat", app: { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" } }));
    const note = m.windows.get("note-4") as WindowState;
    const ledger = new Disclosure(m.windows.values(), { consented: new Set(["note-4"]) });
    // The chat is a conversation held under half of its text, so 99 characters of its line do not fit.
    expect(ledger.take(note, "candidate", [`${LINE.slice(0, 99)}…`])).toBe(false);
    expect(ledger.chars("chat-4")).toBe(0);
  });
});
