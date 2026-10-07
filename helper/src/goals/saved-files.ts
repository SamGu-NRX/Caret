import { Disclosure, type ModelText } from "../privacy/disclosure.ts";
import { redactWindow } from "../fill/redact.ts";
// Saved files (P3): a file the user attached once, kept for the same question next time ("Use this file for résumés
// next time?"), and offered again only in a goal preview's attach row, never attached without that preview's
// acceptance naming it (goalAccept.confirmedFile). Caret never looks for a file on disk: the only paths here are ones
// the user confirmed in a preview and then agreed to keep (memory/files.ts keeps them in files.md).
//
// Offering one follows S1's saved answers (fill/answers.ts, fill.ts): one Jev Choice for the file control between the
// saved files and "none", asked twice with the files shuffled under other ids and the question reworded, and offered
// only when both asks pick the same file at FILL_CUTOFF or above. Anything else, a Jev failure included, leaves the row
// a file chooser. What Jev reads of a saved file is the question it was kept for and its name, never its path.
import { lstatSync, type Stats } from "node:fs";
import { basename } from "node:path";
import { FILL_CUTOFF, shuffled } from "../fill/fill.ts";
import type { AskJev, JevRequest, JevResult } from "../fill/jev.ts";
import { questionExcerpt, type PageContext } from "../fill/answers.ts";
import { words } from "../fill/kinds.ts";
import { MemoryDocumentError, type MemoryDocumentStore } from "../memory/documents.ts";
import { fileFor, fileQuestion, forgetFile, normalizeQuestion, saveFile, savedFiles, UnknownFileError, type SavedFile } from "../memory/files.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import { FileFields, PROTOCOL_VERSION, type FileSave, type FileSaveOffer, type FileSaveReply, type Node, type SavedFilesReply, type SavedFilesRequest, type SavedFileView } from "../protocol.ts";
import type { AttachOffer } from "./plan.ts";

/**
 * Saved files one file control's question offers at most, by how many words the question each was kept for shares with
 * the control's label. Assumed, not measured: well above the few files (a résumé, a cover letter, a transcript) a
 * person keeps for forms.
 */
export const MAX_FILES_ASKED = 8;
/** How long an offer to keep a file can be taken. Assumed, not measured: as long as S1's offer to save an answer (helper.ts ANSWER_OFFER_KEEP_MS). */
export const FILE_OFFER_KEEP_MS = 10 * 60 * 1000;
/** The id of the one question each match ask carries. */
const QUESTION_ID = "file";
const NONE = "none";
const FILE_NONE = "No saved file is the one this field asks for.";
/** How much of a question or file name an offer's sentence quotes. Keeps `says` under its 300 characters. */
const SAYS_QUOTE_CHARS = 100;

/** The two wordings of the match question; each ask uses one. */
export const FILE_WORDINGS = [
  (m: Disclosure, where: ModelText, d: ModelText): ModelText =>
    m.t`A form in the ${where} has a file upload field: ${d} The user attached files to upload fields on earlier forms and kept each for the question it answered. Which saved file is the one this field asks for? Choose none unless the file was kept for a question that asks for the same document.`,
  (m: Disclosure, where: ModelText, d: ModelText): ModelText =>
    m.t`File upload field: ${d} It is in a form in the ${where}. Below are files the user kept from upload fields on other forms, each with the question it was kept for. Which one belongs in this field? Answer none if no file was kept for a question asking for the same document.`,
] as const;

/**
 * The criterion for one saved file: the question it was kept for and its name, never its path, each minted as memory;
 * null when either may not go (privacy/disclosure.ts memoryText).
 */
function mintSavedFile(m: Disclosure, f: SavedFile): ModelText | null {
  const name = m.memoryText(null, basename(f.fields.path));
  const question = m.memoryText(null, questionExcerpt(f.fields.question));
  return name === null || question === null ? null : m.t`The file "${name}", which the user kept for the question "${question}"`;
}

