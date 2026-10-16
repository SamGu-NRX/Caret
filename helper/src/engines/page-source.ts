// Where a copy from a web page's fields would come from (counsel 2026-10-09): their text, read only after the user
// picked that window as the source of a copy. No flow lets the user make that pick yet, and a grant to act is no pick,
// so the page gives no field's text out at all: the extension has no handler for the counsel's pageSourceGrant verb and
// the protocol carries none (audit of PR #52, HIGH 2). Copying from a web field stays dark (fill/candidates.ts
// sourceField), and this refuses by name for any caller. A test asserts no module builds the verb
// (test/page-values-boundary.test.ts).

/** One frame of a tab the user picked as a copy source, as its last walk named it. */
export interface SourceFrame {
  tabId: number;
  frameId: number;
  documentId: string;
}

/** Why a copy from a web page's fields is refused: no pick flow exists, so nothing a caller holds can be the user's pick. */
export const PAGE_SOURCE_REFUSAL = "Caret copies from a web page's fields only from a window you picked as the source";

/**
 * The text of fields `ids` of `frame`, for a source the user picked. Refuses, whatever it is given, until a pick flow
 * exists and the page has a verb for it; nothing is sent to the page.
 */
export function readPickedSource(_frame: SourceFrame, _taskId: string, _ids: readonly string[], _picked: { by: "user"; windowId: string } | null): { refused: string } {
  return { refused: PAGE_SOURCE_REFUSAL };
}
