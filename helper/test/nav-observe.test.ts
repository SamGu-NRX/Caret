// Slice 2: what an observation of an opened item lists (goals/replay.ts observe). Its values come from a frozen copy of
// the window as redaction leaves it, in the window's own order, less the list's rows.
import { afterEach, describe, expect, it } from "vitest";
import { observe } from "../src/goals/replay.ts";
import { checkDraftText, DraftRefused } from "../src/goals/drafts.ts";
import { basisText } from "../src/goals/inventory.ts";
import { macClock } from "../src/offers/event-time.ts";
import { goalScene, mailboxWindow, mailMessages, standInJev, type DeskMessage, type GoalScene } from "./goal-desk.ts";

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});

const INSTRUCTION = "Reply to Dana with the confirmation number from Kayak's message";

function observed(messages: DeskMessage[], open: string): ReturnType<typeof observe> {
  const sc = goalScene({ scripts: [], windows: [mailboxWindow(messages, open)], userWindow: "6262-1", askJev: standInJev() });
  scenes.push(sc);
  return observe(sc.helper.model, "6262-1", 1, { instruction: INSTRUCTION, clock: macClock(new Date(sc.desk.at)), now: sc.desk.at, readerSession: 1 });
}

describe("observe", () => {
  it("lists the item's code as a value of the frozen copy, and none of the list's cells", () => {
    const o = observed(mailMessages("QX7R2P", "ZZ9Y8W"), "kayak");
    expect(o.snapshot.values.some((v) => v.display.startsWith('"QX7R2P"'))).toBe(true);
    expect(o.snapshot.values.some((v) => v.display.startsWith('"3m ago"') || v.display.includes("ZZ9Y8W"))).toBe(false);
    expect(o.frozen[0]).toBe("obs1:6262-1");
    expect([...o.frozen[1].nodes.values()].some((n) => n.role === "AXRow")).toBe(false);
  });

  it("a code redaction withholds stays withheld: it is never listed, and a draft quoting it is unsupported by the copy", () => {
    // Review of 49901539: the copy once moved lines the instruction named ahead of the others before redaction, which
    // read "Verification" and "code: QX7R2P" apart and let the one-time code through as a confirmation number.
    const messages = mailMessages("AAAAAA", "ZZ9Y8W").map((m) => (m.id === "kayak" ? { ...m, body: ["Your trip to San Francisco is booked.", "Verification", "code: QX7R2P", "Manage your trip at kayak.example/trips."] } : m));
    const o = observed(messages, "kayak");
    expect(o.snapshot.values.some((v) => v.display.includes("QX7R2P"))).toBe(false);
    expect([...o.frozen[1].nodes.values()].some((n) => (n.label ?? "").includes("QX7R2P") || (n.value ?? "").includes("QX7R2P"))).toBe(false);
    expect(() => checkDraftText("Hi Dana, the confirmation number is QX7R2P.", { instruction: INSTRUCTION, windows: [basisText(o.frozen[1])], memory: [] })).toThrow(DraftRefused);
  });
});
