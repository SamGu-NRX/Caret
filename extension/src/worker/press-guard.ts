// B28 lead decision 2: a Yes/No press (content/press.ts) must not navigate or submit. The content script reports
// beforeunload, pagehide and submit in its frame; the worker adds what only it can see: the frame's navigation
// generation moved, a navigation began in the frame, or the frame's document went away before it answered. Any of
// these makes the press `failed` with `pageChanged`: the press may have landed, and the run stops.
import type { ActAnswer, PageChange } from "../shared/messages.ts";

/** What the worker read of the pressed frame: its navigation generation and its count of navigations begun. */
export interface FrameMarks {
  navGen: number;
  starts: number;
}

/**
 * Outcomes the content script gives only before it presses (press.ts): nothing of Caret's reached the page, so a
 * change seen meanwhile is the page's own and the answer stands as it is.
 */
const BEFORE_PRESS: ReadonlySet<ActAnswer["outcome"]> = new Set(["alreadyTrue", "stale", "unsupported", "notAllowed", "noElement", "notSameElement", "excluded", "siteOff", "handoff"]);

/**
 * The answer for a Yes/No press, given the content script's answer (null when none came: the frame's document went
 * away) and the frame as the worker read it right before sending the press and after the answer.
 */
export function judgePress(answer: ActAnswer | null, before: FrameMarks, after: FrameMarks): ActAnswer {
  if (answer !== null && BEFORE_PRESS.has(answer.outcome)) return answer;
  const seen: PageChange[] = [];
  if (answer === null) seen.push("documentGone");
  if (after.navGen !== before.navGen) seen.push("navigated");
  if (after.starts !== before.starts) seen.push("navigationStarted");
  for (const c of answer?.pageChanged ?? []) if (!seen.includes(c)) seen.push(c);
  if (seen.length === 0) return answer as ActAnswer;
  return {
    outcome: "failed",
    detail: `the page changed after the press (${seen.join(", ")}), so Caret stopped`,
    ...(answer?.choice === undefined ? {} : { choice: answer.choice }),
    pageChanged: seen,
  };
}

/**
 * Slice 2: the answer for a page-row activation, given the content script's answer (null when none came: the frame's
 * document went away) and the frame as the worker read it right before sending the verb and after the answer. A
 * history update alone — a fragment jump, or pushState to the item's own address — is the expected shape of a page
 * open, so it is not a change (the helper re-walked the frame before it answered); what is, is a navigation begun
 * (onBeforeNavigate, which a fragment or pushState update does not fire) or the document gone or replaced: the open
 * may have gone through, and the run stops with `pageChanged`.
 */
const BEFORE_ACTIVATION: ReadonlySet<ActAnswer["outcome"]> = new Set(["alreadyTrue", "stale", "unsupported", "notAllowed", "noElement", "notSameElement", "excluded", "siteOff", "failed", "error"]);

export function judgeActivation(answer: ActAnswer | null, before: FrameMarks, after: FrameMarks): ActAnswer {
  if (answer !== null && BEFORE_ACTIVATION.has(answer.outcome)) return answer;
  const seen: PageChange[] = [];
  if (answer === null) seen.push("documentGone");
  if (after.starts !== before.starts) seen.push("navigationStarted");
  for (const c of answer?.pageChanged ?? []) if (!seen.includes(c)) seen.push(c);
  if (seen.length === 0) return answer as ActAnswer;
  return {
    outcome: "failed",
    detail: `the page changed when the row was opened (${seen.join(", ")}), so Caret stopped`,
    pageChanged: seen,
  };
}
