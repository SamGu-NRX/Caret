// SC1 section 4, the typed boundary's own guards beside T-P1 (test/sc1-provenance.test.ts):
// T-P2 the types: a raw string does not compile where a request carries text (tsc checks this file; `pnpm test` runs it);
// T-P3 the lint: casts to ModelText, a private Disclosure member, a Basis or a laundering own() appear only under
//      src/privacy/; and no builder is left minting legacy text.
// Then the minting primitives, each with one correct answer.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Basis, Disclosure, UnmintedText, verifySent, verifyWriterInput, type ModelText } from "../src/privacy/disclosure.ts";
import type { ChoiceQuestion, JevRequest } from "../src/fill/jev.ts";
import type { WriterRequest } from "../src/writer/port.ts";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { field, snap, text } from "./builders.ts";

/** T-P2: compiled, never run. Each line under @ts-expect-error must fail to compile, or tsc fails this file. */
export function typeChecks(d: Disclosure, raw: string): void {
  const ok: ChoiceQuestion = { type: "choice", instructions: d.own("Which one?"), criteria: { a: d.own("A"), none: null } };
  // @ts-expect-error a raw string in a request's state
  const state: Pick<JevRequest, "state"> = { state: raw };
  // @ts-expect-error a raw string deep in a request's state
  const nested: Pick<JevRequest, "state"> = { state: { fields: [{ name: raw }] } };
  // @ts-expect-error a raw string as a question's instructions
  const instructions: ChoiceQuestion = { type: "choice", instructions: raw, criteria: {} };
  // @ts-expect-error a raw string as a criterion
  const criteria: ChoiceQuestion = { type: "choice", instructions: d.own("Which one?"), criteria: { a: raw } };
  // @ts-expect-error a raw string in a writer's input
  const input: Pick<WriterRequest, "input"> = { input: { goal: raw } };
  // @ts-expect-error own() takes a literal; a string variable does not compile
  d.own(raw);
  // @ts-expect-error a hole of t must be minted text
  d.t`Field: ${raw}`;
  void [ok, state, nested, instructions, criteria, input];
}

