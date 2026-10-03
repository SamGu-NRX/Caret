// memoryRequest op `add` (B17): the host's onboarding sends the name and email the user types, and the
// helper keeps each as a sealed About entry. fixtures/golden/memory.ndjson is the host's contract
// (apps/caret/Tests/CaretHostCoreTests/Fixtures/memory.ndjson on v2/host), copied byte for byte; these
// tests hold the helper's schema and answers to it.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { MemoryReply, MemoryRequest, PROTOCOL_VERSION, type MemoryEntry } from "../src/protocol.ts";

const GOLDEN = fileURLToPath(new URL("../fixtures/golden/memory.ndjson", import.meta.url));
const lines = readFileSync(GOLDEN, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
const line = (requestId: string, type: "memoryRequest" | "memoryReply"): Record<string, unknown> => {
  const l = lines.find((x) => x.requestId === requestId && x.type === type);
  if (l === undefined) throw new Error(`the golden file has no ${type} ${requestId}`);
  return l;
};

describe("the host's memory contract, line by line", () => {
  it("parses every request losslessly", () => {
    for (const l of lines.filter((x) => x.type === "memoryRequest")) expect(MemoryRequest.parse(l)).toEqual(l);
  });

  it("parses every reply losslessly, the list's permission uses and ops included", () => {
    for (const id of ["host-memory-1", "host-memory-2", "host-memory-3", "host-memory-4", "host-memory-5"]) {
      const l = line(id, "memoryReply");
      expect(MemoryReply.parse(l), id).toEqual(l);
    }
  });
});

describe("memoryRequest add", () => {
  let dir: string;
  let store: Store;
  let helper: Helper;
  const ask = (op: string, rest: Record<string, unknown> = {}): MemoryReply =>
    MemoryReply.parse(helper.handleMemory(MemoryRequest.parse({ type: "memoryRequest", v: PROTOCOL_VERSION, requestId: `r-${op}`, op, ...rest })));
  const add = (fields: Record<string, unknown>, rest: Record<string, unknown> = {}): MemoryReply => ask("add", { kind: "about", fields, ...rest });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "caret-memory-add-"));
    store = new Store(dir);
    helper = new Helper({ store, askJev: null, shadow: false, allowBackgroundFocus: false, publish: () => undefined });
  });
  afterEach(() => {
    helper.shutdown();
    helper.memory.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers the host's add line with its reply line, apart from the new id and the time", () => {
    const req = line("host-memory-3", "memoryRequest");
    const want = line("host-memory-3", "memoryReply") as { entries: MemoryEntry[] };
    const got = MemoryReply.parse(helper.handleMemory(MemoryRequest.parse(req)));
    const e = got.entries[0] as MemoryEntry;
    expect(e.id).toMatch(/^about-[0-9a-f]{8}$/);
    expect({ ...got, entries: [{ ...e, id: "x", evidence: { ...e.evidence, lastSeen: 0 } }] }).toEqual({
      ...want,
      entries: want.entries.map((w) => ({ ...w, id: "x", evidence: { ...w.evidence, lastSeen: 0 } })),
    });
    expect(e.says).toBe("Name: Dana Whitfield (you typed this)");
  });

  it("names add among its ops on a list reply, as the host's list line does, and on no other reply", () => {
    const hostOps = (line("host-memory-1", "memoryReply") as { ops: string[] }).ops;
    const listed = ask("list");
    expect(new Set(listed.ops)).toEqual(new Set(hostOps));
    expect(add({ label: "Name", value: "Dana Whitfield", source: "typed" }).ops).toBeUndefined();
  });

  it("keeps the value sealed: no row holds the typed text in the clear", () => {
    add({ label: "Email", value: "dana.whitfield@example.com", source: "typed" });
    const raw = JSON.stringify(helper.memory.rawRows(), (_k, v: unknown) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v));
    expect(raw).not.toContain("dana.whitfield");
    expect(raw).not.toContain("Email");
  });

  it("replaces the entry with the same label, whatever its case, instead of adding a second", () => {
    const first = add({ label: "Name", value: "Dana Whitfield", source: "typed" }).entries[0] as MemoryEntry;
    const again = add({ label: " name ", value: "Dana W. Whitfield", source: "typed" }).entries[0] as MemoryEntry;
    expect(again.id).toBe(first.id);
    expect(again.fields).toEqual({ label: "name", value: "Dana W. Whitfield", source: "typed" });
    expect(again.evidence.count).toBe(2);
    expect(ask("list", { kind: "about" }).entries).toHaveLength(1);
  });

  it("finds a renamed typed entry by its new label", () => {
    const e = add({ label: "Email", value: "dana@example.com", source: "typed" }).entries[0] as MemoryEntry;
    ask("edit", { id: e.id, fields: { label: "Work email" } });
    const again = add({ label: "Work email", value: "dana@lumen.example", source: "typed" }).entries[0] as MemoryEntry;
    expect(again.id).toBe(e.id);
    expect(add({ label: "Email", value: "dana@home.example", source: "typed" }).entries[0]?.id).not.toBe(e.id);
  });

  it("refuses what is not a typed About entry, saying what was wrong, and stores nothing", () => {
    const refusals: [Record<string, unknown>, Record<string, unknown>, RegExp][] = [
      [{ label: "Name", value: "Dana", source: "typed" }, { id: "about-1" }, /takes no id/],
      [{ alias: "Dana", name: "Dana Reyes" }, { kind: "people" }, /About entries you typed, not people/],
      [{ label: "Name", value: "Dana", source: "typed" }, { kind: undefined }, /without a kind/],
      [{ label: "Name", value: "Dana", source: "contacts" }, {}, /source/],
      [{ label: "Name", value: "Dana" }, {}, /source/],
      [{ label: "Name", value: "Dana", source: "typed", color: "red" }, {}, /color/],
      [{ label: "Name", value: "   ", source: "typed" }, {}, /Name is blank/],
      [{ label: " ", value: "Dana", source: "typed" }, {}, /label is blank/],
      [{ label: "Name", value: "Dana\nWhitfield", source: "typed" }, {}, /one line/],
      [{ label: "Name", value: "Dana Whitfield", source: "typed" }, {}, /one line/],
      [{ label: "Email", value: "dana at example dot com", source: "typed" }, {}, /one email address/],
      [{ label: "Work e-mail", value: "dana@example", source: "typed" }, {}, /one email address/],
      [{ label: "Name", value: "x".repeat(501), source: "typed" }, {}, /value/],
    ];
    for (const [fields, rest, why] of refusals) {
      const r = add(fields, rest);
      expect(r.error, JSON.stringify(fields)).toMatch(why);
      expect(r.entries).toEqual([]);
    }
    expect(ask("add", { kind: "about" }).error).toMatch(/needs fields/);
    expect(ask("list", { kind: "about" }).entries).toEqual([]);
  });

  it("refuses to rename a typed entry onto a label another typed entry has (review B17 #5)", () => {
    const email = add({ label: "Email", value: "dana@example.com", source: "typed" }).entries[0] as MemoryEntry;
    add({ label: "Work email", value: "dana@lumen.example", source: "typed" });
    expect(ask("edit", { id: email.id, fields: { label: " work email" } }).error).toMatch(/already told Caret your work email/);
    expect(ask("list", { kind: "about" }).entries.map((e) => (e.kind === "about" ? e.fields.label : "")).sort()).toEqual(["Email", "Work email"]);
    // Renaming to its own label, in another case, is fine.
    expect(ask("edit", { id: email.id, fields: { label: "EMAIL" } }).error).toBeNull();
  });

  it("holds an edit of a typed entry to the same rules", () => {
    const e = add({ label: "Email", value: "dana@example.com", source: "typed" }).entries[0] as MemoryEntry;
    expect(ask("edit", { id: e.id, fields: { value: "not an address" } }).error).toMatch(/invalid edit: Email must be one email address/);
    expect(ask("edit", { id: e.id, fields: { value: "  dana@lumen.example " } }).entries[0]?.fields).toMatchObject({ value: "dana@lumen.example" });
  });

  it("forgets a typed entry like any other", () => {
    const e = add({ label: "Name", value: "Dana Whitfield", source: "typed" }).entries[0] as MemoryEntry;
    expect(ask("forget", { id: e.id }).error).toBeNull();
    expect(ask("list", { kind: "about" }).entries).toEqual([]);
  });
});
