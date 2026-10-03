// Synthetic desks: sets of windows the privacy test and the live replay (scripts/live-replay.ts) both
// load. Every name, number and address is invented.
import type { ReaderMessage } from "../src/protocol.ts";
import { field, focus, snap, text, value } from "./builders.ts";
import { CODEX, T3, agentSnap, codexWindow, t3Window } from "./agent-fixtures.ts";

/** Long paragraphs: text no fill can use, since every line is over 80 characters. */
export const NOTES = "7070-1";
export function notesWindow(at: number): ReaderMessage {
  const para = (i: number): string =>
    `Paragraph ${i} of the private notes, which runs well past eighty characters so that no fill could ever take it as a value.`;
  return snap(
    Array.from({ length: 12 }, (_, i) => text(`dev.caret.notes/standard/statictext:p${i}~0`, para(i))),
    { at, windowId: NOTES, app: { pid: 7070, bundleId: "dev.caret.notes", name: "Notes" }, title: "Private notes" },
  );
}

/**
 * A chat of 40 short, different messages, each one a fill could take, every line naming its sender and
 * time: a conversation, so a request may carry less than half of it and at most 600 characters. Without
 * the budget the generator would take every line.
 */
export const CHAT = "7171-1";
export function chatWindow(at: number): ReaderMessage {
  const lines = Array.from({ length: 40 }, (_, i) =>
    text(`dev.caret.chat/standard/statictext:m${i}~0`, `${i % 2 === 0 ? "Kofi Mensah" : "Aiko Tanaka"}, table ${i} is set for ${i + 4} guests, ${(i % 12) + 1}:${String(i).padStart(2, "0")} PM`),
  );
  return snap(lines, { at, windowId: CHAT, app: { pid: 7171, bundleId: "dev.caret.chat", name: "Chat" }, title: "Team chat" });
}

/**
 * Short chats, each small enough to pass as a card (24 lines or fewer, none over 80 characters), so that
 * before B11 a fill could carry every line. The values the form wants are in them, as messages.
 */
export const SHORT_CHAT = "7272-1";
export const MESSAGES_CHAT = "7373-1";
export const COMPOSER_CHAT = "7474-1";
export const MAIL_THREAD = "7575-1";
export const CHECKOUT = "5150-2";
/** Ten lines: two senders, four times and four messages, in rows as Slack or a web chat draws them. */
function shortChat(at: number): ReaderMessage {
  const K = "dev.caret.webchat/standard/statictext";
  const rows: [string, string, string][] = [
    ["Dana Whitfield", "3:41 PM", "Can you send the vendor form back today?"],
    ["Kofi Mensah", "3:42 PM", "Sure, which email should I put on it?"],
    ["Dana Whitfield", "3:44 PM", "dana.whitfield@example.com"],
    ["Kofi Mensah", "3:45 PM", "Got it, sending in ten"],
  ];
  const nodes = rows.flatMap(([who, when, body], i) => [
    text(`${K}:sender${i}~0`, who, [100, 40 + i * 60, 140, 18]),
    text(`${K}:time${i}~0`, when, [250, 40 + i * 60, 60, 18]),
    text(`${K}:body${i}~0`, body, [100, 62 + i * 60, 500, 18]),
  ]);
  return snap(nodes, {
    at,
    windowId: SHORT_CHAT,
    app: { pid: 7272, bundleId: "dev.caret.webchat", name: "Browser" },
    title: "Chat with Dana",
    focused: true,
    values: [value("email", "dana.whitfield@example.com", `${K}:body2~0`)],
  });
}
/** Six lines in Messages: its bundle id alone makes it a conversation. */
function messagesChat(at: number): ReaderMessage {
  const K = "com.apple.MobileSMS/standard/statictext";
  const lines = ["Dana", "Are we still on for Thursday?", "Yes, 3 PM at the office", "My cell is +1 (512) 555-0142", "Perfect, see you", "Read"];
  return snap(
    lines.map((l, i) => text(`${K}:l${i}~0`, l, [100, 40 + i * 30, 400, 18])),
    { at, windowId: MESSAGES_CHAT, app: { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" }, title: "Dana Whitfield", focused: true, values: [value("phone", "+1 (512) 555-0142", `${K}:l3~0`)] },
  );
}
/** A web chat with no times: five lines and the message composer at the bottom. */
function composerChat(at: number): ReaderMessage {
  const K = "dev.caret.helpdesk/standard";
  const lines = ["Support", "Hi Dana, how can we help?", "My order ORD-2026-48213 has not shipped", "Sorry about that, checking now", "It ships tomorrow"];
  return snap(
    [...lines.map((l, i) => text(`${K}/statictext:l${i}~0`, l, [100, 40 + i * 30, 400, 18])), field(`${K}/textarea:composer~0`, "", { role: "AXTextArea", frame: [40, 520, 700, 50], placeholder: "Write a message" })],
    { at, windowId: COMPOSER_CHAT, app: { pid: 7474, bundleId: "dev.caret.helpdesk", name: "Helpdesk" }, title: "Support chat", focused: true },
  );
}
/** A short mail thread in a mail app: a conversation by bundle id. */
function mailThread(at: number): ReaderMessage {
  const K = "com.apple.mail/standard/statictext";
  const lines = ["Dana Whitfield <dana.whitfield@example.com>", "Re: vendor form", "Thanks Kofi, my name on it should be Dana Whitfield.", "Dana"];
  return snap(
    lines.map((l, i) => text(`${K}:l${i}~0`, l, [100, 40 + i * 30, 500, 18])),
    { at, windowId: MAIL_THREAD, app: { pid: 7575, bundleId: "com.apple.mail", name: "Mail" }, title: "Re: vendor form", focused: true, values: [value("email", "dana.whitfield@example.com", `${K}:l0~0`)] },
  );
}
/** The form the chats' values go into, focused last. */
function checkout(at: number): ReaderMessage[] {
  const F = "dev.caret.fixture/standard/textfield";
  const fields = ["Name", "Email", "Phone"].map((label, i) => field(`${F}:${label.toLowerCase()}~0`, "", { label, frame: [100, 40 + i * 40, 200, 24] }));
  return [snap(fields, { at, windowId: CHECKOUT, title: "Checkout", focused: true }), focus(CHECKOUT, `${F}:name~0`, at + 100)];
}
export const shortChats = (): ReaderMessage[] => [mailThread(1000), composerChat(1100), messagesChat(1200), shortChat(1300), ...checkout(3000)];

/** Two agent threads behind 450-line transcripts: T3 Code finishes its turn, Codex waits on an approval. */
export function agentThreads(): ReaderMessage[] {
  const threads = [{ title: "Venue shortlist", status: "Working" }, { title: "Badge printing" }];
  const t3 = (o: Parameters<typeof t3Window>[0], at: number, focused: boolean) => agentSnap(T3, t3Window(o), { at, windowId: "8101-1", title: "Seating chart", focused });
  return [
    t3({ running: true, threads, transcriptLines: 450 }, 1000, true),
    agentSnap(CODEX, codexWindow({ running: true, threads, transcriptLines: 450, last: ["Allow this command? pnpm install --frozen-lockfile"] }), { at: 1100, windowId: "8202-1", title: "Badge export", focused: true }),
    t3({ running: false, threads, transcriptLines: 450, last: ["Updated all four seating files and ran the checks: 48 of 48 passed."] }, 1200, false),
  ];
}
