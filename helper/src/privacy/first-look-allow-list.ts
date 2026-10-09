import { AsyncLocalStorage } from "node:async_hooks";
import type { Span } from "../privacy.ts";

/** Per-look state follows awaited generators, not unrelated work using the same provider. */
export class FirstLookAllowList {
  stale = false;
  closed = false;
  private readonly spans: readonly Span[];

  constructor(spans: readonly Span[]) {
    this.spans = spans.map((s) => ({ ...s }));
  }

  refuse(): never {
    this.stale = true;
    throw new PreviewStale();
  }

  checkOpen(): void {
    if (this.stale || this.closed) this.refuse();
  }

  check(spans: readonly Span[], reasons: ReadonlySet<string> | null, text: string, origins: readonly string[] = []): void {
    this.checkOpen();
    for (const s of spans) {
      const piece = s.line.slice(s.at, s.at + s.len);
      if (!this.spans.some((a) => a.windowId === s.windowId && a.line.slice(a.at, a.at + a.len).includes(piece))) this.refuse();
    }
    if (text === "") return;
    // Saved values and user instructions may contain words no open window shows. They were not previewed.
    const originals = origins.length > 0 ? origins : reasons?.has("memory") || reasons?.has("instruction") ? [text] : [];
    for (const origin of originals) {
      if (!origin.split(/\r?\n/u).every((line) => this.spans.some((s) => s.line.slice(s.at, s.at + s.len).includes(line)))) this.refuse();
    }
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
export function checkFirstLookText(spans: readonly Span[], reasons: ReadonlySet<string> | null, text: string, origins: readonly string[]): void {
  active.getStore()?.check(spans, reasons, text, origins);
}
