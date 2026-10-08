import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseToHelper } from "../src/shared/bridge-messages.ts";
import { parseFromHelper, parseVerb } from "../src/worker/wire.ts";
import { examples, incoming, outgoing, verbs } from "./page-contract-examples.ts";

const root = new URL("../../", import.meta.url);
const directory = new URL("helper/fixtures/contracts/page/", root);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const fixtures = () => readdirSync(directory).filter((f) => f.endsWith(".json")).map((f) => ({ name: f, value: JSON.parse(readFileSync(new URL(f, directory), "utf8")) as Record<string, unknown> }));
const swift = read("bridge/Sources/CaretPageProtocol/PageProtocol.swift");
const kinds = (text: string, key: string) => [...text.matchAll(new RegExp(`${key}: "([^"]+)"`, "g"))].map((m) => m[1]!);
const unique = (xs: string[]) => [...new Set(xs)].sort();
const nameOf = (x: { type: string; verb?: { kind: string } }) => x.type === "pageCommand" ? `${x.type}-${x.verb!.kind}.json` : `${x.type}.json`;

describe("extension/Swift page contract", () => {
  it("has a shared fixture for every bridge message and every page verb, without extra kinds", () => {
    const f = fixtures();
    expect(f.map((x) => x.name).sort()).toEqual(examples.map(nameOf).sort());
    const messages = read("extension/src/shared/messages.ts");
    const toHelper = messages.split("export type ToHelper =")[1]!;
    const fromHelper = read("extension/src/worker/wire.ts").split("export type FromHelper =")[1]!.split("/** A bridge message")[0]!;
    expect(unique(f.map((x) => String(x.value.type)))).toEqual(unique([...kinds(toHelper, "type"), ...kinds(fromHelper, "type")]));
    const declaredVerbs = messages.split("export type ActVerb =")[1]!.split("/**\n * H10")[0]!;
    expect(unique(verbs.map((v) => v.kind))).toEqual(unique(kinds(declaredVerbs, "kind")));
    const swiftKinds = [...swift.split("public enum PageMessage:")[1]!.matchAll(/case "([^"]+)": self = \./g)].map((m) => m[1]!);
    // The bridge's engineChallenge/engineHello/engineWelcome handshake is not spoken by the extension.
    expect(unique(swiftKinds.filter((k) => !["engineChallenge", "engineHello", "engineWelcome"].includes(k)))).toEqual(unique(f.map((x) => String(x.value.type))));
    expect(unique([...swift.matchAll(/case "(page[^"]+)": self = \./g)].map((m) => m[1]!).filter((k) => verbs.some((v) => v.kind === k)))).toEqual(unique(verbs.filter((v) => v.kind !== "pageWalk").map((v) => v.kind)));
    expect(swift).toContain('if kind == "pageWalk"');
  });
  it.each(examples)("parses and serializes its own $type example through the production decoder", (example) => {
    const fixture = JSON.parse(readFileSync(new URL(nameOf(example), directory), "utf8"));
    expect(JSON.parse(JSON.stringify(example))).toEqual(fixture);
    if (outgoing.some((m) => m.type === example.type)) expect(parseToHelper(fixture)).toEqual(example);
    else {
      const parsed = parseFromHelper(fixture);
      expect(parsed).not.toBeNull();
      expect(parsed).toEqual(parseFromHelper(JSON.parse(JSON.stringify(example))));
      // The incoming decoder intentionally projects only routing fields, so compare its serialized projection.
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parseFromHelper(example));
    }
    if ("verb" in example) expect(parseVerb(fixture.verb)).toEqual(example.verb);
  });
  it("pins the Swift required stored fields and verb decode keys to the fixtures", () => {
    function types(name: string): string | undefined {
      const start = swift.indexOf(`public struct ${name}:`);
      if (start < 0) return undefined;
      const opening = swift.indexOf("{", start);
      let depth = 1, end = opening + 1;
      while (depth > 0 && end < swift.length) {
        if (swift[end] === "{") depth++;
        if (swift[end] === "}") depth--;
        end++;
      }
      return swift.slice(opening + 1, end - 1);
    }
    function required(name: string, value: Record<string, unknown>) {
      const body = types(name);
      expect(body, `missing Swift type ${name}`).toBeDefined();
      for (const declaration of body!.matchAll(/public var ([^\n;}]+)/g)) {
        for (const match of declaration[1]!.matchAll(/([\w, ]+): ([\w\[\]:]+)(\?)?/g)) {
          if (match[3]) continue;
          for (const key of match[1]!.split(",").map((s) => s.trim()).filter(Boolean)) expect(value, `${name}.${key}`).toHaveProperty(key);
        }
      }
    }
    for (const { value } of fixtures()) {
      const type = String(value.type);
      const name = type === "pageFocus" ? "PageFocusMoved" : type[0]!.toUpperCase() + type.slice(1);
      required(name, value);
      if (type === "pageSnapshot") {
        for (const f of value.frames as Record<string, unknown>[]) {
          required("PageFrame", f);
          for (const c of f.controls as Record<string, unknown>[]) required("PageControl", c);
        }
      }
      if (type === "pageCommand") {
        const verb = value.verb as Record<string, unknown>;
        const block = swift.split('case "' + verb.kind + '": self =')[1]?.split("\n")[0];
        if (verb.kind !== "pageWalk") {
          expect(block, `missing Swift verb ${verb.kind}`).toBeDefined();
          const targetBlock = swift.split("let t = PageTarget(")[1]!.split("// The wire")[0]!;
          for (const key of [...(block! + targetBlock).matchAll(/c\.decode\([^\n]*?forKey: \.(\w+)\)/g)].map((m) => m[1]!)) expect(verb, `Swift ${verb.kind}.${key}`).toHaveProperty(key);
        }
      }
    }
  });
  it("uses outgoing validation at the actual worker send boundary", () => {
    expect(read("extension/src/worker.ts")).toContain("const checked = parseToHelper(m)");
    expect(read("extension/src/worker.ts")).toContain("port?.postMessage(checked)");
  });
  it.each(outgoing)("rejects unknown kinds and missing required fields for $type", (example) => {
    expect(parseToHelper({ ...example, type: "broken" })).toBeNull();
    for (const key of Object.keys(example).filter((k) => !["readings", "choice", "attached", "text"].includes(k))) {
      const broken = { ...example } as Record<string, unknown>;
      delete broken[key];
      expect(parseToHelper(broken), `${example.type}.${key}`).toBeNull();
    }
  });
  it("rejects malformed nested controls and preserves extension-only snapshot fields", () => {
    const snapshot = outgoing.find((m) => m.type === "pageSnapshot")!;
    const bad = JSON.parse(JSON.stringify(snapshot));
    delete bad.frames[0].controls[0].name;
    expect(parseToHelper(bad)).toBeNull();
    const extra = { ...snapshot, walkMs: 1, view: null };
    expect(parseToHelper(extra)).toEqual(extra);
  });
});
