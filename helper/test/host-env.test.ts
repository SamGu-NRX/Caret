import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { tokenizer } from "acorn";
import { describe, expect, it } from "vitest";
import { ENV, HOST_ENV, HELPER_ONLY_ENV } from "../src/host-env.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");
const caret = read("apps/caret/Sources/CaretHost/Services/ServiceLauncher.swift");
const legacy = read("apps/mac/Sources/CaretCore/CoreProcessTransport.swift");
const legacySettings = read("apps/mac/Sources/Caret/CoreLaunchSettings.swift");
const launchRole = read("apps/caret/Sources/CaretHostCore/Services/LaunchRole.swift");
const names = HOST_ENV.map((e) => e.name);
const allNames = [...names, ...HELPER_ONLY_ENV.map((e) => e.name)];
const literals = (source: string) => [...source.matchAll(/"([A-Z][A-Z0-9_]*)"/g)].map((m) => m[1]!);
function swiftList(source: string, name: string): string[] {
  const body = source.match(new RegExp(`static let ${name} = \\[([^\\]]*)\\]`));
  expect(body, `missing Swift list ${name}`).not.toBeNull();
  return literals(body![1]!);
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}
// Every reference to process.env, whatever its shape: `process` must be followed by a member other than `env`, and
// `env` may not be imported from node:process. Anything else (an alias, destructuring, a computed key) is a reference.
function envReferences(source: string, file: string): string[] {
  const tokens = [...tokenizer(source, { ecmaVersion: "latest", locations: true })];
  const text = (i: number) => (tokens[i] === undefined ? "" : source.slice(tokens[i]!.start, tokens[i]!.end));
  const found: string[] = [];
  tokens.forEach((t, i) => {
    const processName = t.type.label === "name" && text(i) === "process";
    const importsProcess = t.type.label === "string" && ["node:process", "process"].includes(text(i).slice(1, -1)) && text(i - 1) === "from";
    const member = [".", "?."].includes(text(i + 1)) && tokens[i + 2]?.type.label === "name" && text(i + 2) !== "env";
    if ((processName && !member) || importsProcess) found.push(`${file}:${t.loc!.start.line}: process.env outside host-env.ts`);
  });
  return found;
}

describe("native/helper environment contract", () => {
  it("uses one inventory with a direction or a helper-only reason", () => {
    expect(new Set(allNames).size).toBe(allNames.length);
    for (const entry of HOST_ENV) {
      expect(entry.direction).not.toBe("");
      expect(entry.meaning).not.toBe("");
      expect(ENV[entry.key]).toBe(entry.name);
    }
    for (const entry of HELPER_ONLY_ENV) expect(entry.reason).not.toBe("");
  });
  it("references process.env only in host-env.ts; helper/scripts is out of scope", () => {
    const violations = files(join(root, "helper/src")).filter((f) => !f.endsWith("/host-env.ts"))
      .flatMap((f) => envReferences(readFileSync(f, "utf8"), relative(root, f)));
    expect(violations).toEqual([]);
  });
  it.each([
    "process.env.A", 'process.env["B"]', "process.env[`C${x}`]", "process?.env", 'process["env"]', "const { D } = process.env",
    "const { env } = process", "const p = process; p.env.E", "Object.entries(process.env)", 'import { env } from "node:process"',
  ])("reports %s with its file and line", (sample) => {
    expect(envReferences(`// process.env in a comment\n${sample};`, "probe.ts")).toEqual(["probe.ts:2: process.env outside host-env.ts"]);
  });
  it("ignores other process members and the word in strings", () => {
    expect(envReferences('process.exit(1); process.stdout.write("process.env"); const s = "process";', "probe.ts")).toEqual([]);
  });
  it("finds every shared name in each launcher or an explicit per-launcher exception", () => {
    for (const entry of HOST_ENV) {
      for (const [source, exception, label] of [[caret, entry.caret, "caret"], [legacy + legacySettings, entry.legacy, "legacy"]] as const) {
        if (exception !== null) expect(exception.length, `${label}: ${entry.name}`).toBeGreaterThan(0);
        else expect(literals(source), `${label} must handle ${entry.name}`).toContain(entry.name);
      }
    }
    // Host-only and test-only consumers are not helper launchers.
    for (const entry of HOST_ENV.filter((e) => e.direction === "host-only")) expect(literals(launchRole)).toContain(entry.name);
    for (const entry of HOST_ENV.filter((e) => e.direction === "test-to-reader")) expect(literals(read("apps/screen-reader/Sources/caret-screen/main.swift"))).toContain(entry.name);
    for (const entry of HOST_ENV.filter((e) => e.direction === "test-to-bridge")) expect(literals(read("bridge/Sources/caret-bridge/main.swift"))).toContain(entry.name);
  });
  it("requires each Swift-owned list and launch marker to exist in the helper inventory", () => {
    for (const name of [...swiftList(caret, "typeSafeEnvironmentKeys"), ...swiftList(caret, "developmentEnvironmentKeys"), ...swiftList(legacySettings, "providerEnvironmentKeys")]) expect(names).toContain(name);
    for (const key of ["agentMarker", "launchServicesMarker"]) {
      const name = launchRole.match(new RegExp(`static let ${key} = "([^"]+)"`))?.[1];
      expect(name).toBeDefined();
      expect(names).toContain(name);
    }
    expect(caret).toContain("let devKeys = release ? [] : developmentEnvironmentKeys");
    expect(legacySettings).toContain("for key in Self.providerEnvironmentKeys");
  });
  it("pins release strip rules and excludes gateway/dev names from the TypeSafe allow-list", () => {
    const allow = swiftList(caret, "typeSafeEnvironmentKeys");
    for (const source of [caret, legacy]) {
      expect(source).toContain(`let release = ${source === caret ? "host" : "input"}["${ENV.caret_release_host}"] == "1"`);
      expect(source).toContain(`#else\n        let release = true`);
      for (const prefix of ["CARET_DEV_", "AI_GATEWAY_", "VERCEL_"]) expect(source).toContain(`!key.hasPrefix("${prefix}")`);
      for (const entry of HOST_ENV.filter((e) => /^(CARET_DEV_|AI_GATEWAY_|VERCEL_)/.test(e.name))) {
        expect(allow).not.toContain(entry.name);
        expect(["CARET_DEV_", "AI_GATEWAY_", "VERCEL_"].some((p) => entry.name.startsWith(p) && source.includes(`!key.hasPrefix("${p}")`))).toBe(true);
      }
    }
    expect(allow.some((n) => /^(CARET_DEV_|AI_GATEWAY_|VERCEL_)/.test(n))).toBe(false);
    expect(caret).toContain("guard typeSafeEnvironmentKeys.contains(key)");
    expect(caret).toContain('env.removeValue(forKey: "CARET_ENV_FILE")');
    expect(legacy).toContain('key != "CARET_JEV_GATEWAY_KEY"');
  });
});
