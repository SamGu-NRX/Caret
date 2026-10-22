// Slice 2: what the bridge accepts for a pageActivateItem before the worker routes it to a frame (worker/wire.ts):
// the fields every act names, and a control kind that is a list row the walk carries — nothing else of the page opens.
import { describe, expect, it } from "vitest";
import { parseVerb } from "../src/worker/wire.ts";

const base = { kind: "pageActivateItem", tabId: 7, frameId: 0, documentId: "D0", id: "r1", control: "row", name: "Kayak · Flight itinerary", taskId: "g1", rebind: false };

describe("parseVerb: pageActivateItem", () => {
  it("takes the verb for each list-row kind the walk carries", () => {
    for (const control of ["row", "option", "listitem"]) expect(parseVerb({ ...base, control })).toMatchObject({ kind: "pageActivateItem", control });
  });

  it("refuses every other control kind, and a verb missing a field", () => {
    expect(parseVerb({ ...base, control: "button" })).toBeNull();
    expect(parseVerb({ ...base, control: "text" })).toBeNull();
    expect(parseVerb({ ...base, name: "" })).toBeNull();
    expect(parseVerb({ ...base, documentId: undefined })).toBeNull();
  });
});
