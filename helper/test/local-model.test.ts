// The client for apps/local-model (writer/local-model.ts) against a fake tool: a node child that speaks the same
// line protocol. The real tool's side of the framing is tested in apps/local-model/Tests/LocalModelCoreTests.
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LocalModelError, startLocalModel, type LocalModelTool } from "../src/writer/local-model.ts";
import { toolLocalModel } from "../src/writer/local-port.ts";
import { draftAsk } from "../src/writer/local-draft.ts";

const MEM = { residentMB: 1, footprintMB: 1, peakFootprintMB: 1, peakResidentMB: 1 };
/** The fake: Ready (or not), then for each line a completion whose text is the raw line it read, or what `prompt` asks. */
const FAKE = `
const mode = process.env.MODE;
const mem = ${JSON.stringify(MEM)};
if (mode === "notready") { process.stdout.write(JSON.stringify({ ready: false, error: "no model file at /x.gguf" }) + "\\n"); process.exit(2); }
if (mode === "garbage") { process.stdout.write("hello\\n"); }
else process.stdout.write(JSON.stringify({ ready: true, model: "m.gguf", loadMs: 5, nCtx: 4096, memory: mem }) + "\\n");
let buf = "";
process.stdin.on("data", (b) => {
  buf += b.toString("utf8");
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const r = JSON.parse(line);
    if (r.prompt === "die") { process.stderr.write("boom: out of memory\\n"); process.exit(3); }
    if (r.prompt.startsWith("echo")) { process.stderr.write("could not decode: " + r.prompt + "\\n"); process.exit(4); }
    if (r.prompt === "fail") { process.stdout.write(JSON.stringify({ id: r.id, ok: false, error: "grammar does not parse" }) + "\\n"); continue; }
    if (r.prompt.startsWith("refuse")) { process.stdout.write(JSON.stringify({ id: r.id, ok: false, error: "cannot use " + r.prompt }) + "\\n"); continue; }
    const id = r.prompt === "wrong id" ? "zzz" : r.id;
    const out = { id, ok: true, text: line, stop: "eog", prefixTokens: 1, prefixCached: false, promptTokens: 1, outputTokens: 1, ms: { prefix: 0, prompt: 0, decode: 0, total: 0 }, memory: mem };
    // Two answers in one write, split across writes, to exercise the reader.
    const s = JSON.stringify(out) + "\\n";
    process.stdout.write(s.slice(0, 7)); setTimeout(() => process.stdout.write(s.slice(7)), 5);
  }
});
process.stdin.on("end", () => process.exit(0));
`;
const start = (mode: string): Promise<LocalModelTool> =>
  startLocalModel({ binary: "unused", modelPath: "unused", spawnFn: () => spawn(process.execPath, ["-e", FAKE], { env: { ...process.env, MODE: mode }, stdio: ["pipe", "pipe", "pipe"] }), loadTimeoutMs: 5000 });
const req = (prompt: string) => ({ prefix: "P\nwith a newline", prompt, grammar: 'root ::= "x"', maxTokens: 8 });
const errOf = async (p: Promise<unknown>): Promise<string> => p.then(() => "resolved", (e: unknown) => (e instanceof LocalModelError ? e.message : `not a LocalModelError: ${String(e)}`));

describe("startLocalModel", () => {
  it("sends each request as one JSON line and pairs answers in order, even when they arrive in pieces", async () => {
    const port = await start("ok");
    expect(port.model).toBe("m.gguf");
    const [a, b] = await Promise.all([port.complete(req("first\nline")), port.complete(req("second"))]);
    expect(a.id).toBe("r1");
    expect(b.id).toBe("r2");
    // The fake echoes the raw line it read: one line, and exactly the request.
    expect(a.text.includes("\n")).toBe(false);
    expect(JSON.parse(a.text)).toEqual({ id: "r1", ...req("first\nline") });
    expect(JSON.parse(b.text)).toEqual({ id: "r2", ...req("second") });
    expect(await port.close()).toBe(0);
  });

  it("rejects only the request the tool refused, and keeps serving", async () => {
    const port = await start("ok");
    expect(await errOf(port.complete(req("fail")))).toBe("the local model refused the request (request r1)");
    expect((await port.complete(req("after"))).id).toBe("r2");
    await port.close();
  });

  it("refuses an answer to a request it did not send next", async () => {
    const port = await start("ok");
    expect(await errOf(port.complete(req("wrong id")))).toBe("the local model broke its protocol (request r1: answered out of turn)");
    await port.close();
  });

  it("says why the model did not load", async () => {
    expect(await errOf(start("notready"))).toBe("the local model's file could not be loaded (loading)");
  });

  it("refuses a first line that is not Ready", async () => {
    expect(await errOf(start("garbage"))).toBe("the local model broke its protocol (a line that is not JSON, 5 chars)");
  });

  it("rejects the waiting request and every later one when the tool dies, with its exit status and what it means", async () => {
    const port = await start("ok");
    expect(await errOf(port.complete(req("die")))).toBe("the local model ran out of memory (exit code 3)");
    expect(await errOf(port.complete(req("later")))).toBe("the local model ran out of memory (exit code 3)");
    // The stderr tail stays in memory, for a debugger.
    expect(port.stderrForDebugger()).toContain("out of memory");
  });

  it("never carries a prompt the tool echoes, to stderr or in an error line, into a thrown error or a warning", async () => {
    const fragment = "Dana's staging rotation note";
    const refusing = await start("ok");
    const refused = await refusing.complete(req(`refuse ${fragment}`)).catch((e: unknown) => e);
    expect(String(refused)).not.toContain(fragment);
    await refusing.close();
    const port = await start("ok");
    const e = await port.complete(req(`echo ${fragment}`)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(LocalModelError);
    expect(String(e)).not.toContain(fragment);
    expect(JSON.stringify(e)).not.toContain(fragment);
    expect(port.stderrForDebugger()).toContain(fragment);
    // The port the helper drafts through (writer/local-port.ts) wraps it; the helper warns with that message.
    const wrapped = await toolLocalModel(port).complete(draftAsk(`echo ${fragment}`, { name: "Notes", placeholder: null }, [], Date.now())).catch((x: unknown) => x);
    expect(String(wrapped)).toMatch(/caret-local-model: the local model stopped \(exit code 4\)/u);
    expect(String(wrapped)).not.toContain(fragment);
  });

  it("does not send a request whose signal already aborted", async () => {
    const port = await start("ok");
    const c = new AbortController();
    c.abort();
    await expect(port.complete(req("x"), c.signal)).rejects.toThrow();
    expect((await port.complete(req("next"))).id).toBe("r2");
    await port.close();
  });
});
