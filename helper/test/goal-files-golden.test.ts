// P3: the lines in fixtures/golden/goal-files.ndjson are the contract the host batch decodes byte for byte: a hello
// with GOAL_FILES_CAPABILITY, a page goal's preview whose last row is an attach with a file chooser, its acceptance with
// the file the user chose (confirmedFile), the run's receipts and partial end, the offer to keep the file and the
// user's yes (and a refused one), the carried goal's preview of the next page (reason nextPage), the same preview with
// a saved file in its attach row, and its acceptance with and without that file. Cut from a page-rig run with a fixed
// clock (test/page-rig.ts); the paths are synthetic. The saved-row preview is the carried preview with its attach row
// as a matched saved file shows it, under a digest of its own (a digest covers a row's file); its acceptances name it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, GoalAccept, GoalProgress, HelperMessage } from "../src/protocol.ts";

const lines = readFileSync(new URL("../fixtures/golden/goal-files.ndjson", import.meta.url), "utf8").trim().split("\n");
const CONSUMER = new Set(["hello", "planRequest", "goalAccept", "fileSave"]);
const at = (i: number): Record<string, unknown> => JSON.parse(lines[i] as string) as Record<string, unknown>;
type Segment = Extract<GoalProgress, { event: "segment" }>;
const segment = (i: number): Segment => GoalProgress.parse(at(i)) as Segment;

describe("the goal-files protocol lines (P3)", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string; event?: string }).type)).toEqual([
      "hello",
      "planRequest",
      "goalProgress",
      "goalAccept",
      ...Array<string>(11).fill("goalProgress"),
      "fileSaveOffer",
      "fileSave",
      "fileSaveReply",
      "fileSave",
      "fileSaveReply",
      "goalProgress",
      "goalProgress",
      "goalAccept",
      "goalAccept",
    ]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("names the attach row's file and the acceptance's file by step", () => {
    const first = segment(2);
    const row = first.steps.at(-1);
    expect(row).toEqual({ index: 9, kind: "attach", says: "Resume: a file you choose", file: { source: "choose" } });
    expect(GoalAccept.parse(at(3)).confirmedFile).toEqual({ step: 9, path: "/private/tmp/caret-fixture/Robin Vale Resume.pdf" });
    const next = segment(20);
    expect([next.reason, next.replaces, next.requestId]).toEqual(["nextPage", first.goalId, null]);
    expect(segment(21).steps.at(-1)?.file).toEqual({ source: "saved", savedId: "file-5e6f7a8b", path: "/private/tmp/caret-fixture/Robin Vale Cover Letter.pdf", name: "Robin Vale Cover Letter.pdf", edited: 1790100000000 });
    expect(GoalAccept.parse(at(23)).confirmedFile).toBeUndefined();
    // Two previews that differ in a row's file are two plans: their digests differ, and each acceptance names its own.
    expect(segment(21).digest).not.toBe(next.digest);
    expect([at(22).digest, at(23).digest]).toEqual([segment(21).digest, segment(21).digest]);
  });

  it("refuses the shapes the contract rules out", () => {
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    const seg = at(2) as { steps: Record<string, unknown>[] };
    const [write] = seg.steps as [Record<string, unknown>];
    const attach = seg.steps.at(-1) as Record<string, unknown>;
    // An attach row names its file, and no other row does.
    expect(bad({ ...seg, steps: [{ ...attach, file: undefined }] })).toBe(true);
    expect(bad({ ...seg, steps: [{ ...write, file: { source: "choose" } }] })).toBe(true);
    expect(bad({ ...seg, steps: [{ ...attach, file: { source: "disk" } }] })).toBe(true);
    // A saved row's path is absolute, and its edited time whole milliseconds.
    const saved = (at(21) as { steps: Record<string, unknown>[] }).steps.at(-1) as { file: Record<string, unknown> };
    expect(bad({ ...at(21), steps: [{ ...saved, file: { ...saved.file, path: "Documents/cv.pdf" } }] })).toBe(true);
    expect(bad({ ...at(21), steps: [{ ...saved, file: { ...saved.file, edited: 1790100000000.5 } }] })).toBe(true);
    // A confirmed file names its step and an absolute path.
    expect(bad({ ...at(3), confirmedFile: { path: "/private/tmp/caret-fixture/x.pdf" } })).toBe(true);
    expect(bad({ ...at(3), confirmedFile: { step: 9, path: "x.pdf" } })).toBe(true);
    // Only the reasons the protocol lists.
    expect(bad({ ...at(20), reason: "carried" })).toBe(true);
    // A saved reply names the file; a refused one names none.
    expect(bad({ ...at(17), fileId: null })).toBe(true);
    expect(bad({ ...at(19), fileId: "file-1a2b3c4d" })).toBe(true);
    // An offer's question is one line.
    expect(bad({ ...at(15), question: "Resume\nCV" })).toBe(true);
  });
});
