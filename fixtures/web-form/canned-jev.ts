// page-loop-eval's canned Jev, by kind of question (helper engines/decide/canned.ts: a kind with no rule throws), kept
// apart from the eval so a helper test can meet it with every question the planner and fill ask (test/canned-kinds).
// Ask's heads read the whole form from any source for the user and confirm code's reading of the scope (A1's `reading`;
// before W1 it was answered "none", "fill no field", and every page goal asked which fields to fill); the field yes/no
// heads say no; each fill question takes what `value` says (the answer key's value); whose and owner questions say the
// user's; every yes/no check says no.
import { cannedReply, type CannedAnswer, type CannedRules } from "../../helper/src/engines/decide/canned.ts";
import type { AskJev, JevRequest } from "../../helper/src/fill/jev.ts";

export const PAGE_LOOP_HEADS: Readonly<Record<string, string>> = { scope: "all", source: "any", whose: "user", why: "nothingToFill", section: "none", reading: "code" };

export function pageLoopRules(value: (q: JevRequest["questions"][string]) => Promise<CannedAnswer>): CannedRules {
  const user = (): CannedAnswer => ({ choice: "user", confidence: 0.95 });
  const no = (): CannedAnswer => ({ choice: "no", confidence: 0.95 });
  return {
    confidence: 0.9,
    choice: {
      ...Object.fromEntries(Object.entries(PAGE_LOOP_HEADS).map(([k, v]) => [`ask.heads:${k}`, () => v])),
      "ask.confirm:all": no,
      "ask.confirm:field": no,
      "fill.whose:whose": user,
      "fill.whose:owner": user,
      "fill.values:whose": user,
      "fill.values:owner": user,
      "fill.values:value": value,
      "fill.values:answer": () => ({ choice: "none", confidence: 0.9 }),
      "plan.verify:value": no,
      "plan.verify:whose": user,
      "plan.verify:owner": user,
    },
    noul: { "ask.heads:field": () => 0 },
  };
}

export const pageLoopCanned = (value: (q: JevRequest["questions"][string]) => Promise<CannedAnswer>): AskJev => (req) => cannedReply(req, pageLoopRules(value));
