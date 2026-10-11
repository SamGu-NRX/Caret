// H14: the memory window's Files section. The host lists the files the user kept (files.md), newest saved first, each
// with its name and when the file on disk was last modified, by lstat (never following a link; null when the file is
// gone or not a regular file), and may forget one. Every name, path and site is invented.
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { forgetFile, normalizeQuestion, saveFile } from "../src/memory/files.ts";
import type { MemoryDocumentStore } from "../src/memory/documents.ts";
import { HelperMessage, PROTOCOL_VERSION, type FileFields, type SavedFilesReply, type SavedFilesRequest } from "../src/protocol.ts";

const SITE = "https://jobs.example-ats.test/larkspur/apply/88";

let dir: string;
let store: Store;
let helper: Helper;
let docs: MemoryDocumentStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-h14-files-"));
  store = new Store(join(dir, "data"));
  helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => {} });
  docs = helper.memory.files as MemoryDocumentStore;
});
afterEach(() => {
  helper.shutdown();
  helper.memory.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const fields = (question: string, path: string, savedOn: string): FileFields => ({ question, normalized: normalizeQuestion(question), site: SITE, path, savedOn });
const touch = (name: string): string => {
  const p = join(dir, name);
  writeFileSync(p, "invented file body");
  return p;
};
const ask = (m: Omit<SavedFilesRequest, "type" | "v">): SavedFilesReply => helper.handleSavedFiles({ type: "savedFilesRequest", v: PROTOCOL_VERSION, ...m } as SavedFilesRequest);

describe("listing saved files (H14)", () => {
  it("lists newest saved first, with each file's name and modification time, and null for one gone or a link", () => {
    const resume = touch("Robin Vale Resume.pdf");
    const gone = join(dir, "Portfolio.pdf");
    const link = join(dir, "Cover letter.pdf");
    symlinkSync(touch("elsewhere.pdf"), link);
    const a = saveFile(docs, fields("Resume", resume, "2026-10-05T10:00:00.000Z"));
    const b = saveFile(docs, fields("Portfolio", gone, "2026-10-06T09:00:00.000Z"));
    const c = saveFile(docs, fields("Cover letter", link, "2026-10-04T08:00:00.000Z"));
    const r = ask({ requestId: "l1", op: "list" });
    expect(HelperMessage.parse(r)).toEqual(r);
    expect(r.error).toBeNull();
    expect(r.files.map((f) => f.id)).toEqual([b, a, c]);
    expect(r.files[1]).toEqual({ id: a, question: "Resume", site: SITE, name: "Robin Vale Resume.pdf", path: resume, savedOn: Date.parse("2026-10-05T10:00:00.000Z"), edited: Math.floor(statSync(resume).mtimeMs), status: "active" });
    expect(r.files[0]?.edited).toBeNull();
    expect(r.files[2]?.edited).toBeNull();
  });

  it("says memory is still in the old store, and lists nothing, while files.md cannot be read", () => {
    Object.defineProperty(helper.memory, "files", { get: () => null });
    const r = ask({ requestId: "l2", op: "list" });
    expect(r.files).toEqual([]);
    expect(r.error).toMatch(/old encrypted store/);
  });
});

describe("forgetting a saved file (H14)", () => {
  it("removes the record from files.md and answers with the list after it", () => {
    const a = saveFile(docs, fields("Resume", touch("Resume.pdf"), "2026-10-05T10:00:00.000Z"));
    const b = saveFile(docs, fields("Cover letter", touch("Letter.pdf"), "2026-10-06T10:00:00.000Z"));
    const r = ask({ requestId: "f1", op: "forget", id: a });
    expect(r.error).toBeNull();
    expect(r.files.map((f) => f.id)).toEqual([b]);
    expect(readFileSync(docs.path("files"), "utf8")).not.toContain(a);
  });

  it("refuses an id files.md does not hold, and lists nothing", () => {
    saveFile(docs, fields("Resume", touch("Resume.pdf"), "2026-10-05T10:00:00.000Z"));
    const r = ask({ requestId: "f2", op: "forget", id: "file-00000000" });
    expect(r.files).toEqual([]);
    expect(r.error).toMatch(/file-00000000/);
  });

  it("forgetFile throws for an unknown id and changes nothing", () => {
    const a = saveFile(docs, fields("Resume", touch("Resume.pdf"), "2026-10-05T10:00:00.000Z"));
    const before = readFileSync(docs.path("files"), "utf8");
    expect(() => forgetFile(docs, "file-ffffffff")).toThrow(/no saved file file-ffffffff/);
    expect(readFileSync(docs.path("files"), "utf8")).toBe(before);
    forgetFile(docs, a);
    expect(() => forgetFile(docs, a)).toThrow(/no saved file/);
  });
});