/** What the saved-file offers read and write through; the helper supplies each (helper.ts). */
export interface SavedFilesDeps {
  model: ScreenModel;
  /** The memory documents (files.md lives beside answers.md), or null while memory is in its old encrypted store. */
  documents: () => MemoryDocumentStore | null;
  /** Jev, for the match question; null when Jev is off (then no saved file is offered). */
  askJev: () => AskJev | null;
  /** Publishes a fileSaveOffer; the server sends it only to hosts that declared GOAL_FILES_CAPABILITY. */
  publish: (m: FileSaveOffer) => void;
  /** A page window's address and headings (S1's page context), or null. */
  pageContext: (windowId: string) => PageContext | null;
  /** Whether the host session a goal was offered to shows attach rows. */
  hostShowsFiles: (session: string | undefined) => boolean;
  now: () => number;
  newId: () => string;
  count: (metric: string) => void;
}

/** What a verified attach of a confirmed file tells the saved-file offers (runs.ts GoalRunDeps.onAttached). */
export interface AttachedFile {
  goalId: string;
  session: string | undefined;
  path: string;
  windowId: string;
  key: string;
  label: string;
}

interface PendingOffer {
  session: string | undefined;
  fields: Omit<FileFields, "savedOn">;
  replaces: string | null;
  expires: number;
}

/** The path as a regular file, by lstat: null for a symlink (never followed), a folder, anything else, or nothing there. */
function regularFile(path: string): Stats | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st : null;
  } catch {
    return null;
  }
}

const quote = (s: string): string => (s.length <= SAYS_QUOTE_CHARS ? s : `${s.slice(0, SAYS_QUOTE_CHARS - 1).trimEnd()}…`);

export class SavedFiles {
  private readonly deps: SavedFilesDeps;
  /** Offers to keep a file, by offer id, until the user's yes or their expiry. */
  private readonly offers = new Map<string, PendingOffer>();

  constructor(deps: SavedFilesDeps) {
    this.deps = deps;
  }

  /** What the attach row of file control `node` offers: a saved file a Jev choice matched to it, else a chooser. */
  async offer(w: WindowState, node: Node, label: string): Promise<AttachOffer> {
    const choose: AttachOffer = { source: "choose" };
    // Page planning supplies a raw node and label. Both must survive the model-facing view.
    w = redactWindow(w);
    const kept = w.nodes.get(node.key);
    if (kept === undefined || !(kept.label ?? "").includes(label)) return choose;
    const docs = this.deps.documents();
    const ask = this.deps.askJev();
    if (docs === null || ask === null) return choose;
    try {
      const picked = await this.match(docs, ask, w, label);
      if (picked === null) return choose;
      this.deps.count("files.matched");
      return { source: "saved", savedId: picked.file.id, path: picked.file.fields.path, name: basename(picked.file.fields.path), edited: Math.floor(picked.stat.mtimeMs) };
    } catch {
      // Page planning goes on with a chooser: a failed match question is no reason to stop a goal.
      this.deps.count("files.match_failed");
      return choose;
    }
  }

