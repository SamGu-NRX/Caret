import { randomUUID } from "node:crypto";
import type { ScreenModel, WindowState } from "../model.ts";
import { PROTOCOL_VERSION, type FirstLookPreview, type FirstLookPreviewRequest } from "../protocol.ts";
import { flat, sectionTexts, type Span } from "../privacy.ts";
import { Disclosure, viewHolds } from "../privacy/disclosure.ts";
import { excludedValue } from "../privacy/exclude.ts";
import { redactWindow } from "../fill/redact.ts";
import { FirstLookAllowList } from "../privacy/first-look-allow-list.ts";
import { FAMILIES, LEVELS } from "./settings.ts";

export const PREVIEW_TTL_MS = 10 * 60 * 1000;

type SavedPreview = { at: number; spans: readonly Span[] };
type PreviewLookup = { list: FirstLookAllowList } | { error: "previewUnknown" | "previewExpired" };

/** The ledger's distinct, whitespace-collapsed lines in document order. */
function linesOf(w: WindowState): string[] {
  const lines = new Set<string>();
  const add = (text: string | undefined): void => {
    for (const raw of (text ?? "").split(/\r?\n/u)) {
      const line = flat(raw);
      if (line !== "") lines.add(line);
    }
  };
  add(w.window.title);
  for (const n of w.nodes.values()) {
    add(n.label); add(n.value); add(n.placeholder);
    for (const text of sectionTexts(n)) add(text);
  }
  return [...lines];
}

/** Session-local consent text; a restart deliberately makes old ids unknown. */
export class FirstLookPreviews {
  private readonly saved = new Map<string, SavedPreview>();

  build(req: FirstLookPreviewRequest, model: ScreenModel, at: number): FirstLookPreview {
    if (req.families.some((f) => !(FAMILIES as readonly string[]).includes(f))) throw new Error("unknown preview family");
    if (new Set(req.families).size !== req.families.length) throw new Error("a preview family is named twice");
    // Loop and routine recognition are local. Only these enabled families can ask a model in a first look.
    const readsScreen = FAMILIES.some((f) => req.families.includes(f) && LEVELS[req.level].families[f] && ["fill", "pending", "event"].includes(f));
    const windows = readsScreen ? [...model.windows.values()] : [];
    const d = new Disclosure(windows);
    const spans: Span[] = [];
    for (const w of windows) {
      const view = redactWindow(w);
      for (const line of linesOf(view)) {
        if (d.chars(w.window.windowId) >= d.budget(w)) break;
        if (excludedValue(line) !== null) continue;
        let taken = d.held(view, line);
        if (taken === null) {
          // A long conversation line may not fit whole. Select a prefix through the same ledger, not a separate budget.
          let low = 0;
          let high = line.length - 1;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (d.cost(view, [line.slice(0, middle)]) === null) high = middle - 1;
            else low = middle;
          }
          if (low > 0) taken = d.held(view, line.slice(0, low));
        }
        if (taken !== null) spans.push(...d.spansOfText(taken));
      }
    }
    // A take can charge another window showing the same words. Never expose a span its redacted view drops.
    const allowed = spans.filter((s) => {
      const w = model.windows.get(s.windowId);
      return w !== undefined && viewHolds(redactWindow(w), s.line.slice(s.at, s.at + s.len));
    });
    const shown: FirstLookPreview["windows"] = [];
    for (const w of windows) {
      const lines: FirstLookPreview["windows"][number]["lines"] = [];
      for (const line of linesOf(w)) {
        const mask = new Uint8Array(line.length);
        for (const s of allowed) if (s.windowId === w.window.windowId && s.line === line) mask.fill(1, s.at, s.at + s.len);
        for (let start = 0; start < line.length;) {
          const sent = mask[start] === 1;
          let end = start + 1;
          while (end < line.length && (mask[end] === 1) === sent) end++;
          lines.push({ text: sent ? line.slice(start, end) : "", sent });
          start = end;
        }
      }
      const charsSent = lines.reduce((n, l) => n + l.text.length, 0);
      if (charsSent > 0) shown.push({ bundleId: w.app.bundleId, appName: w.app.name, title: redactWindow(w).window.title, lines, charsSent });
    }
    // Retain expired ids' timestamps for the specific error, but release their screen text.
    for (const [id, saved] of this.saved) if (at - saved.at > PREVIEW_TTL_MS && saved.spans.length > 0) this.saved.set(id, { at: saved.at, spans: [] });
    const previewId = randomUUID();
    this.saved.set(previewId, { at, spans: allowed });
    return { type: "firstLookPreview", v: PROTOCOL_VERSION, requestId: req.requestId, at, previewId, windows: shown, totalChars: shown.reduce((n, w) => n + w.charsSent, 0) };
  }

  lookup(id: string, at: number): PreviewLookup {
    const preview = this.saved.get(id);
    if (preview === undefined) return { error: "previewUnknown" };
    if (at - preview.at > PREVIEW_TTL_MS) return { error: "previewExpired" };
    return { list: new FirstLookAllowList(preview.spans) };
  }
}
