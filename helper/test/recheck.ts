// I1: the one recheck of a value's source (fill/contract.ts provenanceStale), as tests ask it. The merge folded G2's
// offers/fill-popup.ts sourceHolds into it; its tests now read a value from one source text and recheck it on another.
import { provenanceStale, windowProvenance } from "../src/fill/contract.ts";
import type { ScreenModel } from "../src/model.ts";

/**
 * Whether a value fill read as `span` (beside `context`, a "Label: value" line's label) from the node `nodeKey` of the
 * window `windowId` in `source(was)` is still held once that window reads `source(now)`: the provenance fill records
 * (windowProvenance, digests of the lines around the span in `was`), rechecked against the model built from `now`.
 */
export function holds(source: (text: string) => ScreenModel, at: { windowId: string; nodeKey: string }, was: string, now: string, span: string, context: string | null = null): boolean {
  const pr = windowProvenance(source(was).windows.get(at.windowId), { text: span, context, labelled: context !== null, source: { windowId: at.windowId, nodeKey: at.nodeKey, appName: "", windowTitle: "" } });
  return provenanceStale(source(now), pr) === null;
}
