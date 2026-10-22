import { describe, expect, it } from "vitest";
import { ScreenTextReply, ScreenTextRequest } from "../src/protocol.ts";

describe("screen text wire messages", () => {
  it("validates request and reply and carries revision", () => {
    const request = { type: "screenTextRequest", v: 1, id: "r1", revision: 7, windowId: "7-1", maxCharacters: 2048 };
    expect(ScreenTextRequest.parse(request)).toEqual(request);
    const reply = { type: "screenTextReply", v: 1, id: "r1", revision: 7, text: "Reply above" };
    expect(ScreenTextReply.parse(reply)).toEqual(reply);
    expect(ScreenTextReply.parse({ ...reply, revision: 6 })).not.toEqual(request);
  });
});
