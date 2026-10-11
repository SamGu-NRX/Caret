// W1: the page engine's wire (protocol.ts, "the page engine"), against the golden lines the Swift bridge also decodes.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ActGrant, AnyMessage, AnyPageMessage, EngineMessage, GRANT_MAX_MS, HelperToEngine, HelperToReader, MAX_ATTACH_BYTES, PageCommand, PageResult, PageSnapshot, ScopedActGrant, TAB_TEXT_BYTES } from "../src/protocol.ts";
import { bridgeProof, helperProof, pageKey } from "../src/engines/auth.ts";

const GOLDEN = fileURLToPath(new URL("../fixtures/golden/page.ndjson", import.meta.url));
const lines = readFileSync(GOLDEN, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("page golden lines", () => {
  it("holds one of every page message, in this order", () => {
    expect(lines.map((l) => l.type)).toEqual([
      "engineChallenge", "engineHello", "engineWelcome", "engineReady", "pageHello",
      "pageCommand", "pageSnapshot", "pageResult", "scopedActGrant", "pageCommand", "pageResult", "pageCommand", "pageResult",
      "pageCommand", "pageCommand", "pageResult", "actRevoke", "pageResult", "pageResult", "pageCommand", "pageCommand", "pageResult",
      "pagePing", "pagePong", "pageChunk", "scopedActGrant",
      "pageResult", "pageResult", "pageFocus", "pageSitesOff", "pageResult",
      "pageCommand", "pageResult", "pageInput",
      "pageSnapshot", "pageCommand", "pageResult",
      "pageResult",
      "pageReadText", "pageResult", "pageReadText", "pageResult", "pageCommand", "pageResult", "pageSnapshot",
    ]);
  });

  it("parses every line losslessly as a page message", () => {
    for (const l of lines) expect(AnyPageMessage.parse(l)).toEqual(l);
  });

  it("keeps each direction to its own union", () => {
    const fromEngine = new Set(["pageHello", "pageSnapshot", "pageResult", "pagePong", "pageFocus", "pageInput"]);
    const toEngine = new Set(["pageCommand", "scopedActGrant", "actRevoke", "pagePing", "pageSitesOff", "pageReadText"]);
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

  it("carries the file's bytes, a size they match, a bare name and no more than MAX_ATTACH_BYTES (W2)", () => {
    const attach = lines[20] as { verb: { file: Record<string, unknown> } };
    const withFile = (f: Record<string, unknown>) => PageCommand.safeParse({ ...attach, verb: { ...attach.verb, file: { ...attach.verb.file, ...f } } }).success;
    expect(withFile({})).toBe(true);
    expect(withFile({ size: 10 })).toBe(false);
    expect(withFile({ data: "not base64!" })).toBe(false);
    expect(withFile({ name: "../resume.pdf" })).toBe(false);
    expect(withFile({ name: "a\\b.pdf" })).toBe(false);
    expect(withFile({ size: MAX_ATTACH_BYTES + 1 })).toBe(false);
    const { data: _d, ...noData } = attach.verb.file;
    expect(PageCommand.safeParse({ ...attach, verb: { ...attach.verb, file: noData } }).success).toBe(false);
  });

  it("reports what a combobox pick found: the pick, or both names when a filter matches two (W2)", () => {
    const picked = PageResult.parse(lines[26]);
    expect(picked.choice).toEqual({ flavor: "reactSelect", matches: ["United States"], expanded: false, hiddenInput: "set" });
    const both = PageResult.parse(lines[27]);
    expect(both.outcome).toBe("failed");
    expect(both.choice?.matches).toEqual(["United States", "United States Minor Outlying Islands"]);
    expect(both.readings?.afterBlur).toBe(both.readings?.before);
  });

  it("says Not on this site with a whole list of origins, and answers siteOff (W2)", () => {
    const off = lines[29] as Record<string, unknown>;
    expect(HelperToEngine.parse(off)).toEqual(off);
    expect(HelperToEngine.safeParse({ ...off, origins: ["http://127.0.0.1:4310/form"] }).success).toBe(false);
    expect(HelperToEngine.safeParse({ ...off, origins: ["javascript:alert(1)"] }).success).toBe(false);
    expect(PageResult.parse(lines[30]).outcome).toBe("siteOff");
    expect(EngineMessage.parse(lines[28])).toEqual({ type: "pageFocus", v: 1, at: 1790000004200, tabId: 7, frameId: 0 });
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
  it("matches HMAC-SHA256 over both nonces with the side's label, the helper's bound to its pid, under the launch's page key", () => {
    const v = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/golden/page-auth.json", import.meta.url)), "utf8")) as Record<string, string>;
    const key = Buffer.from(v.secret as string, "hex");
    expect(pageKey(Buffer.from(v.launchSecret as string, "hex")).equals(key)).toBe(true);
    expect(bridgeProof(key, v.challenge as string, v.bridgeNonce as string, Number(v.helperPid))).toBe(v.bridgeProof);
    expect(bridgeProof(key, v.challenge as string, v.bridgeNonce as string, Number(v.helperPid) + 1)).not.toBe(v.bridgeProof);
    expect(helperProof(key, v.challenge as string, v.bridgeNonce as string, Number(v.helperPid))).toBe(v.helperProof);
    expect(createHmac("sha256", key).update(`caret-page-helper\n${v.bridgeNonce}\n${v.challenge}\n${v.helperPid}`).digest("hex")).toBe(v.helperProof);
    // Another pid gives another proof: a relay's peer pid cannot reuse the helper's answer.
    expect(helperProof(key, v.challenge as string, v.bridgeNonce as string, Number(v.helperPid) + 1)).not.toBe(v.helperProof);
  });
});

describe("W3 page messages", () => {
  it("an undo's verb says rebind: false, its refusal is notSameElement, and no other rebind value is accepted", () => {
    const undo = PageCommand.parse(lines[31]);
    expect(undo.verb).toMatchObject({ kind: "pageWrite", rebind: false, sameAs: "m1" });
    expect(PageResult.parse(lines[32]).outcome).toBe("notSameElement");
    const verb = (lines[31] as { verb: Record<string, unknown> }).verb;
    expect(PageCommand.safeParse({ ...lines[31], verb: { ...verb, rebind: true } }).success).toBe(false);
    const { rebind: _r, ...forward } = verb;
    expect(PageCommand.safeParse({ ...lines[31], verb: forward }).success).toBe(true);
  });

  it("the user's input names the tab, frame and kind only, and a snapshot must say whether its window has focus", () => {
    expect(EngineMessage.parse(lines[33])).toEqual({ type: "pageInput", v: 1, at: 1790000004500, tabId: 7, frameId: 0, kind: "mouse" });
    expect(EngineMessage.safeParse({ ...lines[33], kind: "scroll" }).success).toBe(false);
    expect(HelperToEngine.safeParse(lines[33]).success).toBe(false);
    const { inFocusedWindow: _f, ...older } = lines[6] as Record<string, unknown>;
    expect(PageSnapshot.safeParse(older).success).toBe(false);
  });
});

describe("W4 page lines", () => {
  it("carries a radio group's question, a press group's options and the press that names its question", () => {
    const snap = PageSnapshot.parse(lines[34]);
    const [yes, no, pressYes, pressNo] = snap.frames[0]!.controls;
    expect(yes?.group).toEqual({ id: "e20", name: "Are you authorized to work here?" });
    expect(no?.group?.id).toBe(yes?.group?.id);
    expect(pressYes?.pressed === false && pressNo?.pressed === true && pressYes.group?.name === "Do you have seven years of experience?").toBe(true);
    const cmd = PageCommand.parse(lines[35]);
    expect(cmd.verb.kind === "pageChooseOption" && cmd.verb.control === "button" && cmd.verb.question === "Do you have seven years of experience?").toBe(true);
    expect(PageResult.parse(lines[36]).choice?.flavor).toBe("pressGroup");
    // An empty question or group name is not one.
    expect(PageCommand.safeParse({ ...cmd, verb: { ...cmd.verb, question: "" } }).success).toBe(false);
  });
});

describe("B28 page lines", () => {
  it("carries what showed the page changed after a Yes/No press, on a failed result with no readings", () => {
    const r = PageResult.parse(lines[37]);
    expect(r.outcome === "failed" && r.readings === undefined && r.choice?.flavor === "pressGroup").toBe(true);
    expect(r.pageChanged).toEqual(["navigationStarted", "beforeunload"]);
    expect(PageResult.safeParse({ ...lines[37], pageChanged: ["reloaded"] }).success).toBe(false);
  });
});

describe("P4: the tab the user just left, and the field being typed in", () => {
  const read = lines[39] as Record<string, unknown>;
  const text = read.text as Record<string, unknown>;

  it("carries a read's text only with outcome ok", () => {
    expect(PageResult.safeParse(read).success).toBe(true);
    expect(PageResult.safeParse({ ...read, outcome: "notAllowed", detail: "it is not the tab you just left" }).success).toBe(false);
  });

  it("refuses a read over TAB_TEXT_BYTES, counted in UTF-8 bytes across selection and paragraphs", () => {
    const at = (n: number): Record<string, unknown> => ({ ...read, text: { ...text, selection: [], blocks: ["é".repeat(n)] } });
    expect(PageResult.safeParse(at(TAB_TEXT_BYTES / 2)).success).toBe(true);
    expect(PageResult.safeParse(at(TAB_TEXT_BYTES / 2 + 1)).success).toBe(false);
    expect(PageResult.safeParse({ ...read, text: { ...text, selection: ["x".repeat(TAB_TEXT_BYTES / 2)], blocks: ["y".repeat(TAB_TEXT_BYTES / 2)] } }).success).toBe(false);
  });

  it("names at least one frame read, and no empty paragraph", () => {
    expect(PageResult.safeParse({ ...read, text: { ...text, frames: [] } }).success).toBe(false);
    expect(PageResult.safeParse({ ...read, text: { ...text, blocks: [""] } }).success).toBe(false);
  });

  it("bounds the text around the caret: 2000 before, 500 after, 2000 selected", () => {
    const snap = lines[44] as Record<string, unknown>;
    const focused = snap.focused as Record<string, unknown>;
    const withText = (t: Record<string, string>): Record<string, unknown> => ({ ...snap, focused: { ...focused, text: { before: "", after: "", selection: "", ...t } } });
    expect(PageSnapshot.safeParse(withText({ before: "a".repeat(2000), after: "b".repeat(500), selection: "c".repeat(2000) })).success).toBe(true);
    expect(PageSnapshot.safeParse(withText({ before: "a".repeat(2001) })).success).toBe(false);
    expect(PageSnapshot.safeParse(withText({ after: "b".repeat(501) })).success).toBe(false);
    expect(PageSnapshot.safeParse(withText({ selection: "c".repeat(2001) })).success).toBe(false);
    // An extension before P4 sends no text.
    expect(PageSnapshot.safeParse({ ...snap, focused: { frameId: 0, id: "e9", selection: null } }).success).toBe(true);
  });

  it("inserts only a non-empty text, and only where the text before the caret is named", () => {
    const ins = lines[42] as { verb: Record<string, unknown> } & Record<string, unknown>;
    expect(PageCommand.safeParse(ins).success).toBe(true);
    expect(PageCommand.safeParse({ ...ins, verb: { ...ins.verb, text: "" } }).success).toBe(false);
    const { expect: _gone, ...noExpect } = ins.verb;
    expect(PageCommand.safeParse({ ...ins, verb: noExpect }).success).toBe(false);
  });
});
