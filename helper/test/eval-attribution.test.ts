import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ ask: vi.fn(), propose: vi.fn() }));
vi.mock("../src/engines/decide/harness.ts", () => ({ harnessEngine: () => ({
  ask: fake.ask, engine: { name: "decisions", model: "gpt-6-luna" },
  says: "engine decisions (gpt-6-luna), cache off",
}) }));
vi.mock("../src/fill/fill.ts", async (original) => ({ ...await original<typeof import("../src/fill/fill.ts")>(), proposeFill: fake.propose }));
let dir: string;
let argv: string[];
beforeEach(() => {
  vi.resetModules(); fake.propose.mockReset(); fake.ask.mockReset();
  dir = mkdtempSync(join(tmpdir(), "caret-eval-attribution-")); argv = process.argv;
  vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
  fake.propose.mockResolvedValue({ fields: [], candidates: 0, jev: { inputTokens: 0, latencyMs: 0, costUsd: 0 } });
});
afterEach(() => { process.argv = argv; vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
it("attributes About JSON and Markdown to the selected engine, not the default oracle", async () => {
  const forms = join(dir, "forms.json");
  writeFileSync(forms, JSON.stringify([{ id: "synthetic", app: "fixture", title: "Form", open: "none", fields: [{ label: "Your name", section: null, expect: "name" }] }]));
  process.argv = [argv[0]!, "about-fill-eval.ts", "--forms", forms, "--out", dir, "--engine", "decisions"];
  await import("../scripts/about-fill-eval.ts");
  const report = JSON.parse(readFileSync(join(dir, "about-fill-eval.json"), "utf8"));
  expect(report.engine).toBe("engine decisions (gpt-6-luna), cache off");
  expect(report.jev).not.toBe("oracle");
  const md = readFileSync(join(dir, "about-fill-eval.md"), "utf8");
  expect(md).toContain(report.engine);
  expect(md).not.toContain("scripted");
  expect(md).not.toContain("Jev oracle");
});
it("attributes real-form JSON and Markdown to the selected engine", async () => {
  process.argv = [argv[0]!, "realfill-eval.ts", "--out", dir, "--engine", "decisions", "--forms", "b01"];
  await import("../scripts/realfill-eval.ts");
  const report = JSON.parse(readFileSync(join(dir, "realfill-eval.json"), "utf8"));
  expect(report.engine).toBe("engine decisions (gpt-6-luna), cache off");
  expect(readFileSync(join(dir, "realfill-eval.md"), "utf8")).toContain(report.engine);
});