describe("T-P3: the boundary's casts and internals stay under src/privacy/", () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const RULES: [string, RegExp][] = [
    ["a cast to ModelText or ModelValue", /\bas\s+(?:unknown\s+as\s+)?[^;,)\n]*\bModel(?:Text|Value)\b/u],
    ["a private Disclosure member", /\[\s*["'](?:record|mints|reasons|fromView|keptByViews|asTaken|asPlan|asMemory)["']\s*\]/u],
    ["a Basis made by hand", /\bnew\s+Basis\s*\(/u],
    ["own() of a cast value", /\.own\([^)]*\bas\s+(?:never|any|unknown)\b/u],
    ["a legacy minter", /\.legacy\s*\(/u],
  ];
  const violations = (sources: Map<string, string>): string[] =>
    [...sources].flatMap(([file, src]) => (file.startsWith("privacy/") ? [] : RULES.filter(([, re]) => re.test(src)).map(([what]) => `${file}: ${what}`)));
  const sources = (): Map<string, string> => new Map(files(root).map((f) => [relative(root, f), readFileSync(f, "utf8")]));

  it("finds none outside src/privacy/", () => {
    expect(violations(sources())).toEqual([]);
  });

  it("catches each kind when a builder adds it", () => {
    const s = sources();
    const add = (line: string): string[] => violations(new Map([...s, ["planner/new-builder.ts", line]]));
    expect(add("const t = raw as ModelText;")).toEqual(["planner/new-builder.ts: a cast to ModelText or ModelValue"]);
    expect(add("const t = raw as unknown as ModelText;")).toEqual(["planner/new-builder.ts: a cast to ModelText or ModelValue"]);
    expect(add('const t = (d as any)["record"](raw, ["candidate"]);')).toEqual(["planner/new-builder.ts: a private Disclosure member"]);
    expect(add("const b = new Basis(token, d, raw);")).toEqual(["planner/new-builder.ts: a Basis made by hand"]);
    expect(add("const t = d.own(raw as never);")).toEqual(["planner/new-builder.ts: own() of a cast value"]);
    expect(add("return d.legacy(req);")).toEqual(["planner/new-builder.ts: a legacy minter"]);
  });
});

describe("the minting primitives", () => {
  const model = (): ScreenModel => {
    const m = new ScreenModel();
    m.apply(snap([text("t1", "Name: Elena Vance"), text("t2", "Password: violet-orchard-seven"), field("f1", "", { label: "Email" })], { at: 1000, windowId: "note", title: "Notes" }));
    return m;
  };

  it("mints screen text only from a redacted view that shows it, and never a line redaction removed", () => {
    const m = model();
    const raw = m.windows.get("note") as WindowState;
    const view = redactWindow(raw);
    const d = new Disclosure(m.windows.values());
    expect(d.candidate(view, "Elena Vance")).toBe("Elena Vance");
    expect(d.candidate(view, "violet-orchard-seven")).toBeNull();
    expect(d.held(view, "Email")).toBe("Email");
    // A plain object with the same shape is no redacted view.
    expect(() => d.candidate({ ...view }, "Elena Vance")).toThrow(UnmintedText);
    // Plan and held text may show no line a redacted view removed, whole or in part.
    expect(d.planText("The note says violet-orchard-seven")).toBeNull();
    expect(d.heldText("Password: violet-orchard-seven")).toBeNull();
    expect(d.planText("The Email field holds Elena Vance")).toBe("The Email field holds Elena Vance");
  });

  it("composes only minted text, keeps the reasons, and refuses a raw hole", () => {
    const m = model();
    const view = redactWindow(m.windows.get("note") as WindowState);
    const d = new Disclosure(m.windows.values());
    const name = d.candidate(view, "Elena Vance") as ModelText;
    const said = d.t`The value is "${name}".`;
    expect(said).toBe('The value is "Elena Vance".');
    expect([...(d.reasonsOf(said) ?? [])].sort()).toEqual(["candidate", "ownWording"]);
    expect(() => d.t`The value is ${"raw text" as ModelText}.`).toThrow(UnmintedText);
    expect(() => d.join(["raw" as ModelText], " ")).toThrow(UnmintedText);
    expect(() => d.cut("raw" as ModelText, 3)).toThrow(UnmintedText);
    expect(d.derived(name, "Elena")).toBe("Elena");
    // A derivation brings in no word its bases do not show, beyond numbers and calendar words.
    expect(d.derived(name, "Elena Whitfield")).toBeNull();
    expect(d.derived(name, "Elena, 3 pm Monday")).toBe("Elena, 3 pm Monday");
  });

  it("verifies a body: every string minted, every key an identifier, the client's own paths by value", () => {
    const d = new Disclosure([]);
    const ok = d.own("Which one?");
    expect(() => d.verify("probe.latency", { state: { task: ok }, questions: { q: { type: "choice", instructions: ok, criteria: { a: ok } } }, model: "jev-latest" })).not.toThrow();
    expect(() => d.verify("probe.latency", { state: { task: "raw" } })).toThrow(/state\.task carries text that was not minted/u);
    expect(() => d.verify("probe.latency", { state: { "a key with spaces": ok } })).toThrow(/not an identifier/u);
    expect(() => d.verify("probe.latency", { questions: { q: { type: "other" } } })).toThrow(/does not allow there/u);
    // The message names the path, never the text.
    try {
      d.verify("probe.latency", { state: { task: "violet-orchard-seven" } });
    } catch (e) {
      expect(String(e)).not.toContain("violet");
    }
  });

  it("refuses a request with no Disclosure at the client and at the writer port, and a Basis made by hand", () => {
    expect(() => verifySent({ purpose: "probe.latency" }, { state: {} })).toThrow(/has no Disclosure/u);
    expect(() => verifyWriterInput({ kind: "plan", input: {} })).toThrow(/has no Disclosure/u);
    expect(() => new Basis(Symbol("basis"), new Disclosure([]), "raw")).toThrow(UnmintedText);
  });
});
