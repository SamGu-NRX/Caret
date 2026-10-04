import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { userInput } from "../scripts/synthetic-input.ts";

describe("telling an evaluation's own posted input from someone using the Mac", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const markFile = (content: string | null): string => {
    const d = mkdtempSync(join(tmpdir(), "caret-synthetic-"));
    dirs.push(d);
    const f = join(d, "mark");
    if (content !== null) writeFileSync(f, content);
    return f;
  };

  it("counts low idle as the user's unless the last event came within the margin after the last post", () => {
    const now = 1_000_000;
    expect(userInput(1, now, markFile(null))).toBe(true);
    const posted = markFile(String(now));
    expect(userInput(0, now, posted)).toBe(false);
    expect(userInput(0, now + 500, posted)).toBe(false);
    expect(userInput(0, now + 1000, posted)).toBe(true);
    expect(userInput(0.2, now + 1500, posted)).toBe(true);
  });

  it("excuses input only while a post is under way, and not past its deadline", () => {
    const now = 1_000_000;
    const busy = markFile(`busy ${now + 2000}`);
    expect(userInput(0, now, busy)).toBe(false);
    expect(userInput(0, now + 2001, busy)).toBe(true);
    expect(userInput(0, now, markFile("busy"))).toBe(true);
  });
});
