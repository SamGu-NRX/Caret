// Brief J1 part A2: the request body Jev receives carries each option that several questions share once, in the state,
// instead of once per question. A fill asks every field about every candidate, so its candidate list was repeated per
// field: 86.5% of the characters of the corpus's fill requests were option descriptions (evidence/screen/j1). The body
// must say exactly what the request says, so expanding it back gives the request's own questions.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expandWireBody, makeJevClient, OPTION_DESCRIPTIONS, wireBody, type JevRequest } from "../src/fill/jev.ts";
import { DailySpend } from "../src/engines/decide/daily-cap.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

afterEach(() => {
  vi.unstubAllGlobals();
});

const plain = (req: JevRequest) => ({ state: req.state, model: "jev-latest", questions: { ...req.questions, ...req.nouls } });

function fill(fields: number, cands: number): JevRequest {
  const criteria: Record<string, string> = {};
  for (let i = 1; i <= cands; i++) criteria[`c${i}`] = `"value ${i}" (in a block that starts 'apartment app'; in TextEdit window 'Rental notes.txt', the window the user just left)`;
  criteria.none = "No candidate is the value this field asks for.";
  const questions: JevRequest["questions"] = {};
  for (let f = 1; f <= fields; f++) questions[`f${f}`] = { type: "choice", instructions: `Label: 'Field ${f}'. Which candidate?`, criteria: { ...criteria } };
  return { state: { destination_window: "Chrome window 'Form'", task: "The user is filling in this form." }, questions, nouls: { n_1: { type: "noul", instructions: "yes?" } }, snippets: [], charged: {} };
}

describe("the body sent to Jev", () => {
  it("says the same as the request: expanding it gives back every question, option and description", () => {
    const req = fill(18, 41);
    const body = wireBody(req);
    expect(expandWireBody(body)).toEqual(plain(req));
  });

  it("carries a shared option's description once, and each question names it with no description of its own", () => {
    const req = fill(18, 41);
    const body = wireBody(req);
    const shared = (body.state as Record<string, Record<string, string>>)[OPTION_DESCRIPTIONS];
    expect(Object.keys(shared ?? {})).toHaveLength(42);
    for (const q of Object.values(body.questions)) if (q.type === "choice") expect(Object.values(q.criteria).every((d) => d === null)).toBe(true);
    // 18 fields x 41 candidates: the body is under a fifth of what it was.
    expect(JSON.stringify(body).length).toBeLessThan(0.2 * JSON.stringify(plain(req)).length);
  });

  it("leaves an option inline when its id has another description, or no description, in some question", () => {
    const req = fill(2, 2);
    (req.questions.f2 as { criteria: Record<string, string | null> }).criteria.c1 = "something else";
    (req.questions.f2 as { criteria: Record<string, string | null> }).criteria.c2 = null;
    const body = wireBody(req);
    const shared = (body.state as Record<string, Record<string, string>>)[OPTION_DESCRIPTIONS] ?? {};
    expect(Object.keys(shared)).toEqual(["none"]);
    expect(expandWireBody(body)).toEqual(plain(req));
  });

  it("is the request unchanged when no option repeats, or the state is not an object", () => {
    const one = { ...fill(1, 5), nouls: undefined };
    expect(wireBody(one)).toEqual(plain(one));
    const text = { ...fill(3, 5), state: "a string state" };
    expect(wireBody(text)).toEqual(plain(text));
  });

  it("refuses a state that already uses the key it would add", () => {
    const req = fill(3, 3);
    req.state = { [OPTION_DESCRIPTIONS]: "taken" };
    expect(() => wireBody(req)).toThrow(OPTION_DESCRIPTIONS);
  });

  it("is what the client posts", async () => {
    const fetch = vi.fn(async (_url: string, init: { body: string }) => {
      expect(JSON.parse(init.body)).toEqual(JSON.parse(JSON.stringify(wireBody(fill(4, 6)))));
      return new Response(JSON.stringify({ model: "m", answers: { f1: { choice: "c1", confidence: 1 }, f2: { choice: "c1", confidence: 1 }, f3: { choice: "c1", confidence: 1 }, f4: { choice: "c1", confidence: 1 }, n_1: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 10 } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);
    await makeJevClient(() => "k", 10_000, new DailySpend({ dir: mkdtempSync(join(tmpdir(), "j1-wire-")), capUsd: 1 }))(fill(4, 6));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("shrinks the corpus's recorded fill requests by more than half", () => {
    // The b2b-demo-request form's four fill requests from the in-process corpus probe (evidence/screen/j1/probe/fill-base.ndjson; synthetic corpus text).
    const rows = readFileSync(join(import.meta.dirname, "..", "fixtures", "j1", "fill-requests.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { body: ReturnType<typeof plain> });
    let before = 0;
    let after = 0;
    for (const { body } of rows) {
      const req: JevRequest = { state: body.state, questions: Object.fromEntries(Object.entries(body.questions).filter(([, q]) => q.type === "choice")) as JevRequest["questions"], snippets: [], charged: {} };
      before += JSON.stringify(plain({ ...req, nouls: undefined })).length;
      after += JSON.stringify(wireBody(req)).length;
    }
    expect(after / before).toBeLessThan(0.5);
  });
});
