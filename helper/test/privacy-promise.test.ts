import { describe, expect, it } from "vitest";
import { OWNER_NOTE_DISCLOSURE, PRIVACY_PROMISE } from "../src/privacy.ts";

describe("approved privacy promise", () => {
  it("contains the whole-note disclosure verbatim", () => {
    expect(OWNER_NOTE_DISCLOSURE).toBe("To decide whose details a value is, Caret may send the whole note it came from, if the note is 2,000 characters or shorter.");
    expect(PRIVACY_PROMISE).toContain(OWNER_NOTE_DISCLOSURE);
  });
});
