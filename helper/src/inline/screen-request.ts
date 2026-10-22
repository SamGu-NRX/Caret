import type { ScreenModel } from "../model.ts";
import { admittedScreenText } from "./screen-context.ts";

export const SCREEN_TEXT_MAX_CHARS = 2048;
export type ScreenTextRequest = { type: "screenTextRequest"; v: 1; id: string; revision: number; windowId: string; maxCharacters: number; offApps?: string[]; offSites?: string[]; site?: string | null };
export type ScreenTextReply = { type: "screenTextReply"; v: 1; id: string; revision: number; text: string | null };

export function answerScreenText(model: ScreenModel, request: ScreenTextRequest): ScreenTextReply {
  return { type: "screenTextReply", v: 1, id: request.id, revision: request.revision, text: admittedScreenText(model, request.windowId, Math.min(request.maxCharacters, SCREEN_TEXT_MAX_CHARS), request.offApps, request.offSites, request.site ?? null) };
}
