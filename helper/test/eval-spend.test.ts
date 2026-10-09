import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AskJev } from "../src/fill/jev.ts";
const fake = vi.hoisted(() => ({ ask: vi.fn(), propose: vi.fn(), config: vi.fn(), usd: 0, ledger: false }));
vi.mock("../src/engines/decide/harness.ts", () => ({ harnessEngine: (o: unknown) => {
  fake.config(o);
  return { ask: fake.ask, engine: { name: "decisions", model: "gpt-6-luna" }, says: "engine decisions (gpt-6-luna)",
    ...(fake.ledger ? { decisionsSpend: { run: () => ({ usd: fake.usd }) } } : {}) };
} }));
vi.mock("../src/fill/fill.ts", async (original) => ({ ...await original<typeof import("../src/fill/fill.ts")>(), proposeFill: fake.propose }));
let dir: string;
let argv: string[];
beforeEach(async () => {
  vi.resetModules(); fake.ask.mockReset(); fake.propose.mockReset(); fake.config.mockClear(); fake.ledger = false; fake.usd = 0;
  dir = mkdtempSync(join(tmpdir(), "caret-eval-spend-")); argv = process.argv;
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  const { minted } = await import("./minted.ts");
  const req = minted({ state: { synthetic: "blue" }, questions: { q: { type: "choice", instructions: "Pick", criteria: { a: "blue", none: null } } }, snippets: [], charged: {} });
  fake.propose.mockImplementation(async (_model: unknown, ask: AskJev) => {
    const r = await ask(req);
    return { fields: [], candidates: 0, jev: r };
  });
});
afterEach(() => { process.argv = argv; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

it.each(["about", "realfill", "scope"])("%s passes its CLI ceiling to the ledger and counts full unknown-usage reservations", async (script) => {
  fake.ledger = true;
  const { DecisionsAttemptError } = await import("../src/engines/decide/decisions.ts");
  fake.ask.mockImplementation(async () => {
    fake.usd += 0.04;
    throw new DecisionsAttemptError(new Error("synthetic timeout"), { latencyMs: 1, inputTokens: null, costUsd: null, refused: false }, []);
  });
  if (script === "about") {
    const forms = join(dir, "forms.json");
    writeFileSync(forms, JSON.stringify([1, 2].map((id) => ({ id: `f${id}`, app: "fixture", title: "Form", open: "none", fields: [{ label: "Your name", section: null, expect: "name" }] }))));
    process.argv = [argv[0]!, "about-fill-eval.ts", "--forms", forms, "--out", dir, "--engine", "decisions", "--max-usd", "0.03"];
    await import("../scripts/about-fill-eval.ts");
    expect(JSON.parse(readFileSync(join(dir, "about-fill-eval.json"), "utf8")).cost).toBe(0.04);
    expect(fake.ask).toHaveBeenCalledOnce();
  } else if (script === "realfill") {
    process.argv = [argv[0]!, "realfill-eval.ts", "--out", dir, "--engine", "decisions", "--forms", "httpbin-pizza,greenhouse-apply", "--spend-limit", "0.03"];
    await import("../scripts/realfill-eval.ts");
    expect(JSON.parse(readFileSync(join(dir, "realfill-eval.json"), "utf8")).spent).toBe(0.04);
    expect(fake.ask).toHaveBeenCalledOnce();
  } else {
    process.argv = [argv[0]!, "ask-scope-eval.ts", "--out", dir, "--engine", "decisions", "--spend-limit", "0.03"];
    await expect(import("../scripts/ask-scope-eval.ts")).rejects.toThrow("synthetic timeout");
  }
  expect(fake.config.mock.calls[0]![0].decisionsMaxUsd).toBe(0.03);
});
it.each(["about", "realfill"])("%s counts a billed failure and stops later dispatches at its budget", async (script) => {
  const { DecisionsAttemptError } = await import("../src/engines/decide/decisions.ts");
  fake.ask.mockRejectedValue(new DecisionsAttemptError(new Error("synthetic refusal"), { latencyMs: 1, inputTokens: 10, costUsd: 0.04, refused: true }, []));
  if (script === "about") {
    const forms = join(dir, "forms.json");
    writeFileSync(forms, JSON.stringify([1, 2].map((id) => ({ id: `f${id}`, app: "fixture", title: "Form", open: "none", fields: [{ label: "Your name", section: null, expect: "name" }] }))));
    process.argv = [argv[0]!, "about-fill-eval.ts", "--forms", forms, "--out", dir, "--engine", "decisions", "--max-usd", "0.03"];
    await import("../scripts/about-fill-eval.ts");
  } else {
    process.argv = [argv[0]!, "realfill-eval.ts", "--out", dir, "--engine", "decisions", "--forms", "httpbin-pizza,greenhouse-apply", "--spend-limit", "0.03"];
    await import("../scripts/realfill-eval.ts");
  }
  expect(fake.ask).toHaveBeenCalledOnce();
  const report = JSON.parse(readFileSync(join(dir, `${script === "about" ? "about-fill" : "realfill"}-eval.json`), "utf8"));
  expect(script === "about" ? report.cost : report.spent).toBe(0.04);
});
it.each([0.02, 0, null, "ordinary"] as const)("counts success once and adds only documented failed usage: %s", async (failedCost) => {
  const { DecisionsAttemptError } = await import("../src/engines/decide/decisions.ts");
  fake.ask.mockResolvedValueOnce({ model: "gpt-6-luna", answers: {}, latencyMs: 1, inputTokens: 10, costUsd: 0.01 });
  fake.ask.mockRejectedValueOnce(failedCost === "ordinary" ? new Error("synthetic failure") : new DecisionsAttemptError(new Error("synthetic invalid response"), { latencyMs: 1, inputTokens: null, costUsd: failedCost, refused: false }, []));
  process.argv = [argv[0]!, "realfill-eval.ts", "--out", dir, "--engine", "decisions", "--forms", "httpbin-pizza,greenhouse-apply"];
  await import("../scripts/realfill-eval.ts");
  const report = JSON.parse(readFileSync(join(dir, "realfill-eval.json"), "utf8"));
  expect(report.spent).toBeCloseTo(0.01 + (typeof failedCost === "number" ? failedCost : 0), 10);
  expect(fake.ask).toHaveBeenCalledTimes(2);
});
it("Ask evaluation rewrites scored samples when the same output directory is rerun", async () => {
  fake.ask.mockImplementation(async (req) => ({ model: "gpt-6-luna", answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, { choice: Object.keys((q as { criteria: object }).criteria)[0], confidence: 1 }])), probabilities: Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, Object.fromEntries(Object.keys((q as { criteria: object }).criteria).map((option, i) => [option, i === 0 ? 1 : 0]))])), latencyMs: 0, inputTokens: 0, costUsd: 0 }));
  process.argv = [argv[0]!, "realfill-asks.ts", "--out", dir, "--engine", "decisions", "--maker", "jev", "--asks", "ask-01", "--max-usd", "0.1", "--gap", "0"];
  await import("../scripts/realfill-asks.ts");
  const first = readFileSync(join(dir, "scored.ndjson"), "utf8");
  expect(first.trim().split("\n").length).toBeGreaterThan(0);
  vi.resetModules();
  await import("../scripts/realfill-asks.ts");
  expect(readFileSync(join(dir, "scored.ndjson"), "utf8")).toBe(first);
  fake.ask.mockRejectedValue(new Error("synthetic failure"));
  vi.resetModules();
  await import("../scripts/realfill-asks.ts");
  expect(readFileSync(join(dir, "scored.ndjson"), "utf8")).toBe("");
});
it("Ask evaluation counts billed failures before the next Ask's budget check", async () => {
  const { DecisionsAttemptError } = await import("../src/engines/decide/decisions.ts");
  fake.ask.mockRejectedValue(new DecisionsAttemptError(new Error("synthetic refusal"), { latencyMs: 1, inputTokens: 10, costUsd: 0.04, refused: true }, []));
  process.argv = [argv[0]!, "realfill-asks.ts", "--out", dir, "--engine", "decisions", "--maker", "jev", "--asks", "ask-01,ask-02", "--spend-limit", "0.03", "--max-usd", "0.1", "--gap", "0"];
  await import("../scripts/realfill-asks.ts");
  // The maker sends two sibling requests before either settles; the next Ask must dispatch none.
  expect(fake.ask).toHaveBeenCalledTimes(2);
  const report = JSON.parse(readFileSync(join(dir, "realfill-asks.json"), "utf8"));
  expect(report.jevSpent).toBe(0.08);
  expect(report.requestErrors.filter((e: { ask: string }) => e.ask === "ask-02").every((e: { kind: string }) => e.kind === "Error")).toBe(true);
});
