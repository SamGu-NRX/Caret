// choose() inside a plan program, answered by Jev through the existing client (fill/jev.ts). The question
// and option labels are the host's, from the frozen snapshot; the program only picks which group to ask
// about. Options are numbered so Jev answers with a key, never with free text.
import type { AskJev, JevRequest } from "../fill/jev.ts";
import type { Snippet } from "../privacy.ts";
import type { ChooserPort } from "./sandbox.ts";

/**
 * The plan's provisional router floor (action-engine-v2 section 3). There is no calibration for
 * task-local choices yet; below it the program gets null and can ask the user instead.
 */
export const CHOOSE_FLOOR = 0.75;
const NONE = "none";

export function jevChooser(ask: AskJev, goal: string): ChooserPort {
  return async ({ window, question, options, signal }) => {
    const criteria: Record<string, string | null> = {};
    options.forEach((o, i) => (criteria[String(i + 1)] = o.label));
    criteria[NONE] = "None of these is supported by what is on screen";
    const snippets: Snippet[] = [{ windowId: window, kind: "descriptor", text: question.text }, ...options.map((o): Snippet => ({ windowId: window, kind: "candidate", text: o.label }))];
    const req: JevRequest = {
      purpose: "codemode.choice",
      state: { goal },
      questions: { choice: { type: "choice", instructions: question.text, criteria } },
      snippets,
      charged: { [window]: snippets.reduce((n, s) => n + s.text.length, 0) },
    };
    // The existing client takes no AbortSignal (its own fetch times out at 10 s), so an abort here stops
    // waiting and drops the answer; the request itself runs to its own timeout.
    const result = await new Promise<Awaited<ReturnType<AskJev>>>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      ask(req).then(resolve, reject);
    });
    const a = result.answers.choice;
    if (a === undefined || a.choice === NONE || !(a.confidence >= CHOOSE_FLOOR)) return null;
    const i = Number(a.choice) - 1;
    // An answer outside the numbered options is an abstention, as the routers treat an unknown choice.
    if (!Number.isInteger(i) || String(i + 1) !== a.choice) return null;
    return options[i]?.ref ?? null;
  };
}
