// Which windows are conversations. The onboarding copy promises "Never a whole document or
// conversation", and privacy.ts holds a conversation to less than half of its text and at most
// CONVERSATION_CHARS per request, whatever its size, where a short form may go out whole. A window is
// a conversation when any of three signs holds: its app is a known chat or mail app, it has a message
// composer, or it shows a message list.
import type { Frame, Node } from "./protocol.ts";
import type { WindowState } from "./model.ts";

/**
 * Chat and mail apps by bundle id: every window of these apps is a conversation, including a mail
 * compose window or a settings sheet, which costs a fill from them some values and nothing else. The
 * ids are the ones installed on the build Mac (read from each app's Info.plist on 2026-10-02) and, for
 * Telegram and WhatsApp, the published ids of their App Store and desktop builds. Outlook and Teams are
 * not on the B11 brief's list; they are here because they are a mail and a chat app.
 */
export const CONVERSATION_BUNDLES: ReadonlyMap<string, string> = new Map([
  ["com.apple.MobileSMS", "Messages"],
  ["com.apple.mail", "Mail"],
  ["com.tinyspeck.slackmacgap", "Slack"],
  ["com.hnc.Discord", "Discord"],
  ["ru.keepcoder.Telegram", "Telegram"],
  ["com.tdesktop.Telegram", "Telegram Desktop"],
  ["net.whatsapp.WhatsApp", "WhatsApp"],
  ["desktop.WhatsApp", "WhatsApp (Electron)"],
  ["com.t3tools.t3code", "T3 Code"],
  ["com.openai.codex", "Codex (the current ChatGPT app has this id too)"],
  ["com.openai.codex.alternate", "Codex alternate build"],
  ["com.openai.chat", "ChatGPT (classic)"],
  ["com.anthropic.claudefordesktop", "Claude"],
  ["com.microsoft.Outlook", "Outlook"],
  ["com.microsoft.teams2", "Microsoft Teams"],
]);

/** Which sign made a window a conversation, for tests and reports; null when it is not one. */
export type ConversationSign = "bundle" | "composer" | "messageList";

export function conversationSign(w: WindowState): ConversationSign | null {
  if (CONVERSATION_BUNDLES.has(w.app.bundleId)) return "bundle";
  if (hasMessageComposer(w)) return "composer";
  if (hasMessageList(w)) return "messageList";
  return null;
}

export function isConversation(w: WindowState): boolean {
  return conversationSign(w) !== null;
}

const TEXT_FIELD_ROLES = new Set(["AXTextArea", "AXTextField"]);

/**
 * Where the user writes to an agent: an editable text field or area, not secure, in the lower 40% of
 * the window and at least a quarter of its width. The census found one in 117 of 139 T3 Code snapshots
 * and 68 of 71 Codex ones (B6). The pending watch looks for a Stop button beside it.
 */
export function composers(w: WindowState): readonly Frame[] {
  const win = w.window.frame;
  if (win === null || win[3] <= 0) return [];
  const out: Frame[] = [];
  for (const n of w.nodes.values()) {
    if (n.editable !== true || n.frame === undefined || n.states?.includes("secure")) continue;
    if (!TEXT_FIELD_ROLES.has(n.role)) continue;
    const [, y, wd, h] = n.frame;
    if ((y + h / 2 - win[1]) / win[3] >= 0.6 && wd >= win[2] * 0.25) out.push(n.frame);
  }
  return out;
}

/**
 * A form is not a conversation, but B6's composer shape alone takes the lower fields of most forms:
 * the fill calibration fixture's Claim form has four fields in its lower 40%, each over half its width
 * (~/.caret-run/evidence/screen/fill-distractors-v2/cal-1/reader-record.ndjson), and a two-field form
 * has one whenever its second field sits low. So the composer sign also needs what a composer is for:
 * exactly one composer-shaped field, at most MAX_CHAT_FIELDS editable text fields in the window (a
 * search box, the composer and one more), and at least MIN_MESSAGE_LINES lines of text above the
 * composer that are not a field's label (ending in a colon, level with a field, or just above one).
 * Both numbers are assumed; no real chat window was counted for them.
 */
const MAX_CHAT_FIELDS = 3;
const MIN_MESSAGE_LINES = 3;
/** A text this far above a field, overlapping it across, is the field's label. Assumed. */
const LABEL_GAP = 32;

export function hasMessageComposer(w: WindowState): boolean {
  const comps = composers(w);
  const composer = comps[0];
  if (composer === undefined || comps.length !== 1) return false;
  const fields: Frame[] = [];
  for (const n of w.nodes.values()) {
    if (n.editable !== true || !TEXT_FIELD_ROLES.has(n.role)) continue;
    if (fields.length >= MAX_CHAT_FIELDS) return false;
    if (n.frame !== undefined) fields.push(n.frame);
  }
  const labels = (f: Frame): boolean =>
    fields.some(
      (x) =>
        Math.abs(centreY(x) - centreY(f)) <= ROW_POINTS ||
        (f[1] + f[3] <= x[1] && x[1] - (f[1] + f[3]) <= LABEL_GAP && f[0] < x[0] + x[2] && x[0] < f[0] + f[2]),
    );
  const seen = new Set<string>();
  for (const n of w.nodes.values()) {
    if (n.editable === true || n.frame === undefined || n.frame[1] + n.frame[3] > composer[1]) continue;
    const t = rowText(n);
    if (t === null || t.endsWith(":") || seen.has(t) || labels(n.frame)) continue;
    seen.add(t);
    if (seen.size >= MIN_MESSAGE_LINES) return true;
  }
  return false;
}

