import { describe, expect, test } from "vitest";
import { jevChooser } from "../../src/codemode/jev-chooser.ts";
import { Disclosure } from "../../src/privacy/disclosure.ts";
import type { AskJev, JevRequest } from "../../src/fill/jev.ts";

const OPTIONS = [
  { ref: "o:tue", label: "Tue Oct 20, 3:00 PM" },
  { ref: "o:wed", label: "Wed Oct 21, 10:00 AM" },
];
const QUESTION = { ref: "q:session", text: "Which session time does the email confirm?" };

function fakeJev(choice: string, confidence: number, seen: JevRequest[] = []): AskJev {
  return async (req) => {
    seen.push(req);
    return { model: "jev-test", answers: { choice: { choice, confidence } }, inputTokens: 10, latencyMs: 1, costUsd: 0 };
  };
}

/** The Disclosure that minted the program's snapshots: the question and labels are its texts (fixture wording here). */
const snapshotsDisclosure = (): Disclosure => {
  const d = new Disclosure([]);
  for (const t of [QUESTION.text, ...OPTIONS.map((o) => o.label)]) d.own(t as never);
  return d;
};
const call = (ask: AskJev, signal = new AbortController().signal) => jevChooser(ask, "sign me up", snapshotsDisclosure())({ window: "win:form", question: QUESTION, options: OPTIONS, signal });

describe("jevChooser", () => {
  test("sends the host's question and numbered labels, declares them, and maps the answer to a ref", async () => {
    const seen: JevRequest[] = [];
    expect(await call(fakeJev("2", 0.9, seen))).toBe("o:wed");
    const req = seen[0]!;
    expect(req.questions.choice).toEqual({ type: "choice", instructions: QUESTION.text, criteria: { "1": OPTIONS[0]!.label, "2": OPTIONS[1]!.label, none: expect.any(String) } });
    expect(req.state).toEqual({ goal: "sign me up" });
    expect(req.snippets.map((s) => [s.windowId, s.kind, s.text])).toEqual([
      ["win:form", "descriptor", QUESTION.text],
      ["win:form", "candidate", OPTIONS[0]!.label],
      ["win:form", "candidate", OPTIONS[1]!.label],
    ]);
    expect(req.charged).toEqual({ "win:form": QUESTION.text.length + OPTIONS[0]!.label.length + OPTIONS[1]!.label.length });
  });

  test("none, low confidence and unknown keys abstain", async () => {
    expect(await call(fakeJev("none", 0.99))).toBeNull();
    expect(await call(fakeJev("1", 0.74))).toBeNull();
    expect(await call(fakeJev("1", Number.NaN))).toBeNull();
    expect(await call(fakeJev("3", 0.99))).toBeNull();
    expect(await call(fakeJev("01", 0.99))).toBeNull();
    expect(await call(fakeJev("o:tue", 0.99))).toBeNull();
  });

  test("an abort stops waiting on a request that hangs", async () => {
    const ac = new AbortController();
    const pending = call(() => new Promise(() => {}), ac.signal);
    ac.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("deadline");
  });
});
