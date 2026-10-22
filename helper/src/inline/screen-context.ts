import type { Node } from "../protocol.ts";
import type { ScreenModel, WindowState } from "../model.ts";

/** Returns admitted static text near the focused node, bounded by characters. */
export function admittedScreenText(model: ScreenModel, focusedWindowId: string | null = model.focusedWindowId, maxCharacters = 2048): string | null {
  if (focusedWindowId === null) return null;
  const window = model.windows.get(focusedWindowId);
  if (window === undefined || !window.focused || model.frontmostPid !== null && window.app.pid !== model.frontmostPid) return null;
  const focus = window.focusedKey === null ? undefined : window.nodes.get(window.focusedKey);
  const candidates = [...window.nodes.values()]
    .filter(isAdmittedStaticText)
    .filter(node => near(node, focus));
  const text = candidates.map(node => node.label ?? node.value ?? "").filter(Boolean).join("\n").trim();
  return text.length === 0 ? null : text.slice(0, maxCharacters);
}

function isAdmittedStaticText(node: Node): boolean {
  return node.role === "AXStaticText" && node.excluded === undefined && node.unread !== true && node.editable !== true && node.rev === undefined;
}

function near(node: Node, focus: Node | undefined): boolean {
  if (focus?.frame === undefined || node.frame === undefined) return true;
  const [x, y, w, h] = node.frame;
  const [fx, fy, fw, fh] = focus.frame;
  return Math.abs((x + w / 2) - (fx + fw / 2)) <= 800 && Math.abs((y + h / 2) - (fy + fh / 2)) <= 600;
}
