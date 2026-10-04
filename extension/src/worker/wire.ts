// Checks on what arrives from the bridge before the worker routes it. The helper is authenticated and validates its
// own output with zod; these checks keep a malformed line from reaching a tab and pin the fields routing reads.
import type { ActVerb, PageVerb } from "../shared/messages.ts";

const int = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
const str = (x: unknown): x is string => typeof x === "string";
const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const KINDS = new Set(["text", "email", "tel", "url", "number", "search", "date", "time", "datetime", "month", "week", "textarea", "select", "checkbox", "radio", "combobox", "button", "link", "file", "contenteditable", "range", "color"]);

export function parseVerb(x: unknown): PageVerb | null {
  if (typeof x !== "object" || x === null) return null;
  const v = x as Record<string, unknown>;
  if (v.kind === "pageWalk") return v.tabId === null || int(v.tabId) ? { kind: "pageWalk", tabId: v.tabId as number | null } : null;
  if (!int(v.tabId) || !int(v.frameId) || !nonEmpty(v.documentId) || !nonEmpty(v.id) || !str(v.control) || !KINDS.has(v.control) || !str(v.name) || !nonEmpty(v.taskId)) return null;
  switch (v.kind) {
    case "pageWrite":
    case "pageSelect":
    case "pageChooseOption":
      return str(v.expect) && str(v.value) ? (v as unknown as ActVerb) : null;
    case "pagePress":
      return v as unknown as ActVerb;
    case "pageSetChecked":
      return typeof v.checked === "boolean" ? (v as unknown as ActVerb) : null;
    case "pageAttachFile": {
      const f = v.file as Record<string, unknown> | undefined;
      return f !== undefined && nonEmpty(f.name) && str(f.type) && int(f.size) && str(f.sha256) && /^[0-9a-f]{64}$/.test(f.sha256) ? (v as unknown as ActVerb) : null;
    }
    default:
      return null;
  }
}

export type FromHelper =
  | { type: "engineReady"; engine: string }
  | { type: "pageCommand"; id: string; expires: number; verb: PageVerb }
  | { type: "scopedActGrant"; taskId: string; scope: { kind: string; [k: string]: unknown }; at: number; expires: number }
  | { type: "actRevoke"; taskId: string }
  | { type: "pagePing"; id: string }
  | { type: "pageChunk"; id: string; index: number; count: number; data: string };

/** A bridge message the worker understands, or null. */
export function parseFromHelper(x: unknown): FromHelper | null {
  if (typeof x !== "object" || x === null) return null;
  const m = x as Record<string, unknown>;
  if (m.v !== 1) return null;
  switch (m.type) {
    case "engineReady":
      return nonEmpty(m.engine) ? { type: "engineReady", engine: m.engine } : null;
    case "pageCommand": {
      const verb = parseVerb(m.verb);
      return nonEmpty(m.id) && int(m.expires) && verb !== null ? { type: "pageCommand", id: m.id, expires: m.expires, verb } : null;
    }
    case "scopedActGrant": {
      const s = m.scope as Record<string, unknown> | undefined;
      if (!nonEmpty(m.taskId) || !int(m.at) || !int(m.expires) || typeof s !== "object" || s === null || !str(s.kind)) return null;
      if (s.kind === "page" && !(nonEmpty(s.engine) && int(s.tabId) && int(s.frameId) && nonEmpty(s.origin) && int(s.navGen))) return null;
      return { type: "scopedActGrant", taskId: m.taskId, scope: s as { kind: string }, at: m.at, expires: m.expires };
    }
    case "actRevoke":
      return nonEmpty(m.taskId) ? { type: "actRevoke", taskId: m.taskId } : null;
    case "pagePing":
      return nonEmpty(m.id) ? { type: "pagePing", id: m.id } : null;
    case "pageChunk":
      return nonEmpty(m.id) && int(m.index) && int(m.count) && m.count >= 2 && m.index < m.count && str(m.data) ? { type: "pageChunk", id: m.id, index: m.index, count: m.count, data: m.data } : null;
    default:
      return null;
  }
}

/** Joins pageChunk parts by id, in order. A part out of order, or a new id while one is open, starts over. */
export class Chunks {
  private open: { id: string; count: number; parts: string[] } | null = null;
  /** Largest joined message accepted, in characters. Assumed: a helper line is at most a few MB (the helper's own cap is 32 MB). */
  static readonly MAX = 32 * 1024 * 1024;

  add(c: { id: string; index: number; count: number; data: string }): string | null {
    if (c.index === 0) this.open = { id: c.id, count: c.count, parts: [] };
    const o = this.open;
    if (o === null || o.id !== c.id || o.count !== c.count || o.parts.length !== c.index) {
      this.open = null;
      return null;
    }
    o.parts.push(c.data);
    if (o.parts.reduce((n, p) => n + p.length, 0) > Chunks.MAX) {
      this.open = null;
      return null;
    }
    if (o.parts.length < o.count) return null;
    this.open = null;
    return o.parts.join("");
  }
}
