// Which later step of a plan may depend on an earlier step's value (C1, lead decision for item 4): when a run leaves a
// failed field to the user and goes on, a step that depends on it is left too, never written. A plan's steps carry no
// dependencies, so the one a form declares by its labels is read here, as the page planner orders by it
// (goals/page-planner.ts ordered): a state, city or ZIP that may follow the country before it (its list of states, a
// postal format). No other dependency is read; a field whose list a pick reveals is not in the plan at all (it comes
// as a fresh plan after the writes, goals/runs.ts afterReveal).
import { asksCountry, fieldPart } from "../fill/derive.ts";

/** Whether a field named `later` may depend on the value of the field named `earlier` in the same window. */
export function dependsOn(earlier: string, later: string): boolean {
  if (!asksCountry(earlier)) return false;
  const part = fieldPart(later);
  return part === "state" || part === "city" || part === "zip";
}
