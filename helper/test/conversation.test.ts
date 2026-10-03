// Which windows count as conversations, and the budget privacy.ts gives them. Every window here is
// synthetic; snap() gives each an 800 by 600 frame at the origin.
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { AppRef, Frame, Node } from "../src/protocol.ts";
import { CONVERSATION_BUNDLES, conversationSign } from "../src/conversation.ts";
import { CONVERSATION_CHARS, WINDOW_CHARS, setConversationCap, windowBudget } from "../src/privacy.ts";
import { snap } from "./builders.ts";

const OTHER: AppRef = { pid: 4040, bundleId: "dev.caret.browser", name: "Browser" };
let k = 0;
const t = (label: string, frame?: Frame): Node => ({ key: `n${k++}`, parent: null, role: "AXStaticText", label, ...(frame === undefined ? {} : { frame }) });
const f = (frame: Frame, role = "AXTextField"): Node => ({ key: `n${k++}`, parent: null, role, editable: true, frame });

function windowOf(nodes: Node[], app: AppRef = OTHER): WindowState {
  const m = new ScreenModel();
  m.apply(snap(nodes, { at: 1, windowId: `${app.pid}-1`, app, title: "Window" }));
  return m.windows.get(`${app.pid}-1`) as WindowState;
}

/** A Slack-like list: each message a sender and a time on one row, its text on the row below. */
function slackRows(senders: readonly string[]): Node[] {
  return senders.flatMap((who, i) => {
    const y = 40 + i * 60;
    return [t(who, [100, y, 120, 18]), t(`${((8 + i) % 12) + 1}:${String(i % 60).padStart(2, "0")} AM`, [230, y, 60, 18]), t(`message ${i} about the venue`, [100, y + 22, 500, 18])];
  });
}

afterEach(() => setConversationCap(true));

describe("conversation windows", () => {
  it("knows every chat and mail app in the table by bundle id alone", () => {
    for (const bundleId of CONVERSATION_BUNDLES.keys()) expect(conversationSign(windowOf([t("Hello")], { pid: 7, bundleId, name: "x" })), bundleId).toBe("bundle");
    expect(conversationSign(windowOf([t("Hello")]))).toBeNull();
  });

  it("finds a composer: one wide field at the bottom, with a search box above", () => {
    expect(conversationSign(windowOf([f([20, 10, 200, 22]), t("Earlier text"), f([20, 520, 700, 60], "AXTextArea")]))).toBe("composer");
  });

  it("does not take a form's lower fields for a composer", () => {
    // Four wide fields in the lower 40%, as the calibration fixture's Claim form has.
    const form = [400, 450, 500, 550].map((y) => f([200, y, 320, 24]));
    expect(conversationSign(windowOf([f([200, 100, 320, 24]), ...form]))).toBeNull();
    // One field in the lower part, but a form of five.
    expect(conversationSign(windowOf([100, 150, 200, 250].map((y) => f([200, y, 320, 24])).concat(f([200, 500, 320, 24]))))).toBeNull();
    // A secure field is never a composer, nor a narrow one.
    expect(conversationSign(windowOf([{ ...f([20, 520, 700, 30]), states: ["secure"] }]))).toBeNull();
    expect(conversationSign(windowOf([f([20, 520, 150, 30])]))).toBeNull();
  });

  it("finds a message list: stamped rows with senders, one sender twice", () => {
    expect(conversationSign(windowOf(slackRows(["Dana Whitfield", "Kofi Mensah", "Dana Whitfield"])))).toBe("messageList");
  });

  it("finds a message list whose lines name the sender and the time together", () => {
    const lines = ["Dana Whitfield, see you at the venue, 3:41 PM", "Kofi: running ten minutes late · 3:44 PM", "Dana Whitfield, no problem, 3:45 PM"];
    expect(conversationSign(windowOf(lines.map((l) => t(l))))).toBe("messageList");
  });

  it("finds a stamp whose sender is the text before it, as a list without frames reads", () => {
    expect(conversationSign(windowOf(["priya", "Yesterday at 9:12 AM", "hi", "dana", "just now", "hello", "priya", "5 min ago", "ok"].map((l) => t(l))))).toBe("messageList");
  });

  it("needs five rows when no sender repeats, and three rows at least", () => {
    expect(conversationSign(windowOf(slackRows(["Ines Okafor", "Kofi Mensah", "Aiko Tanaka", "Bram Dekker"])))).toBeNull();
    expect(conversationSign(windowOf(slackRows(["Ines Okafor", "Kofi Mensah", "Aiko Tanaka", "Bram Dekker", "Lucia Moreau"])))).toBe("messageList");
    expect(conversationSign(windowOf(slackRows(["Dana Whitfield", "Dana Whitfield"])))).toBeNull();
  });

  it("leaves cards and forms with times in them alone", () => {
    // The calibration fixture's Reference and Inbox: one time each, after a line with a date.
    expect(conversationSign(windowOf(["Design review with Priya Raman", "Thursday, October 8, 2026", "3:00 PM to 3:45 PM", "https://meet.example.com/xqp-rtz-kfa"].map((l) => t(l))))).toBeNull();
    // Labelled times: a sender-shaped label needs five rows, and "Start time" is not one.
    expect(conversationSign(windowOf(["Start time: 3:00 PM", "End time: 3:45 PM", "Doors: 2:30 PM", "Break: 3:15 PM"].map((l) => t(l))))).toBeNull();
    // Times with nobody beside them.
    expect(conversationSign(windowOf(["3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM", "5:00 PM"].map((l) => t(l))))).toBeNull();
  });
});

describe("the budget of a conversation", () => {
  /** A short chat of ten distinct lines, title included, each short enough that the card rule alone would send it whole. */
  const shortChat = (): WindowState => windowOf(slackRows(["Dana Whitfield", "Kofi Mensah", "Dana Whitfield"]).concat(t("Kofi Mensah"), t("10:44 AM")));
  const textChars = (w: WindowState): number => [...new Set([w.window.title, ...[...w.nodes.values()].map((n) => n.label ?? "")])].reduce((n, s) => n + s.length, 0);

  it("is under half its text however short, and the card rule no longer sends it whole", () => {
    const w = shortChat();
    expect(windowBudget(w)).toBe(Math.floor((textChars(w) - 1) / 2));
    setConversationCap(false);
    expect(windowBudget(shortChat())).toBe(WINDOW_CHARS);
  });

  it("is at most CONVERSATION_CHARS however long", () => {
    const long = windowOf(slackRows(Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? "Dana Whitfield" : "Kofi Mensah"))));
    expect(textChars(long)).toBeGreaterThan(2 * WINDOW_CHARS);
    expect(windowBudget(long)).toBe(CONVERSATION_CHARS);
    const mid = windowOf(slackRows(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? "Dana Whitfield" : "Kofi Mensah"))));
    expect(textChars(mid)).toBeGreaterThan(2 * CONVERSATION_CHARS);
    expect(windowBudget(mid)).toBe(CONVERSATION_CHARS);
  });

  it("leaves a card that is not a conversation its whole budget", () => {
    expect(windowBudget(windowOf(["Dana Whitfield", "Lumen Labs", "+1 (512) 555-0142"].map((l) => t(l))))).toBe(WINDOW_CHARS);
  });
});
