// Which windows count as conversations, and the budget privacy.ts gives them. Every window here is
// synthetic; snap() gives each an 800 by 600 frame at the origin.
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import type { AppRef, Frame, Node } from "../src/protocol.ts";
import { CONVERSATION_BUNDLES, conversationSign } from "../src/conversation.ts";
import { CONVERSATION_CHARS, SnippetLedger, WINDOW_CHARS, setConversationCap, windowBudget } from "../src/privacy.ts";
import { buildLookRequest } from "../src/tasks/pending.ts";
import { proposeFill } from "../src/fill/fill.ts";
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

  it("finds a composer: one wide field at the bottom under messages, with a search box above", () => {
    const messages = ["Are we still on?", "Yes, see you there", "Bring the badges"].map((l, i) => t(l, [40, 100 + i * 40, 400, 18]));
    expect(conversationSign(windowOf([f([20, 10, 200, 22]), ...messages, f([20, 520, 700, 60], "AXTextArea")]))).toBe("composer");
    // The same window with only two lines above the composer, or with its lines below it, is not one.
    expect(conversationSign(windowOf([f([20, 10, 200, 22]), ...messages.slice(0, 2), f([20, 520, 700, 60], "AXTextArea")]))).toBeNull();
    expect(conversationSign(windowOf([f([20, 300, 700, 60], "AXTextArea"), ...["a b", "c d", "e f"].map((l, i) => t(l, [40, 400 + i * 40, 400, 18]))]))).toBeNull();
  });

  it("does not take a form's lower fields for a composer", () => {
    // Four wide fields in the lower 40%, as the calibration fixture's Claim form has.
    const form = [400, 450, 500, 550].map((y) => f([200, y, 320, 24]));
    expect(conversationSign(windowOf([f([200, 100, 320, 24]), ...form]))).toBeNull();
    // One field in the lower part, but a form of five.
    expect(conversationSign(windowOf([100, 150, 200, 250].map((y) => f([200, y, 320, 24])).concat(f([200, 500, 320, 24]))))).toBeNull();
    // A two-field form whose second field sits low, its labels beside and above the fields, and a heading.
    const two = [t("Contact details", [200, 40, 300, 22]), t("Name:", [100, 100, 90, 18]), f([200, 98, 320, 24]), t("Work email", [200, 470, 200, 18]), f([200, 492, 320, 24]), t("Email:", [100, 494, 90, 18])];
    expect(conversationSign(windowOf(two))).toBeNull();
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

  it("needs two rows when a sender repeats, and three when none does", () => {
    expect(conversationSign(windowOf(slackRows(["Dana Whitfield", "Dana Whitfield"])))).toBe("messageList");
    expect(conversationSign(windowOf(slackRows(["Ines Okafor", "Kofi Mensah"])))).toBeNull();
    expect(conversationSign(windowOf(slackRows(["Ines Okafor", "Kofi Mensah", "Aiko Tanaka"])))).toBe("messageList");
    expect(conversationSign(windowOf(slackRows(["Dana Whitfield"])))).toBeNull();
  });

  it("reads senders in any script and case, and handles with digits", () => {
    for (const who of ["张伟", "dana whitfield", "@sam123"]) expect(conversationSign(windowOf(slackRows([who, "Kofi Mensah", who]))), who).toBe("messageList");
  });

  it("reads a transcript drawn as one multi-line node", () => {
    const transcript = ["Dana Whitfield, can you send the form? 3:41 PM", "Kofi Mensah, on it 3:42 PM", "Dana Whitfield, thanks 3:44 PM"].join("\n");
    expect(conversationSign(windowOf([t(transcript, [40, 40, 600, 200])]))).toBe("messageList");
  });

  it("finds a message list after thousands of other nodes", () => {
    const chrome = Array.from({ length: 5000 }, (_, i) => t(`Nav item ${i}`));
    expect(conversationSign(windowOf([...chrome, ...slackRows(["Dana Whitfield", "Kofi Mensah", "Dana Whitfield"])]))).toBe("messageList");
  });

  it("leaves cards and forms with times in them alone", () => {
    // The calibration fixture's Reference and Inbox: one time each, after a line with a date.
    expect(conversationSign(windowOf(["Design review with Priya Raman", "Thursday, October 8, 2026", "3:00 PM to 3:45 PM", "https://meet.example.com/xqp-rtz-kfa"].map((l) => t(l))))).toBeNull();
    // Labelled times: the line after the label says nothing but the time.
    expect(conversationSign(windowOf(["Start time: 3:00 PM", "End time: 3:45 PM", "Doors: 2:30 PM", "Break: 3:15 PM", "Talk: 3:00 PM to 3:45 PM"].map((l) => t(l))))).toBeNull();
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

  it("charges the lines a taken text contains, so nested labels cannot carry half a chat", () => {
    const MESSAGES: AppRef = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
    const w = windowOf(["Alice, meet Bob at 3:41 PM", "Alice", "meet Bob", "Bob at 3:41 PM", "3:41 PM", "Bob"].map((l) => t(l)), MESSAGES);
    const budget = windowBudget(w);
    const ledger = new SnippetLedger([w]);
    // The parent line is 26 characters, but with the four lines inside it, 59: over the budget.
    expect(budget).toBeLessThan(59);
    expect(ledger.take(w, "candidate", ["Alice, meet Bob at 3:41 PM"])).toBe(false);
    expect(ledger.take(w, "candidate", ["meet Bob"])).toBe(true);
    // "Bob" was paid for inside "meet Bob", so it is free; "Bob at 3:41 PM" pays for itself and "3:41 PM".
    expect(ledger.chars(w.window.windowId)).toBe(11);
    expect(ledger.take(w, "candidate", ["Bob"])).toBe(true);
    expect(ledger.chars(w.window.windowId)).toBe(11);
  });

  it("charges a window's text that reads like an indicator line", () => {
    const MESSAGES: AppRef = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
    const w = windowOf([t("[progress bar]"), { key: "p", parent: null, role: "AXProgressIndicator" }], MESSAGES);
    const { req } = buildLookRequest(w, [w], [{ rule: "progressBar", line: "[progress bar]" }]);
    expect(req.snippets.map((x) => x.text)).not.toContain("[progress bar]");
    expect(JSON.stringify(req.state)).not.toContain("[progress bar]");
  });

  it("fills a two-field form whose second field sits low", async () => {
    const m = new ScreenModel();
    m.apply(snap([t("Dana Whitfield"), t("dana.whitfield@example.com")], { at: 1, windowId: "6160-1", app: { pid: 6160, bundleId: "dev.caret.mail", name: "Mail Fixture" }, title: "Card", focused: true }));
    const form = [t("Name:", [100, 100, 90, 18]), { ...f([200, 98, 320, 24]), label: "Name" }, t("Email:", [100, 494, 90, 18]), { ...f([200, 492, 320, 24]), label: "Email" }];
    m.apply(snap(form, { at: 2, windowId: "5150-1", title: "Form", focused: true }));
    const w = m.windows.get("5150-1") as WindowState;
    expect(conversationSign(w)).toBeNull();
    const ask = async () => ({ model: "x", answers: { f1: { choice: "none", confidence: 1 }, f2: { choice: "none", confidence: 1 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 });
    await expect(proposeFill(m, ask, "5150-1", form[1]?.key as string, 10)).resolves.toMatchObject({ fields: [{}, {}] });
  });
});
