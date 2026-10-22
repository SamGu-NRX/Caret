// pageCompare's per-origin bound, across documents (counsel, "pageCompare as an oracle"): at most COMPARE_PER_ORIGIN
// candidates per origin in any hour; past it every candidate answers unknown. The content script holds the per-control
// and per-task bounds of its own document. The spend is kept in chrome.storage.session, not the worker's memory: MV3
// stops an idle worker within about 30 seconds, and a budget in a Map would start over at every restart (audit of
// PR #52, LOW 9). Session storage lasts until the browser quits and, at its default access level, no content script
// can read or reset it.

export const COMPARE_PER_ORIGIN = 256;
export const COMPARE_WINDOW_MS = 60 * 60 * 1000;

/** The part of chrome.storage.session the budget uses. */
export interface BudgetStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const keyOf = (origin: string): string => `compareSpend:${origin}`;

/**
 * Spends from each origin's hourly budget in `store`. Spends are queued one after another, so two compares that
 * arrive together cannot both read the same balance. A store that fails to answer allows nothing: the candidates
 * then answer unknown, and `onError` names why.
 */
export class CompareSpend {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly store: BudgetStore;
  private readonly onError: (why: string) => void;

  constructor(store: BudgetStore, onError: (why: string) => void = () => {}) {
    this.store = store;
    this.onError = onError;
  }

  /** Spends `n` of `origin`'s budget; how many of them are allowed, the rest answering unknown. */
  allowance(origin: string, n: number, now = Date.now()): Promise<number> {
    const run = this.queue.then(() => this.spend(origin, n, now));
    this.queue = run.catch(() => {});
    return run;
  }

  private async spend(origin: string, n: number, now: number): Promise<number> {
    const key = keyOf(origin);
    try {
      const kept = (await this.store.get(key))[key];
      const times = Array.isArray(kept) ? kept.filter((t): t is number => typeof t === "number" && now - t < COMPARE_WINDOW_MS && t <= now) : [];
      const allowed = Math.max(0, Math.min(n, COMPARE_PER_ORIGIN - times.length));
      for (let i = 0; i < n; i++) times.push(now);
      await this.store.set({ [key]: times.slice(-COMPARE_PER_ORIGIN * 2) });
      return allowed;
    } catch (e) {
      this.onError(`the compare budget for ${origin} could not be read or kept (${e instanceof Error ? e.message : String(e)}), so its candidates answer unknown`);
      return 0;
    }
  }
}
