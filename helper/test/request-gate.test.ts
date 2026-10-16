// The table behind the server's inbound gate (src/request-gate.ts): every type a consumer can send has a rule, only the
// handshake and sessionLocked are open to a consumer that is not the proven host, and each refusal names why. The
// socket-level checks are in test/nonhost-commands.test.ts.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { ConsumerMessage } from "../src/protocol.ts";
import { REQUEST_RULE, refusedBecause, ruleOf } from "../src/request-gate.ts";

function typesOf(schema: z.ZodType): string[] {
  const s = schema as unknown as { options?: z.ZodType[]; shape?: { type: { values: Set<string> } } };
  if (Array.isArray(s.options)) return s.options.flatMap(typesOf);
  if (s.shape === undefined) throw new Error("a union member without a shape");
  return [...s.shape.type.values];
}

const SENT = [...new Set(typesOf(ConsumerMessage))].sort();

describe("request gate rules", () => {
  it("has a rule for every type the protocol lets a consumer send, and for nothing else", () => {
    expect(SENT.filter((t) => !Object.hasOwn(REQUEST_RULE, t))).toEqual([]);
    expect(Object.keys(REQUEST_RULE).filter((t) => !SENT.includes(t))).toEqual([]);
  });

  it("throws, naming the type, for a type with no rule, including Object's own keys", () => {
    for (const t of ["somethingNew", "toString", "constructor", "__proto__"]) {
      expect(() => ruleOf(t)).toThrow(`consumer message type ${JSON.stringify(t)} has no rule in REQUEST_RULE`);
      expect(() => refusedBecause("host", t)).toThrow(/has no rule/);
    }
  });

  it("lets a consumer that is not the host send only the handshake and sessionLocked, and the host send everything", () => {
    expect(SENT.filter((t) => refusedBecause("other", t) === null)).toEqual(["hello", "hostProof", "sessionLocked"]);
    expect(SENT.filter((t) => refusedBecause("host", t) !== null)).toEqual([]);
    for (const t of ["runPlan", "taskControl", "offerAccept", "offerStop", "offerControl", "settings", "fillResult"]) expect(REQUEST_RULE[t as keyof typeof REQUEST_RULE].from).toBe("host");
  });

  it("names why a request is refused", () => {
    expect(refusedBecause("other", "offerAccept")).toBe("offerAccept needs a host hello (host: true): accepting an offer makes Caret act");
    expect(refusedBecause("other", "firstLookPreviewRequest")).toBe("firstLookPreviewRequest needs a host hello (host: true): only the host shows the preview as consent");
  });
});
