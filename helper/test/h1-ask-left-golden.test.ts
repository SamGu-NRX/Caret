// H1: fixtures/golden/ask-left.ndjson is the plan line the host's Ask card reads its "left to you" steps from (AskCaret.swift
// AskCaret.left): a plan that writes one field and leaves the rest to the user. The host finds those blocks by their first
// row's label, so the line's blocks must be exactly what planSpec emits (leftToYouBlocks). The values are synthetic.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HelperMessage, type PlanProposal } from "../src/protocol.ts";
import { MAX_FILL_ROWS } from "../src/offers/fill-popup.ts";
import { LEFT_TO_YOU_LABEL, YOU_TYPE_LABEL, leftToYouBlocks } from "../src/planner/proposal.ts";
import { saysLeftToYou } from "../src/planner/says.ts";

const line = readFileSync(new URL("../fixtures/golden/ask-left.ndjson", import.meta.url), "utf8").trim();
const facts = (p: PlanProposal) => (p.spec?.blocks ?? []).filter((b) => b.type === "facts");
const UNSURE = ["Telephone", "E-mail address", "Pizza Size", "Bacon", "Extra Cheese", "Onion", "Mushroom"];

describe("the Ask's left-to-you plan line (H1)", () => {
  it("parses and writes back byte for byte", () => {
    expect(JSON.stringify(HelperMessage.parse(JSON.parse(line)))).toBe(line);
  });

  it("holds the blocks planSpec emits for one field Caret never types and seven Jev wasn't sure about", () => {
    const p = HelperMessage.parse(JSON.parse(line)) as PlanProposal;
    const windowId = p.window?.windowId ?? "";
    const emitted = leftToYouBlocks(windowId, saysLeftToYou([{ name: "Social Security number", kind: "governmentId" }]), UNSURE.map((name) => ({ key: `form/textbox:${name.toLowerCase()}~0`, name })));
    const [youType, left, press] = facts(p);
    expect([youType, left]).toEqual(emitted);
    // What the host matches on: the first row's label, and the counting row's rule after MAX_FILL_ROWS fields.
    expect(emitted.map((b) => (b.type === "facts" ? b.rows[0]?.label : null))).toEqual([YOU_TYPE_LABEL, LEFT_TO_YOU_LABEL]);
    expect(left?.type === "facts" && left.rows.length).toBe(MAX_FILL_ROWS + 1);
    expect(left?.type === "facts" && left.rows.at(-1)?.value.ref).toMatchObject({ rule: "count" });
    // The press is the plan's handoff, which the host reads from `handoff`, not from this block.
    expect(press?.type === "facts" && press.rows[0]?.label).toBe("You press (outbound)");
    expect(p.handoff).toEqual({ label: "Place order", why: "outbound" });
  });
});
