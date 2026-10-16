// The one sender of pageSourceGrant (counsel 2026-10-09): the text of a web page's fields, read only after the user
// picked that window as the source of a copy. Until a caller holds that pick, copying from a web field stays dark
// (model.ts WEB_FIELD_NOT_A_SOURCE): no fill or planner path calls this yet. A test asserts no other module builds the
// verb (test/page-values-boundary.test.ts). The page answers null for a withheld, secret or gone field.
import type { EngineSession } from "./session.ts";

/** One frame of a tab the user picked as a copy source, as its last walk named it. */
export interface SourceFrame {
  tabId: number;
  frameId: number;
  documentId: string;
}

/**
 * The text of fields `ids` of `frame`, under `taskId`'s grant, for a source the user picked (`picked`: the pick itself,
 * which the caller must hold; this module refuses without one). Null for a field the page withholds.
 */
export async function readPickedSource(session: EngineSession, frame: SourceFrame, taskId: string, ids: readonly string[], picked: { by: "user"; windowId: string } | null): Promise<{ values: Record<string, string | null> } | { refused: string }> {
  if (picked === null) return { refused: "Caret copies from a web page's fields only from a window you picked as the source" };
  if (ids.length === 0) return { values: {} };
  const { result } = await session.command({ kind: "pageSourceGrant", tabId: frame.tabId, frameId: frame.frameId, documentId: frame.documentId, taskId, ids: [...ids] });
  if (result.outcome !== "ok" || result.source === undefined) return { refused: result.detail === null ? result.outcome : `${result.outcome}: ${result.detail}` };
  return { values: result.source };
}
