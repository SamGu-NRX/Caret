// PV1's two open items, closed in PV2: an Ask's sentence about fields it found nothing for (says.ts saysNoValue) and the
// Ask scope's local record of each field (fill/ask-scope.ts fieldFingerprint, planner/ask.ts seenOf) carried names read
// from the raw window. Both now come from the redacted view: a name as the view shows it, and records as digests.
import { describe, expect, it } from "vitest";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { fieldFingerprint } from "../src/fill/ask-scope.ts";
import { planAsk } from "../src/planner/ask.ts";
import type { AskJev } from "../src/fill/jev.ts";
import type { AskIntent, IntentSnapshot } from "../src/planner/intent.ts";
import type { IntentMaker } from "../src/planner/intent.ts";
import { field, node, snap, text } from "./builders.ts";

const P = "com.google.Chrome/standard";
const SECRET_LABEL = "API key for staging";

/** A form whose one field is named only by a nearby line the redacted view drops (a marker line), beside a note. */
function desk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("te/note", "Rental notes\nName: Elena Vance", { role: "AXTextArea" })], { at: 900, windowId: "note", title: "Notes.txt", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" }, focused: true }));
  m.apply(
    snap(
      [
        node(`${P}/webarea:~0`, "AXWebArea", { label: "Apply" }),
        text(`${P}/statictext:key~0`, SECRET_LABEL, [20, 100, 140, 18], `${P}/webarea:~0`),
        field(`${P}/textfield:~0`, "", { parent: `${P}/webarea:~0`, frame: [170, 98, 200, 22] }),
      ],
      { at: 1000, windowId: "form", title: "Apply", app: { pid: 7002, bundleId: "com.google.Chrome", name: "Google Chrome" }, focused: true, focusedKey: `${P}/textfield:~0` },
    ),
  );
  return m;
}

const none: AskJev = async (req) => ({
  model: "jev-test",
  answers: Object.fromEntries(Object.entries(req.questions).map(([id]) => [id, { choice: req.purpose === "ask.scope" ? "asks" : "none", confidence: 0.95 }])),
  inputTokens: 1,
  latencyMs: 1,
  costUsd: 0,
});
const maker = (pick: (s: IntentSnapshot) => Partial<AskIntent>): IntentMaker => ({
  name: "heads",
  async make(s) {
    return { intent: { route: "fill", why: "none", scope: "list", section: "none", fields: [], sources: ["any"], whose: "user", literals: [], ...pick(s) }, use: { maker: "heads", model: "test", calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1 } };
  },
});

describe("PV1 records, from the redacted view", () => {
  it("an Ask that finds nothing names the field as the redacted view does, never by a line it dropped", async () => {
    const m = desk();
    const e = await planAsk("fill the staging field", m, { values: () => [] }, [], { askJev: none, maker: maker((s) => ({ fields: s.fields.map((f) => f.ref) })), writer: null, offerKey: "pv2", windowId: "form", now: 2000 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(String((e as Error).message)).not.toContain(SECRET_LABEL);
    // The refusal's record (its detail) names the field the same way.
    expect(JSON.stringify(e)).not.toContain(SECRET_LABEL);
  });

  it("keeps each field's record as a digest of what the redacted view shows, never its text", () => {
    const m = new ScreenModel();
    m.apply(snap([node(`${P}/webarea:~0`, "AXWebArea", { label: "Apply" }), field(`${P}/textfield:email~0`, "elena.vance@example.com", { parent: `${P}/webarea:~0`, label: "Email" })], { at: 1000, windowId: "form", title: "Apply" }));
    const fp = fieldFingerprint(m.windows.get("form") as WindowState, `${P}/textfield:email~0`);
    expect(fp).toMatch(/^[0-9a-f]{64}$/u);
    expect(fp).not.toContain("elena");
    // A field the redacted view removes (its nearest label is a dropped marker line) records as gone, never by its text.
    expect(fieldFingerprint(desk().windows.get("form") as WindowState, `${P}/textfield:~0`)).toBe("gone");
  });
});
