// H1: fixtures/golden/ask-left.ndjson is the plan line the host's Ask card reads its "left to you" steps from (AskCaret.swift
// AskCaret.left): a plan that writes one field and leaves the rest to the user, in planSpec's blocks. The host finds those
// blocks by their first row's label, so the labels and sentences here are planSpec's own. The values are synthetic.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HelperMessage, type PlanProposal } from "../src/protocol.ts";
import { MAX_FILL_ROWS } from "../src/offers/fill-popup.ts";
import { LEFT_TO_YOU_LABEL, YOU_TYPE_LABEL } from "../src/planner/proposal.ts";
import { saysLeftToYou, saysUnsureField } from "../src/planner/says.ts";

const line = readFileSync(new URL("../fixtures/golden/ask-left.ndjson", import.meta.url), "utf8").trim();
const facts = (p: PlanProposal) => (p.spec?.blocks ?? []).flatMap((b) => (b.type === "facts" ? [b.rows] : []));

describe("the Ask's left-to-you plan line (H1)", () => {
  it("parses and writes back byte for byte", () => {
    expect(JSON.stringify(HelperMessage.parse(JSON.parse(line)))).toBe(line);
  });

  it("labels its blocks as planSpec does, and says each field as planSpec does", () => {
    const p = HelperMessage.parse(JSON.parse(line)) as PlanProposal;
    const [youType, left, press] = facts(p);
    expect(youType?.map((r) => r.label)).toEqual([YOU_TYPE_LABEL]);
    expect(youType?.[0]?.value.text).toBe(saysLeftToYou([{ name: "Social Security number", kind: "governmentId" }]));
    // planSpec shows MAX_FILL_ROWS fields, then one row that counts the rest under the rule "count".
    expect(left?.map((r) => r.label)).toEqual([LEFT_TO_YOU_LABEL, ...Array<string>(MAX_FILL_ROWS).fill("")]);
    const names = ["Telephone", "E-mail address", "Pizza Size", "Bacon", "Extra Cheese"];
    expect(left?.slice(0, MAX_FILL_ROWS).map((r) => r.value.text)).toEqual(names.map(saysUnsureField));
    const more = left?.at(-1)?.value;
    expect(more?.text).toBe("and 2 more");
    expect(more?.ref).toMatchObject({ rule: "count" });
    expect(more !== undefined && "derived" in more.ref ? more.ref.derived.length : 0).toBe(2);
    // The press is the plan's handoff, which the host reads from `handoff`, not from this block.
    expect(press?.[0]?.label).toBe("You press (outbound)");
    expect(p.handoff).toEqual({ label: "Place order", why: "outbound" });
  });
});
