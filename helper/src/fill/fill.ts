// Grounded fill: one Jev request per form, one Choice question per empty field, each offering
// the same candidate spans plus "none" (deep plan section 5, "Fill"). Jev picks a candidate id;
// code copies that candidate's text verbatim into the proposal. Nothing here writes to any app.
import { randomUUID } from "node:crypto";
import { PROTOCOL_VERSION, type FillField, type FillProposal, type Node } from "../protocol.ts";
import type { ScreenModel, WindowState } from "../model.ts";
import { describeCandidate, generateCandidates, type Candidate } from "./candidates.ts";
import { describeField } from "./descriptor.ts";
import type { AskJev, JevRequest } from "./jev.ts";

export const NONE = "none";
const FILLABLE_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox"]);
/** A form question beyond this many fields is cut to the fields nearest the trigger. Assumed. */
export const MAX_FIELDS = 20;

export class FillError extends Error {}

/** The empty fillable fields of the trigger's window, nearest the trigger first. The trigger is always included. */
export function formFields(w: WindowState, triggerKey: string, max = MAX_FIELDS): Node[] {
  const trigger = w.nodes.get(triggerKey);
  if (trigger === undefined) throw new FillError(`field ${triggerKey} is not in window ${w.window.windowId}`);
  if (trigger.editable !== true) throw new FillError(`field ${triggerKey} is not editable`);
  const fields = [...w.nodes.values()].filter(
    (n) => n.key === triggerKey || (n.editable === true && FILLABLE_ROLES.has(n.role) && (n.value ?? "") === "" && !n.states?.includes("secure")),
  );
  const center = (n: Node): [number, number] => (n.frame === undefined ? [0, 0] : [n.frame[0] + n.frame[2] / 2, n.frame[1] + n.frame[3] / 2]);
  const [tx, ty] = center(trigger);
  const dist = (n: Node): number => (n.key === triggerKey ? -1 : Math.hypot(center(n)[0] - tx, center(n)[1] - ty));
  return fields.sort((a, b) => dist(a) - dist(b)).slice(0, max);
}

export function buildFillRequest(w: WindowState, fields: { id: string; descriptor: string }[], candidates: Candidate[]): JevRequest {
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.id] = describeCandidate(c);
  criteria[NONE] = "No candidate is the value this field asks for.";
  const where = `${w.app.name} window '${w.window.title}'`;
  const questions: JevRequest["questions"] = {};
  for (const f of fields) {
    questions[f.id] = {
      type: "choice",
      instructions: `A form in the ${where} has this field: ${f.descriptor} Which candidate is the value the user should enter in this field? Choose none if no candidate fits.`,
      criteria,
    };
  }
  return {
    state: {
      destination_window: where,
      task: "The user is filling in this form. The candidates are values visible in the user's other open windows.",
    },
    questions,
  };
}

export async function proposeFill(model: ScreenModel, askJev: AskJev, windowId: string, triggerKey: string, now = Date.now()): Promise<FillProposal> {
  const w = model.windows.get(windowId);
  if (w === undefined) throw new FillError(`unknown window ${windowId}`);
  const nodes = formFields(w, triggerKey);
  const fields = nodes.map((n, i) => ({ id: `f${i + 1}`, node: n, descriptor: describeField(w, n).text }));
  const candidates = generateCandidates(model, windowId);
  if (candidates.length === 0) throw new FillError(`no candidate values in any window other than ${windowId}`);

  const res = await askJev(buildFillRequest(w, fields, candidates));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: FillField[] = fields.map((f) => {
    const a = res.answers[f.id];
    if (a === undefined) throw new FillError(`Jev returned no answer for ${f.id}`);
    const c = a.choice === NONE ? undefined : byId.get(a.choice);
    if (a.choice !== NONE && c === undefined) throw new FillError(`Jev chose ${a.choice}, which is not a candidate id`);
    return {
      key: f.node.key,
      descriptor: f.descriptor,
      choice: a.choice,
      confidence: a.confidence,
      value: c?.text ?? null,
      source: c?.source ?? null,
    };
  });

  return {
    type: "fillProposal",
    v: PROTOCOL_VERSION,
    id: randomUUID(),
    at: now,
    windowId,
    bundleId: w.app.bundleId,
    triggerKey,
    fields: out,
    candidates: candidates.length,
    jev: { model: res.model, latencyMs: res.latencyMs, inputTokens: res.inputTokens, costUsd: res.costUsd },
  };
}
