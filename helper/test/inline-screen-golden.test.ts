import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ConsumerMessage, ScreenTextReply } from "../src/protocol.ts";

const fixture = new URL("../fixtures/golden/screen-text.ndjson", import.meta.url);
const lines = readFileSync(fixture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("screen text golden wire", () => {
  it("keeps the request and reply shared with the host", () => {
    const request = ConsumerMessage.parse(lines[0]);
    expect(request).toEqual({ type: "screenTextRequest", v: 1, id: "screen-golden-1", revision: 42, pid: 2001, windowNumber: 101, maxCharacters: 2048, appsOff: ["com.example.Secret"], sitesOff: ["https://secret.example"], site: "https://docs.example" });
    expect(request).not.toHaveProperty("windowId");
    expect(ScreenTextReply.parse(lines[1])).toMatchObject({ type: "screenTextReply", id: "screen-golden-1", revision: 42, text: "Project brief\nShip the local suggestion" });
  });
});
