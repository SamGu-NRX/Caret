import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ConsumerMessage, ScreenTextReply } from "../src/protocol.ts";

const fixture = new URL("../fixtures/golden/screen-text.ndjson", import.meta.url);
const lines = readFileSync(fixture, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

describe("screen text golden wire", () => {
  it("keeps the request and reply shared with the host", () => {
    expect(ConsumerMessage.parse(lines[0])).toMatchObject({ type: "screenTextRequest", id: "screen-golden-1", revision: 42 });
    expect(ScreenTextReply.parse(lines[1])).toMatchObject({ type: "screenTextReply", id: "screen-golden-1", revision: 42, text: "Project brief\nShip the local suggestion" });
  });
});
