// J1 part A2: a field's value question leaves out the window candidates its own kind check would withhold if picked
// (fill.ts controlValue's wrongKind: kinds.ts misfit, or the wrong part of a value), so a fill request no longer
// carries every candidate in every field's question. With the shared options sent once (fill/jev.ts wireBody) these
// lists of ids were 35% of the corpus's fill bodies, and half of the field-candidate pairs in them were misfits
// (evidence/screen/j1/probe/trim-sim.txt).
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { misfit } from "../src/fill/kinds.ts";
import { field, MAIL_APP, snap, text, value } from "./builders.ts";

const FORM = "5150-1";
const SRC = "6160-1";
const k = (s: string) => `dev.caret.fixture/standard/${s}`;

function desk(): ScreenModel {
  const m = new ScreenModel();
  m.apply(
    snap(
      [
        text("m/statictext:order~0", "Order number: ORD-2026-48213", [20, 40, 300, 18]),
        text("m/statictext:sig~0", "Dana Whitfield\ndana.whitfield@example.com\n(415) 555-0162", [20, 70, 300, 54]),
        text("m/statictext:when~0", "Thursday, October 8, 2026 at 3:00 PM", [20, 140, 300, 18]),
      ],
      {
        at: 1000,
        windowId: SRC,
        title: "Order confirmation",
        app: MAIL_APP,
        values: [
          value("id", "ORD-2026-48213", "m/statictext:order~0"),
          value("email", "dana.whitfield@example.com", "m/statictext:sig~0"),
          value("phone", "(415) 555-0162", "m/statictext:sig~0"),
          value("date", "Thursday, October 8, 2026 at 3:00 PM", "m/statictext:when~0"),
        ],
      },
    ),
  );
  m.apply(
    snap(
      [
        field(k("textfield:email~0"), "", { label: "Email address", frame: [120, 40, 240, 22] }),
        field(k("textfield:phone~0"), "", { label: "Phone number", frame: [120, 80, 240, 22] }),
        field(k("textfield:order~0"), "", { label: "Order number", frame: [120, 120, 240, 22] }),
      ],
      { at: 2000, windowId: FORM, title: "Claim form", focused: true },
    ),
  );
  return m;
}

/** Records every value request and picks, for each field, the candidate whose quoted text `want` names. */
function recording(want: Record<string, string>): { ask: AskJev; reqs: JevRequest[] } {
  const reqs: JevRequest[] = [];
  return {
    reqs,
    ask: async (req) => {
      reqs.push(req);
      const answers: Record<string, { choice: string; confidence: number }> = {};
      for (const [id, q] of Object.entries(req.questions)) {
        const label = /Label: '([^']+)'/u.exec(String(q.instructions))?.[1] ?? "";
        const v = want[label];
        const hit = v === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${v}"`))?.[0];
        answers[id] = { choice: hit ?? "none", confidence: 0.95 };
      }
      return { model: "test", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
    },
  };
}

const quoted = (d: string | null): string | null => (d === null ? null : (/^"([^"]*)"/u.exec(d)?.[1] ?? null));

describe("a fill's value questions", () => {
  it("offer a text field no window candidate its kind check would refuse", async () => {
    const r = recording({});
    await proposeFill(desk(), r.ask, FORM, k("textfield:email~0"), 5000, { rand: () => 0 });
    expect(r.reqs.length).toBeGreaterThan(0);
    for (const req of r.reqs) {
      for (const q of Object.values(req.questions)) {
        const label = /Label: '([^']+)'/u.exec(String(q.instructions))?.[1];
        if (label === undefined) continue;
        for (const d of Object.values(q.criteria)) {
          const t = quoted(d);
          if (t !== null) expect(misfit(t, [label]), `${label} was offered '${t}'`).toBeNull();
        }
      }
    }
    const email = r.reqs.find((x) => x.questions.f1 !== undefined)?.questions.f1;
    expect(Object.values(email?.criteria ?? {}).map(quoted)).toContain("dana.whitfield@example.com");
    expect(Object.values(email?.criteria ?? {}).map(quoted)).not.toContain("(415) 555-0162");
  });

  it("fill the same values as before for an engine that picks the right ones", async () => {
    const p = await proposeFill(desk(), recording({ "Email address": "dana.whitfield@example.com", "Phone number": "(415) 555-0162", "Order number": "ORD-2026-48213" }).ask, FORM, k("textfield:email~0"), 5000, { rand: () => 0 });
    expect(p.fields.map((f) => [f.descriptor.includes("Email") ? "email" : f.descriptor.includes("Phone") ? "phone" : "order", f.value])).toEqual([
      ["email", "dana.whitfield@example.com"],
      ["phone", "(415) 555-0162"],
      ["order", "ORD-2026-48213"],
    ]);
  });
});
