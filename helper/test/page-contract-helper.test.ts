import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { AnyPageMessage } from "../src/protocol.ts";
import { handshakeExamples } from "./page-contract-handshake-examples.ts";

const directory = new URL("../fixtures/contracts/page/", import.meta.url);
const files = () => readdirSync(directory).filter((s) => s.endsWith(".json"));
const fixture = (name: string) => JSON.parse(readFileSync(new URL(name, directory), "utf8")) as Record<string, unknown>;
function kinds(schema: z.ZodType): string[] {
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) return schema.options.flatMap((s) => kinds(s as z.ZodType));
  if (schema instanceof z.ZodObject && schema.shape.type instanceof z.ZodLiteral) return [...schema.shape.type.values].filter((s): s is string => typeof s === "string");
  throw new Error("AnyPageMessage branch has no literal type discriminator");
}
const unique = (xs: string[]) => [...new Set(xs)].sort();

/**
 * Each nullable field the value carries, by path, and whether it is non-null here. Swift's synthesized Codable drops
 * nil, so a fixture holding only null would let a renamed Swift field decode as nil and still compare equal.
 */
function nullable(schema: z.ZodType, value: unknown, path: string, seen: Map<string, boolean>): void {
  if (schema instanceof z.ZodOptional) return nullable(schema.unwrap() as z.ZodType, value, path, seen);
  if (schema instanceof z.ZodNullable) {
    seen.set(path, seen.get(path) === true || value !== null);
    if (value !== null) nullable(schema.unwrap() as z.ZodType, value, path, seen);
  } else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    const option = (schema.options as z.ZodType[]).find((o) => o.safeParse(value).success);
    if (option !== undefined) nullable(option, value, path, seen);
  } else if (schema instanceof z.ZodObject && typeof value === "object" && value !== null) {
    for (const [key, field] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
      if (key in value) nullable(field, (value as Record<string, unknown>)[key], `${path}.${key}`, seen);
    }
  } else if (schema instanceof z.ZodArray && Array.isArray(value)) {
    for (const item of value) nullable(schema.element as z.ZodType, item, `${path}[]`, seen);
  }
}

describe("helper/Swift shared page wire, handshake included", () => {
  it("has fixtures for exactly the production schema's message kinds", () => {
    expect(unique(files().map((name) => String(fixture(name).type)))).toEqual(unique(kinds(AnyPageMessage)));
  });
  it("carries a non-null example of every nullable field the fixtures hold", () => {
    const seen = new Map<string, boolean>();
    for (const name of files()) nullable(AnyPageMessage, fixture(name), String(fixture(name).type), seen);
    expect([...seen].filter(([, nonNull]) => !nonNull).map(([path]) => path)).toEqual([]);
    expect(seen.size).toBeGreaterThan(0);
  });
  it.each(handshakeExamples)("serializes its own $type handshake example to the shared fixture", (example) => {
    expect(JSON.parse(JSON.stringify(example))).toEqual(fixture(`${example.type}.json`));
  });
});
