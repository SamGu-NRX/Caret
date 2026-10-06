// Saved files (P3): a file the user attached once, kept for the same question next time ("Use this file for résumés
// next time?"), and offered again only in a goal preview's attach row, never attached without that preview's
// acceptance naming it (goalAccept.confirmedFile). Caret never looks for a file on disk: the only paths here are ones
// the user confirmed in a preview and then agreed to keep.
//
// Placeholder until the saved-file memory lands: every row offers a file chooser, no save is offered, and a save is
// refused. The helper calls exactly these three methods.
import type { AskJev } from "../fill/jev.ts";
import type { MemoryDocumentStore } from "../memory/documents.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import type { PageContext } from "../fill/answers.ts";
import { PROTOCOL_VERSION, type FileSave, type FileSaveOffer, type FileSaveReply, type Node } from "../protocol.ts";
import type { AttachOffer } from "./plan.ts";

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

export class SavedFiles {
  private readonly deps: SavedFilesDeps;

  constructor(deps: SavedFilesDeps) {
    this.deps = deps;
  }

  /** What the attach row of file control `node` offers: a saved file a Jev choice matched to it, else a chooser. */
  async offer(_w: WindowState, _node: Node, _label: string): Promise<AttachOffer> {
    return { source: "choose" };
  }

  /** An attach of a file the user confirmed verified: an offer to keep it may follow (fileSaveOffer). */
  attached(_a: AttachedFile): void {}

  /** The user's yes to a fileSaveOffer. */
  save(m: FileSave, _session: string | undefined): FileSaveReply {
    return { type: "fileSaveReply", v: PROTOCOL_VERSION, requestId: m.requestId, outcome: "refused", fileId: null, says: "That offer has ended, so nothing was saved." };
  }
}
