// Seeded end-to-end consistency check of the output ledger (OUTPUT-LEDGER-SPEC sections 4-7), the cases and the
// independent counter. test/ledger-fuzz.test.ts runs a fixed-seed sample in the suite; scripts/ledger-fuzz.ts runs the
// full set and minimizes a flagged case.
//
// Each case builds a synthetic desk (one or two conversations, a TextEdit note, a form; a webmail tab read through
// TabSource in tab mode), runs proposeFill through a scripted Jev that seals every request (jev.ts sealRequest) and posts
// it (send.ts sendable) as the client does, and keeps the requests that pass both. The counter then reads each passing
// request's final bytes and counts, per conversation and per operation, the source positions the request carries: rule E
// (12-scalar runs and whole contained lines) plus the source positions of the values the scripted answers chose from
// that window. A case is flagged when that count exceeds the window's limit: min(600, floor((T-1)/2)), T the union of
// every line any state of the window showed, a window that was ever a conversation counted as one (section 7).
//
// The counter shares nothing with the ledger's measure: its own inventory, normalization (NFKC, case fold, whitespace
// collapse, scalar by scalar with origin maps), JSON walk and matcher. Its count is a lower bound of what a request
// takes, by three constraints:
//   - a value a window shows more than once is counted at the occurrence that adds fewest positions (occurrence);
//   - a read names a window by app and title only when no other window on screen has the same app and title (byTitle);
//   - every line of every state a window showed makes its inventory, so a tab's partial live walk beside the text read
//     from it does not set the window's limit.
// The ledger's own inventory (viewInventory) is read only to report a mismatch with the counter's and the positions the
// ledger charged; never in the count.
import { ScreenModel } from "../src/model.ts";
import { proposeFill, valueSettlementOf } from "../src/fill/fill.ts";
import { sealRequest } from "../src/fill/jev.ts";
import { sendable } from "../src/privacy/send.ts";
import { TabSource, type TabReader } from "../src/engines/tab-source.ts";
import { PageResult, PROTOCOL_VERSION, Snapshot } from "../src/protocol.ts";
import type { WindowState } from "../src/model.ts";
import { viewInventory } from "../src/privacy/ledger/account.ts";
import { redactWindow } from "../src/fill/redact.ts";

/** Each sent request's bytes and what the answers chose, kept per case for a dump (FuzzOptions.dump). */
let dumping = false;
const DEBUG_SENT: unknown[] = [];

// ---------------------------------------------------------------------------------------------------------------------
// Seeded randomness

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type R = { f: () => number; int: (n: number) => number; pick: <T>(xs: readonly T[]) => T; chance: (p: number) => boolean };
function rng(seed: number): R {
  const f = mulberry32(seed);
  return { f, int: (n) => Math.floor(f() * n), pick: (xs) => xs[Math.floor(f() * xs.length)]!, chance: (p) => f() < p };
}

// ---------------------------------------------------------------------------------------------------------------------
// Desk generator. A desk is plain JSON (snapshots and events), so a flagged case can be replayed and minimized.

