// The caches of answers about screen text (privacy/text-memo.ts) never hold the text: after the helper reads a window
// with planted secrets, no cache key or value holds any six-character piece of them; entries expire after ten minutes;
// and a purged window empties every cache. Every secret here is synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { excludedValue } from "../src/privacy/exclude.ts";
import { markerEnds, markerWord, secretText } from "../src/memory/sensitive.ts";
import { TEXT_MEMO_MS, TextMemo, clearTextMemos, hmacSha256, padsOf, textMemos } from "../src/privacy/text-memo.ts";
import { createHmac } from "node:crypto";
import type { ReaderLink } from "../src/executor/means.ts";
import { snap, text } from "./builders.ts";

const SECRETS = ["Tr0ub4dor&3xQz9!", "4111 1111 1111 1111", "sk-live-9fQ2mZ7xW4kP1rT8vB3nY6cD", "Q7MZ-PW2K-88XJ"];
const LINES = [`Password: ${SECRETS[0]}`, `Card ${SECRETS[1]}`, `API key ${SECRETS[2]}`, `Recovery code ${SECRETS[3]}`, `My password is ${SECRETS[0]}`];

/** Every piece of six characters or more of each secret. */
function pieces(): string[] {
  const out = new Set<string>();
  for (const s of SECRETS) for (let i = 0; i < s.length; i++) for (let j = i + 6; j <= s.length; j++) out.add(s.slice(i, j));
  return [...out];
}

function heldText(): string {
  return JSON.stringify(textMemos().map((m) => m.dump()));
}

describe("text memos hold no text", () => {
  beforeEach(() => clearTextMemos());

  it("keeps no piece of a planted secret after the scanners read it", () => {
    for (const l of LINES) {
      excludedValue(l);
      secretText(l);
      markerWord(l);
      markerEnds(l);
    }
    expect(textMemos().some((m) => m.size > 0)).toBe(true);
    const held = heldText();
    for (const p of pieces()) expect(held, p).not.toContain(p);
    for (const l of LINES) expect(held).not.toContain(l);
  });

  it("answers the same from the cache as from a fresh scan", () => {
    const first = LINES.map((l) => [excludedValue(l), secretText(l), markerWord(l), markerEnds(l)]);
    const again = LINES.map((l) => [excludedValue(l), secretText(l), markerWord(l), markerEnds(l)]);
    expect(again).toEqual(first);
  });

  it("keys by HMAC-SHA256, byte for byte as node:crypto computes it", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef");
    for (const l of [...LINES, "", "é ü 東京"]) expect(hmacSha256(padsOf(key), l)).toBe(createHmac("sha256", key).update(l, "utf8").digest("base64"));
  });

  it("drops an entry ten minutes after it was made", () => {
    let now = 1_000;
    const m = new TextMemo<number>(10, () => now);
    let computed = 0;
    expect(m.get("a line", () => ++computed)).toBe(1);
    now += TEXT_MEMO_MS - 1;
    expect(m.get("a line", () => ++computed)).toBe(1);
    now += 1;
    expect(m.get("a line", () => ++computed)).toBe(2);
    m.expire(now + TEXT_MEMO_MS);
    expect(m.size).toBe(0);
  });
});

describe("the helper's text memos", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  beforeEach(() => {
    clearTextMemos();
    dir = mkdtempSync(join(tmpdir(), "caret-memo-"));
    store = new Store(join(dir, "c.db"));
    helper = new Helper({ store, askJev: async () => Promise.reject(new Error("no Jev in this test")), shadow: false, allowBackgroundFocus: false, publish: () => {}, readerLink: {} as ReaderLink });
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("holds no piece of a secret on screen, and empties when a window is purged", () => {
    helper.handleReader(snap(LINES.map((l, i) => text(`t${i}`, l)), { at: 1_000, windowId: "notes-1" }));
    expect(textMemos().some((m) => m.size > 0)).toBe(true);
    const held = heldText();
    for (const p of pieces()) expect(held, p).not.toContain(p);
    helper.purgeWindow(snap([], { at: 2_000, windowId: "notes-1" }));
    expect(textMemos().map((m) => m.size)).toEqual(textMemos().map(() => 0));
  });
});
