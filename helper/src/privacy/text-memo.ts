// Caches of answers about screen text (privacy/exclude.ts, memory/sensitive.ts) keyed so that no cache holds the text:
// each key is an HMAC-SHA256 of the text under a key made at random when the process starts and never stored or sent,
// and each value is an answer or offsets, never text. An entry lives at most TEXT_MEMO_MS; a purged window clears every
// memo (Helper.purgeWindow), and the helper's periodic prune drops expired entries (Helper.tick).
//
// The caches were Maps keyed by the raw text, cleared only at 8,000 entries: a password or card number on screen stayed
// in the helper's memory as a key long after its window closed (Greptile on #13, P0).
import { hash, randomBytes } from "node:crypto";

/**
 * How long an answer is kept: the screen model's rolling ten minutes (model.ts ROLLING_WINDOW_MS), so a cache doesn't
 * outlive the text it answered for. No hit rate was measured for it; a miss only costs a rescan.
 */
export const TEXT_MEMO_MS = 10 * 60 * 1000;

/** SHA-256's block size, and HMAC's key pads (RFC 2104) for `key`, which is at most one block. */
const BLOCK = 64;
function pads(key: Buffer): { inner: Buffer; outer: Buffer } {
  if (key.length > BLOCK) throw new Error("text-memo: an HMAC key longer than a block must be hashed first");
  const inner = Buffer.alloc(BLOCK, 0x36);
  const outer = Buffer.alloc(BLOCK, 0x5c);
  for (let i = 0; i < key.length; i++) {
    inner[i] = (inner[i] as number) ^ (key[i] as number);
    outer[i] = (outer[i] as number) ^ (key[i] as number);
  }
  return { inner, outer };
}

/**
 * HMAC-SHA256 of `text` under the pads of a key, base64: the same bytes as createHmac's, made from two one-shot
 * crypto.hash calls. createHmac cost 10.3 µs a call and this 0.92 µs on the dev Mac (2026-10-09, 200,000 calls on lines of about 55
 * characters, under load); every cached lookup pays it.
 */
export function hmacSha256(p: { inner: Buffer; outer: Buffer }, text: string): string {
  const inner = hash("sha256", Buffer.concat([p.inner, Buffer.from(text, "utf8")]), "buffer");
  return hash("sha256", Buffer.concat([p.outer, inner]), "base64");
}

/** Made once per process from 32 random bytes, never stored or sent. */
const PADS = pads(randomBytes(32));
const ALL = new Set<TextMemo<unknown>>();

/** The cache key of `text`. */
function keyOf(text: string): string {
  return hmacSha256(PADS, text);
}

/** HMAC pads for a test's own key. */
export const padsOf = pads;

export class TextMemo<V> {
  private readonly entries = new Map<string, { value: V; at: number }>();
  private readonly max: number;
  private readonly now: () => number;

  /** `max`: entries kept at most; past it the cache starts over. `now` is for tests. */
  constructor(max: number, now: () => number = Date.now) {
    this.max = max;
    this.now = now;
    ALL.add(this as TextMemo<unknown>);
  }

  /** The answer for `text`, computed by `answer` when none younger than TEXT_MEMO_MS is kept. */
  get(text: string, answer: () => V): V {
    const key = keyOf(text);
    const now = this.now();
    this.expire(now);
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit.value;
    const value = answer();
    if (this.entries.size >= this.max) this.entries.clear();
    this.entries.set(key, { value, at: now });
    return value;
  }

  /** Drops entries older than TEXT_MEMO_MS. Entries are kept in the order they were made, so the oldest come first. */
  expire(now = this.now()): void {
    for (const [k, e] of this.entries) {
      if (now - e.at < TEXT_MEMO_MS) break;
      this.entries.delete(k);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  /** What the cache holds, for tests: keys and values only. */
  dump(): { key: string; value: V; at: number }[] {
    return [...this.entries].map(([key, e]) => ({ key, ...e }));
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Empties every text memo: a window was purged. */
export function clearTextMemos(): void {
  for (const m of ALL) m.clear();
}

/** Drops expired entries from every text memo (Helper.tick). */
export function expireTextMemos(now = Date.now()): void {
  for (const m of ALL) m.expire(now);
}

/** Every text memo, for tests. */
export function textMemos(): readonly TextMemo<unknown>[] {
  return [...ALL];
}
