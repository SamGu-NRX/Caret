// Budget and count flags reject anything that would leave a guard unable to fire.
import { describe, expect, it } from "vitest";
import { positiveInt, positiveNumber } from "../scripts/flags.ts";

describe("positiveNumber", () => {
  it("accepts a positive dollar amount", () => {
    expect(positiveNumber("max-usd", "0.05")).toBe(0.05);
  });

  it.each([undefined, "", "abc", "NaN", "0", "-0.01", "Infinity"])("rejects %j", (raw) => {
    expect(() => positiveNumber("max-usd", raw)).toThrow(/--max-usd must be a positive number/);
  });
});

describe("positiveInt", () => {
  it("accepts a positive whole number", () => {
    expect(positiveInt("rounds", "200")).toBe(200);
  });

  it.each([undefined, "", "abc", "0", "-3", "2.5", "1e30"])("rejects %j", (raw) => {
    expect(() => positiveInt("rounds", raw)).toThrow(/--rounds must be a positive whole number/);
  });
});
