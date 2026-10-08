import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { AnyPageMessage } from "../src/protocol.ts";
import { handshakeExamples } from "./page-contract-handshake-examples.ts";

const root = new URL("../../", import.meta.url);
const directory = new URL("helper/fixtures/contracts/page/", root);
const files = () => readdirSync(directory).filter((s) => s.endsWith(".json"));
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, directory), "utf8")) as Record<string, unknown>;
function kinds(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) return schema.options.flatMap((s) => kinds(s as z.ZodType));
  if (schema instanceof z.ZodObject && schema.shape.type instanceof z.ZodLiteral) return [...schema.shape.type.values].filter((s): s is string => typeof s === "string");
  throw new Error("AnyPageMessage branch has no literal type discriminator");
}
const unique = (xs: string[]) => [...new Set(xs)].sort();

describe("helper/Swift shared page wire, handshake included", () => {
  it("has fixtures for exactly the production schema's message kinds", () => {
    expect(unique(files().map((name) => String(fixture(name).type)))).toEqual(unique(kinds(AnyPageMessage)));
  });
  it.each(files())("parses and serializes %s with the existing helper schema", (name) => {
    const expected = fixture(name);
    expect(AnyPageMessage.parse(expected)).toEqual(expected);
    expect(AnyPageMessage.parse(JSON.parse(JSON.stringify(expected)))).toEqual(expected);
  });
  it.each(handshakeExamples)("serializes its own $type handshake example to the shared fixture", (example) => {
    expect(JSON.parse(JSON.stringify(example))).toEqual(fixture(`${example.type}.json`));
  });
  it("matches the Swift discriminator cases, including bridge-only handshake messages", () => {
    const swift = readFileSync(new URL("bridge/Sources/CaretPageProtocol/PageProtocol.swift", root), "utf8").split("public enum PageMessage:")[1]!;
    const swiftKinds = [...swift.matchAll(/case "([^"]+)": self = \./g)].map((m) => m[1]!);
    expect(unique(swiftKinds)).toEqual(unique(kinds(AnyPageMessage)));
  });
});
