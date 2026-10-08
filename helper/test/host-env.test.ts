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
function literalReads(source: string, file: string): string[] {
  const tokens = [...tokenizer(source, { ecmaVersion: "latest", locations: true })].map((t) => ({
    ...t, value: source.slice(t.start, t.end).replace(/^['"]|['"]$/g, ""),
  }));
  const found: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    let end = -1;
    if (t.value === "process" && tokens[i + 1]?.type.label === "." && tokens[i + 2]?.value === "env") end = i + 3;
    else if (t.value === "env" && tokens[i - 1]?.type.label !== ".") end = i + 1;
    const next = tokens[end];
    const name = tokens[end + 1];
    const isDot = next?.type.label === "." && name?.type.label === "name";
    const isBracket = next?.type.label === "[" && name?.type.label === "string";
    const isCall = ["setting", "readKey"].includes(String(t.value)) && tokens[i + 1]?.type.label === "(" && tokens[i + 2]?.type.label === "string";
    const literal = isCall ? tokens[i + 2] : isDot || isBracket ? name : undefined;
    if (!literal) continue;
    // runStop's env is a disk/hold configuration, not NodeJS.ProcessEnv.
    if (file.endsWith("engines/decide/slow.ts") && ["holdFile", "diskPath", "floorGiB"].includes(String(literal.value))) continue;
    found.push(`${file}:${t.loc!.start.line}: literal environment read ${literal.value}; use host-env.ts`);
  }
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
  it("rejects literal reads throughout helper/src; helper/scripts is out of scope", () => {
    const violations = files(join(root, "helper/src")).filter((f) => !f.endsWith("/host-env.ts"))
      .flatMap((f) => literalReads(readFileSync(f, "utf8"), relative(root, f)));
    expect(violations).toEqual([]);
  });
  it("detects each literal syntax with file and line, without scanning comments", () => {
    const sample = '// env.IGNORED\nprocess.env.A; process.env["B"]; env.C; env["D"]; setting("E", env);';
    expect(literalReads(sample, "probe.ts")).toHaveLength(5);
    expect(literalReads(sample, "probe.ts").every((s) => s.startsWith("probe.ts:2:"))).toBe(true);
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