  /** The saved file both asks pick for this control at FILL_CUTOFF or above, with its lstat, or null. Throws when Jev does. */
  private async match(docs: MemoryDocumentStore, ask: AskJev, w: WindowState, label: string): Promise<{ file: SavedFile; stat: Stats } | null> {
    w = redactWindow(w);
    const question = fileQuestion(label);
    if (question === null) return null;
    const present = savedFiles(docs).flatMap((f) => {
      if (f.status !== "active") return [];
      const stat = regularFile(f.fields.path);
      return stat === null ? [] : [{ file: f, stat }];
    });
    if (present.length === 0) return null;
    const own = new Set(words(question));
    const shared = (f: SavedFile): number => words(f.fields.question).filter((t) => own.has(t)).length;
    const ranked = [...present].sort((a, b) => shared(b.file) - shared(a.file)).slice(0, MAX_FILES_ASKED);

    // The control's label and the page's title are screen text, held to the window's budget; a saved file's question
    // and name are memory, declared as memory and charged to any window that shows them (privacy.ts).
    const ledger = new Disclosure(this.deps.model.windows.values());
    const field = ledger.descriptor(w, questionExcerpt(question));
    if (field === null) return null;
    const d = ledger.t`"${field}"`;
    const title = w.window.title.trim() === "" ? null : ledger.descriptor(w, w.window.title);
    const where = title === null ? ledger.t`${ledger.app(w)} window` : ledger.t`${ledger.app(w)} window '${title}'`;
    const asked = ranked.flatMap((c) => {
      if (!ledger.memory([questionExcerpt(c.file.fields.question), basename(c.file.fields.path)])) return [];
      const said = mintSavedFile(ledger, c.file);
      return said === null ? [] : [{ ...c, said }];
    });
    if (asked.length === 0) return null;
    const declared = ledger.declared();

    // f1... in the first ask, g1..., shuffled, in the second: neither position nor id carries a choice across.
    const first = new Map(asked.map((c, i) => [`f${i + 1}`, c]));
    const second = new Map(shuffled(asked).map((c, i) => [`g${i + 1}`, c]));
    const request = (ids: Map<string, (typeof asked)[number]>, wording: 0 | 1): JevRequest => (ledger.seal({
      purpose: "savedFile.match",
      state: {
        destination_window: where,
        form_fields: d,
        task: ledger.own("The user is filling in this form. The candidates are files the user attached to forms before and kept for the question each answered; one fits only when this field asks for the same document."),
      },
      questions: {
        [QUESTION_ID]: { type: "choice", instructions: FILE_WORDINGS[wording](ledger, where, d), criteria: { ...Object.fromEntries([...ids].map(([id, c]) => [id, c.said])), [NONE]: ledger.own(FILE_NONE) } },
      },
      snippets: declared.snippets,
      charged: declared.charged,
    }));
    const [r1, r2] = await Promise.all([ask(request(first, 0)), ask(request(second, 1))]);
    const pick = (r: JevResult, ids: Map<string, (typeof asked)[number]>): { c: (typeof asked)[number] | null; confidence: number } | undefined => {
      const a = r.answers[QUESTION_ID];
      if (a === undefined) return undefined;
      if (a.choice === NONE) return { c: null, confidence: a.confidence };
      const c = ids.get(a.choice);
      return c === undefined ? undefined : { c, confidence: a.confidence };
    };
    const a1 = pick(r1, first);
    const a2 = pick(r2, second);
    if (a1 === undefined || a2 === undefined || a1.c === null || a1.c !== a2.c) return null;
    if (Math.min(a1.confidence, a2.confidence) < FILL_CUTOFF) return null;
    return a1.c;
  }

  /** An attach of a file the user confirmed verified: an offer to keep it may follow (fileSaveOffer). */
  attached(a: AttachedFile): void {
    const docs = this.deps.documents();
    if (!this.deps.hostShowsFiles(a.session) || docs === null) return;
    const question = fileQuestion(a.label);
    if (question === null) return;
    const site = this.deps.pageContext(a.windowId)?.site ?? null;
    const fields = FileFields.omit({ savedOn: true }).safeParse({ question, normalized: normalizeQuestion(question), site, path: a.path });
    if (!fields.success) return;
    const was = fileFor(docs, fields.data.normalized, fields.data.site);
    if (was !== null && was.fields.path === a.path) return;
    const now = this.deps.now();
    // Expired offers go, and so does an earlier one for the same question on the same site: only the newest is answered.
    for (const [id, o] of this.offers) {
      if (now > o.expires || (o.fields.normalized === fields.data.normalized && o.fields.site === fields.data.site)) this.offers.delete(id);
    }
    const id = this.deps.newId();
    const expires = now + FILE_OFFER_KEEP_MS;
    const name = basename(a.path).slice(0, 255);
    this.offers.set(id, { session: a.session, fields: fields.data, replaces: was?.id ?? null, expires });
    this.deps.count("files.offer");
    this.deps.publish({
      type: "fileSaveOffer",
      v: PROTOCOL_VERSION,
      id,
      at: now,
      expires,
      goalId: a.goalId,
      question,
      site,
      file: { name },
      replaces: was?.id ?? null,
      says: `Use ${quote(name)} for '${quote(question)}' next time?`,
    });
  }

