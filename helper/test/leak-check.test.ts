// The leak check finds a seen string in a file by hash alone, only at word boundaries, and keeps
// which apps showed it. All strings are invented.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addedLines } from "../scripts/added-lines.ts";
import { scanText, SeenSet, seenUnits } from "../src/leak-check.ts";

describe("seen units", () => {
  it("keeps the whole text, each line and each long word, normalized, and drops short ones", () => {
    expect(seenUnits("Invoice  INV-30417\nPaid by Tomasz Wilk.").sort()).toEqual(
      ["invoice inv-30417 paid by tomasz wilk.", "invoice inv-30417", "invoice", "inv-30417", "paid by tomasz wilk.", "tomasz"].sort(),
    );
    expect(seenUnits("OK")).toEqual([]);
  });
});

describe("scan", () => {
  const seen = new SeenSet();
  seen.add("Invoice INV-30417 from Halvorsen Freight", "dev.caret.mail");
  seen.add("halvorsen", "dev.caret.notes");

  it("finds a seen word or line inside a file line, whatever its case and spacing", () => {
    const hits = scanText("We matched   inv-30417 against the ledger.\nNothing here.", seen);
    expect(hits).toEqual([{ unit: "inv-30417", bundles: ["dev.caret.mail"] }]);
  });

  it("merges the apps that showed the same unit", () => {
    expect(scanText("Halvorsen", seen)).toEqual([{ unit: "halvorsen", bundles: ["dev.caret.mail", "dev.caret.notes"] }]);
  });

  it("does not report a seen word inside a longer word", () => {
    expect(scanText("Halvorsenbergs and xinv-30417x", seen)).toEqual([]);
  });

  it("round-trips through its file form with no text in it", () => {
    const f = seen.toJSON();
    expect(JSON.stringify(f)).not.toMatch(/halvorsen|invoice/i);
    expect(scanText("from halvorsen freight", SeenSet.fromJSON(f)).map((h) => h.unit).sort()).toEqual(["freight", "halvorsen"]);
  });

  it("finds a unit whose letters lowercase differently in context", () => {
    const greek = new SeenSet();
    greek.add("ΑΒΓΔΣ.", "dev.caret.mail");
    expect(scanText("ΑΒΓΔΣ.ΑΒΓΔ", greek).map((h) => h.unit)).toEqual(["αβγδσ."]);
  });

  it("refuses a seen file with a malformed key", () => {
    expect(() => SeenSet.fromJSON({ salt: "abc", bundles: [], lengths: [], hashes: {} })).toThrow(/salt/);
  });
});

describe("added lines of a diff", () => {
  it("scans an added source line that begins with ++, which git prints as +++ inside a hunk", () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-leak-diff-"));
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
      git("init", "-q");
      writeFileSync(join(dir, "notes.txt"), "first\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      writeFileSync(join(dir, "notes.txt"), "first\n++ paid halvorsen\n");
      git("commit", "-q", "-am", "add");
      const diff = git("diff", "--unified=0", "--no-color", "HEAD~1..HEAD");
      expect(diff).toContain("\n+++ paid halvorsen\n");

      const added = addedLines(diff);
      expect([...added.entries()]).toEqual([["diff:notes.txt", "++ paid halvorsen\n"]]);
      const seen = new SeenSet();
      seen.add("halvorsen", "dev.caret.notes");
      expect(scanText(added.get("diff:notes.txt") ?? "", seen).map((h) => h.unit)).toEqual(["halvorsen"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
