// P4 items 7 and 9: what the host is told about the field the user is typing in on a page (protocol.ts PageFieldText),
// from the tab's latest walk. The host cannot read a web field itself (Chrome shows Accessibility no web content, H10),
// so inline text had no context in any web page (GD1 finding 4). Built from the snapshot alone; nothing is kept here.
import type { PageControlKind, PageFieldText, PageSnapshot } from "../protocol.ts";

/**
 * Whether the page offers its own inline suggestions in this field (brief item 9), by origin and path: Gmail's compose
 * body (Smart Compose; the body is the one contenteditable of a compose window, its subject and recipients are inputs),
 * and a Google Doc (docs.google.com/document). Caret's offer would take Tab from them (GD1 finding 5); the host decides.
 */
export function ownSuggestions(origin: string | null, path: string | null, kind: PageControlKind | null): PageFieldText["ownSuggestions"] {
  if (origin === "https://mail.google.com" && (path ?? "").startsWith("/mail/") && kind === "contenteditable") return "gmail";
  if (origin === "https://docs.google.com" && (path ?? "").startsWith("/document/")) return "google-docs";
  return null;
}

/** The text part of the host's pageField for a tab, from its latest walk. */
export function pageFieldText(s: PageSnapshot): PageFieldText {
  const top = s.frames.find((f) => f.parentFrameId < 0);
  // A Docs editor keeps its caret in an off-screen text-event frame the walk does not keep: the top frame reads it.
  if (s.docs !== undefined) return { text: s.docs.field, ownSuggestions: s.docs.kind === "document" ? "google-docs" : null, docsText: s.docs.text };
  const f = s.focused;
  if (f === null) return { text: null, ownSuggestions: null, docsText: null };
  const kind = s.frames.find((x) => x.frameId === f.frameId)?.controls.find((c) => c.id === f.id)?.kind ?? null;
  return { text: f.text ?? null, ownSuggestions: ownSuggestions(top?.origin ?? null, top?.path ?? null, kind), docsText: null };
}
