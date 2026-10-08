import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { OWNER_NOTE_DISCLOSURE, PRIVACY_PROMISE } from "../src/privacy.ts";

const draft = join(homedir(), ".caret-run/design/privacy/PROMISE-draft.md");
describe("approved privacy promise", () => {
  it("contains the whole-note disclosure verbatim", () => {
    expect(OWNER_NOTE_DISCLOSURE).toBe("To decide whose details a value is, Caret may send the whole note it came from, if the note is 2,000 characters or shorter.");
    expect(PRIVACY_PROMISE).toContain(OWNER_NOTE_DISCLOSURE);
  });
  it.skipIf(!existsSync(draft))("matches draft 2's paragraph, skipped when the local approved draft is unavailable", () => {
    const section = readFileSync(draft, "utf8").split("## The paragraph\n")[1]?.split("\n## ")[0];
    if (section === undefined) throw new Error("Approved draft is missing its The paragraph section");
    const paragraph = section.trim().replace(/^\*\*(What Caret sends|Who receives it)\*\*$/gm, "$1");
    expect(PRIVACY_PROMISE).toBe(paragraph);
    expect(PRIVACY_PROMISE).not.toContain("**");
  });
});
