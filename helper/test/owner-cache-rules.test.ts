// HA2 lever 2, Sam's rules: the session's owner verdicts (fill/owner-cache.ts) stay in memory, and are dropped when a
// site is switched off, before anything else reacts, when the session locks or signs out, and when the host's
// connection closes.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { ConsumerMessage, PROTOCOL_VERSION, type Settings } from "../src/protocol.ts";
import { OwnerVerdicts } from "../src/fill/owner-cache.ts";
import type { Helper } from "../src/helper.ts";
import { closeRigs, rig } from "./page-rig.ts";

afterEach(closeRigs);

const verdictsOf = (h: Helper): OwnerVerdicts => (h as unknown as { ownerVerdicts: OwnerVerdicts }).ownerVerdicts;
const seed = (c: OwnerVerdicts): void => {
  c.set("k-note", [{ choice: "user", confidence: 1 }, { choice: "user", confidence: 1 }], ["note"], c.ticket());
  c.set("k-page", [{ choice: "user", confidence: 1 }, { choice: "user", confidence: 1 }], ["page:1"], c.ticket());
};
const settings = (sitesOff?: string[]): Settings => ({ type: "settings", v: PROTOCOL_VERSION, at: Date.now(), roles: ["fill", "repeat", "watch", "calendar"], level: "balanced", paused: false, ...(sitesOff === undefined ? {} : { sitesOff }) });

describe("rule 1: memory only", () => {
  it("owner-cache.ts imports nothing that can write: no file system, no store, no persistence hook", () => {
    const src = readFileSync(new URL("../src/fill/owner-cache.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gmu)].map((m) => m[1]);
    expect(imports).toEqual(["node:crypto"]);
    expect(src).not.toMatch(/\b(?:fs|writeFile|appendFile|createWriteStream|Store|persist|serialize|toJSON|localStorage)\b/u);
  });

  it("the helper only reads, fills, forgets and clears it, and never hands it to its store", () => {
    const src = readFileSync(new URL("../src/helper.ts", import.meta.url), "utf8");
    const uses = [...src.matchAll(/this\.ownerVerdicts(\.\w+)?/gu)].map((m) => m[1] ?? "(passed to fill)");
    expect(new Set(uses)).toEqual(new Set([".clear", ".forget", "(passed to fill)"]));
    expect(src).not.toMatch(/store\.\w+\([^)]*ownerVerdicts/u);
  });
});

describe("rule 3: when it is cleared", () => {
  it("(i, ii) a change to the sites switched off clears every entry, before the page engines hear the list", async () => {
    const r = await rig();
    const cache = verdictsOf(r.helper);
    r.helper.handleSettings(settings(["https://a.example"]));
    seed(cache);
    let sizeWhenHeard = -1;
    r.helper.onSitesOff(() => void (sizeWhenHeard = cache.size));
    sizeWhenHeard = -1;
    r.helper.handleSettings(settings(["https://a.example", "https://b.example"]));
    expect(cache.size).toBe(0);
    expect(sizeWhenHeard).toBe(0);
  });

  it("(i) a settings message whose list did not change keeps the entries", async () => {
    const r = await rig();
    const cache = verdictsOf(r.helper);
    r.helper.handleSettings(settings(["https://a.example"]));
    seed(cache);
    r.helper.handleSettings(settings(["https://a.example"]));
    r.helper.handleSettings(settings());
    expect(cache.size).toBe(2);
  });

  it("(iii) a locked or signed-out session clears the whole cache", async () => {
    for (const why of ["lock", "signOut"] as const) {
      const r = await rig();
      const cache = verdictsOf(r.helper);
      seed(cache);
      const m = ConsumerMessage.parse({ type: "sessionLocked", v: PROTOCOL_VERSION, at: Date.now(), why });
      if (m.type !== "sessionLocked") throw new Error("not parsed as sessionLocked");
      r.helper.handleSessionLocked(m);
      expect(cache.size, why).toBe(0);
    }
  });

  it("(iii) a lock while the host is reconnecting is never heard, so the host's closed connection clears the cache", async () => {
    const r = await rig();
    const cache = verdictsOf(r.helper);
    r.helper.hostConnected("host-1");
    r.helper.consumerConnected("eval-1");
    seed(cache);
    r.helper.hostDisconnected("eval-1");
    expect(cache.size, "a consumer that is not the host leaving keeps the entries").toBe(2);
    r.helper.hostDisconnected("host-1");
    // The screen locks now: the host's sessionLocked has no connection to go through.
    r.helper.hostConnected("host-2");
    expect(cache.size).toBe(0);
  });

  it("(iii) the protocol refuses a sessionLocked without its reason", () => {
    expect(ConsumerMessage.safeParse({ type: "sessionLocked", v: PROTOCOL_VERSION, at: 1 }).success).toBe(false);
  });
});
