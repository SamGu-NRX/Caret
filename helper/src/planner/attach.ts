// "Attach my resume" (H5, lead decision 7 in ~/.caret-run/plans/action-engine-v2.md): an instruction that asks for a
// file on a page becomes a plan of one step, the page's file input holding the file the user confirms for that run.
// The plan names no file. The host proposes the likely one in the slip from the user's own folders, the user confirms
// it, and only then may the helper read it (engines/attach.ts). A saved path never implies consent.
//
// Code decides it, with no model: the instruction must name attaching or uploading, and the page must hold a file
// input whose label fits what it names, or exactly one file input. Anything else is not this rule's; the planner and
// Ask go on as before.
import type { ScreenModel, WindowState } from "../model.ts";
import type { Node } from "../protocol.ts";
import type { Plan, WindowSel } from "../executor/schema.ts";
import { FILE_INPUT_SUBROLE } from "../engines/page-link.ts";
import { SAYS, SaidError } from "./says.ts";
import { validatePlan } from "./validate.ts";
import type { PlanDraft } from "./planner.ts";
import { PAGE_WINDOW_KIND } from "../engines/windows.ts";

/** The files people attach to forms, the words that name each, and how the slip says it. */
const KINDS: readonly { words: RegExp; wants: string }[] = [
  { words: /\b(?:resume|résumé|cv|curriculum vitae)\b/iu, wants: "your resume" },
  { words: /\bcover\s+letter\b/iu, wants: "your cover letter" },
  { words: /\b(?:transcript)\b/iu, wants: "your transcript" },
  { words: /\b(?:portfolio)\b/iu, wants: "your portfolio" },
];
const ASKS_TO_ATTACH = /\b(?:attach|upload|add)\b/iu;

/** The file kind an instruction asks to attach, or null when it asks for none of the kinds above. */
export function attachWanted(instruction: string): { words: RegExp; wants: string } | null {
  if (!ASKS_TO_ATTACH.test(instruction)) return null;
  return KINDS.find((k) => k.words.test(instruction)) ?? null;
}

/** The page window of the browser the user is in: a `page:` window of that process, the focused tab first. */
function pageWindowFor(model: ScreenModel, windowId: string | null): WindowState | null {
  const at = windowId === null ? model.userWindow() : (model.windows.get(windowId) ?? null);
  if (at === null) return null;
  if (at.window.windowId.startsWith("page:")) return at;
  const pages = [...model.windows.values()].filter((w) => w.window.windowId.startsWith("page:") && w.app.pid === at.app.pid);
  return pages.find((w) => w.focused) ?? (pages.length === 1 ? (pages[0] as WindowState) : null);
}

const fileInputs = (w: WindowState): Node[] => [...w.nodes.values()].filter((n) => n.subrole === FILE_INPUT_SUBROLE);

/**
 * The plan for an instruction that asks to attach a file, or null when it does not ask for one or the page holds no
 * file input. Throws SaidError when the page has several file inputs and none of their labels names the file.
 */
export function planAttach(instruction: string, model: ScreenModel, windowId: string | null, offerKey: string): PlanDraft | null {
  const kind = attachWanted(instruction);
  if (kind === null) return null;
  const w = pageWindowFor(model, windowId);
  if (w === null) return null;
  const inputs = fileInputs(w);
  if (inputs.length === 0) return null;
  const named = inputs.filter((n) => kind.words.test(n.label ?? ""));
  const target = named.length === 1 ? named[0] : inputs.length === 1 ? inputs[0] : undefined;
  if (target === undefined) throw new SaidError("ambiguousTarget", SAYS.whichField, `${inputs.length} file inputs in '${w.window.title}', and ${named.length} of their labels name ${kind.wants}`);
  const sel: WindowSel = { bundleId: w.app.bundleId, title: w.window.title, ...(w.window.number === undefined ? {} : { number: w.window.number }), ...(w.window.kind === PAGE_WINDOW_KIND ? { page: true as const, windowId: w.window.windowId } : {}) };
  const label = (target.label ?? "").trim();
  const plan: Plan = {
    id: offerKey,
    title: instruction.replace(/\s+/g, " ").trim().slice(0, 100),
    slots: {},
    steps: [{ says: `${label === "" ? "The file input" : label} holds ${kind.wants}`, end: { kind: "fileAttached", window: sel, target: { key: target.key, describe: `the ${label === "" ? "file" : label} input` }, wants: kind.wants } }],
  };
  // No value step, so no write contract mint (fill/contract.ts).
  const checked = validatePlan(plan, {}, { model, memory: [], instruction }, new Map());
  return { plan, slots: {}, checked, answers: {}, withheld: [], jev: { calls: 0, costUsd: 0, latencyMs: 0 } };
}
