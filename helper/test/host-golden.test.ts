// H5's lines between the helper and the host app (fixtures/golden/host.ndjson): Ask's sentences, controls the user
// sets, "Not on this site" and the confirmed file. They live apart from protocol.ndjson because the reader's Swift
// mirror decodes and re-encodes every line there and has no reason to know these. The host's HostGoldenTests read the
// same file by path.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ConsumerMessage, HelperMessage, PROTOCOL_VERSION, type Settings } from "../src/protocol.ts";
import { parsePopupSpec } from "../src/popup.ts";
import { planError } from "../src/planner/proposal.ts";
import { SAYS, saysPress } from "../src/planner/says.ts";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";

const GOLDEN = fileURLToPath(new URL("../fixtures/golden/host.ndjson", import.meta.url));
const lines = readFileSync(GOLDEN, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("host.ndjson", () => {
  it("holds valid messages, each spec a valid pop-up", () => {
    expect(lines.map((l) => l.type)).toEqual(["planProposal", "planProposal", "planProposal", "popup", "settings", "planProposal", "fileConfirm", "fileConfirmReply", "fileConfirmReply"]);
    for (const [i, l] of lines.entries()) {
      const ok = HelperMessage.safeParse(l).success || ConsumerMessage.safeParse(l).success;
      expect(ok, `line ${i + 1}`).toBe(true);
      const spec = (l as { spec?: unknown }).spec;
      if (spec !== undefined && spec !== null) expect(parsePopupSpec(spec)).toEqual(spec);
    }
  });

  it("carries the user's sentence beside the check's detail, as planError writes it", () => {
    const refusal = lines[0] as { requestId: string; at: number; error: { code: "unsupportedStep"; detail: string; says: string } };
    expect(refusal.error.says).toBe(saysPress("outbound", "Submit order"));
    expect(planError(refusal.requestId, refusal.error.code, refusal.error.detail, refusal.at, refusal.error.says)).toEqual(lines[0]);
    // With no sentence given, a refusal says the one for its code.
    expect(planError("r", "unsupportedStep", "d", 1).error?.says).toBe(SAYS.onlyFills);
    // A helper before H5 sent none, and its line still parses.
    const before = { ...refusal, error: { code: refusal.error.code, detail: refusal.error.detail } };
    expect(HelperMessage.safeParse(before).success).toBe(true);
    expect(HelperMessage.safeParse({ ...refusal, error: { ...refusal.error, says: "" } }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...refusal, error: { ...refusal.error, says: null } }).success).toBe(false);
  });

  it("refuses a file reply that does not say what it says, and an attach out of shape (review #4)", () => {
    const yes = lines[7] as Record<string, unknown>;
    const no = lines[8] as Record<string, unknown>;
    expect(HelperMessage.safeParse({ ...no, says: null }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...yes, file: null }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...yes, says: "x" }).success).toBe(false);
    expect(HelperMessage.safeParse({ ...yes, file: { name: "a.pdf", size: -1 } }).success).toBe(false);
    const attach = lines[5] as { attach: Record<string, unknown> };
    for (const bad of [{ step: -1 }, { field: "" }, { wants: "" }]) expect(HelperMessage.safeParse({ ...attach, attach: { ...attach.attach, ...bad } }).success, JSON.stringify(bad)).toBe(false);
  });

  it("names no press for an Ask that only hands over controls, and marks each control yours", () => {
    const p = lines[2] as { handoff: unknown; spec: { blocks: { type: string; rows?: { state: string }[] }[] } };
    expect(p.handoff).toBeNull();
    expect(p.spec.blocks.filter((b) => b.type === "fields").flatMap((b) => b.rows?.map((r) => r.state))).toEqual(["yours", "yours"]);
    const popup = lines[3] as { spec: { blocks: { type: string; rows?: { state: string }[] }[] } };
    expect(popup.spec.blocks.filter((b) => b.type === "fields").map((b) => b.rows?.map((r) => r.state))).toEqual([["ready", "ready"], ["yours"]]);
  });

  it("refuses a sitesOff entry that is not an origin, and reads a host before H5 as sending none", () => {
    const s = lines[4] as Settings;
    expect(ConsumerMessage.parse(s)).toMatchObject({ sitesOff: ["http://127.0.0.1:4310", "https://jobs.example.com"] });
    for (const bad of ["https://jobs.example.com/apply", "jobs.example.com", "file:///tmp", "https://a b"]) {
      expect(ConsumerMessage.safeParse({ ...s, sitesOff: [bad] }).success, bad).toBe(false);
    }
    const { sitesOff: _, ...before } = s;
    expect((ConsumerMessage.parse(before) as Settings).sitesOff).toBeUndefined();
  });
});

describe("Not on this site (H5)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("passes the host's list to whoever listens, now and to a listener that joins later, and keeps it across a settings message without one", () => {
    dir = mkdtempSync(join(tmpdir(), "caret-h5-sites-"));
    const helper = new Helper({ store: new Store(join(dir, "data")), askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
    const heard: (readonly string[])[] = [];
    const stop = helper.onSitesOff((o) => heard.push(o));
    const settings = lines[4] as Settings;
    helper.handleSettings(settings);
    expect(heard).toEqual([["http://127.0.0.1:4310", "https://jobs.example.com"]]);
    // A host before H5 sends no list: the helper's stays as it was, and nobody hears anything.
    const { sitesOff: _, ...before } = settings;
    helper.handleSettings({ ...before, at: settings.at + 1 });
    expect(heard.length).toBe(1);
    const late: (readonly string[])[] = [];
    helper.onSitesOff((o) => late.push(o));
    expect(late).toEqual([["http://127.0.0.1:4310", "https://jobs.example.com"]]);
    helper.handleSettings({ ...settings, at: settings.at + 2, sitesOff: [] });
    expect(heard.at(-1)).toEqual([]);
    stop();
    helper.handleSettings({ ...settings, at: settings.at + 3 });
    expect(heard.length).toBe(2);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
