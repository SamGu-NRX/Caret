// The cloud routes' last check against the focused field's caret text (counsel 2026-10-09, "The focused field"): that
// text is for inline writing on this Mac only (engines/focus-text.ts), so a request body to a cloud model that holds it
// is refused, loudly, whatever path put it there. Belt and braces: WRITER_ROUTE is null today (writer/config.ts), and the
// text is branded so no JSON of it can be made by accident. Holds only the current focused field's text, in memory,
// replaced at each walk that reports one and dropped when none does.

/**
 * The shortest run of the focused text the check looks for. Assumed, not measured: shorter runs ("Hi", a single word)
 * occur in ordinary requests by chance, and the check would then refuse requests that never saw the field.
 */
export const MIN_TRIPWIRE_CHARS = 12;

let current: string[] = [];

/** The focused field's text now, as the last walk reported it (engines/focus-text.ts); [] when no field has focus. */
export function noteFocusedText(parts: readonly string[]): void {
  current = parts.filter((p) => p.length >= MIN_TRIPWIRE_CHARS);
}

/** Thrown when a request body to a cloud route holds the focused field's text. */
export class FocusTextLeak extends Error {
  constructor(sink: string) {
    super(`a request to ${sink} held the text of the field you are typing in, which never leaves this Mac; nothing was sent`);
    this.name = "FocusTextLeak";
  }
}

/** Refuses `body`, bound for the cloud route `sink`, when it holds the focused text as it is or as JSON escapes it. */
export function refuseFocusedText(body: string, sink: string): void {
  for (const p of current) if (body.includes(p) || body.includes(JSON.stringify(p).slice(1, -1))) throw new FocusTextLeak(sink);
}
