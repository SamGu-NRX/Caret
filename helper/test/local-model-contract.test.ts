import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { AnswerLine, LoadLine, LocalModelError, startLocalModel, type LocalModelTool } from "../src/writer/local-model.ts";
import { examples, request, ready } from "./local-model-contract-examples.ts";

const directory = new URL("../fixtures/contracts/local-model/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, directory), "utf8")) as Record<string, unknown>;
const responses = Object.keys(examples).filter((s) => s !== "request");
const lineSchemas = [...LoadLine.options, ...AnswerLine.options];

// This fixture process captures exactly what the helper writes and serves shared Swift response examples.
// No model, network, app, or hardware is involved.
function start(head: unknown, body: unknown, observe?: (child: ChildProcess) => void): Promise<LocalModelTool> {
  const script = `
    process.stdout.write(JSON.stringify(${JSON.stringify(head)}) + "\\n");
    require("node:readline").createInterface({input: process.stdin}).on("line", line => {
      process.stdout.write(JSON.stringify(${JSON.stringify(body)}) + "\\n");
    }).on("close", () => process.exit(0));
  `;
  let child: ReturnType<typeof spawn>;
  return startLocalModel({ binary: "fixture-only", modelPath: "fixture-only", spawnFn: () => {
    child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    observe?.(child);
    return child;
  }, loadTimeoutMs: 5000 }).catch((error: unknown) => {
    // A rejected startup has no LocalModelTool to close; terminate only this test's fixture child.
    child!.kill();
    throw error;
  });
}

describe("helper/Swift local-model wire contract", () => {
  it("has exactly the request and a fixture for every line production parses", () => {
    expect(readdirSync(directory).filter((s) => s.endsWith(".json")).sort()).toEqual(Object.keys(examples).map((s) => `${s}.json`).sort());
    const covered = responses.map((name) => lineSchemas.findIndex((schema) => schema.safeParse(fixture(name)).success));
    expect([...new Set(covered)].sort()).toEqual(lineSchemas.map((_, i) => i));
  });
  it.each(responses)("%s parses whole with the schema production reads it with", (name) => {
    const schema = "ready" in fixture(name) ? LoadLine : AnswerLine;
    expect(schema.parse(fixture(name))).toEqual(fixture(name));
  });
  it.each(Object.entries(examples))("serializes its own %s example to the shared fixture", (name, value) => {
    expect(JSON.parse(JSON.stringify(value))).toEqual(fixture(name));
  });
  it("serializes the shared request through the real client and parses Ready and Completion", async () => {
    let writeSpy: MockInstance | undefined;
    const tool = await start(fixture("ready"), fixture("completion"), (child) => { writeSpy = vi.spyOn(child.stdin!, "write"); });
    try {
      expect({ model: tool.model, loadMs: tool.loadMs, memory: tool.memoryAtLoad }).toEqual({ model: ready.model, loadMs: ready.loadMs, memory: ready.memory });
      const result = await tool.complete(request);
      expect(result).toEqual(fixture("completion"));
      expect(writeSpy).toHaveBeenCalledWith(JSON.stringify(fixture("request")) + "\n");
    } finally { writeSpy?.mockRestore(); expect(await tool.close()).toBe(0); }
  });
  it("parses NotReady through the real startup parser", async () => {
    await expect(start(fixture("notReady"), null)).rejects.toMatchObject({ failure: "modelMissing" } satisfies Partial<LocalModelError>);
  });
  it.each(["failure", "failure-null"])("parses %s through the real completion parser", async (name) => {
    const tool = await start(fixture("ready"), fixture(name));
    try { await expect(tool.complete(request)).rejects.toMatchObject({ failure: "refused" }); }
    finally { expect(await tool.close()).toBe(0); }
  });
  it("rejects renamed response fields rather than accepting a second test schema", async () => {
    const broken = { ...fixture("completion"), textBroken: "fixture" };
    delete (broken as Record<string, unknown>).text;
    const tool = await start(fixture("ready"), broken);
    try { await expect(tool.complete(request)).rejects.toMatchObject({ failure: "protocol" }); }
    finally { expect(await tool.close()).toBe(0); }
  });
});