/**
 * A time stamp as chat and mail lists show them: a clock time ("3:41 PM", "15:41") or a relative one
 * ("just now", "5 min ago", "yesterday at"). Dates alone are left out, since forms and documents are
 * full of them.
 */
const STAMP = /\b(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]\.?m\.?)?|just now|\d{1,2}\s?(?:m|min|mins|minutes?|h|hr|hrs|hours?)\s+ago|yesterday at)(?![\p{L}\p{N}])/iu;
/** A line that is only a time stamp, perhaps with a day: "3:41 PM", "Yesterday at 3:41 PM", "Tue 15:41". */
const STAMP_ONLY_CHARS = 24;
/**
 * A sender as a list shows one: one to four words of letters in any script and case ("Dana Whitfield",
 * "dana whitfield", "张伟"), or a handle that starts with @ and may hold digits ("@sam123").
 */
const NAME = /^(?:\p{L}[\p{L}\p{M}'’.-]*(?:\s+\p{L}[\p{L}\p{M}'’.-]*){0,3}|@[\p{L}\p{N}._-]{1,31})$/u;
/** Separators between a sender and the rest of a line that names both: "Dana Whitfield, see you at 3:41 PM". */
const SENDER_PREFIX = /^([^,:·|–—]{1,40})\s*[,:·|–—]\s*(\S.*)$/u;
/**
 * A line that names a sender says something besides its time: a word of letters once the times and the
 * words that join times are taken out. "Doors: 2:30 PM" and "Start time: 3:00 PM to 3:45 PM" are a
 * labelled value, not a message; "Dana Whitfield, thanks 3:44 PM" is a message.
 */
const TIME_WORDS = new Set(["to", "at", "from", "until", "till", "and", "through", "today", "tomorrow", "yesterday", "noon", "midnight", "am", "pm"]);
const saysSomething = (rest: string): boolean =>
  (rest.replace(new RegExp(STAMP.source, "giu"), " ").match(/\p{L}{2,}/gu) ?? []).some((w) => !TIME_WORDS.has(w.toLowerCase()));
/** Rows within this many points of each other's centre are one row. Assumed. */
const ROW_POINTS = 12;
/** A sender in the stamp's row is looked for this many texts either side of it in document order, so the scan stays linear. */
const ROW_REACH = 8;
/**
 * A message list has at least MIN_ROWS stamped rows with a sender, one of whom comes up twice, as people
 * do in a conversation; or MIN_ROWS_DISTINCT_SENDERS such rows from different people, as an inbox shows.
 * A schedule of three people at three times passes too, which only costs a fill from it some values;
 * labelled times ("Doors: 2:30 PM") do not, since a sender's line must say something (saysSomething).
 * Both numbers are assumed.
 */
const MIN_ROWS = 2;
const MIN_ROWS_DISTINCT_SENDERS = 3;

const isName = (s: string): boolean => s.length <= 40 && NAME.test(s.trim());
const centreY = (f: Frame): number => f[1] + f[3] / 2;

/** A node's first line, its label or value, whitespace collapsed; null for editable fields. */
function rowText(n: Node): string | null {
  return nodeLines(n)[0] ?? null;
}

/** Every line of a node's label or value, whitespace collapsed, empty ones dropped; none for editable fields. */
function nodeLines(n: Node): string[] {
  if (n.editable === true) return [];
  const raw = n.label ?? n.value;
  if (raw === undefined) return [];
  return raw
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l !== "");
}

/**
 * Repeated rows with a sender and a time: stamped lines, each with a sender, either named at the start of
 * the same line or as a name-shaped text just before the stamp (the previous line in document order, or
 * a text to its left in the same row). Every line of every node is read, so a transcript drawn as one
 * multi-line node counts its messages. A calendar day of events at set times can pass, which only costs
 * a fill from it some values. The shapes are assumed from how Slack, Discord and webmail lists draw a
 * message; no real window's tree was read for them.
 */
export function hasMessageList(w: WindowState): boolean {
  const texts: { text: string; frame: Frame | undefined }[] = [];
  for (const n of w.nodes.values()) {
    const lines = nodeLines(n);
    // A multi-line node's frame is the whole block's, so its lines have none of their own.
    for (const text of lines) texts.push({ text, frame: lines.length === 1 ? n.frame : undefined });
  }
  const senders = new Map<string, number>();
  let rows = 0;
  for (let i = 0; i < texts.length; i++) {
    const { text, frame } = texts[i] as { text: string; frame: Frame | undefined };
    if (!STAMP.test(text)) continue;
    let sender: string | null = null;
    const m = SENDER_PREFIX.exec(text);
    const prefix = m?.[1]?.trim();
    if (prefix !== undefined && isName(prefix) && saysSomething(m?.[2] ?? "")) sender = prefix;
    else if (text.length <= STAMP_ONLY_CHARS) {
      const prev = texts[i - 1];
      if (prev !== undefined && isName(prev.text)) sender = prev.text;
      else if (frame !== undefined) {
        const left = texts
          .slice(Math.max(0, i - ROW_REACH), i + ROW_REACH + 1)
          .find((o) => o.frame !== undefined && o.frame[0] < frame[0] && Math.abs(centreY(o.frame) - centreY(frame)) <= ROW_POINTS && isName(o.text));
        if (left !== undefined) sender = left.text;
      }
    }
    if (sender === null) continue;
    rows++;
    const seen = (senders.get(sender) ?? 0) + 1;
    senders.set(sender, seen);
    if ((rows >= MIN_ROWS && seen >= 2) || rows >= MIN_ROWS_DISTINCT_SENDERS) return true;
  }
  return false;
}