const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const CHROME = { pid: 8080, bundleId: "com.google.Chrome", name: "Google Chrome" };
const TEXTEDIT = { pid: 6161, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const FORM_APP = { pid: 5150, bundleId: "dev.caret.fixture", name: "Fixture" };

type Node = { key: string; parent: string | null; role: string; label?: string; value?: string; placeholder?: string; editable?: boolean; subrole?: string; frame?: [number, number, number, number] };
type TypedValue = { kind: string; text: string; nodeKey: string };
type App = { pid: number; bundleId: string; name: string };
interface WinSpec { windowId: string; title: string; app: App; nodes: Node[]; values: TypedValue[]; kind?: string; at: number; focused?: boolean }
type Event =
  | { type: "open"; win: WinSpec }
  | { type: "replace"; win: WinSpec } // a new snapshot of an existing window (page to mail, or an identical refresh)
  | { type: "close"; windowId: string };
export interface Desk {
  mode: "focus" | "scope" | "tab";
  windows: WinSpec[];
  form: { windowId: string; keys: string[]; labels: string[] };
  /** Applied just before the request with this index is sealed. */
  event: { before: number; ev: Event } | null;
  /** Tab mode: the page window read and its text. */
  tab: { windowId: string; title: string; blocks: string[] } | null;
  whose: boolean;
  answerSeed: number;
  disagree: number; // probability a field's second base wording answers none
  lowVerify: number; // probability the verifier answers under its cutoff
  instruction: string;
}

const FIRST = ["Dana", "Kofi", "Ines", "Priya", "Tomas", "Lena", "Arjun", "Mei", "Olu", "Sven"];
const LAST = ["Whitfield", "Mensah", "Vandermeer", "Raman", "Okafor", "Hartmann", "Castell", "Lindqvist"];
const STREETS = ["Main St", "Cedar Ave", "Harbor Rd", "Elm Way", "Birch Ln"];
const CITIES = [["Austin", "TX", "78701"], ["Portland", "OR", "97205"], ["Denver", "CO", "80202"], ["Madison", "WI", "53703"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FILLER = [
  "ok", "sounds good", "lol yes", "thanks!", "can you send the details?", "see you then", "on my way", "yes", "perfect, thank you",
  "did you get my last message", "running ten minutes late sorry", "let me check and get back to you", "haha fair", "k",
  "the venue changed again so double check before you leave", "who else is coming on saturday", "great",
];
const WORDS = ["river", "lantern", "copper", "meadow", "quiet", "orbit", "velvet", "harbor", "signal", "maple", "ember", "glacier", "tidal", "saffron", "pixel", "summit"];

interface Persona { name: string; first: string; email: string; phone: string; phone2: string; date: string; dateTyped: string; ref: string; address: string }

function persona(r: R): Persona {
  const first = r.pick(FIRST);
  const last = r.pick(LAST);
  const mon = r.int(12);
  const day = 1 + r.int(28);
  const year = 2026 + r.int(2);
  const iso = `${year}-${String(mon + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const spaced = r.chance(0.35);
  const date = r.chance(0.3) ? iso : `${MONTHS[mon]}${spaced ? "   " : " "}${day},${spaced && r.chance(0.5) ? "  " : " "}${year}`;
  const [city, st, zip] = r.pick(CITIES);
  const fw = r.chance(0.08); // a full-width digit, which NFKC folds
  const phone = `555-01${String(r.int(100)).padStart(2, "0")}`;
  return {
    name: `${first} ${last}`,
    first,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@example.${r.pick(["com", "org", "net"])}`,
    phone: fw ? phone.replace("5", "５") : phone,
    phone2: `555-02${String(r.int(100)).padStart(2, "0")}`,
    date,
    dateTyped: date,
    ref: `${String.fromCharCode(65 + r.int(26))}${String.fromCharCode(65 + r.int(26))}${String(r.int(100)).padStart(2, "0")}-${1000 + r.int(9000)}`,
    address: `${100 + r.int(900)} ${r.pick(STREETS)}, ${city}, ${st} ${zip}`,
  };
}

const FIELD_KINDS = ["name", "email", "phone", "date", "reference", "address", "city", "zip"] as const;
type FieldKind = (typeof FIELD_KINDS)[number];
const LABELS: Record<FieldKind, string[]> = {
  name: ["Full name", "Name"],
  email: ["Email", "Email address"],
  phone: ["Phone", "Phone number"],
  date: ["Date", "Event date"],
  reference: ["Reference", "Booking reference"],
  address: ["Address", "Street address"],
  city: ["City"],
  zip: ["ZIP code", "Postal code"],
};

function sentence(r: R, n: number): string {
  return Array.from({ length: n }, () => r.pick(WORDS)).join(" ");
}

const EOLS = ["\n", "\r", "\r\n"];

/** Lines of a conversation that carry `p`'s values, with the typed values a reader would report. */
function valueLines(r: R, p: Persona): { text: string; kind?: string; value?: string }[] {
  const out: { text: string; kind?: string; value?: string }[] = [];
  if (r.chance(0.8)) out.push(r.chance(0.5) ? { text: `Phone: ${p.phone}`, kind: "phone", value: p.phone } : { text: `my number is ${p.phone}, call ${p.phone} after 5`, kind: "phone", value: p.phone });
  if (r.chance(0.6)) out.push({ text: r.chance(0.5) ? `Email: ${p.email}` : `you can reach me at ${p.email}`, kind: "email", value: p.email });
  if (r.chance(0.6)) out.push(r.chance(0.5) ? { text: `Ref: ${p.ref}` } : { text: `booking ref ${p.ref} (ref ${p.ref})` });
  if (r.chance(0.7)) out.push({ text: r.chance(0.5) ? `Date: ${p.date}` : `see you ${p.date} at noon`, kind: "date", value: p.date });
  if (r.chance(0.5)) out.push({ text: `Address: ${p.address}`, kind: "address", value: p.address });
  if (r.chance(0.5)) out.push({ text: r.chance(0.5) ? `Name: ${p.name}` : p.name });
  return out;
}

/** Text nodes from lines, some joined into one node across CR, LF or CRLF; typed values point at the node. */
function textNodes(r: R, prefix: string, lines: { text: string; kind?: string; value?: string }[], y0 = 60): { nodes: Node[]; values: TypedValue[] } {
  const nodes: Node[] = [];
  const values: TypedValue[] = [];
  let i = 0;
  let y = y0;
  while (i < lines.length) {
    const take = r.chance(0.25) ? Math.min(lines.length - i, 2 + r.int(2)) : 1;
    const group = lines.slice(i, i + take);
    const key = `${prefix}${nodes.length}`;
    const text = group.map((g) => g.text).join(r.pick(EOLS));
    nodes.push({ key, parent: null, role: "AXStaticText", label: text, frame: [20, y, 600, 20 * take] });
    for (const g of group) if (g.kind !== undefined && g.value !== undefined) values.push({ kind: g.kind, text: g.value, nodeKey: key });
    y += 24 * take;
    i += take;
  }
  return { nodes, values };
}

/** Odd spellings the normalizations disagree on or fold: case, a ligature, a decomposed accent, full-width letters. */
const ODD = ["OK", "SOUNDS GOOD", "\uFB01ne by me", "Ine\u0301s says hi", "\uFF2F\uFF2B", "Stra\u00DFe", "caf\u00E9 at noon?"];

function chatLines(r: R, p: Persona, other: Persona | null): { text: string; kind?: string; value?: string }[] {
  const lines = [...valueLines(r, p), ...(other !== null && r.chance(0.4) ? valueLines(r, other).slice(0, 2) : [])];
  // A value alone on its line: a whole line, which a request that carries the value holds.
  if (r.chance(0.35)) lines.push(r.pick([{ text: p.phone, kind: "phone", value: p.phone }, { text: p.email, kind: "email", value: p.email }, { text: p.ref }, { text: p.first }]));
  if (r.chance(0.15)) lines.push({ text: r.pick(ODD) });
  // Tiny chats keep the limit close to what one value and its facts cost.
  const tiny = r.chance(0.3);
  if (tiny) lines.splice(2 + r.int(2));
  const fill = tiny ? r.int(2) : r.int(10);
  for (let k = 0; k < fill; k++) lines.push({ text: r.pick(FILLER) });
  if (r.chance(0.3)) lines.push({ text: `${sentence(r, 20 + r.int(20))} ${p.ref} ${sentence(r, 5)}` }); // a long line
  if (r.chance(0.2)) lines.push({ text: lines[r.int(lines.length)]!.text }); // an exact repeat
  // Shuffle
  for (let k = lines.length - 1; k > 0; k--) {
    const j = r.int(k + 1);
    [lines[k], lines[j]] = [lines[j]!, lines[k]!];
  }
  return lines;
}

let atClock = 0;
const tick = (): number => (atClock += 100);

function messagesWindow(r: R, id: string, p: Persona, other: Persona | null, titleChoices: string[]): WinSpec {
  const { nodes, values } = textNodes(r, `${id}-m`, chatLines(r, p, other));
  return { windowId: id, title: r.pick(titleChoices), app: MESSAGES, nodes, values, at: tick() };
}

function mailLines(r: R, p: Persona, subject: string): { text: string; kind?: string; value?: string }[] {
  return [{ text: `From: ${p.name} <${p.email}>` }, { text: r.chance(0.5) ? "To: me" : `Date: ${p.date}` }, { text: `Subject: ${subject}` }, ...chatLines(r, p, null).filter(() => r.chance(0.8))];
}

function mailWindow(r: R, id: string, p: Persona, kind: string | undefined): WinSpec {
  const subject = r.pick(["Trip details", "Booking confirmed", "Re: forms for Saturday", "Your details"]);
  const { nodes, values } = textNodes(r, `${id}-b`, mailLines(r, p, subject));
  return { windowId: id, title: r.chance(0.3) ? `${subject} - Inbox` : subject, app: CHROME, nodes, values, at: tick(), ...(kind === undefined ? {} : { kind }) };
}

/** A Chrome page that shows some of `p`'s values but no mail header: not a conversation until a later snapshot makes it one. */
function pageWindow(r: R, id: string, p: Persona, kind: string | undefined): WinSpec {
  const lines = valueLines(r, p);
  for (let k = r.int(5); k > 0; k--) lines.push({ text: sentence(r, 3 + r.int(10)) });
  const { nodes, values } = textNodes(r, `${id}-p`, lines);
  return { windowId: id, title: "Account overview", app: CHROME, nodes, values, at: tick(), ...(kind === undefined ? {} : { kind }) };
}

function noteWindow(r: R, p: Persona, coincide: Persona | null, titleChoices: string[], copied: readonly string[] = []): WinSpec {
  const lines: string[] = [...copied];
  const src = coincide ?? p;
  if (r.chance(0.6)) lines.push(`Phone: ${r.chance(0.5) ? src.phone : p.phone2}`);
  if (r.chance(0.5)) lines.push(`Email: ${src.email}`);
  if (r.chance(0.5)) lines.push(`Ref: ${src.ref}`);
  if (r.chance(0.4)) lines.push(`Address: ${src.address}`);
  for (let k = r.int(4); k > 0; k--) lines.push(r.chance(0.3) ? r.pick(FILLER) : sentence(r, 2 + r.int(8)));
  const text = lines.join(r.pick(EOLS));
  return {
    windowId: "note-1",
    title: r.pick(titleChoices),
    app: TEXTEDIT,
    nodes: [{ key: "note-1/text", parent: null, role: "AXTextArea", editable: true, value: text, frame: [10, 40, 600, 400] }],
    values: [],
    at: tick(),
  };
}

const fieldKey = (label: string): string => `dev.caret.fixture/standard/textfield:${label.toLowerCase().replace(/ /gu, "-")}~0`;

export function makeDesk(caseSeed: number): Desk {
  const r = rng(caseSeed);
  atClock = 0;
  const mode = r.pick(["focus", "focus", "scope", "scope", "tab"] as const);
  const user = persona(r);
  const other = persona(r);
  const kinds = [...FIELD_KINDS].sort(() => r.f() - 0.5).slice(0, 2 + r.int(5));
  const labels = kinds.map((k) => r.pick(LABELS[k]));
  // Variety: a window title equal to a label or a value.
  const labelTitle = r.chance(0.15) ? [labels[0]!] : [];
  const valueTitle = r.chance(0.1) ? [user.phone] : [];
  const windows: WinSpec[] = [];
  const nConv = 1 + (r.chance(0.35) ? 1 : 0);
  const convIds: string[] = [];
  for (let c = 0; c < nConv; c++) {
    const id = `chat-${c + 1}`;
    if (mode !== "tab" && r.chance(0.3)) windows.push(mailWindow(r, `mail-${c + 1}`, c === 0 ? user : other, undefined)), convIds.push(`mail-${c + 1}`);
    else windows.push(messagesWindow(r, id, c === 0 ? user : other, c === 0 ? other : user, [...(c === 0 ? [other.first] : [user.first]), ...labelTitle, ...valueTitle].concat(c === 1 ? [`${other.first} ${user.first}`] : []))), convIds.push(id);
  }
  // Make the titles of two conversations distinct (the counter reads a window by its app and title).
  if (windows.length === 2 && windows[0]!.title === windows[1]!.title && windows[0]!.app === windows[1]!.app) windows[1]!.title += " (2)";
  // A note may hold a passage copied from the chat: still that chat's text for measurement (section 7).
  const chatText = windows[0]!.nodes.flatMap((n) => (n.label ?? "").split(LINE_BREAK));
  const copied = r.chance(0.25) ? chatText.slice(r.int(Math.max(1, chatText.length - 3))).slice(0, 2 + r.int(4)) : [];
  if (r.chance(0.85)) windows.push(noteWindow(r, user, r.chance(0.4) ? user : null, ["Untitled", "Notes", ...labelTitle], copied));
  let page: WinSpec | null = null;
  if (mode !== "tab" && r.chance(0.25)) {
    page = pageWindow(r, "page:eng1:5", user, "page");
    windows.push(page);
  }
  const formId = mode === "tab" ? "page:eng1:7" : "5150-7";
  const keys = labels.map(fieldKey);
  const formNodes: Node[] = labels.map((l, i) => {
    const isDate = kinds[i] === "date" && r.chance(0.3);
    return { key: keys[i]!, parent: null, role: isDate ? "AXDateField" : "AXTextField", editable: true, label: l, ...(isDate ? { subrole: "CaretDateInput" } : {}), frame: [100, 40 + i * 40, 300, 24] };
  });
  let tab: Desk["tab"] = null;
  if (mode === "tab") {
    // The webmail tab the user left for the form; fill reads its text through TabSource.
    const subject = r.pick(["Trip details", "Your booking", "Re: forms"]);
    const blocks = mailLines(r, user, subject).map((l) => l.text);
    const grouped: string[] = [];
    for (let i = 0; i < blocks.length; ) {
      const take = r.chance(0.3) ? Math.min(blocks.length - i, 2 + r.int(2)) : 1;
      grouped.push(blocks.slice(i, i + take).join("\n"));
      i += take;
    }
    tab = { windowId: "page:eng1:3", title: r.chance(0.5) ? `Inbox: ${subject}` : subject, blocks: grouped };
    windows.push({ windowId: "page:eng1:3", title: "Mail", app: CHROME, nodes: [{ key: "page:eng1:3/x", parent: null, role: "AXTextField", editable: true }], values: [], kind: "page", at: tick(), focused: true });
  }
  windows.push({ windowId: formId, title: r.chance(0.1) ? labels[0]! : "Registration", app: mode === "tab" ? CHROME : FORM_APP, nodes: formNodes, values: [], at: tick() + 1000, focused: true, ...(mode === "tab" ? { kind: "page" } : {}) });
  // An event between requests of the operation.
  let event: Desk["event"] = null;
  const ev = r.int(mode === "tab" ? 3 : 7);
  const before = r.int(4);
  if (mode === "tab") {
    if (ev === 0) event = { before, ev: { type: "open", win: messagesWindow(r, "chat-new", other, user, [other.first]) } };
    else if (ev === 1) {
      // The chat the view was made beside changes on the live screen: a line that is one of the tab's values arrives.
      const add = textNodes(r, "chat-1-late", [{ text: r.pick([user.phone, user.email, user.ref, `Ref: ${user.ref}`]) }], 500);
      event = { before, ev: { type: "replace", win: { ...windows[0]!, nodes: [...windows[0]!.nodes, ...add.nodes], values: [...windows[0]!.values, ...add.values], at: 9000 } } };
    }
  } else if (ev === 1) event = { before, ev: { type: "open", win: messagesWindow(r, "chat-new", user, other, [user.first.slice(0, 3) + "!"]) } };
  else if (ev === 2 && page !== null) {
    // The page becomes a mail: its lines stay, and mail headers appear.
    const hdr = mailLines(r, user, "Your account").slice(0, 3);
    const extra = textNodes(r, `${page.windowId}-h`, hdr, 400);
    event = { before, ev: { type: "replace", win: { ...page, nodes: [...page.nodes, ...extra.nodes], values: [...page.values, ...extra.values], at: 9000 } } };
  } else if (ev === 3) event = { before, ev: { type: "close", windowId: r.pick(convIds) } };
  else if (ev === 4) event = { before, ev: { type: "replace", win: { ...windows[0]!, at: 9000 } } };
  else if (ev === 5 && windows.some((w) => w.windowId === "note-1")) event = { before, ev: { type: "close", windowId: "note-1" } };
  else if (ev === 6) {
    // A new chat opens whose lines are values other windows show, alone on their lines.
    const lines = [{ text: user.phone }, { text: user.email }, { text: `Ref: ${user.ref}` }, { text: r.pick(FILLER) }].filter(() => r.chance(0.7));
    const t = textNodes(r, "chat-new-m", lines.length === 0 ? [{ text: user.phone }] : lines);
    event = { before, ev: { type: "open", win: { windowId: "chat-new", title: other.first, app: MESSAGES, nodes: t.nodes, values: t.values, at: 400 } } };
  }
  return {
    mode,
    windows,
    form: { windowId: formId, keys, labels },
    event,
    tab,
    whose: r.chance(0.5),
    answerSeed: r.int(2 ** 30),
    disagree: mode === "focus" ? 0.1 : 0.5,
    lowVerify: mode === "scope" ? 0.3 : 0,
    instruction: r.pick(["fill this in from my messages", "use what was sent to me", "fill the form"]),
  };
}

function snapOf(w: WinSpec): Snapshot {
  return Snapshot.parse({
    type: "snapshot", v: PROTOCOL_VERSION, seq: 0, at: w.at, reason: "event", app: w.app,
    window: { windowId: w.windowId, kind: w.kind ?? "standard", title: w.title, frame: [0, 0, 800, 600] },
    focused: w.focused ?? false, root: null, nodes: w.nodes, values: w.values, focusedKey: null, stats: { walkMs: 5, visited: w.nodes.length, truncated: false },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The independent counter.

const LINE_BREAK = /\r\n|\r|\n/u;
const collapse = (s: string): string => s.replace(/\s+/gu, " ").trim();

interface Inv { lines: string[]; total: number }
/** Section 1, written again: title and every node's label, value and placeholder, split, collapsed, trimmed, deduplicated. */
function inventory(w: { window: { title: string }; nodes: Map<string, Node> }): Inv {
  const parts: string[] = [];
  if (w.window.title) parts.push(w.window.title);
  for (const n of w.nodes.values()) for (const t of [n.label, n.value, n.placeholder]) if (t !== undefined && t !== "") parts.push(t);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const p of parts) for (const raw of p.split(LINE_BREAK)) {
    const l = collapse(raw);
    if (l === "" || seen.has(l)) continue;
    seen.add(l);
    lines.push(l);
  }
  return { lines, total: lines.reduce((a, l) => a + l.length, 0) };
}
const convLimit = (T: number): number => Math.min(600, Math.max(0, Math.floor((T - 1) / 2)));

/**
 * One scalar normalized by the spec's rules (section 2), written again from the runtime's own tables rather than the
 * ledger's: NFKD, full case folding (upper then lower case, so "ß" folds to "ss" and "STRASSE" matches "Straße"), NFKD
 * again, white space to one ASCII space. The runtime's Unicode version may differ from the ledger's pinned 16.0.0, and
 * upper-then-lower is full case folding but for a few scripts (Cherokee folds to upper case); neither turns a breach
 * into a pass on these desks' Latin text.
 */
function normScalar(ch: string): string {
  if (/^\s$/u.test(ch)) return " ";
  return ch.normalize("NFKD").toUpperCase().toLowerCase().normalize("NFKD").replace(/\s/gu, " ");
}
/** A text normalized scalar by scalar, with each normalized scalar's origin offsets (UTF-16) in the text. */
export function normalize(text: string): { cps: string[]; origins: number[][] } {
  const cps: string[] = [];
  const origins: number[][] = [];
  let off = 0;
  for (const ch of text) {
    const at = Array.from({ length: ch.length }, (_, k) => off + k);
    for (const c of normScalar(ch)) {
      if (c === " " && cps.at(-1) === " ") origins.at(-1)!.push(...at);
      else {
        cps.push(c);
        origins.push([...at]);
      }
    }
    off += ch.length;
  }
  while (cps[0] === " ") cps.shift(), origins.shift();
  while (cps.at(-1) === " ") cps.pop(), origins.pop();
  return { cps, origins };
}

/** Every key, string and scalar spelling of a JSON body, by my own walk. */
function unitsOf(bytes: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number" || typeof v === "boolean" || v === null) out.push(JSON.stringify(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as object)) out.push(k), walk(x);
  };
  walk(JSON.parse(bytes));
  return out.filter((u) => u !== "");
}

const RUN = 12;
/** Rule E: positions of `inv` (as `line\0offset` keys) a request's units reveal, with which lines were whole. */
function ruleE(units: string[], inv: Inv): Set<string> {
  const normUnits = units.map((u) => normalize(u).cps);
  const grams = new Set<string>();
  for (const u of normUnits) for (let i = 0; i + RUN <= u.length; i++) grams.add(u.slice(i, i + RUN).join(""));
  const joined = normUnits.map((u) => u.join(""));
  const out = new Set<string>();
  for (const line of inv.lines) {
    const n = normalize(line);
    if (n.cps.length === 0) continue;
    const ls = n.cps.join("");
    if (joined.some((u) => u.includes(ls))) {
      for (let k = 0; k < line.length; k++) out.add(`${line}\u0000${k}`);
      continue;
    }
    for (let i = 0; i + RUN <= n.cps.length; i++) {
      if (!grams.has(n.cps.slice(i, i + RUN).join(""))) continue;
      for (let j = i; j < i + RUN; j++) for (const o of n.origins[j]!) out.add(`${line}\u0000${o}`);
    }
  }
  return out;
}

/**
 * The positions of one occurrence of `text` (collapsed) in `inv`, or none. A value a window shows more than once was read
 * at one of them, which this counter cannot know, so it takes the occurrence that adds fewest positions to `have`: the
 * count stays a lower bound, and a ref read from "Ref: X" is not counted at a long line that also holds X.
 */
function occurrence(text: string, inv: Inv, have: ReadonlySet<string>, prefer: (line: string) => number = () => 0): string[] {
  const t = collapse(text);
  if (t === "") return [];
  let best: string[] | null = null;
  let bestScore = [Infinity, Infinity];
  for (const line of inv.lines) {
    for (let at = line.indexOf(t); at >= 0; at = line.indexOf(t, at + 1)) {
      const keys = Array.from({ length: t.length }, (_, k) => `${line}\u0000${at + k}`);
      // Fewest new positions first; on a tie, the line the option's own words place it in.
      const score = [keys.filter((k) => !have.has(k)).length, -prefer(line)];
      if (score[0]! < bestScore[0]! || (score[0] === bestScore[0] && score[1]! < bestScore[1]!)) [best, bestScore] = [keys, score];
    }
  }
  return best ?? [];
}

const MONTH_INDEX = new Map(MONTHS.map((m, i) => [m.toLowerCase(), i + 1]));
/** A date as year-month-day, from "Oct 16, 2026" or "2026-10-16"; null otherwise. */
function ymd(s: string): string | null {
  const t = collapse(s);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(t);
  if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const m = /^([A-Za-z]{3}) (\d{1,2}), (\d{4})$/u.exec(t);
  const mi = m === null ? undefined : MONTH_INDEX.get(m[1]!.toLowerCase());
  return m === null || mi === undefined ? null : `${m[3]}-${String(mi).padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
}
/** The basis a derived value (a date reformatted, an address part) was read from, among a window state's typed values. */
function basisOf(derived: string, w: WS): string | null {
  const d = collapse(derived);
  for (const v of w.values) {
    const b = collapse(v.text);
    if (b === d) continue;
    if (b.includes(d) || (ymd(b) !== null && ymd(b) === ymd(d))) return v.text;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// One case

type WS = WindowState;

/** A candidate an option stood for: its text, app and window title; `derived` when code derived it from a basis. */
type Read = { text: string; app: string | null; title: string | null; derived: boolean; label: string | null; line: string | null };

/** What an option's criterion says of where its candidate was read: its label and its line, when it says them. */
function readOf(text: string, app: string | null, criterion: string, derived: boolean): Read {
  const label = /labelled '([^']*)'/u.exec(criterion)?.[1] ?? /Observed label: (.*?)\. Supporting text: /u.exec(criterion)?.[1] ?? null;
  const line = /in the line '([^']*)'/u.exec(criterion)?.[1] ?? /Supporting text: "(.*?)"(?:;|\. Derivation)/u.exec(criterion)?.[1] ?? null;
  return { text, app, title: whereOf(criterion, app), derived, label: label === "unavailable" ? null : label, line };
}

interface SentRecord {
  purpose: string;
  bytes: string;
  /** Every window state on screen (and in the fill's view) when it was sent. */
  states: WS[];
  /** Options the scripted answers chose in it: candidate text, app, window title. */
  chosen: Read[];
  offered: Read[];
  ledger: Record<string, number>;
  ledgerPositions: Map<string, string[]>;
}

const isMailState = (w: WS): boolean => {
  if (w.app.bundleId !== CHROME.bundleId) return false;
  let from = false;
  let other = false;
  for (const n of w.nodes.values()) for (const t of [n.label, n.value, n.placeholder]) for (const l of (t ?? "").split(LINE_BREAK)) {
    if (/^from:/iu.test(l.trim())) from = true;
    else if (/^(?:to|cc|subject|date|sent):/iu.test(l.trim())) other = true;
  }
  return from && other;
};
const isConvState = (w: WS): boolean => w.app.bundleId === MESSAGES.bundleId || isMailState(w);

/** The window a candidate came from, by its option's criterion: "in <app> window '<title>'" or "Source: <app> window '<title>'". */
function whereOf(criterion: string, app: string | null): string | null {
  if (app === null) return null;
  const esc = app.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const m = new RegExp(`(?:\\bin |Source: )${esc} window '([^']*)'`, "u").exec(criterion);
  return m?.[1] ?? null;
}

export interface CaseResult {
  case: number;
  seed: number;
  mode: string;
  event: string;
  requests: { purpose: string; ok: boolean; refused?: string }[];
  flagged: Flag[];
  gaps?: Gap[];
  inventoryMismatch: string[];
  error?: string;
}
interface Gap { windowId: string; limit: number; count: number; ledger: number; missing: number; eMissing: number; chosenMissing: number; lines: { line: string; shown: string }[] }
interface Flag {
  windowId: string;
  T: number;
  limit: number;
  count: number;
  ruleE: number;
  chosen: number;
  offered: number;
  /** Positions only page-state requests carried (the window was not yet a conversation when they were sent). */
  beforeConversation: number;
  /** Positions only matched in a state no longer on screen when the request was sent. */
  offScreen: number;
  ledgerUnion: number;
  ledgerPerRequest: number[];
  counter: "E+chosen" | "E+offered";
}

export async function runCase(i: number, desk: Desk): Promise<CaseResult> {
  const r = rng(desk.answerSeed);
  const live = new ScreenModel();
  for (const w of desk.windows) live.apply(snapOf(w));
  let model = live;
  let tabSource: { viewFor: (o: string) => unknown } | null = null;
  if (desk.mode === "tab" && desk.tab !== null) {
    const tab = desk.tab;
    const reader: TabReader = {
      readText: async () => PageResult.parse({ type: "pageResult", v: PROTOCOL_VERSION, id: "r", at: 0, outcome: "ok", detail: null, text: { tabId: 3, leftAt: 0, title: tab.title, frames: [{ frameId: 0, origin: "https://mail.example.test" }], selection: [], blocks: tab.blocks, cut: false, docsText: null } }),
      sitesOff: () => [],
      documentOf: () => "D1",
    };
    const ts = new TabSource({ model: live, reader, now: () => 3000, count: () => {}, dropped: () => {} });
    const got = await ts.readFor(desk.form.windowId, "f1");
    if (!("windowId" in got)) return { case: i, seed: 0, mode: desk.mode, event: "", requests: [], flagged: [], inventoryMismatch: [], error: `tab read refused: ${JSON.stringify(got)}` };
    model = ts.viewFor("f1");
    tabSource = ts;
  }
  let traces: { owns: (req: unknown) => boolean; fields: { id: string; key: string; name: string }[]; options: Map<string, { text: string; from: string; app: string | null }> }[] = [];
  const sent: SentRecord[] = [];
  const reqLog: CaseResult["requests"] = [];
  const chosenText = new Map<string, string>(); // field key -> candidate text
  const baseSeen = new Map<string, number>();
  const forceDisagree = new Map<string, boolean>();
  let reqIndex = 0;
  const statesNow = (): WS[] => {
    const out = new Map<WS, true>();
    for (const w of live.windows.values()) out.set(w, true);
    if (model !== live) for (const w of model.windows.values()) out.set(w, true);
    return [...out.keys()];
  };
  // Every window state on screen before the first request, a window that closes before it too.
  const initial = statesNow();
  const ask = async (req: any): Promise<any> => {
    if (desk.event !== null && reqIndex === desk.event.before) {
      const ev = desk.event.ev;
      if (ev.type === "close") live.close(ev.windowId, 8000);
      else live.apply(snapOf(ev.win));
    }
    reqIndex++;
    let bytes: string;
    let s: any;
    try {
      s = sealRequest(req);
      bytes = sendable(s.sealed);
    } catch (e) {
      reqLog.push({ purpose: req.purpose, ok: false, refused: e instanceof Error ? e.message : String(e) });
      throw e;
    }
    reqLog.push({ purpose: req.purpose, ok: true });
    const t = traces.find((x) => x.owns(req));
    const answers: Record<string, { choice: string; confidence: number }> = {};
    const chosen: SentRecord["chosen"] = [];
    const offered: SentRecord["offered"] = [];
    for (const [qid, q] of Object.entries<any>(req.questions)) {
      if (req.purpose === "fill.verify") {
        answers[qid] = { choice: "exact", confidence: r.chance(desk.lowVerify) ? 0.1 : 0.99 };
        continue;
      }
      if (qid.endsWith("_whose") || qid.endsWith("_owner")) {
        answers[qid] = { choice: "user", confidence: 0.95 };
        continue;
      }
      const field = t?.fields.find((f) => f.id === qid);
      const opts = Object.entries<string | null>(q.criteria).filter(([k]) => k !== "none" && !k.includes("_"));
      for (const [k, c] of opts) {
        const o = t?.options.get(k);
        if (o !== undefined && o.from !== "memory") offered.push(readOf(o.text, o.app, String(c ?? ""), o.from === "derived"));
      }
      if (req.purpose !== "fill.values" || field === undefined || t === undefined) {
        answers[qid] = { choice: opts[0]?.[0] ?? "none", confidence: 0.95 };
        continue;
      }
      const settlement = opts.some(([, c]) => String(c ?? "").startsWith("Proposed value: "));
      let want = chosenText.get(field.key);
      if (want === undefined && opts.length > 0) {
        want = t.options.get(r.pick(opts)[0])?.text;
        if (want !== undefined) chosenText.set(field.key, want);
        forceDisagree.set(field.key, r.chance(desk.disagree));
      }
      const n = settlement ? 0 : (baseSeen.get(field.key) ?? 0);
      if (!settlement) baseSeen.set(field.key, n + 1);
      const hit = opts.find(([k]) => t.options.get(k)?.text === want);
      if (hit === undefined || (!settlement && n === 1 && forceDisagree.get(field.key) === true)) {
        answers[qid] = { choice: "none", confidence: 0.95 };
        continue;
      }
      answers[qid] = { choice: hit[0], confidence: 0.99 };
      const o = t.options.get(hit[0])!;
      if (o.from !== "memory") chosen.push(readOf(o.text, o.app, String(hit[1] ?? ""), o.from === "derived"));
    }
    const ledgerPositions = new Map<string, string[]>();
    for (const [key, { view, bits }] of s.sealed.measurement.positions as Map<string, { view: any; bits: Uint8Array }>) {
      const inv = viewInventory(view);
      const keys: string[] = [];
      inv.lines.forEach((line: string, li: number) => {
        for (let k = 0; k < line.length; k++) if (bits[inv.starts[li]! + k] === 1) keys.push(`${line}\u0000${k}`);
      });
      ledgerPositions.set(key.replace(/@\d+$/u, ""), [...(ledgerPositions.get(key.replace(/@\d+$/u, "")) ?? []), ...keys]);
    }
    sent.push({ purpose: req.purpose, bytes, states: statesNow(), chosen, offered, ledger: { ...s.sealed.charged }, ledgerPositions });
    if (dumping) DEBUG_SENT.push({ purpose: req.purpose, bytes, chosen, offered, ledger: { ...s.sealed.charged } });
    return { model: "fuzz", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  };

  const fillOpts: any = { whose: desk.whose, trace: (t: any) => traces.push(t) };
  if (desk.mode === "scope") fillOpts.scope = { fields: desk.form.keys, windows: null, memory: false, instruction: desk.instruction, person: null, literals: new Map() };
  let error: string | undefined;
  try {
    const trigger = desk.form.keys[0];
    if (trigger === undefined) throw new Error("a desk's form has no field");
    const p = await proposeFill(model, ask, desk.form.windowId, trigger, 3000, fillOpts);
    // The Ask's clarification: for each unresolved value a pick of which can be sent, the user picks one.
    const vs = valueSettlementOf(p);
    if (vs !== undefined) {
      for (const u of vs.unresolved) {
        const s = vs.sendable(u);
        if (s === null || s.options.length === 0) continue;
        const o = s.options[r.int(s.options.length)];
        if (o === undefined) continue;
        try {
          await vs.settle(u.key, o.id, { model, askJev: ask });
        } catch (e) {
          error = `settle: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
        }
      }
    }
  } catch (e) {
    error = (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);
  }

  // Count.
  const firstStates = new Map<string, WS[]>(); // window id -> every state seen
  const invOf = new Map<WS, Inv>();
  const inv = (w: WS): Inv => {
    let x = invOf.get(w);
    if (x === undefined) invOf.set(w, (x = inventory(w as any)));
    return x;
  };
  const allStates = new Set<WS>(initial);
  for (const s of sent) for (const w of s.states) allStates.add(w);
  for (const w of allStates) {
    const id = w.window.windowId;
    firstStates.set(id, [...(firstStates.get(id) ?? []), w]);
  }
  const inventoryMismatch: string[] = [];
  for (const w of allStates) {
    const mine = inv(w).lines;
    const theirs: string[] = [...viewInventory(redactWindow(w)).lines];
    if (mine.length !== theirs.length || mine.some((l, k) => l !== theirs[k])) inventoryMismatch.push(w.window.windowId);
  }
  const flagged: Flag[] = [];
  const gaps: Gap[] = [];
  for (const [id, states] of firstStates) {
    if (!states.some(isConvState)) continue;
    // The window's limit at each send: every line its states had shown by then, as one inventory (section 7), a
    // conversation once one of those states is. Each send is checked against the limit as it stood then: a state that
    // padded the window later cannot hide an earlier breach.
    const limitThen = (seen: readonly WS[]): number | null => (seen.some(isConvState) ? convLimit([...new Set(seen.flatMap((x) => inv(x).lines))].reduce((n, l) => n + l.length, 0)) : null);
    let breach: { count: number; limit: number; T: number; counter: "E+chosen" | "E+offered" } | null = null;
    const E = new Set<string>();
    const ch = new Set<string>();
    const of = new Set<string>();
    const beforeConv = new Set<string>();
    const afterConv = new Set<string>();
    const onScreenSet = new Set<string>();
    const offScreenSet = new Set<string>();
    const ledgerUnion = new Set<string>();
    const ledgerPerRequest: number[] = [];
    // Every state of this window seen up to and including each send, from the states on screen before the first.
    const seenSoFar: WS[] = initial.filter((w) => w.window.windowId === id);
    for (const s of sent) {
      for (const w of s.states) if (w.window.windowId === id && !seenSoFar.includes(w)) seenSoFar.push(w);
      const units = unitsOf(s.bytes);
      const current = s.states.filter((w) => w.window.windowId === id);
      const convNow = current.some(isConvState) || (current.length === 0 && seenSoFar.some(isConvState));
      const here = new Set<string>();
      // Every state the window showed, a page state before it became a conversation too: the operation counts what was
      // sent before a promotion.
      for (const w of seenSoFar) {
        const got = ruleE(units, inv(w));
        for (const k of got) {
          E.add(k);
          here.add(k);
          (current.includes(w) ? onScreenSet : offScreenSet).add(k);
        }
      }
      // The window a read names by app and title, only when no other window on screen has the same app and title.
      const byTitle = (x: Read): WS | undefined => {
        const named = (w: WS): boolean => x.app === w.app.name && (x.title === null || x.title === w.window.title);
        if (s.states.some((w) => w.window.windowId !== id && named(w))) return undefined;
        return [...current, ...seenSoFar].find((w) => named(w));
      };
      /** Where a read sits: its own text, or for a derived value its basis, whole. */
      const at = (x: Read, have: ReadonlySet<string>): string[] => {
        const w = byTitle(x);
        if (w === undefined) return [];
        // The line its criterion quotes, a line under its label, or the node of a typed value of the same text.
        const typedLines = new Set(w.values.filter((v) => collapse(v.text) === collapse(x.text)).flatMap((v) => {
          const n = w.nodes.get(v.nodeKey);
          return [n?.label, n?.value].flatMap((t) => (t ?? "").split(LINE_BREAK).map(collapse));
        }));
        const prefer = (line: string): number =>
          (x.line !== null && collapse(x.line) === line ? 4 : 0) + (x.label !== null && line.startsWith(`${x.label}:`) ? 2 : 0) + (typedLines.has(line) ? 1 : 0);
        const own = occurrence(x.text, inv(w), have, prefer);
        if (!x.derived) return own;
        const b = basisOf(x.text, w);
        return b === null ? own : occurrence(b, inv(w), have, prefer);
      };
      for (const x of s.chosen) for (const k of at(x, new Set([...E, ...ch]))) ch.add(k), here.add(k), onScreenSet.add(k);
      for (const x of s.offered) for (const k of at(x, new Set([...E, ...ch, ...of]))) of.add(k), onScreenSet.add(k);
      for (const k of here) (convNow ? afterConv : beforeConv).add(k);
      const lp = s.ledgerPositions.get(id) ?? [];
      lp.forEach((k) => ledgerUnion.add(k));
      ledgerPerRequest.push(lp.length);
      const lim = limitThen(seenSoFar);
      if (lim !== null && breach === null) {
        const T = [...new Set(seenSoFar.flatMap((x) => inv(x).lines))].reduce((n, l) => n + l.length, 0);
        const chosenNow = new Set([...E, ...ch]).size;
        const offeredNow = new Set([...E, ...ch, ...of]).size;
        if (chosenNow > lim) breach = { count: chosenNow, limit: lim, T, counter: "E+chosen" };
        else if (offeredNow > lim) breach = { count: offeredNow, limit: lim, T, counter: "E+offered" };
      }
    }
    const final = limitThen(seenSoFar) ?? 0;
    const T = breach?.T ?? [...new Set(seenSoFar.flatMap((x) => inv(x).lines))].reduce((n, l) => n + l.length, 0);
    const limit = breach?.limit ?? final;
    const eChosen = new Set([...E, ...ch]);
    const eOffered = new Set([...E, ...ch, ...of]);
    const onlyBefore = [...eChosen].filter((k) => beforeConv.has(k) && !afterConv.has(k)).length;
    const onlyOff = [...eOffered].filter((k) => offScreenSet.has(k) && !onScreenSet.has(k)).length;
    const base = { windowId: id, T, limit, ruleE: E.size, chosen: ch.size, offered: of.size, beforeConversation: onlyBefore, offScreen: onlyOff, ledgerUnion: ledgerUnion.size, ledgerPerRequest };
    // Positions this counter has that the ledger's seals never charged, flagged or not: where an undercount would show
    // before it crosses a limit.
    const missing = [...eOffered].filter((k) => !ledgerUnion.has(k));
    if (missing.length > 0) {
      const byLine = new Map<string, number[]>();
      for (const k of missing) {
        const [line, off] = k.split("\u0000") as [string, string];
        byLine.set(line, [...(byLine.get(line) ?? []), Number(off)]);
      }
      gaps.push({ windowId: id, limit, count: eOffered.size, ledger: ledgerUnion.size, missing: missing.length, eMissing: [...E].filter((k) => !ledgerUnion.has(k)).length, chosenMissing: [...ch].filter((k) => !ledgerUnion.has(k)).length, lines: [...byLine].slice(0, 4).map(([l, offs]) => ({ line: l, shown: offs.sort((a, b) => a - b).map((o) => l[o]).join("") })) });
    }
    if (breach !== null) flagged.push({ ...base, count: breach.count, counter: breach.counter });
  }
  const evName = desk.event === null ? "none" : `${desk.event.ev.type}${desk.event.ev.type === "close" ? `:${desk.event.ev.windowId}` : `:${desk.event.ev.win.windowId}`}@${desk.event.before}`;
  void tabSource;
  return { case: i, seed: 0, mode: desk.mode, event: evName, requests: reqLog, flagged, gaps, inventoryMismatch, ...(error === undefined ? {} : { error }) };
}


export const caseSeed = (seed: number, i: number): number => (Math.imul(seed, 2654435761) ^ Math.imul(i + 1, 40503)) >>> 0;

export interface FuzzOptions {
  seed: number;
  /** Case indexes to run. */
  cases: readonly number[];
  /** Keep every sent request's bytes and choices on its result. */
  dump?: boolean;
  /** One desk to run instead of the seeded ones (a minimized case). */
  replay?: Desk;
}

export interface FuzzRun {
  summary: { seed: number; cases: number; ms: number; requestsSent: number; requestsRefused: number; flaggedCases: number; harnessErrors: number; inventoryMismatchCases: number };
  results: CaseResult[];
  /** The desk of every flagged (or, with dump, every) case, by index. */
  desks: Record<number, Desk>;
}

/** Runs the cases and counts them. */
export async function runFuzz(o: FuzzOptions): Promise<FuzzRun> {
  dumping = o.dump === true;
  const results: CaseResult[] = [];
  const desks: Record<number, Desk> = {};
  const t0 = Date.now();
  for (const i of o.replay !== undefined ? [0] : o.cases) {
    const desk: Desk = o.replay ?? makeDesk(caseSeed(o.seed, i));
    let res: CaseResult;
    try {
      res = await runCase(i, desk);
    } catch (e) {
      res = { case: i, seed: caseSeed(o.seed, i), mode: desk.mode, event: "", requests: [], flagged: [], inventoryMismatch: [], error: `harness: ${e instanceof Error ? e.stack : String(e)}`.slice(0, 600) };
    }
    res.seed = caseSeed(o.seed, i);
    results.push(res);
    if (res.flagged.length > 0 || dumping) desks[i] = desk;
    if (dumping) (res as CaseResult & { sent?: unknown[] }).sent = DEBUG_SENT.splice(0);
  }
  return {
    summary: {
      seed: o.seed,
      cases: results.length,
      ms: Date.now() - t0,
      requestsSent: results.reduce((a, r) => a + r.requests.filter((x) => x.ok).length, 0),
      requestsRefused: results.reduce((a, r) => a + r.requests.filter((x) => !x.ok).length, 0),
      flaggedCases: results.filter((r) => r.flagged.length > 0).length,
      harnessErrors: results.filter((r) => r.error?.startsWith("harness") === true).length,
      inventoryMismatchCases: results.filter((r) => r.inventoryMismatch.length > 0).length,
    },
    results,
    desks,
  };
}
