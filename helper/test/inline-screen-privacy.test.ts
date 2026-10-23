import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const promise = "It leaves out secure fields, excluded apps such as password managers, terminals and System Settings, apps and sites you turned off, and text you typed into web pages.";

describe("inline screen privacy explanation", () => {
  for (const file of ["../src/privacy.ts", "../../docs/privacy/chrome-extension.md"]) {
    it(`names the excluded text in ${file} without changing writing or clipboard promises`, () => {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toContain("admitted static text");
      expect(source).toContain(promise);
      expect(source).toContain("your recent writing in that app, kept in memory for up to ten minutes.");
      expect(source).toContain("Clipboard text is off unless you turn it on in Writing. When on, Caret reads the plain text on the general pasteboard when it makes a local Tab suggestion, subject to a 256-token limit and the secret filter. It skips concealed, temporary, generated, oversized or secret clipboard text. Nothing goes to Groq.");
    });
  }
});
