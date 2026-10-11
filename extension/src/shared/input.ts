// Which page events count as the user taking over a page task (W3).

/**
 * A pointer or key press the browser dispatched itself (trusted). A page's script, and Caret's own synthetic presses
 * (the combobox handler), can only make untrusted events, and focus moves are not presses.
 */
export function isUsersOwn(e: { isTrusted: boolean; type: string }): boolean {
  return e.isTrusted && (e.type === "pointerdown" || e.type === "keydown");
}
