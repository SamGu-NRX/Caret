// W1: the page engine's wire (protocol.ts, "the page engine"), against the golden lines the Swift bridge also decodes.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActGrant, AnyMessage, AnyPageMessage, EngineMessage, GRANT_MAX_MS, HelperToEngine, HelperToReader, PageCommand, PageResult, PageSnapshot, ScopedActGrant } from "../src/protocol.ts";

const GOLDEN = fileURLToPath(new URL("../fixtures/golden/page.ndjson", import.meta.url));
const lines = readFileSync(GOLDEN, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("page golden lines", () => {
  it("holds one of every page message, in this order", () => {
    expect(lines.map((l) => l.type)).toEqual([
      "engineChallenge", "engineHello", "engineWelcome", "engineReady", "pageHello",
      "pageCommand", "pageSnapshot", "pageResult", "scopedActGrant", "pageCommand", "pageResult", "pageCommand", "pageResult",
      "pageCommand", "pageCommand", "pageResult", "actRevoke", "pageResult", "pageResult", "pageCommand", "pageCommand", "pageResult",
      "pagePing", "pagePong", "pageChunk", "scopedActGrant",
    ]);
  });

  it("parses every line losslessly as a page message", () => {
    for (const l of lines) expect(AnyPageMessage.parse(l)).toEqual(l);
  });

  it("keeps each direction to its own union", () => {
    const fromEngine = new Set(["pageHello", "pageSnapshot", "pageResult", "pagePong"]);
    const toEngine = new Set(["pageCommand", "scopedActGrant", "actRevoke", "pagePing"]);
    for (const l of lines) {
      expect(EngineMessage.safeParse(l).success).toBe(fromEngine.has(l.type as string));
      expect(HelperToEngine.safeParse(l).success).toBe(toEngine.has(l.type as string));
    }
  });

  it("is a set of additions: no page message parses as a screen-socket message except the shared actRevoke", () => {
    for (const l of lines) expect(AnyMessage.safeParse(l).success).toBe(l.type === "actRevoke");
    // And the reader's own grant is unchanged: a scoped grant is not an actGrant, and actGrant still needs pid and windowId.
    expect(HelperToReader.safeParse(lines[8]).success).toBe(false);
    expect(ActGrant.safeParse({ type: "actGrant", v: 1, taskId: "t", pid: 1, windowId: "1-1", at: 1, expires: 2 }).success).toBe(true);
  });
});

describe("scoped act grant", () => {
  const page = lines[8] as Record<string, unknown>;
  it("caps a grant at GRANT_MAX_MS, as ActGrant does", () => {
    expect(ScopedActGrant.safeParse({ ...page, expires: (page.at as number) + GRANT_MAX_MS }).success).toBe(true);
    expect(ScopedActGrant.safeParse({ ...page, expires: (page.at as number) + GRANT_MAX_MS + 1 }).success).toBe(false);
    expect(ScopedActGrant.safeParse({ ...page, expires: page.at }).success).toBe(false);
  });
  it("pins engine, tab, frame, origin and navigation generation for a page", () => {
    const scope = page.scope as Record<string, unknown>;
    for (const k of ["engine", "tabId", "frameId", "origin", "navGen"]) {
      const { [k]: _gone, ...rest } = scope;
      expect(ScopedActGrant.safeParse({ ...page, scope: rest }).success, k).toBe(false);
    }
    expect(ScopedActGrant.safeParse({ ...page, scope: { ...scope, kind: "elsewhere" } }).success).toBe(false);
  });
});

describe("page verbs", () => {
  const write = lines[9] as { verb: Record<string, unknown> };
  it("refuses a mutating verb without a task: pages have no fixture bypass", () => {
    const { taskId: _t, ...noTask } = write.verb;
    expect(PageCommand.safeParse({ ...write, verb: noTask }).success).toBe(false);
  });
  it("requires the document the walk named, so a write cannot reach another document in the frame", () => {
    const { documentId: _d, ...noDoc } = write.verb;
    expect(PageCommand.safeParse({ ...write, verb: noDoc }).success).toBe(false);
  });
  it("refuses an attach whose digest is not a sha256", () => {
    const attach = lines[20] as { verb: { file: Record<string, unknown> } };
    expect(PageCommand.safeParse({ ...attach, verb: { ...attach.verb, file: { ...attach.verb.file, sha256: "abc" } } }).success).toBe(false);
  });
});

describe("page results and snapshots", () => {
  it("names a risk exactly on a handoff", () => {
    const handoff = lines[15] as Record<string, unknown>;
    expect(PageResult.safeParse(handoff).success).toBe(true);
    const { risk: _r, ...noRisk } = handoff;
    expect(PageResult.safeParse(noRisk).success).toBe(false);
    expect(PageResult.safeParse({ ...lines[7], risk: "outbound" }).success).toBe(false);
  });
  it("counts exclusions only by positive count, never by name", () => {
    const snap = lines[6] as { frames: Record<string, unknown>[] };
    const f = snap.frames[0] as Record<string, unknown>;
    expect(PageSnapshot.safeParse({ ...snap, frames: [{ ...f, excluded: { password: 0 } }] }).success).toBe(false);
    expect(PageSnapshot.safeParse({ ...snap, frames: [{ ...f, excluded: { ssn: 1 } }] }).success).toBe(false);
  });
  it("refuses a snapshot with no frame", () => {
    expect(PageSnapshot.safeParse({ ...lines[6], frames: [] }).success).toBe(false);
  });
});

describe("handshake vector", () => {
  it("matches HMAC-SHA256 over both nonces with the side's label", () => {
    const v = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/golden/page-auth.json", import.meta.url)), "utf8")) as Record<string, string>;
    const key = Buffer.from(v.secret as string, "hex");
    expect(createHmac("sha256", key).update(`caret-page-bridge\n${v.challenge}\n${v.bridgeNonce}`).digest("hex")).toBe(v.bridgeProof);
    expect(createHmac("sha256", key).update(`caret-page-helper\n${v.bridgeNonce}\n${v.challenge}`).digest("hex")).toBe(v.helperProof);
  });
});
