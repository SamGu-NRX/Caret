// The table behind HelperServer.send (src/send-gate.ts): every message type the server can send has a class, and each
// role is sent exactly the classes it may read. The socket-level checks are in test/nonhost-gate.test.ts.
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { HelperMessage, HelperToReader } from "../src/protocol.ts";
import { classOf, HOST_ANSWERED, MESSAGE_CLASS, withheldBecause, type SessionRole } from "../src/send-gate.ts";

/** The `type` literals of a discriminated union, through nested unions such as taskProgress's phases. */
function typesOf(schema: z.ZodType): string[] {
  const s = schema as unknown as { options?: z.ZodType[]; shape?: { type: { values: Set<string> } } };
  if (Array.isArray(s.options)) return s.options.flatMap(typesOf);
  if (s.shape === undefined) throw new Error("a union member without a shape");
  return [...s.shape.type.values];
}

const SENT = [...new Set([...typesOf(HelperMessage), ...typesOf(HelperToReader)])].sort();

describe("send gate classes", () => {
  it("classes every type the protocol lets the helper send, and nothing else but its own refusal", () => {
    const missing = SENT.filter((t) => !Object.hasOwn(MESSAGE_CLASS, t));
    expect(missing).toEqual([]);
    expect(Object.keys(MESSAGE_CLASS).filter((t) => !SENT.includes(t))).toEqual(["refusal"]);
  });

  it("throws, naming the type, for a type with no class, including Object's own keys", () => {
    for (const t of ["somethingNew", "toString", "constructor", "__proto__"]) {
      expect(() => classOf(t)).toThrow(`message type ${JSON.stringify(t)} has no class in MESSAGE_CLASS`);
      expect(() => withheldBecause("host", t)).toThrow(/has no class/);
    }
  });

  it("sends a non-host consumer only status, the reader only status and its own messages, and the host everything but the reader's", () => {
    const allowed = (role: SessionRole): string[] => [...SENT, "refusal"].filter((t) => withheldBecause(role, t) === null).sort();
    expect(allowed("other")).toEqual(["hostAuthenticated", "hostChallenge", "refusal", "spend"]);
    expect(allowed("reader")).toEqual(["actGrant", "actRevoke", "calendarGrant", "helperAuth", "hostAuthenticated", "hostChallenge", "readerCommand", "refusal", "spend"]);
    expect(allowed("host")).toEqual([...SENT, "refusal"].filter((t) => classOf(t) !== "reader").sort());
  });

  it("names why a message is withheld", () => {
    expect(withheldBecause("other", "fillProposal")).toBe("fillProposal is derived from the screen or the user's data, and only a host whose proof checked out is sent that");
    expect(withheldBecause("host", "readerCommand")).toBe("readerCommand is the reader's, and this connection is not the reader");
  });

  it("refuses up front only requests whose answer is a host message", () => {
    const answers: Record<string, string> = { fillRequest: "fillProposal", planRequest: "planProposal", askAnswer: "askQuestion", firstLook: "firstLookReply", firstLookPreviewRequest: "firstLookPreview", memoryRequest: "memoryReply", memoryNotRight: "memoryReply", memoryDocumentRequest: "memoryDocumentReply", activityRequest: "activityReply", fileConfirm: "fileConfirmReply" };
    expect(Object.keys(HOST_ANSWERED).sort()).toEqual(Object.keys(answers).sort());
    for (const answer of Object.values(answers)) expect(classOf(answer)).toBe("host");
  });
});
