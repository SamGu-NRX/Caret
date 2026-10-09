import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScreenModel } from "../src/model.ts";
import type { FillProposal, Snapshot } from "../src/protocol.ts";

const fake = vi.hoisted(() => ({ propose: vi.fn(), ask: vi.fn(), close: vi.fn() }));
vi.mock("../src/fill/fill.ts", () => ({ proposeFill: fake.propose }));
vi.mock("../src/engines/decide/harness.ts", () => ({ harnessEngine: () => ({
  ask: fake.ask, engine: { name: "decisions", model: "gpt-6-luna", close: fake.close },
  says: "engine decisions (gpt-6-luna), cache off",
}) }));
let dir: string;
let argv: string[];
const snapshot = (id: string, at: number, root: string | null = null): Snapshot => ({
  type: "snapshot", v: 1, seq: at, at, reason: "focus", app: { pid: 9100, name: "caret-fixture", bundleId: "" },
  window: { windowId: id, title: id, kind: "standard", frame: [0, 0, 100, 100] },
  focused: true, focusedKey: "field", root,
  nodes: [{ key: "field", parent: null, role: "AXTextField", editable: true, value: root === null ? "" : "updated", frame: [0, 0, 20, 20] }],
  values: [], stats: { walkMs: 0, visited: 1, truncated: false },
});
const proposal = (id: string): FillProposal => ({
  type: "fillProposal", v: 1, id: "fake", pid: 9100, bundleId: "", windowId: id, at: 1, triggerKey: "field", fields: [],
  candidates: 0, cutoff: 0.8, jev: { model: "gpt-6-luna", latencyMs: 0, inputTokens: 0, costUsd: 0 },
} as FillProposal);
beforeEach(() => {
  vi.resetModules(); fake.propose.mockReset(); fake.close.mockClear();
  dir = mkdtempSync(join(tmpdir(), "caret-fill-eval-")); argv = process.argv;
  writeFileSync(join(dir, "gold.json"), JSON.stringify({ pid: 9100, forms: ["form", "other"].map((window) => ({ window, fields: [{ label: "Name", gold: null, frame: [0, 0, 20, 20] }] })) }));
  writeFileSync(join(dir, "record.ndjson"), [snapshot("source", 1), snapshot("form", 2), snapshot("other", 3), snapshot("source", 4, "field"), snapshot("form", 5, "field")].map((s) => JSON.stringify(s)).join("\n"));
  process.argv = [argv[0]!, "fill-eval.ts", "--gold", join(dir, "gold.json"), "--record", join(dir, "record.ndjson"), "--out", dir, "--engine", "decisions", "--rounds", "1"];
  fake.propose.mockImplementation(async (_model: ScreenModel, _ask: unknown, id: string) => proposal(id));
});
afterEach(() => { process.argv = argv; rmSync(dir, { recursive: true, force: true }); });
it("replays partial values and focus visits in event order, using the last event time", async () => {
  await import("../scripts/fill-eval.ts");
  const [model, , , , now] = fake.propose.mock.calls[0]! as [ScreenModel, unknown, string, string, number];
  expect(model.windows.get("source")?.nodes.get("field")?.value).toBe("updated");
  expect(model.windows.get("form")?.nodes.get("field")?.value).toBe("updated");
  expect(model.windowBefore("form")).toBe("source");
  expect(now).toBe(6);
  expect(fake.close).toHaveBeenCalledOnce();
});
it("attributes fixture reports to Decisions rather than live Jev", async () => {
  await import("../scripts/fill-eval.ts");
  const report = JSON.parse(readFileSync(join(dir, "fill-eval.json"), "utf8"));
  expect(report.engine).toBe("engine decisions (gpt-6-luna), cache off");
  const md = readFileSync(join(dir, "fill-eval.md"), "utf8");
  expect(md).toContain(report.engine);
  expect(md).not.toContain("live Jev");
});
it("records a failed form and continues to write a partial report", async () => {
  fake.propose.mockRejectedValueOnce(new Error("synthetic refusal"));
  await import("../scripts/fill-eval.ts");
  expect(fake.propose).toHaveBeenCalledTimes(2);
  expect(fake.close).toHaveBeenCalledOnce();
  const report = JSON.parse(readFileSync(join(dir, "fill-eval.json"), "utf8"));
  expect(report.summary.requests).toBe(1);
  expect(report.requests[0].form).toBe("other");
  expect(report.summary.errors).toEqual(["round 0 form: synthetic refusal"]);
  expect(readFileSync(join(dir, "fill-eval.md"), "utf8")).toContain("round 0 form: synthetic refusal");
});