  /** The user's yes to a fileSaveOffer. */
  save(m: FileSave, session: string | undefined): FileSaveReply {
    const refused = (why: string, says: string): FileSaveReply => {
      this.deps.count(`files.refused_${why}`);
      return { type: "fileSaveReply", v: PROTOCOL_VERSION, requestId: m.requestId, outcome: "refused", fileId: null, says };
    };
    const o = this.offers.get(m.offerId);
    if (o === undefined) return refused("noOffer", "That offer has ended, so nothing was saved.");
    if (this.deps.now() > o.expires) {
      this.offers.delete(m.offerId);
      return refused("expired", "That offer to keep the file has expired, so nothing was saved.");
    }
    // Another host's yes neither saves nor uses up the offer.
    if (o.session !== session) return refused("otherSession", "That offer was made to another window, so nothing was saved.");
    // Answered once, whatever happens next.
    this.offers.delete(m.offerId);
    const docs = this.deps.documents();
    if (docs === null) return refused("unavailable", "Caret's memory is still in its old encrypted store, so it can't keep files yet.");
    const name = quote(basename(o.fields.path));
    if (regularFile(o.fields.path) === null) return refused("notFile", `${name} is no longer a file Caret can keep, so nothing was saved.`);
    try {
      const id = saveFile(docs, { ...o.fields, savedOn: new Date(this.deps.now()).toISOString() }, o.replaces);
      this.deps.count("files.saved");
      return { type: "fileSaveReply", v: PROTOCOL_VERSION, requestId: m.requestId, outcome: "saved", fileId: id, says: `Caret will offer ${name} for '${quote(o.fields.question)}' next time.` };
    } catch (e) {
      if (e instanceof MemoryDocumentError) return refused("unavailable", "Caret couldn't write files.md, so nothing was saved.");
      throw e;
    }
  }

  /**
   * H14: the memory window's Files section: the saved files newest saved first, or forget one and list what is left. A
   * refusal (memory in the old store, an unknown id, files.md edited since it was read) says why in `error` and lists
   * nothing.
   */
  files(m: SavedFilesRequest): SavedFilesReply {
    const reply = (error: string | null, files: SavedFileView[]): SavedFilesReply => ({ type: "savedFilesReply", v: PROTOCOL_VERSION, requestId: m.requestId, error, files });
    const docs = this.deps.documents();
    if (docs === null) return reply("Caret's memory is still in its old encrypted store, so it has no saved files yet.", []);
    try {
      if (m.op === "forget") {
        forgetFile(docs, m.id as string);
        this.deps.count("files.forgotten");
      }
      return reply(null, fileViews(savedFiles(docs)));
    } catch (e) {
      if (e instanceof UnknownFileError || e instanceof MemoryDocumentError) return reply(e.message, []);
      throw e;
    }
  }
}

/** The most files a savedFilesReply lists (protocol SavedFilesReply.files). */
const MAX_FILE_VIEWS = 200;

/** Saved files as the Files section shows them, newest saved first; `edited` by lstat, null unless a regular file. */
function fileViews(files: SavedFile[]): SavedFileView[] {
  return files
    .map((f) => {
      const st = regularFile(f.fields.path);
      const name = basename(f.fields.path) || f.fields.path;
      return {
        id: f.id,
        question: f.fields.question,
        site: f.fields.site,
        name: name.length <= 255 ? name : `${name.slice(0, 254)}…`,
        path: f.fields.path,
        savedOn: Math.max(0, Date.parse(f.fields.savedOn)),
        edited: st === null ? null : Math.floor(st.mtimeMs),
        status: f.status,
      };
    })
    .sort((a, b) => b.savedOn - a.savedOn)
    .slice(0, MAX_FILE_VIEWS);
}
