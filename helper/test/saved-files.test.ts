// P3: saved files. A file the user attached once, confirmed in a preview, may be kept for the same question in files.md
// with their yes, and is offered again only when two Jev asks agree on it. All names, paths and sites are invented.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FILL_CUTOFF } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { MemoryDocumentStore } from "../src/memory/documents.ts";
import { fileFor, fileNow, normalizeQuestion, saveFile, savedFiles } from "../src/memory/files.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { FileSaveOffer, FileSaveReply, PROTOCOL_VERSION, type FileFields, type FileSave } from "../src/protocol.ts";
import { FILE_OFFER_KEEP_MS, SavedFiles, type AttachedFile, type SavedFilesDeps } from "../src/goals/saved-files.ts";
import { node, snap } from "./builders.ts";

const SITE = "https://jobs.example-ats.test/larkspur/apply/88";
const CHROME = { pid: 5200, bundleId: "com.google.Chrome", name: "Google Chrome" };
const WINDOW = "page-tab-3";

let dir: string;
let store: MemoryDocumentStore;
let docs: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "caret-files-"));
  store = new MemoryDocumentStore(join(dir, "Memory"));
  docs = join(dir, "Documents");
  mkdirSync(docs);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const fields = (question: string, path: string, site: string | null = SITE): FileFields => ({ question, normalized: normalizeQuestion(question), site, path, savedOn: "2026-10-05T10:00:00.000Z" });
const touch = (name: string): string => {
  const p = join(docs, name);
  writeFileSync(p, "invented file body");
  return p;
};

describe("files.md", () => {
  it("saves a file, reads it back, and replaces it in place", () => {
    const resume = touch("Quill Resume.pdf");
    const id = saveFile(store, fields("Resume/CV", resume));
    expect(id).toMatch(/^file-[0-9a-f]{8}$/);
    const text = readFileSync(store.path("files"), "utf8");
    expect(text).toContain(`<!-- caret:id=${id} kind=file -->`);
    expect(text).toContain(`- Path: ${resume}`);
    expect(text).toContain("- Normalized: resume/cv");
    expect(savedFiles(store)).toEqual([{ id, status: "active", fields: fields("Resume/CV", resume) }]);
    expect(fileFor(store, "resume/cv", "https://jobs.example-ats.test/larkspur/other")?.id).toBe(id);
    expect(fileFor(store, "resume/cv", "https://jobs.example-ats.test/wren/apply")).toBeNull();

    const newer = touch("Quill Resume 2026.pdf");
    expect(saveFile(store, fields("Resume/CV", newer), id)).toBe(id);
    expect(savedFiles(store).map((f) => f.fields.path)).toEqual([newer]);
    // The memory window's list does not carry files.md.
    expect(store.documents().map((d) => d.doc)).not.toContain("files");
  });

  it("reports a hand-edited broken line and does not use the record", () => {
    const resume = touch("Resume.pdf");
    const id = saveFile(store, fields("Resume", resume));
    const p = store.path("files");
    writeFileSync(p, readFileSync(p, "utf8").replace(`- Path: ${resume}`, "- Path: Documents/Resume.pdf"));
    expect(savedFiles(store)).toEqual([]);
    const d = store.info("files").diagnostics.find((x) => x.id === id && x.severity === "error");
    expect(d).toMatchObject({ file: "files.md", field: "Path", message: "must be an absolute path" });
    expect(fileNow(store, id)).toBeNull();
  });

  it("normalizes a question: lower case, digits masked, spacing collapsed", () => {
    expect(normalizeQuestion("Cover  Letter (2026)\tUpload")).toBe("cover letter (####) upload");
  });
});

/** A page window with one file input labelled `label`. */
function pageWindow(label: string): { model: ScreenModel; w: WindowState } {
  const model = new ScreenModel();
  model.apply(
    snap([node("frame-0", "AXWebArea", { label: "Apply: Larkspur Labs" }), node("in-1", "CaretFileInput", { label, frame: [10, 40, 300, 30] })], {
      at: 1000,
      windowId: WINDOW,
      title: "Apply: Larkspur Labs",
      kind: "page",
      app: CHROME,
      focused: true,
    }),
  );
  return { model, w: model.windows.get(WINDOW) as WindowState };
}

/**
 * A fake Jev answering the file question by file name: `pick(wording)` names the file each ask chooses (null for none).
 * Ask 0 is the one whose criteria use f-ids.
 */
