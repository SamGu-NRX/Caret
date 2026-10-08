// SC1 section 4, the typed boundary's own guards beside T-P1 (test/sc1-provenance.test.ts):
// T-P2 the types: a raw string does not compile where a request carries text (tsc checks this file; `pnpm test` runs it);
// T-P3 the lint: casts to ModelText, a private Disclosure member, a Basis or a laundering own() appear only under
//      src/privacy/; and no builder is left minting legacy text.
// Then the minting primitives, each with one correct answer.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Basis, Disclosure, UnmintedText, verifySent, verifyWriterInput, type ModelText, registryOf } from "../src/privacy/disclosure.ts";
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
    ["a private Disclosure member", /\[\s*["'](?:record|recordWays|composedWays|mints|ways|asJson|policy|reasons|fromView|keptByViews|asTaken|asPlan|asMemory|walk|takeDerived)["']\s*\]/u],
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

describe("the I/O boundary: every POST body and every request store is checked as it leaves (privacy/send.ts)", () => {
  const helperRoot = fileURLToPath(new URL("../", import.meta.url));
  const tsFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : tsFiles(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
  const read = (dirs: readonly string[]): Map<string, string> => new Map(dirs.flatMap((d) => tsFiles(join(helperRoot, d))).map((f) => [relative(helperRoot, f), readFileSync(f, "utf8")]));
  /** A POST's body that is not sealedBody(...), or a write of request text that is not storedLine(...) or storableRequest(...). */
  const breaks = (sources: Map<string, string>): string[] =>
    [...sources].flatMap(([file, src]) => {
      const out: string[] = [];
      for (const m of src.matchAll(/method:\s*"POST"[\s\S]{0,400}?\bbody:\s*([A-Za-z_]+)/gu)) if (m[1] !== "sealedBody") out.push(`${file}: a POST body that is not sealedBody`);
      for (const line of src.split("\n")) {
        if (!/\b(?:append|write)FileSync\(/u.test(line) || !/\breq\b|\.questions\b|\.state\b|\bwire\b/u.test(line)) continue;
        if (!/\b(?:storedLine|storableRequest)\(/u.test(line)) out.push(`${file}: a store of request text that is not storedLine or storableRequest`);
      }
      // A request store's path is checked (privacy/store-path.ts) by writeStoredLine and appendStoredLine, not by a bare
      // write of storedLine's text.
      if (file !== "src/privacy/send.ts") for (const line of src.split("\n")) if (/\b(?:append|write)FileSync\([^\n]*\bstoredLine\(/u.test(line)) out.push(`${file}: a request store whose path is not checked`);
      return out;
    });
  // The fixture harness's own scripts (fixtures/web-form/*.ts) send and store requests; its tests and pages post to the
  // local fixture site, never to a model, and are left out.
  const shellScripts = (): Map<string, string> => {
    const dir = join(helperRoot, "scripts");
    return new Map(readdirSync(dir).filter((f) => f.endsWith(".sh")).map((f) => [`scripts/${f}`, readFileSync(join(dir, f), "utf8")]));
  };
  const fixtureScripts = (): Map<string, string> => {
    const dir = join(helperRoot, "../fixtures/web-form");
    return new Map(readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".ts")).map((e) => [`../fixtures/web-form/${e.name}`, readFileSync(join(dir, e.name), "utf8")]));
  };
  const all = (): Map<string, string> => new Map([...read(["src", "scripts"]), ...fixtureScripts()]);

  /** A text write in an evaluation script (helper/scripts, the fixture harness's eval scripts) that is not writeStore or appendStore. */
  // Also a file handed to a child as its output (openSync, a file descriptor in stdio), a reader's --record, and a shell
  // script's redirect to a file (anything but /dev/null).
  // A code generator writes source files from pinned public data, never model or screen text, so it writes them as they
  // are: withholding could corrupt a generated table.
  const CODEGEN: ReadonlySet<string> = new Set(["scripts/gen-ledger-unicode.ts"]);
  const rawScriptWrites = (sources: Map<string, string>): string[] =>
    [...sources].filter(([file]) => !CODEGEN.has(file)).filter(([file]) => file.startsWith("scripts/") || /fixtures\/web-form\/(?:page-loop-eval|tab-source-journey)\.ts$/u.test(file)).flatMap(([file, src]) => {
      // A redirect may stand only with a "# store: <why>" note on its line saying it keeps no model text.
      if (file.endsWith(".sh")) return src.split("\n").some((l) => !l.trimStart().startsWith("#") && !/#\s*store:\s*\S/u.test(l) && /(?:^|[^&0-9])>>?\s*(?!\/dev\/null|&)\S/u.test(l.replace(/"[^"]*"/gu, (q) => (q.includes(">") ? "" : q)))) ? [`${file}: a shell redirect to a file`] : [];
      return /\b(?:writeFileSync|appendFileSync|createWriteStream|openSync)\(|"--record"/u.test(src) ? [`${file}: a store that is not writeStore or appendStore`] : [];
    });

  it("finds every script's text store going through send.ts, so a response is kept with its formats withheld", () => {
    expect(rawScriptWrites(new Map([...all(), ...shellScripts()]))).toEqual([]);
    expect(rawScriptWrites(new Map([["scripts/run.sh", 'node scripts/x.ts >> "$DIR/runner.log" 2>&1 &']]))).toEqual(["scripts/run.sh: a shell redirect to a file"]);
    expect(rawScriptWrites(new Map([["scripts/run.ts", "const fd = openSync(join(out, 'pass.log'), 'a');"]]))).toEqual(["scripts/run.ts: a store that is not writeStore or appendStore"]);
    expect(rawScriptWrites(new Map([...all(), ["scripts/new-eval.ts", "writeFileSync(join(OUT, 'drafts.json'), JSON.stringify(drafts));"]]))).toEqual(["scripts/new-eval.ts: a store that is not writeStore or appendStore"]);
  });

  /**
   * A JSON text handed to a raw-text store: writeStore or appendStore over a JSON.stringify withholds the encoded text and
   * can cut into a number (B31's live scoreboard on v2/int1). A JSON store goes through writeStoreJson, appendStoreJson or
   * writeStoreNdjson (privacy/send.ts storeJson), which withhold inside strings and encode once.
   */
  const jsonAsText = (sources: Map<string, string>): string[] =>
    [...sources].filter(([file]) => file.startsWith("scripts/") || file.startsWith("../fixtures/")).flatMap(([file, src]) => {
      const out: string[] = [];
      for (const m of src.matchAll(/\b(?:writeStore|appendStore|writeAtomic)\(/gu)) {
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < src.length; end++) {
          if (src[end] === "(") depth++;
          else if (src[end] === ")" && --depth === 0) break;
        }
        if (/\bJSON\.stringify\(/u.test(src.slice(m.index, end))) out.push(`${file}: a JSON text through a raw-text store`);
      }
      return out;
    });

  /**
   * A generated secret handed to a withholding store: withholdValues can replace part of its hex, and the host it
   * authenticates then fails. A launch secret goes through privacy/local-secret.ts writeLocalSecretFile, allowlisted
   * here because it writes only random bytes newLocalSecret made in the process, never model or screen text.
   */
  const secretThroughStore = (sources: Map<string, string>): string[] =>
    [...sources].filter(([file]) => file.startsWith("scripts/") || file.startsWith("../fixtures/")).flatMap(([file, src]) =>
      [...src.matchAll(/\b(?:writeStore|appendStore)\([^\n]*\b(?:secret|Secret)\b[^\n]*\.toString\("hex"\)/gu)].map(() => `${file}: a generated secret through a withholding store`));

  it("finds every generated secret on writeLocalSecretFile, and catches one through a withholding store", () => {
    expect(secretThroughStore(all())).toEqual([]);
    expect(secretThroughStore(new Map([["../fixtures/web-form/new-journey.ts", 'writeStore(secretFile, secret.toString("hex"), { mode: 0o600 });']]))).toEqual(["../fixtures/web-form/new-journey.ts: a generated secret through a withholding store"]);
    expect(secretThroughStore(new Map([["../fixtures/web-form/new-journey.ts", "writeLocalSecretFile(secretFile, secret);"]]))).toEqual([]);
  });

  it("finds every script's JSON store on the structured path, and catches one that is not", () => {
    expect(jsonAsText(all())).toEqual([]);
    expect(jsonAsText(new Map([["scripts/new-eval.ts", 'writeStore(join(OUT, "rows.json"), `${JSON.stringify(rows, null, 1)}\\n`);']]))).toEqual(["scripts/new-eval.ts: a JSON text through a raw-text store"]);
    expect(jsonAsText(new Map([["scripts/new-eval.ts", 'appendStore(log, JSON.stringify({ n: 1 }) + "\\n");']]))).toEqual(["scripts/new-eval.ts: a JSON text through a raw-text store"]);
    expect(jsonAsText(new Map([["scripts/new-eval.ts", 'writeStore(f, rows.map((r) => JSON.stringify(r)).join("\\n"));']]))).toEqual(["scripts/new-eval.ts: a JSON text through a raw-text store"]);
    expect(jsonAsText(new Map([["scripts/new-eval.ts", 'writeStoreJson(join(OUT, "rows.json"), rows, 1);']]))).toEqual([]);
  });

  it("finds every POST body sealed and every request store checked", () => {
    expect(breaks(all())).toEqual([]);
  });

  it("catches a transport or a store that skips them", () => {
    const s = all();
    expect(breaks(new Map([...s, ["src/new-transport.ts", 'await f(url, { method: "POST", headers: {}, body: JSON.stringify(wire) });']]))).toEqual(["src/new-transport.ts: a POST body that is not sealedBody"]);
    expect(breaks(new Map([...s, ["src/new-store.ts", "appendFileSync(log, JSON.stringify({ state: req.state }));"]]))).toEqual(["src/new-store.ts: a store of request text that is not storedLine or storableRequest"]);
    expect(breaks(new Map([...s, ["src/new-store.ts", "appendFileSync(log, storedLine(sealed, (w) => ({ body: w })));"]]))).toEqual(["src/new-store.ts: a request store whose path is not checked"]);
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
    const d = new Disclosure(m);
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
    const d = new Disclosure(m);
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
    const d = new Disclosure(registryOf([]));
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
    expect(() => new Basis(Symbol("basis"), new Disclosure(registryOf([])), "raw")).toThrow(UnmintedText);
  });
});
