import { AsyncLocalStorage } from "node:async_hooks";
import { flat, type ViewSpan } from "../privacy.ts";
import { viewInventory } from "./ledger/account.ts";
import { partsOf, sourceLines, sourcePieces } from "./ledger/source.ts";

/**
 * What a first look may send, from the preview the person consented to: per window id, the stretches of its lines the
 * preview showed as sent. Per-look state follows awaited generators, not unrelated work using the same provider.
 */
export class FirstLookAllowList {
  stale = false;
  closed = false;
  private readonly allowed: ReadonlyMap<string, readonly string[]>;

  constructor(allowed: ReadonlyMap<string, readonly string[]>) {
    this.allowed = new Map([...allowed].map(([id, texts]) => [id, texts.map(flat)]));
  }

  refuse(): never {
    this.stale = true;
    throw new PreviewStale();
  }

  checkOpen(): void {
    if (this.stale || this.closed) this.refuse();
  }

  /** Whether `piece`, a line of text a request reveals, stands inside a stretch the preview showed for window `id`. */
  private shown(id: string | null, piece: string): boolean {
    const p = flat(piece);
    if (p === "") return true;
    const windows = id === null ? [...this.allowed.values()] : [this.allowed.get(id) ?? []];
    return windows.some((texts) => texts.some((t) => t.includes(p)));
  }

  /**
   * Refuses (and ends the look) when a request text reveals a line the preview did not show: each declared span's lines
   * in its own window; each saved value or user instruction it carries, line by line, in any window (a saved value the
   * screen never showed was never previewed); and window text with no declared span at all.
   */
  check(spans: readonly ViewSpan[], reasons: ReadonlySet<string> | null, text: string, origins: readonly string[] = []): void {
    this.checkOpen();
    for (const sp of spans) {
      const id = sp.view.window.windowId;
      if ("text" in sp) {
        // A span declared by its text reveals each line of the view that holds a line of it, whole, as the ledger charges
        // it (privacy/ledger/measure.ts placeSpan); Caret's own wording around it stands in no line and reveals nothing.
        const pieces = new Set([...sourceLines(sp.text), ...sourcePieces(sp.text)]);
        for (const line of viewInventory(sp.view).lines) if ([...pieces].some((p) => line.includes(p)) && !this.shown(id, line)) this.refuse();
        continue;
      }
      const raw = partsOf(sp.view).find((p) => p.id === sp.at.part)?.raw.slice(sp.at.start, sp.at.end);
      if (raw === undefined) this.refuse();
      for (const line of sourcePieces(raw)) if (!this.shown(id, line)) this.refuse();
    }
    if (text === "") return;
    const originals = origins.length > 0 ? origins : reasons?.has("memory") || reasons?.has("instruction") ? [text] : [];
    for (const origin of originals) for (const line of sourcePieces(origin)) if (!this.shown(null, line)) this.refuse();
    if (spans.length === 0 && ["candidate", "held", "plan", "drafted"].some((r) => reasons?.has(r))) this.refuse();
  }
}

export class PreviewStale extends Error {
  constructor() {
    super("previewStale");
    this.name = "PreviewStale";
  }
}

const active = new AsyncLocalStorage<FirstLookAllowList>();
export function withFirstLookAllowList<T>(list: FirstLookAllowList, run: () => T): T {
  return active.run(list, run);
}
export function checkFirstLookOpen(): void {
  active.getStore()?.checkOpen();
}
export function checkFirstLookText(spans: readonly ViewSpan[], reasons: ReadonlySet<string> | null, text: string, origins: readonly string[]): void {
  active.getStore()?.check(spans, reasons, text, origins);
}