function jevPicking(pick: (ask: 0 | 1) => string | null, confidence = 0.9, sent: JevRequest[] = []): AskJev {
  return async (req) => {
    sent.push(req);
    const q = req.questions.file;
    if (q === undefined) throw new Error("no file question");
    const ask = Object.keys(q.criteria).some((k) => k.startsWith("f")) ? 0 : 1;
    const want = pick(ask);
    const hit = want === null ? undefined : Object.entries(q.criteria).find(([, d]) => d?.includes(`"${want}"`));
    return { model: "jev-test", answers: { file: { choice: hit?.[0] ?? "none", confidence } }, inputTokens: 300, latencyMs: 5, costUsd: 0 };
  };
}

function rig(o: { ask?: AskJev | null; docs?: MemoryDocumentStore | null; showsFiles?: boolean; model?: ScreenModel } = {}) {
  const published: FileSaveOffer[] = [];
  const counts: string[] = [];
  const clock = { now: 50_000 };
  let n = 0;
  let current = o.docs === undefined ? store : o.docs;
  const deps: SavedFilesDeps = {
    model: o.model ?? new ScreenModel(),
    documents: () => current,
    askJev: () => (o.ask === undefined ? null : o.ask),
    publish: (m) => published.push(FileSaveOffer.parse(m)),
    pageContext: () => ({ site: SITE, headings: [] }),
    hostShowsFiles: () => o.showsFiles ?? true,
    now: () => clock.now,
    newId: () => `offer-${++n}`,
    count: (m) => counts.push(m),
  };
  return { files: new SavedFiles(deps), published, counts, clock, setDocs: (d: MemoryDocumentStore | null) => (current = d) };
}

describe("offer", () => {
  it("offers the saved file both asks pick at the floor, with its name and mtime, never its path to Jev", async () => {
    const resume = touch("Mara Quill Resume.pdf");
    const letter = touch("Cover Letter.pdf");
    const id = saveFile(store, fields("Resume", resume));
    saveFile(store, fields("Cover letter", letter));
    const { model, w } = pageWindow("Resume/CV");
    const sent: JevRequest[] = [];
    const { files } = rig({ model, ask: jevPicking(() => "Mara Quill Resume.pdf", FILL_CUTOFF, sent) });
    const o = await files.offer(w, w.nodes.get("in-1")!, "Resume/CV");
    expect(o).toEqual({ source: "saved", savedId: id, path: resume, name: "Mara Quill Resume.pdf", edited: Math.floor(statSync(resume).mtimeMs) });
    expect(sent).toHaveLength(2);
    expect(sent[0]?.questions.file?.instructions).not.toBe(sent[1]?.questions.file?.instructions);
    expect(Object.keys(sent[1]?.questions.file?.criteria ?? {})).toEqual(expect.arrayContaining(["g1", "g2", "none"]));
    for (const r of sent) expect(JSON.stringify([r.state, r.questions])).not.toContain(docs);
  });

  it("offers a chooser when the asks disagree or are below FILL_CUTOFF", async () => {
    const resume = touch("Resume.pdf");
    const letter = touch("Letter.pdf");
    saveFile(store, fields("Resume", resume));
    saveFile(store, fields("Cover letter", letter));
    const { model, w } = pageWindow("Resume");
    const disagree = rig({ model, ask: jevPicking((a) => (a === 0 ? "Resume.pdf" : "Letter.pdf")) });
    expect(await disagree.files.offer(w, w.nodes.get("in-1")!, "Resume")).toEqual({ source: "choose" });
    const unsure = rig({ model, ask: jevPicking(() => "Resume.pdf", FILL_CUTOFF - 0.01) });
    expect(await unsure.files.offer(w, w.nodes.get("in-1")!, "Resume")).toEqual({ source: "choose" });
    const none = rig({ model, ask: jevPicking(() => null) });
    expect(await none.files.offer(w, w.nodes.get("in-1")!, "Resume")).toEqual({ source: "choose" });
  });

  it("never offers a saved path that became a symlink, a folder, or was deleted", async () => {
    const real = touch("Real.pdf");
    const cases: [string, (p: string) => void][] = [
      ["Linked.pdf", (p) => (unlinkSync(p), symlinkSync(real, p))],
      ["Folder.pdf", (p) => (unlinkSync(p), mkdirSync(p))],
      ["Gone.pdf", (p) => unlinkSync(p)],
    ];
    for (const [name, change] of cases) {
      const p = touch(name);
      saveFile(store, fields(`Resume ${name}`, p));
      change(p);
    }
    const { model, w } = pageWindow("Resume");
    const sent: JevRequest[] = [];
    // Jev would pick any of them; none is asked about, so no request goes at all.
    const { files } = rig({ model, ask: jevPicking(() => "Linked.pdf", 0.99, sent) });
    for (const [name] of cases) {
      const offered = await rig({ model, ask: jevPicking(() => name, 0.99, sent) }).files.offer(w, w.nodes.get("in-1")!, "Resume");
      expect(offered).toEqual({ source: "choose" });
    }
    expect(await files.offer(w, w.nodes.get("in-1")!, "Resume")).toEqual({ source: "choose" });
    expect(sent).toEqual([]);
  });

  it("offers a chooser with no Jev, and when Jev throws", async () => {
    saveFile(store, fields("Resume", touch("Resume.pdf")));
    const { model, w } = pageWindow("Resume");
    expect(await rig({ model, ask: null }).files.offer(w, w.nodes.get("in-1")!, "Resume")).toEqual({ source: "choose" });
    const failing = rig({
      model,
      ask: async () => {
        throw new Error("Jev HTTP 500: invented outage");
      },
    });
    expect(await failing.files.offer(w, w.nodes.get("in-1")!, "Resume")).toEqual({ source: "choose" });
    expect(failing.counts).toContain("files.match_failed");
  });
});

