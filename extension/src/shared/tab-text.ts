// The tab the user just left, read as a fill source (P4). Pure parts shared by the content script (content/text.ts),
// which reads one frame, and the worker, which joins the frames of the tab: the size cap and the order.
//
// Why a cap, and why there: the read exists so fill can find the few values a form needs in the message or note the
// user just looked at. 16 KB holds a long email many times over; a whole wiki page or a mailbox's list does not need to
// leave the frame for that. The cap is applied in the frame (so no more than it ever crosses into the worker) and again
// over the joined frames. It cuts between paragraphs, so no paragraph arrives half-read and looking like another one.

/** The most text one read carries, in UTF-8 bytes, all frames together (brief P4 rule 4). */
export const TAB_TEXT_BYTES = 16 * 1024;

/** What one frame read: the text the user had selected there, then the main region's, each as paragraphs in page order. */
export interface FrameText {
  selection: string[];
  blocks: string[];
}

const enc = new TextEncoder();

export function utf8Bytes(s: string): number {
  return enc.encode(s).length;
}

/**
 * The longest start of `s` within `max` UTF-8 bytes that ends at a line break, or "" when no line break falls within
 * it. Used only when a single paragraph is longer than the whole cap (a plain-text message in one block): its lines are
 * then its paragraphs. A paragraph is never cut inside a line.
 */
export function cutParagraph(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let lo = 0;
  let hi = s.length;
  // The longest prefix in bytes, by binary search over UTF-16 length.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  // Never split a surrogate pair.
  if (end > 0 && end < s.length && /[\uD800-\uDBFF]/.test(s.charAt(end - 1))) end--;
  const prefix = s.slice(0, end);
  const line = prefix.lastIndexOf("\n");
  return line > 0 ? prefix.slice(0, line) : "";
}

/**
 * Whole paragraphs, in order, while they fit in `max` bytes counted with one byte between paragraphs. Stops at the
 * first that does not fit, so the text read is always a start of what the page shows, never a selection from it. A
 * first paragraph longer than the cap is cut inside (cutParagraph); there is no paragraph boundary to cut at.
 */
export function capParagraphs(parts: readonly string[], max: number = TAB_TEXT_BYTES): { kept: string[]; cut: boolean } {
  const kept: string[] = [];
  let used = 0;
  for (const p of parts) {
    const n = utf8Bytes(p) + (kept.length === 0 ? 0 : 1);
    if (used + n <= max) {
      kept.push(p);
      used += n;
      continue;
    }
    if (kept.length === 0) {
      const head = cutParagraph(p, max);
      if (head !== "") kept.push(head);
    }
    return { kept, cut: true };
  }
  return { kept, cut: false };
}

/**
 * One frame's read, capped: its selection first, since what the user marked is what they meant (brief rule 4), then
 * its main region, within one budget.
 */
export function capFrame(t: FrameText, max: number = TAB_TEXT_BYTES): FrameText & { cut: boolean } {
  const all = capParagraphs([...t.selection, ...t.blocks], max);
  return { selection: all.kept.slice(0, t.selection.length), blocks: all.kept.slice(t.selection.length), cut: all.cut };
}

/**
 * The tab's text from its frames, top frame first: every frame's selection before any frame's main region, then the
 * main regions in frame order, under one cap.
 */
export function joinFrames(frames: readonly FrameText[], max: number = TAB_TEXT_BYTES): FrameText & { cut: boolean } {
  return capFrame({ selection: frames.flatMap((f) => f.selection), blocks: frames.flatMap((f) => f.blocks) }, max);
}
