import type { ScreenModel } from "../model.ts";
import type { ScreenTextRequest, ScreenTextReply } from "../protocol.ts";
import { admittedScreenText } from "./screen-context.ts";

export type { ScreenTextRequest, ScreenTextReply } from "../protocol.ts";
export const SCREEN_TEXT_MAX_CHARS = 2048;

export function answerScreenText(model: ScreenModel, request: ScreenTextRequest): ScreenTextReply {
  // Only the reader can name its windows. A host request must still belong to the focused app.
  const windowId = model.focusedWindowId;
  const window = windowId === null ? undefined : model.windows.get(windowId);
  const text = window?.app.pid === request.pid
    ? admittedScreenText(model, windowId, Math.min(request.maxCharacters, SCREEN_TEXT_MAX_CHARS), request.appsOff, request.sitesOff, request.site ?? null)
    : null;
  return { type: "screenTextReply", v: 1, id: request.id, revision: request.revision, text };
}
