import type { ScreenModel } from "../model.ts";
import type { ScreenTextRequest, ScreenTextReply } from "../protocol.ts";
import { admittedScreenText } from "./screen-context.ts";

export type { ScreenTextRequest, ScreenTextReply } from "../protocol.ts";
export const SCREEN_TEXT_MAX_CHARS = 2048;

export function answerScreenText(model: ScreenModel, request: ScreenTextRequest, revision: number): ScreenTextReply {
  // Both AX readers can resolve the window server number; reader-assigned window IDs are not shared.
  // No title/frame fallback: two windows of one app can have identical titles and geometry.
  const windowId = model.focusedWindowId;
  const window = windowId === null ? undefined : model.windows.get(windowId);
  const text = request.revision === revision && window?.app.pid === request.pid && window.window.number === request.windowNumber
    ? admittedScreenText(model, windowId, Math.min(request.maxCharacters, SCREEN_TEXT_MAX_CHARS), request.appsOff, request.sitesOff, request.site ?? null)
    : null;
  return { type: "screenTextReply", v: 1, id: request.id, revision: request.revision, text };
}