const attach = (path: string, more: Partial<AttachedFile> = {}): AttachedFile => ({ goalId: "goal-7", session: "host-a", path, windowId: WINDOW, key: "in-1", label: "  Resume / CV \n", ...more });

describe("attached", () => {
  it("offers nothing to a host that shows no files", () => {
    const r = rig({ showsFiles: false });
    r.files.attached(attach(touch("Resume.pdf")));
    expect(r.published).toEqual([]);
  });

  it("offers to replace a different saved file for the question, and nothing when the same path is saved", () => {
    const old = touch("Old Resume.pdf");
    const fresh = touch("New Resume.pdf");
    const id = saveFile(store, fields("Resume / CV", old));
    const r = rig();
    r.files.attached(attach(fresh));
    expect(r.published).toHaveLength(1);
    expect(r.published[0]).toMatchObject({ id: "offer-1", question: "Resume / CV", site: SITE, file: { name: "New Resume.pdf" }, replaces: id, says: "Use New Resume.pdf for 'Resume / CV' next time?", expires: 50_000 + FILE_OFFER_KEEP_MS });
    expect(r.published[0]?.says).not.toContain(docs);
    r.files.attached(attach(old));
    expect(r.published).toHaveLength(1);
  });
});

describe("save", () => {
  const yes = (offerId: string, requestId = "req-1"): FileSave => ({ type: "fileSave", v: PROTOCOL_VERSION, requestId, offerId });

  it("saves once; a second answer to the same offer is refused", () => {
    const p = touch("Resume.pdf");
    const r = rig();
    r.files.attached(attach(p));
    const first = FileSaveReply.parse(r.files.save(yes("offer-1"), "host-a"));
    expect(first).toMatchObject({ outcome: "saved", says: "Caret will offer Resume.pdf for 'Resume / CV' next time." });
    expect(savedFiles(store)).toEqual([{ id: first.fileId, status: "active", fields: { ...fields("Resume / CV", p), savedOn: new Date(50_000).toISOString() } }]);
    expect(r.files.save(yes("offer-1", "req-2"), "host-a")).toMatchObject({ outcome: "refused", fileId: null });
    expect(r.counts).toEqual(["files.offer", "files.saved", "files.refused_noOffer"]);
  });

  it("refuses an expired offer, another session's yes, and a file that became a symlink", () => {
    const p = touch("Resume.pdf");
    const r = rig();
    r.files.attached(attach(p));
    expect(r.files.save(yes("offer-1"), "host-b")).toMatchObject({ outcome: "refused", says: "That offer was made to another window, so nothing was saved." });
    r.clock.now += FILE_OFFER_KEEP_MS + 1;
    expect(r.files.save(yes("offer-1"), "host-a")).toMatchObject({ outcome: "refused", says: "That offer to keep the file has expired, so nothing was saved." });

    r.files.attached(attach(p, { goalId: "goal-8" }));
    unlinkSync(p);
    symlinkSync(touch("Elsewhere.pdf"), p);
    expect(r.files.save(yes("offer-2"), "host-a")).toMatchObject({ outcome: "refused", fileId: null, says: "Resume.pdf is no longer a file Caret can keep, so nothing was saved." });
    expect(savedFiles(store)).toEqual([]);
    expect(r.counts).toEqual(["files.offer", "files.refused_otherSession", "files.refused_expired", "files.offer", "files.refused_notFile"]);
  });

  it("offers nothing and refuses a yes when memory is not in files mode", () => {
    const off = rig({ docs: null });
    off.files.attached(attach(touch("Resume.pdf")));
    expect(off.published).toEqual([]);
    const r = rig();
    r.files.attached(attach(touch("Cv.pdf")));
    r.setDocs(null);
    expect(r.files.save(yes("offer-1"), "host-a")).toMatchObject({ outcome: "refused", fileId: null });
    expect(r.counts).toContain("files.refused_unavailable");
  });
});
