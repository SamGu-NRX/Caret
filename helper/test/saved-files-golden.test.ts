// H14: the lines in fixtures/golden/saved-files.ndjson are the contract the host's memory window and attach rows decode
// byte for byte: a hello with GOAL_FILES_CAPABILITY, the Files section's list and its reply, a forget and the list after
// it, a forget of an id files.md does not hold, a page goal's preview whose view carries a row for each attach step (a
// file input with its accept types and a dropzone with none), and its acceptance with the file for the dropzone's step.
// The paths are synthetic.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AnyMessage, ConsumerMessage, GoalAccept, GoalProgress, HelperMessage, SavedFilesReply, SavedFilesRequest } from "../src/protocol.ts";

const lines = readFileSync(new URL("../fixtures/golden/saved-files.ndjson", import.meta.url), "utf8").trim().split("\n");
const CONSUMER = new Set(["hello", "savedFilesRequest", "goalAccept"]);
const at = (i: number): Record<string, unknown> => JSON.parse(lines[i] as string) as Record<string, unknown>;
type Segment = Extract<GoalProgress, { event: "segment" }>;

describe("the saved-files protocol lines (H14)", () => {
  it("parses every golden line and writes it back byte for byte", () => {
    expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "hello",
      "savedFilesRequest",
      "savedFilesReply",
      "savedFilesRequest",
      "savedFilesReply",
      "savedFilesRequest",
      "savedFilesReply",
      "goalProgress",
      "goalAccept",
    ]);
    for (const l of lines) {
      const m = JSON.parse(l) as { type: string };
      expect(JSON.stringify((CONSUMER.has(m.type) ? ConsumerMessage : HelperMessage).parse(m)), m.type).toBe(l);
    }
  });

  it("lists newest saved first, forgets by id, and refuses an unknown id with an empty list", () => {
    const first = SavedFilesReply.parse(at(2));
    expect(first.files.map((f) => f.savedOn)).toEqual([...first.files.map((f) => f.savedOn)].sort((a, b) => b - a));
    expect(first.files.some((f) => f.edited === null)).toBe(true);
    const forget = SavedFilesRequest.parse(at(3));
    expect(SavedFilesReply.parse(at(4)).files.map((f) => f.id)).toEqual(first.files.map((f) => f.id).filter((id) => id !== forget.id));
    const unknown = SavedFilesReply.parse(at(6));
    expect(unknown.error).not.toBeNull();
    expect(unknown.files).toEqual([]);
  });

  it("gives each attach step a row with its types, names none as the user's, and accepts a file for the dropzone's step", () => {
    const s = GoalProgress.parse(at(7)) as Segment;
    const attach = s.steps.filter((x) => x.kind === "attach");
    expect(s.page?.files?.map((f) => f.step)).toEqual(attach.map((x) => x.index));
    expect(s.page?.files?.map((f) => f.accept)).toEqual([[".pdf", ".doc", ".docx"], []]);
    expect(s.page?.attach).toEqual([]);
    const a = GoalAccept.parse(at(8));
    expect([a.goalId, a.digest]).toEqual([s.goalId, s.digest]);
    expect(a.confirmedFile?.step).toBe(s.page?.files?.[1]?.step);
  });

  it("refuses the shapes the contract rules out", () => {
    const bad = (m: unknown): boolean => !AnyMessage.safeParse(m).success;
    // A forget names its file's id; a list names none.
    expect(bad({ ...at(3), id: undefined })).toBe(true);
    expect(bad({ ...at(1), id: "file-1a2b3c4d" })).toBe(true);
    expect(bad({ ...at(1), op: "clear" })).toBe(true);
    // A listed file's path is absolute, its times whole milliseconds, its status one of two.
    const reply = at(2) as { files: Record<string, unknown>[] };
    const [f] = reply.files as [Record<string, unknown>];
    expect(bad({ ...reply, files: [{ ...f, path: "Documents/cv.pdf" }] })).toBe(true);
    expect(bad({ ...reply, files: [{ ...f, edited: 1790100000000.5 }] })).toBe(true);
    expect(bad({ ...reply, files: [{ ...f, status: "noticed" }] })).toBe(true);
    expect(bad({ ...reply, files: [{ ...f, name: "" }] })).toBe(true);
    // One row per attach step, with a name.
    const seg = at(7) as Segment;
    const page = seg.page as NonNullable<Segment["page"]>;
    const files = page.files as NonNullable<typeof page.files>;
    expect(bad({ ...seg, page: { ...page, files: [files[0], files[0]] } })).toBe(true);
    expect(bad({ ...seg, page: { ...page, files: [{ ...files[0], label: "" }] } })).toBe(true);
    expect(bad({ ...seg, page: { ...page, files: [{ ...files[0], accept: [""] }] } })).toBe(true);
  });
});
