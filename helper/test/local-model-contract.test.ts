import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { LOCAL_MODEL_RESPONSES, LocalModelError, startLocalModel, type LocalModelTool } from "../src/writer/local-model.ts";
import { examples, request, ready } from "./local-model-contract-examples.ts";

const root = new URL("../../", import.meta.url);
const directory = new URL("helper/fixtures/contracts/local-model/", root);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const responses = Object.entries(LOCAL_MODEL_RESPONSES).map(([type, schema]) => ({ type, schema, fixture: type[0]!.toLowerCase() + type.slice(1) }));
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, directory), "utf8")) as Record<string, unknown>;

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

function structBody(source: string, name: string): string {
  const start = source.indexOf(`public struct ${name}:`);
  expect(start, `missing Swift struct ${name}`).toBeGreaterThanOrEqual(0);
  const opening = source.indexOf("{", start);
  let depth = 1, end = opening + 1;
  while (depth > 0 && end < source.length) {
    if (source[end] === "{") depth++;
    if (source[end] === "}") depth--;
    end++;
  }
  return source.slice(opening + 1, end - 1);
}

describe("helper/Swift local-model wire contract", () => {
  it("has exactly the request and every production response schema, with shared variants", () => {
    expect(readdirSync(directory).filter((s) => s.endsWith(".json")).sort()).toEqual(Object.keys(examples).map((s) => `${s}.json`).sort());
    const variants = Object.keys(examples).filter((s) => s !== "request").map((s) => s.split("-")[0]);
    expect([...new Set(variants)].sort()).toEqual(responses.map((r) => r.fixture).sort());
  });
  it.each(Object.keys(examples).filter((s) => s !== "request"))("%s parses with the helper's response schema", (name) => {
    const { schema } = responses.find((r) => r.fixture === name.split("-")[0])!;
    expect(schema.safeParse(fixture(name)).error?.issues ?? []).toEqual([]);
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
  it("pins Swift request keys and response encoding fields to the fixtures", () => {
    const swift = read("apps/local-model/Sources/LocalModelCore/Wire.swift");
    const requestBody = structBody(swift, "Request");
    const keys = requestBody.match(/static let keys: Set<String> = \[([^\]]+)\]/)?.[1];
    expect(keys).toBeDefined();
    const quoted = (s: string) => [...s.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(quoted(keys!).sort()).toEqual(Object.keys(fixture("request")).sort());
    for (const key of [...swift.matchAll(/o\["([^"]+)"\]/g)].map((m) => m[1]!)) expect(fixture("request"), `Swift request read ${key}`).toHaveProperty(key);
    for (const { type, fixture: name } of responses) {
      const body = structBody(swift, type);
      const coding = body.match(/private enum CodingKeys: String, CodingKey \{ case ([^}]+)\}/)?.[1];
      expect(coding, `missing Swift coding keys for ${type}`).toBeDefined();
      const f = fixture(name);
      expect(coding!.split(",").map((s) => s.trim()).sort()).toEqual(Object.keys(f).sort());
      for (const key of [...body.matchAll(/public let (\w+)(?::| =)/g)].map((m) => m[1]!)) expect(f, `${type}.${key}`).toHaveProperty(key);
    }
    for (const [name, value] of [["MemoryUse", fixture("completion").memory], ["Timing", fixture("completion").ms]] as const) {
      const fields = [...structBody(swift, name).matchAll(/public let (\w+):/g)].map((m) => m[1]!);
      expect(fields.sort()).toEqual(Object.keys(value as Record<string, unknown>).sort());
    }
  });
  it("rejects renamed response fields rather than accepting a second test schema", async () => {
    const broken = { ...fixture("completion"), textBroken: "fixture" };
    delete (broken as Record<string, unknown>).text;
    const tool = await start(fixture("ready"), broken);
    try { await expect(tool.complete(request)).rejects.toMatchObject({ failure: "protocol" }); }
    finally { expect(await tool.close()).toBe(0); }
  });
});
