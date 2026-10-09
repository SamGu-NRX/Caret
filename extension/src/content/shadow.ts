// An element's shadow root, open or closed, for every reader that walks the flat tree (walker.ts, password-watch.ts).

/** An element's shadow root, open or closed. chrome.dom takes HTML elements only and throws on others (SVG). */
export function shadowRootOf(el: Element): ShadowRoot | null {
  if (el.shadowRoot !== null) return el.shadowRoot;
  if (!(el instanceof HTMLElement) || typeof chrome === "undefined" || chrome.dom?.openOrClosedShadowRoot === undefined) return null;
  try {
    return (chrome.dom.openOrClosedShadowRoot(el) as ShadowRoot | null) ?? null;
  } catch {
    return null;
  }
}
