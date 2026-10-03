import { describe, expect, it } from "vitest";
import { posting, userInput } from "../scripts/synthetic-input.ts";

describe("telling the evaluation's own posted input from someone using the Mac", () => {
  it("counts low idle as the user's only when the last event came after the script's last post", async () => {
    // Before any post, low idle is the user's.
    expect(userInput(1)).toBe(true);
    let during: boolean | null = null;
    await posting(async () => {
      during = userInput(0);
    });
    // While posting, every event may be the script's own.
    expect(during).toBe(false);
    const now = Date.now();
    // The last event was the post itself, or within the margin after it.
    expect(userInput(0, now)).toBe(false);
    expect(userInput(0, now + 500)).toBe(false);
    // An event a second after the post ended is someone else's.
    expect(userInput(0, now + 1000)).toBe(true);
    expect(userInput(0.2, now + 1500)).toBe(true);
  });
});
