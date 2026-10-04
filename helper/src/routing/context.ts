// The routing context (action engine v2, section 3): what the router decides about, kept apart from the text
// revision. A decision belongs to one context; it is made again only when the context changes at a semantic
// breakpoint (focus, selection, a new sentence or paragraph, a changed source or task, memory or settings). Ordinary
// typing changes the text revision, which every offer still carries, and never the context, so the host's local
// autocomplete is not put behind a model call on each keystroke.
import { createHash } from "node:crypto";
import type { ScreenModel, WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import { sentences } from "../offers/event-card.ts";

/** How the host says the user's selection stands. "unknown" until a host reports it (routingContext is not on the wire yet). */
export type SelectionMode = "caret" | "range" | "none" | "unknown";

/**
 * What only the host knows about the field the user is in: the selection and whether an input method is composing.
 * The helper takes it through RoutingCoordinator.hostEditing; until the host sends it, selection is "unknown" and
 * composing false.
 */
export interface HostEditing {
  windowId: string;
  key: string;
  selection: Exclude<SelectionMode, "unknown">;
  composing: boolean;
}

/** The field the user is in. */
export interface RoutingField {
  key: string;
  role: string;
  /** A secure text field, or the reader marked the node secure: Caret never reads or writes it. */
  secure: boolean;
  editable: boolean;
  empty: boolean;
  /** A text area, or a field that holds a finished sentence: somewhere a person writes prose. */
  prose: boolean;
}

export interface RoutingContext {
  readerSession: number;
  /** Process and document identity: the app, the reader's window id, and the window's title (a browser's page). */
  pid: number;
  bundleId: string;
  app: string;
  windowId: string;
  title: string;
  /** The window's kind from the reader ("standard", "systemdialog", ...). */
  windowKind: string;
  /** The focused element, or null when focus is on something that is not a field. */
  field: RoutingField | null;
  /** The focused element was reported but is not in the screen model: the walk that holds it has not arrived. */
  incomplete: boolean;
  selection: SelectionMode;
  composing: boolean;
  /** Finished sentences and paragraphs in the field's text: the committed boundary. */
  sentences: number;
  paragraphs: number;
  /** The candidate routes' ids, sorted and joined: a changed source or task changes it. */
  candidates: string;
  memoryRevision: number;
  settingsRevision: number;
  /** Digest of the field's text and selection. Carried for offers and logs; never part of the context's identity. */
  textRevision: string;
}

/** Why a context differs from the one before, in the order checked. */
export type Breakpoint = "reader" | "document" | "focus" | "selection" | "composing" | "sentence" | "candidates" | "memory" | "settings";

/** Whether this node is a field Caret may never read or write. */
export function secureNode(n: Node): boolean {
  return n.role === "AXSecureTextField" || n.states?.includes("secure") === true;
}

/** The committed sentences and paragraphs of a field's text; the sentence being typed does not count until it ends. */
export function boundary(text: string): { sentences: number; paragraphs: number } {
  if (text === "") return { sentences: 0, paragraphs: 0 };
  // A paragraph is committed by the line break after it; the one being typed has none yet.
  const paragraphs = text.split(/\n\s*\n/).length - 1 + (/\n\s*$/.test(text) ? 1 : 0);
  return { sentences: sentences(text, false).length, paragraphs };
}

const digest = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The focus the reader last reported in the app the user is in. */
export interface FocusSeen {
  windowId: string;
  key: string | null;
  role: string;
  editable: boolean;
}

export interface ContextInputs {
  model: ScreenModel;
  focus: FocusSeen | null;
  host: HostEditing | null;
  readerSession: number;
  memoryRevision: number;
  settingsRevision: number;
  candidates: readonly string[];
}

/** The window the user is in: the frontmost app's last focused window. Null when there is none. */
export function userWindow(model: ScreenModel): WindowState | null {
  return model.userWindow();
}

/**
 * The context now, or null when the user is in no window the model knows. The field comes from the reader's last
 * focus event when it names the user's window, else from the window's own focused key.
 */
export function contextNow(i: ContextInputs): RoutingContext | null {
  const w = userWindow(i.model);
  if (w === null) return null;
  const focusHere = i.focus !== null && i.focus.windowId === w.window.windowId ? i.focus : null;
  const key = focusHere !== null ? focusHere.key : w.focusedKey;
  const node = key === null ? undefined : w.nodes.get(key);
  const incomplete = key !== null && node === undefined && focusHere?.editable === true;
  let field: RoutingField | null = null;
  let text = "";
  let b = { sentences: 0, paragraphs: 0 };
  if (key !== null && node !== undefined) {
    const editable = node.editable === true;
    const secure = secureNode(node);
    text = editable && !secure ? (node.value ?? "") : "";
    b = boundary(text);
    field = { key, role: node.role, secure, editable, empty: text === "", prose: editable && !secure && (node.role === "AXTextArea" || b.sentences > 0) };
  }
  const host = i.host !== null && field !== null && i.host.windowId === w.window.windowId && i.host.key === field.key ? i.host : null;
  return {
    readerSession: i.readerSession,
    pid: w.app.pid,
    bundleId: w.app.bundleId,
    app: w.app.name,
    windowId: w.window.windowId,
    title: w.window.title,
    windowKind: w.window.kind,
    field,
    incomplete,
    selection: host?.selection ?? "unknown",
    composing: host?.composing ?? false,
    sentences: b.sentences,
    paragraphs: b.paragraphs,
    candidates: [...i.candidates].sort().join("\u0000"),
    memoryRevision: i.memoryRevision,
    settingsRevision: i.settingsRevision,
    textRevision: digest(`${text}\u0000${host?.selection ?? "unknown"}`),
  };
}

/**
 * The first way `next` differs from `prev` that opens a new decision, or null when it is the same context (ordinary
 * typing, or nothing changed). Order matters only for which reason is logged.
 */
export function breakpoint(prev: RoutingContext | null, next: RoutingContext): Breakpoint | null {
  if (prev === null || prev.readerSession !== next.readerSession) return "reader";
  if (prev.pid !== next.pid || prev.windowId !== next.windowId || prev.title !== next.title) return "document";
  if ((prev.field?.key ?? null) !== (next.field?.key ?? null) || prev.field?.role !== next.field?.role || prev.field?.secure !== next.field?.secure || prev.incomplete !== next.incomplete) return "focus";
  if (prev.selection !== next.selection) return "selection";
  if (prev.composing !== next.composing) return "composing";
  if (prev.sentences !== next.sentences || prev.paragraphs !== next.paragraphs) return "sentence";
  if (prev.candidates !== next.candidates) return "candidates";
  if (prev.memoryRevision !== next.memoryRevision) return "memory";
  if (prev.settingsRevision !== next.settingsRevision) return "settings";
  return null;
}
