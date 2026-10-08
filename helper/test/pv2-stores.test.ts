// PV2 Q2 (SC1 T5): every local store of request bodies (the replay cache, the harness's request log, the evaluations'
// --log-jev and --dump files, through fill/jev.ts storableRequest) keeps a request only after it verifies as the client
// would send it, and with every value in a format Caret never carries withheld.
import { minted } from "./minted.ts";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachedAsk } from "../src/engines/decide/cache.ts";
import { harnessEngine } from "../src/engines/decide/harness.ts";
import { storableRequest, type AskJev, type JevRequest } from "../src/fill/jev.ts";
import { Disclosure, OutOfShape, storable, UnmintedText } from "../src/privacy/disclosure.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pv2-stores-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const FIXTURE = { windows: () => true, memory: true, plan: true };
const CARD = "4111 1111 1111 1111";
const answer: AskJev = async () => ({ model: "jev-test", answers: { f1: { choice: "none", confidence: 0.9 } }, inputTokens: 1, latencyMs: 1, costUsd: 0 });

/**
 * A purpose-less fixture request whose own wording holds a card number: minted, but a format Caret never carries, so
 * sealing it would refuse it (privacy.ts assertNoExcludedValue); built unsealed, as a store's own guarantee must hold
 * whatever reaches it.
 */
function withCard(): JevRequest {
  const d = new Disclosure([]);
  return { state: { task: d.own(`Order note: card 4111 1111 1111 1111`) }, questions: { f1: { type: "choice", instructions: d.own("Which?"), criteria: { none: d.own("None.") } } }, snippets: [], charged: {}, disclosure: d };
}
/** The same request with one string its Disclosure never minted. */
function unminted(): JevRequest {
  const r = minted({ state: { task: "Fill." }, questions: { f1: { type: "choice", instructions: "Which?", criteria: { none: "None." } } }, snippets: [], charged: {} });
  return { ...r, state: { task: "raw screen text" as never } };
}

const files = (d: string): string[] => readdirSync(d, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));

describe("PV2 Q2: what a store keeps of a request", () => {
  it("the replay cache refuses an unminted request before it replays or records, and keeps a card number withheld", async () => {
    const ask = cachedAsk(answer, { dir, mode: "replay-or-record", engine: "jev", model: "jev-latest", fixture: FIXTURE, env: {} });
    await expect(ask(unminted())).rejects.toBeInstanceOf(UnmintedText);
    expect(files(dir)).toEqual([]);
    await ask(withCard());
    const stored = files(dir).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(stored).toContain("[withheld]");
    expect(stored).not.toContain(CARD);
    // Replay verifies too: the unminted request is refused though an entry exists for nothing like it.
    const replay = cachedAsk(answer, { dir, mode: "replay", engine: "jev", model: "jev-latest", fixture: FIXTURE, env: {} });
    await expect(replay(unminted())).rejects.toBeInstanceOf(UnmintedText);
  });

  it("the harness's request log keeps a verified body, with a card number withheld", async () => {
    const log = join(dir, "requests.ndjson");
    const h = harnessEngine({ name: "canned", canned: answer, fixture: FIXTURE, logRequests: log });
    // The canned engine meets the client's format check, so the card is refused before it is answered, and logged
    // only as the verified body with the card withheld.
    await expect(h.ask(withCard())).rejects.toThrow(/shaped like a cardNumber/u);
    const kept = readFileSync(log, "utf8");
    expect(kept).toContain("[withheld]");
    expect(kept).not.toContain(CARD);
    await expect(h.ask(unminted())).rejects.toBeInstanceOf(UnmintedText);
  });

  it("an evaluation's excerpt is kept only for a request in shape, with its formats withheld", () => {
    const r = withCard();
    expect(storableRequest(r, (f) => ({ state: f.state }))).toEqual({ state: { task: "Order note: card [withheld]" } });
    expect(() => storableRequest(unminted(), () => ({}))).toThrow(UnmintedText);
    const d = new Disclosure([]);
    expect(() => storable({ purpose: "route.judge", disclosure: d }, { state: { notes: d.own("x") } }, {})).toThrow(OutOfShape);
  });
});
