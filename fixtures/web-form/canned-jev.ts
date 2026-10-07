// page-loop-eval's canned Jev, by kind of question (helper engines/decide/canned.ts: a kind with no rule throws), kept
// apart from the eval so a helper test can meet it with every question the planner and fill ask (test/canned-kinds).
// Ask's heads read the whole form from any source for the user and confirm code's reading of the scope (A1's `reading`;
// before W1 it was answered "none", "fill no field", and every page goal asked which fields to fill); the field yes/no
// heads say no; each fill question takes what `value` says (the answer key's value); every yes/no check says no. G2:
// whose and owner questions take what `ownership` says (page-loop-eval: each page's ground truth, owners.json), and
// unclear at 0.5 without it: before G2 they all said the user's at 0.95, so canned runs could not see fill's ownership
// stage (evidence/screen/g1).
import { cannedReply, type CannedAnswer, type CannedRules } from "../../helper/src/engines/decide/canned.ts";
import type { AskJev, JevRequest } from "../../helper/src/fill/jev.ts";

export const PAGE_LOOP_HEADS: Readonly<Record<string, string>> = { scope: "all", source: "any", whose: "user", why: "nothingToFill", section: "none", reading: "code" };

/** G2: how a canned engine answers fill's whose-details (`whose`) and whose-value (`owner`) questions. */
export interface PageLoopOwnership {
  whose: (q: JevRequest["questions"][string], id: string, req: JevRequest) => CannedAnswer | Promise<CannedAnswer>;
  owner: (q: JevRequest["questions"][string], id: string, req: JevRequest) => CannedAnswer | Promise<CannedAnswer>;
}
const UNCLEAR_OWNERSHIP: PageLoopOwnership = { whose: () => ({ choice: "unclear", confidence: 0.5 }), owner: () => ({ choice: "unclear", confidence: 0.5 }) };

export function pageLoopRules(value: (q: JevRequest["questions"][string]) => Promise<CannedAnswer>, ownership: PageLoopOwnership = UNCLEAR_OWNERSHIP): CannedRules {
  const unclear = (): CannedAnswer => ({ choice: "unclear", confidence: 0.5 });
  const no = (): CannedAnswer => ({ choice: "no", confidence: 0.95 });
  return {
    confidence: 0.9,
    choice: {
      ...Object.fromEntries(Object.entries(PAGE_LOOP_HEADS).map(([k, v]) => [`ask.heads:${k}`, () => v])),
      "ask.confirm:all": no,
      "ask.confirm:field": no,
      "fill.whose:whose": ownership.whose,
      "fill.whose:owner": ownership.owner,
      "fill.values:whose": ownership.whose,
      "fill.values:owner": ownership.owner,
      "fill.values:value": value,
      "fill.values:answer": () => ({ choice: "none", confidence: 0.9 }),
      "plan.verify:value": no,
      "plan.verify:whose": unclear,
      "plan.verify:owner": unclear,
    },
    noul: { "ask.heads:field": () => 0 },
  };
}

export const pageLoopCanned = (value: (q: JevRequest["questions"][string]) => Promise<CannedAnswer>, ownership?: PageLoopOwnership): AskJev => (req) => cannedReply(req, pageLoopRules(value, ownership));
