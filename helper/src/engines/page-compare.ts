// The one sender of pageCompare (counsel 2026-10-09, "pageCompare as an oracle"): whether a web page's text field holds
// a candidate whole, answered by the page, which never sends the field's text. A test asserts no other module builds the
// verb (test/page-values-boundary.test.ts). The page bounds it (8 candidates per control and 64 per document per task,
// 3 code points at least, unknown for a withheld field), the worker by origin (256 an hour); this module only asks
// under a task's grant, for a control its tab's last walk holds.
import type { PageCompareAnswer, TextPageControl } from "../protocol.ts";
import type { EngineSession } from "./session.ts";

/** A text control as a tab's last walk named it. */
export interface CompareTarget {
  tabId: number;
  frameId: number;
  documentId: string;
  control: TextPageControl;
}

/** The page's answer for each candidate, in order, or why it gave none (a refusal's outcome and detail). */
export async function compareField(session: EngineSession, t: CompareTarget, taskId: string, candidates: readonly string[]): Promise<{ answers: PageCompareAnswer[] } | { refused: string }> {
  if (candidates.length === 0) return { answers: [] };
  const { result } = await session.command({ kind: "pageCompare", tabId: t.tabId, frameId: t.frameId, documentId: t.documentId, id: t.control.id, control: t.control.kind, name: t.control.name, taskId, candidates: [...candidates] });
  if (result.outcome !== "ok" || result.compare === undefined || result.compare.length !== candidates.length) return { refused: result.detail === null ? result.outcome : `${result.outcome}: ${result.detail}` };
  return { answers: result.compare };
}
