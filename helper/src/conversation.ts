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
 * (~/.caret-run/evidence/screen/fill-distractors-v2/cal-1/reader-record.ndjson). A message composer is
 * the one place to write in the lower part of its window, so the composer sign holds only when exactly
 * one composer-shaped field is there and the window has at most MAX_CHAT_FIELDS editable text fields in
 * all: a search box, a composer and one more. The limit is assumed; no real chat window was counted.
 */
const MAX_CHAT_FIELDS = 3;

export function hasMessageComposer(w: WindowState): boolean {
  if (composers(w).length !== 1) return false;
  let fields = 0;
  for (const n of w.nodes.values()) if (n.editable === true && TEXT_FIELD_ROLES.has(n.role) && ++fields > MAX_CHAT_FIELDS) return false;
  return true;
}

/**
 * A time stamp as chat and mail lists show them: a clock time ("3:41 PM", "15:41") or a relative one
 * ("just now", "5 min ago", "yesterday at"). Dates alone are left out, since forms and documents are
 * full of them.
 */
const STAMP = /\b(?:(?:[01]?\d|2[0-3]):[0-5]\d(?:\s?[ap]\.?m\.?)?|just now|\d{1,2}\s?(?:m|min|mins|minutes?|h|hr|hrs|hours?)\s+ago|yesterday at)(?![\p{L}\p{N}])/iu;
/** A line that is only a time stamp, perhaps with a day: "3:41 PM", "Yesterday at 3:41 PM", "Tue 15:41". */
const STAMP_ONLY_CHARS = 24;
/** A sender as a list shows one: one to four capitalised words, or one handle, with no digits. */
const NAME = /^(?:@?\p{Lu}[\p{L}'’.-]*(?:\s+@?\p{Lu}[\p{L}'’.-]*){0,3}|@?[\p{Ll}][\p{L}._-]{1,31})$/u;
/** Separators between a sender and the rest of a line that names both: "Dana Whitfield, see you at 3:41 PM". */
const SENDER_PREFIX = /^([^,:·|–—]{1,40})\s*[,:·|–—]\s*\S/u;
/** Rows within this many points of each other's centre are one row. Assumed. */
const ROW_POINTS = 12;
/** A sender in the stamp's row is looked for this many texts either side of it in document order, so the scan stays linear. */
const ROW_REACH = 8;
/** A message list has at least this many stamped rows with a sender. Assumed, as are the two below. */
const MIN_ROWS = 3;
/** Without a sender seen twice, as in an inbox of different people, it takes this many rows. */
const MIN_ROWS_DISTINCT_SENDERS = 5;
/** Nodes read before the scan gives up and says no; a list shows its stamps long before this. */
const MAX_NODES = 4000;

const isName = (s: string): boolean => s.length <= 40 && NAME.test(s.trim());
const centreY = (f: Frame): number => f[1] + f[3] / 2;

/** One line per node: its label or value, first line only, whitespace collapsed. Editable fields are skipped. */
function rowText(n: Node): string | null {
  if (n.editable === true) return null;
  const raw = n.label ?? n.value;
  if (raw === undefined) return null;
  const t = (raw.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
  return t === "" ? null : t;
}

/**
 * Repeated rows with a sender and a time: at least MIN_ROWS lines carrying a time stamp, each with a
 * sender, either named at the start of the same line or as a name-shaped text just before the stamp
 * (the previous text in document order, or one to its left in the same row). Some sender has to come
 * up twice, as people do in a conversation, unless there are MIN_ROWS_DISTINCT_SENDERS such rows. A
 * calendar day of five events at set times passes too, which only costs a fill from it some values.
 * The shapes are assumed from how Slack, Discord and webmail lists draw a message; no real window's
 * tree was read for them.
 */
export function hasMessageList(w: WindowState): boolean {
  const texts: { text: string; frame: Frame | undefined }[] = [];
  let read = 0;
  for (const n of w.nodes.values()) {
    if (++read > MAX_NODES) break;
    const t = rowText(n);
    if (t !== null) texts.push({ text: t, frame: n.frame });
  }
  const senders = new Map<string, number>();
  let rows = 0;
  for (let i = 0; i < texts.length; i++) {
    const { text, frame } = texts[i] as { text: string; frame: Frame | undefined };
    if (!STAMP.test(text)) continue;
    let sender: string | null = null;
    const prefix = SENDER_PREFIX.exec(text)?.[1]?.trim();
    if (prefix !== undefined && isName(prefix)) sender = prefix;
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
    senders.set(sender, (senders.get(sender) ?? 0) + 1);
  }
  if (rows < MIN_ROWS) return false;
  return rows >= MIN_ROWS_DISTINCT_SENDERS || [...senders.values()].some((k) => k >= 2);
}
