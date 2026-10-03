// Findings from the independent review of B12's fill and privacy path (B13), each as the case the
// reviewer traced. A Jev stand-in picks the right value when it is offered and a decoy otherwise, as
// live Jev did in B11's replay. All text is synthetic.
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates } from "../src/fill/candidates.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { fieldTerms } from "../src/fill/kinds.ts";
import { SnippetLedger } from "../src/privacy.ts";
import type { AppRef, FillProposal } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { field, snap, text, value } from "./builders.ts";
import { FORM_KEY, MESSAGES, SCHEDULE_FORM as FORM, scheduleForm } from "./desks.ts";

const CALENDAR: AppRef = { pid: 6363, bundleId: "dev.caret.calendar", name: "Calendar" };
const NOTES: AppRef = { pid: 6464, bundleId: "dev.caret.notes", name: "Notes" };
const CHAT = "8181-7";
const MEETING = "October 8, 2026";
const DECOY = "September 28, 2026";

/** A calendar window, not a conversation, that offers one date the form does not want. */
const calendar = (at: number) =>
  snap([text("cal/statictext:0~0", `Dentist ${DECOY}`)], { at, windowId: "6363-1", title: "Calendar", app: CALENDAR, focused: true, values: [value("date", DECOY, "cal/statictext:0~0")] });

/** Picks, for each field, the first of its listed values that is offered: the right one, else a decoy. Both asks alike. */
function fallthrough(want: Record<string, readonly string[]>): AskJev {
  return async (req) => {
    const answers: Record<string, { choice: string; confidence: number }> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const label = Object.keys(want).find((l) => String(q.instructions).includes(`'${l}'`));
      const hit = (want[label ?? ""] ?? []).map((t) => Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${t}"`))?.[0]).find((c) => c !== undefined);
      answers[id] = { choice: hit ?? "none", confidence: 0.9 };
    }
    return { model: "jev-test", answers, inputTokens: 1, latencyMs: 1, costUsd: 0 };
  };
}

const fieldOf = (p: FillProposal, label: string) => p.fields.find((f) => f.key === FORM_KEY(label));

