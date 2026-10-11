import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyingReveal, checkActionBar, decodePopupSpec, parsePopupSpec, PopupSpec, PopupSpecError, specChoices } from "../src/popup.ts";
import { OfferAction, OfferAlternatives, OfferPopup } from "../src/protocol.ts";

// The host's golden file (CaretHostCoreTests/Fixtures/popup-specs.json on v2/host at 4048deb), copied verbatim.
const GOLDEN = fileURLToPath(new URL("../fixtures/golden/popup-specs.json", import.meta.url));
const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as { valid: Record<string, unknown>; invalid: { name: string; error: string; spec: unknown }[] };

function refusal(spec: unknown): string {
  try {
    parsePopupSpec(spec);
  } catch (e) {
    if (e instanceof PopupSpecError) return e.short;
    throw e;
  }
  return "accepted";
}

describe("the host's golden pop-up specs", () => {
  it("accepts the three valid specs, and zod's parse of each is lossless", () => {
    expect(Object.keys(golden.valid).sort()).toEqual(["eventCard", "fillPreview", "picker"]);
    for (const [name, spec] of Object.entries(golden.valid)) {
      expect(refusal(spec), name).toBe("accepted");
      expect(PopupSpec.parse(spec), name).toEqual(spec);
    }
  });

  it("refuses every invalid spec with the error the host names", () => {
    expect(golden.invalid.length).toBe(13);
    for (const item of golden.invalid) expect(refusal(item.spec), item.name).toBe(item.error);
  });

  it("reports the same refusal through zod, at the path the error names", () => {
    const bare = golden.invalid.find((i) => i.name === "value given as a bare string");
    const r = PopupSpec.safeParse(bare?.spec);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("missingReference(blocks[1].rows[0].value)");
    expect(r.error?.issues[0]?.path).toEqual(["blocks", 1, "rows", 0, "value"]);
  });

  it("reads the event card's reveal into a valid spec with the time choices", () => {
    const card = parsePopupSpec(golden.valid.eventCard);
    const revealed = applyingReveal(card, "changeTime");
    expect(specChoices(revealed)?.id).toBe("time");
    expect(specChoices(revealed)?.rows.map((r) => r.label.text)).toEqual(["2:30 to 3:00 pm", "3:00 to 3:30 pm", "3:30 to 4:00 pm"]);
    expect(revealed.blocks.find((b) => b.type === "actions")).toEqual({ type: "actions", items: [{ id: "add", label: "Add", key: "tab" }] });
  });

  it("names malformed JSON, a missing field and a wrong type", () => {
    expect(() => decodePopupSpec("{")).toThrow("not JSON");
    expect(refusal({ v: 1, figure: "offering", blocks: [] })).toBe("$.id: missing");
    expect(refusal({ v: 1, id: "x", figure: "sad", blocks: [] })).toBe("$.figure: expected offering or needsYou");
    expect(refusal({ v: 1, id: "x", figure: "offering", blocks: [] })).toBe("$.blocks: empty");
  });
});

describe("offer messages carry only checked values and specs", () => {
  const field = { pid: 5150, windowId: "5150-1", key: "k", frame: null, window: { number: null, title: "Notes" } };
  const value = { text: "Dana Reyes", ref: { node: "6060-1/body", quote: "Dana Reyes" } };

  it("refuses an alternatives candidate with no ref", () => {
    const base = { type: "alternatives", v: 1, offerKey: "o", at: 1, field, quoted: true };
    expect(OfferAlternatives.safeParse({ ...base, candidates: [value] }).success).toBe(true);
    const r = OfferAlternatives.safeParse({ ...base, candidates: [value, "Dana Kim"] });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("missingReference(value)");
    expect(r.error?.issues[0]?.path).toEqual(["candidates", 1]);
  });

  it("refuses an action whose bar has no Tab action, or whose end state has no ref", () => {
    const base = { type: "action", v: 1, offerKey: "o", at: 1, field, app: "Calendar", endState: value, actions: [{ id: "add", label: "Add", key: "tab" }] };
    expect(OfferAction.safeParse(base).success).toBe(true);
    expect(OfferAction.safeParse({ ...base, actions: [{ id: "add", label: "Add", key: "cmd-2" }] }).error?.issues[0]?.message).toBe("noPrimaryAction(actions)");
    expect(OfferAction.safeParse({ ...base, endState: { text: "x" } }).error?.issues[0]?.message).toBe("missingReference(value)");
    const variants = golden.invalid.find((i) => i.name === "four choices")?.spec;
    expect(OfferAction.safeParse({ ...base, variants }).error?.issues[0]?.path).toEqual(["variants", "blocks", 1, "rows"]);
  });

  it("refuses a popup whose spec breaks a rule, naming the path inside the message", () => {
    const base = { type: "popup", v: 1, offerKey: "o", at: 1, field };
    expect(OfferPopup.safeParse({ ...base, spec: golden.valid.picker }).success).toBe(true);
    const bad = golden.invalid.find((i) => i.name === "choice hint without ref")?.spec;
    const r = OfferPopup.safeParse({ ...base, spec: bad });
    expect(r.error?.issues[0]?.message).toBe("missingReference(blocks[1].rows[1].hint)");
    expect(r.error?.issues[0]?.path).toEqual(["spec", "blocks", 1, "rows", 1, "hint"]);
  });

  it("holds an action bar to the actions-block rules", () => {
    expect(() => checkActionBar([{ id: "a", label: "A", key: "tab" }, { id: "a", label: "B", key: "cmd-2" }], "actions")).toThrow('actions[1]: action id "a" used twice');
    expect(() => checkActionBar([], "actions")).toThrow("actions: empty");
  });
});
