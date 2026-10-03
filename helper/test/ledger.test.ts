// SnippetLedger charges a window for every character of it a request reveals, whichever window the text
// was taken from, so the conversation cap holds at runtime and not only in privacy.test.ts. All text is
// synthetic.
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { AppRef } from "../src/protocol.ts";
import { CONVERSATION_CHARS, SnippetLedger, WINDOW_CHARS, windowBudget } from "../src/privacy.ts";
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
    const ledger = new SnippetLedger(m.windows.values());
    expect(ledger.take(card, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 14, "chat-1": 14 });
    // Taken again from the chat, it is already paid for there.
    expect(ledger.take(chat, "candidate", ["Dana Whitfield"])).toBe(true);
    expect(ledger.chars(chat.window.windowId)).toBe(14);
  });

  it("charges a chat for a text taken from a card that one of its messages quotes", () => {
    const { m, card } = screen(CHAT, CARD);
    const ledger = new SnippetLedger(m.windows.values());
    expect(ledger.take(card, "candidate", ["dana.whitfield@example.com"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 26, "chat-1": 26 });
  });

  it("takes nothing from a card when the chat it reveals has no budget left", () => {
    const { m, chat, card } = screen(CHAT, CARD);
    const budget = windowBudget(chat);
    expect(budget).toBeLessThan(CONVERSATION_CHARS);
    const ledger = new SnippetLedger(m.windows.values());
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
    const ledger = new SnippetLedger(m.windows.values());
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
    const ledger = new SnippetLedger(m.windows.values());
    expect(ledger.plan(["The Notes field holds see you at the review on Thursday"])).toBe(true);
    expect(ledger.chars(chat.window.windowId)).toBe(33);
    expect(ledger.snippets).toEqual([{ windowId: "plan", kind: "candidate", text: "The Notes field holds see you at the review on Thursday" }]);
    const tight = new SnippetLedger(m.windows.values());
    expect(tight.take(chat, "candidate", ["bring the printed deck please"])).toBe(true);
    expect(tight.plan(["The Notes field holds see you at the review on Thursday"])).toBe(false);
    expect(tight.snippets.filter((s) => s.windowId === "plan")).toEqual([]);
  });

  it("leaves a card that is not a conversation its whole budget for a value a chat does not show", () => {
    const { m, card } = screen(CHAT, CARD);
    expect(windowBudget(card)).toBe(WINDOW_CHARS);
    const ledger = new SnippetLedger(m.windows.values());
    expect(ledger.take(card, "candidate", ["Lumen Labs"])).toBe(true);
    expect(ledger.charges()).toEqual({ "card-1": 10 });
  });
});