describe("B13 review: no wrong fill from a partial set", () => {
  it("F1: a value sent only as another candidate's fact does not make its kind whole", async () => {
    // The chat's title is the meeting date. Its time fits the budget and carries the title as a fact;
    // the date, with its long label, does not fit.
    const m = new ScreenModel();
    m.apply(calendar(500));
    const label = "Date we agreed on for the design review with the whole team";
    m.apply(
      snap([text(`${CHAT}/t`, "3:45 PM"), field(`${CHAT}/d`, MEETING, { label })], {
        at: 1000,
        windowId: CHAT,
        title: MEETING,
        app: MESSAGES,
        values: [value("time", "3:45 PM", `${CHAT}/t`), value("date", MEETING, `${CHAT}/d`)],
      }),
    );
    m.apply(scheduleForm(2000, ["Meeting date", "Start time"]));
    const ledger = new SnippetLedger(m.windows.values());
    const { candidates, cut } = collectCandidates(m, FORM, { now: 3000, ledger, fields: [fieldTerms(["Meeting date"]), fieldTerms(["Start time"])] });
    expect(cut).toContain(CHAT);
    expect(candidates.map((c) => c.text)).not.toContain(MEETING);
    expect(ledger.snippets.some((s) => s.text === MEETING)).toBe(true);
    const p = await proposeFill(m, fallthrough({ "Meeting date": [MEETING, DECOY], "Start time": ["3:45 PM"] }), FORM, FORM_KEY("Meeting date"), 3000);
    expect(fieldOf(p, "Meeting date")?.value).toBeNull();
    expect(fieldOf(p, "Meeting date")?.withheld).toBe("sourceCut");
  });

  it("F2: a cut date that carries a clock time withholds time fields too", async () => {
    // "3:45 PM" is an unrelated time that fits; the meeting, "October 8, 2026 at 3:00 PM", is typed as one
    // date and does not fit under its long group label.
    const m = new ScreenModel();
    const group = "Design review with the whole product team, agreed in this thread";
    m.apply(
      snap(
        [
          text(`${CHAT}/t`, "Gym at 3:45 PM"),
          { key: `${CHAT}/g`, parent: null, role: "AXGroup", label: group },
          text(`${CHAT}/m`, `${MEETING} at 3:00 PM`, undefined, `${CHAT}/g`),
        ],
        { at: 1000, windowId: CHAT, title: "Dana", app: MESSAGES, values: [value("time", "3:45 PM", `${CHAT}/t`), value("date", `${MEETING} at 3:00 PM`, `${CHAT}/m`)] },
      ),
    );
    m.apply(scheduleForm(2000, ["Start time"]));
    const ledger = new SnippetLedger(m.windows.values());
    const { candidates, cut } = collectCandidates(m, FORM, { now: 3000, ledger, fields: [fieldTerms(["Start time"])] });
    expect(cut).toContain(CHAT);
    expect(candidates.map((c) => c.text)).toContain("3:45 PM");
    expect(candidates.map((c) => c.text)).not.toContain(`${MEETING} at 3:00 PM`);
    const p = await proposeFill(m, fallthrough({ "Start time": ["3:00 PM", "3:45 PM"] }), FORM, FORM_KEY("Start time"), 3000);
    expect(fieldOf(p, "Start time")?.value).toBeNull();
    expect(fieldOf(p, "Start time")?.withheld).toBe("sourceCut");
  });

  it("F3: a chat the candidate cap stops partway through is reported cut", async () => {
    // A calendar offers one decoy date; the chat's 79 times fill the cap of 80 before its meeting date.
    const m = new ScreenModel();
    const times = Array.from({ length: 79 }, (_, i) => `${10 + Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}`);
    const nodes = times.map((t, i) => text(`${CHAT}/t${i}`, t));
    const pad = Array.from({ length: 20 }, (_, i) => text(`${CHAT}/p${i}`, `a longer filler message, number ${i}, about where to have lunch today`));
    const values = times.map((t, i) => value("time", t, `${CHAT}/t${i}`));
    nodes.push(text(`${CHAT}/d`, `Review on ${MEETING}`));
    values.push(value("date", MEETING, `${CHAT}/d`));
    m.apply(snap([...nodes, ...pad], { at: 1000, windowId: CHAT, title: "Dana", app: MESSAGES, focused: true, values }));
    m.apply(calendar(1500));
    m.apply(scheduleForm(2000, ["Start time", "Meeting date"]));
    const ledger = new SnippetLedger(m.windows.values());
    const { candidates, cut } = collectCandidates(m, FORM, { now: 3000, ledger, fields: [fieldTerms(["Start time"]), fieldTerms(["Meeting date"])] });
    expect(candidates).toHaveLength(80);
    expect(candidates.map((c) => c.text)).toContain(DECOY);
    expect(candidates.map((c) => c.text)).not.toContain(MEETING);
    expect(cut).toContain(CHAT);
    const p = await proposeFill(m, fallthrough({ "Meeting date": [MEETING, DECOY] }), FORM, FORM_KEY("Start time"), 3000);
    expect(fieldOf(p, "Meeting date")?.value).toBeNull();
    expect(fieldOf(p, "Meeting date")?.withheld).toBe("sourceCut");
  });

  it("F4: a field whose label names no kind is not asked after a cut, so an untyped decoy cannot fill it", async () => {
    // Thirteen dates are more than the chat's budget; a note offers the untyped "Design review".
    const m = new ScreenModel();
    const lines = Array.from({ length: 12 }, (_, i) => `Shipped September ${i + 10}, 2026`);
    lines.push(`Review ${MEETING}`, "See you all there");
    m.apply(snap(lines.map((l, i) => text(`${CHAT}/m${i}`, l)), { at: 1000, windowId: CHAT, title: "Dana", app: MESSAGES, values: lines.flatMap((l, i) => (/\d{4}/.test(l) ? [value("date", l.slice(l.search(/September|October/)), `${CHAT}/m${i}`)] : [])) }));
    m.apply(snap([text("notes/0", "Design review")], { at: 1200, windowId: "6464-1", title: "Notes", app: NOTES }));
    m.apply(scheduleForm(2000, ["When"]));
    const jev = fallthrough({ When: [MEETING, "Design review"] });
    const p = await proposeFill(m, jev, FORM, FORM_KEY("When"), 3000);
    expect(fieldOf(p, "When")?.value).toBeNull();
    expect(fieldOf(p, "When")?.withheld).toBe("sourceCut");
    // B12 asked it, and the untyped pick went through.
    const b12 = await proposeFill(m, jev, FORM, FORM_KEY("When"), 3000, { unknownKindRule: false });
    expect(fieldOf(b12, "When")?.value).toBe("Design review");
  });
});
