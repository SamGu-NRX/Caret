// The spend ledger (H8 decision 4): what this helper process has spent on models since it started, from each
// provider's own usage report. Every Jev call goes through makeJevClient and every writer call through a WriterPort,
// so main.ts wraps those two and nothing else needs to know. The totals go to consumers whose hello names "spend"
// (protocol.ts Spend); the host shows them on its debug socket, so a run reads its real spend there.
import type { AskJev } from "./fill/jev.ts";
import type { WriterPort } from "./writer/port.ts";
import { PROTOCOL_VERSION, type Spend, type SpendBucket } from "./protocol.ts";

export type SpendKind = "jev" | "writer";

const empty = (): SpendBucket => ({ calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

export class SpendLedger {
  readonly since: number;
  private readonly buckets: Record<SpendKind, SpendBucket> = { jev: empty(), writer: empty() };
  private readonly listeners = new Set<() => void>();

  constructor(now: number = Date.now()) {
    this.since = now;
  }

  /** One call the provider answered, with the usage it reported. */
  answered(kind: SpendKind, usage: { inputTokens: number; outputTokens: number; costUsd: number }): void {
    const b = this.buckets[kind];
    b.calls += 1;
    b.inputTokens += usage.inputTokens;
    b.outputTokens += usage.outputTokens;
    b.costUsd += usage.costUsd;
    this.changed();
  }

  /** One call that threw: no usage came back, so it adds nothing to tokens or cost. */
  failed(kind: SpendKind): void {
    this.buckets[kind].failed += 1;
    this.changed();
  }

  message(at: number = Date.now()): Spend {
    return { type: "spend", v: PROTOCOL_VERSION, at, since: this.since, jev: { ...this.buckets.jev }, writer: { ...this.buckets.writer } };
  }

  /** Called after every change; returns the call that stops it. */
  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private changed(): void {
    for (const f of this.listeners) f();
  }
}

/** The Jev client with every call counted. Jev reports input tokens only; its output is free. */
export function ledgeredJev(ask: AskJev, ledger: SpendLedger): AskJev {
  return async (req) => {
    try {
      const r = await ask(req);
      ledger.answered("jev", { inputTokens: r.inputTokens, outputTokens: 0, costUsd: r.costUsd });
      return r;
    } catch (e) {
      ledger.failed("jev");
      throw e;
    }
  };
}

/** The writer with every call counted. */
export function ledgeredWriter(port: WriterPort, ledger: SpendLedger): WriterPort {
  return {
    route: port.route,
    async write(req) {
      try {
        const r = await port.write(req);
        ledger.answered("writer", { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd });
        return r;
      } catch (e) {
        ledger.failed("writer");
        throw e;
      }
    },
  };
}

/**
 * Calls `send` with the ledger's totals at most once per `everyMs` while calls come in, and once more after the last,
 * so a burst of Jev calls makes one message and the final totals always go out.
 */
export function throttledTotals(ledger: SpendLedger, send: (m: Spend) => void, everyMs = 1000): () => void {
  let timer: NodeJS.Timeout | null = null;
  const stop = ledger.onChange(() => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      send(ledger.message());
    }, everyMs);
    timer.unref();
  });
  return () => {
    stop();
    if (timer !== null) clearTimeout(timer);
  };
}
