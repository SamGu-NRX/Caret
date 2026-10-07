// Findings from the independent review of B12's fill and privacy path (B13), each as the case the
// reviewer traced. A Jev stand-in picks the right value when it is offered and a decoy otherwise, as
// live Jev did in B11's replay. All text is synthetic.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Helper } from "../src/helper.ts";
import { Store } from "../src/store.ts";
import { recheckFill, writtenFields } from "../src/offers/fill-popup.ts";
import { loadRecording } from "./socket-reader.ts";
import { ScreenModel } from "../src/model.ts";
import { collectCandidates, setGeneratorClock } from "../src/fill/candidates.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { fieldTerms } from "../src/fill/kinds.ts";
import { SnippetLedger, WINDOW_CHARS, windowBudget } from "../src/privacy.ts";
import { targetSnippets } from "../src/executor/target.ts";
import { conversationSign } from "../src/conversation.ts";
import { PROTOCOL_VERSION, type AppRef, type FillProposal, type HelperMessage, type ReaderMessage, type ReaderVerb, type Snapshot, type VerbResult } from "../src/protocol.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { field, snap, text, value } from "./builders.ts";
import { FORM_KEY, MESSAGES, SCHEDULE_FORM as FORM, chatWindow, notesWindow, scheduleForm } from "./desks.ts";
import { minted } from "./mint.ts";

// The generator's time budget reads a fixed clock here, so a loaded machine cannot stop it partway and
// change an answer these tests check (candidates.ts setGeneratorClock).
beforeAll(() => setGeneratorClock(() => 0));
afterAll(() => setGeneratorClock(null));

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

  it("F3: a window the candidate cap stops partway through is reported cut", async () => {
    // A calendar offers one decoy date; a note's 79 times fill the cap of 80 before its meeting date. (In
    // a conversation the kinds go in whole or not at all, so there the cap leaves a kind out instead.)
    const m = new ScreenModel();
    const times = Array.from({ length: 79 }, (_, i) => `${10 + Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}`);
    const nodes = times.map((t, i) => text(`${CHAT}/t${i}`, t));
    // Enough filler that the note is large (privacy.ts): a short note held to half its text is read by relevance
    // since B24, which leaves the times out as a group rather than letting the cap stop partway.
    const pad = Array.from({ length: 40 }, (_, i) => text(`${CHAT}/p${i}`, `a longer filler message, number ${i}, about where to have lunch today`));
    const values = times.map((t, i) => value("time", t, `${CHAT}/t${i}`));
    nodes.push(text(`${CHAT}/d`, `Review on ${MEETING}`));
    values.push(value("date", MEETING, `${CHAT}/d`));
    m.apply(snap([...nodes, ...pad], { at: 1000, windowId: CHAT, title: "Dana", app: NOTES, focused: true, values }));
    m.apply(calendar(1500));
    const labels = ["Start time", "Meeting date"];
    m.apply(scheduleForm(2000, labels));
    const ledger = new SnippetLedger(m.windows.values());
    // No time budget, so only the cap stops it: under a loaded test run the 15 ms clock can stop it first.
    const { candidates, cut } = collectCandidates(m, FORM, { now: 3000, ledger, fields: labels.map((l) => fieldTerms([l])), budgetMs: Number.POSITIVE_INFINITY });
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

describe("B13 second review: the fixes' own gaps", () => {
  it("a field of no kind is not asked when a cut took an untyped line", async () => {
    // The chat's only line is the name; with its title it is more than the chat's budget.
    const m = new ScreenModel();
    m.apply(snap([text(`${CHAT}/n`, "Name: Dana Whitfield")], { at: 1000, windowId: CHAT, title: "Thread with Dana Whitfield", app: MESSAGES }));
    m.apply(snap([text("notes/0", "Name: Alex Raman")], { at: 1200, windowId: "6464-1", title: "Notes", app: NOTES }));
    m.apply(scheduleForm(2000, ["Name"]));
    const jev = fallthrough({ Name: ["Dana Whitfield", "Alex Raman"] });
    const p = await proposeFill(m, jev, FORM, FORM_KEY("Name"), 3000);
    expect(fieldOf(p, "Name")?.value).toBeNull();
    expect(fieldOf(p, "Name")?.withheld).toBe("sourceCut");
  });

  it("a field of no kind is still asked beside a cut chat that says nothing about it", async () => {
    // The fill desk: a mail card, private notes, and a team chat too long for its budget, about tables.
    const m = new ScreenModel();
    for (const x of [notesWindow(500), chatWindow(600), ...loadRecording("offers-fill.ndjson")]) if (x.type === "snapshot") m.apply(x);
    const values: Record<string, string[]> = { Name: ["Dana Whitfield"], Email: ["dana.whitfield@example.com"], Phone: ["+1 (512) 555-0142"] };
    const p = await proposeFill(m, fallthrough(values), "5150-2", "dev.caret.fixture/standard/textfield:name~0", 4000);
    expect(p.fields.map((f) => f.value)).toEqual(["Dana Whitfield", "dana.whitfield@example.com", "+1 (512) 555-0142"]);
  });

  it("an email cut from a chat is not made whole by a longer address that ends the same", async () => {
    const m = new ScreenModel();
    m.apply(snap([text(`${CHAT}/e`, "Email: a@example.com"), text(`${CHAT}/k`, "ok")], { at: 1000, windowId: CHAT, title: "Kofi", app: MESSAGES, values: [value("email", "a@example.com", `${CHAT}/e`)] }));
    m.apply(snap([text("notes/0", "dana@example.com")], { at: 1200, windowId: "6464-1", title: "Notes", app: NOTES, values: [value("email", "dana@example.com", "notes/0")] }));
    m.apply(scheduleForm(2000, ["Email"]));
    const ledger = new SnippetLedger(m.windows.values());
    const { candidates, cut } = collectCandidates(m, FORM, { now: 3000, ledger, fields: [fieldTerms(["Email"])] });
    expect(cut).toContain(CHAT);
    expect(candidates.map((c) => c.text)).toContain("dana@example.com");
    expect(candidates.map((c) => c.text)).not.toContain("a@example.com");
    const p = await proposeFill(m, fallthrough({ Email: ["a@example.com", "dana@example.com"] }), FORM, FORM_KEY("Email"), 3000);
    expect(fieldOf(p, "Email")?.value).toBeNull();
    expect(fieldOf(p, "Email")?.withheld).toBe("sourceCut");
  });
});

describe("B13 review: executor plan text", () => {
  it("F8: a goal cut one or two characters into a sourced value charges them", () => {
    const m = new ScreenModel();
    m.apply(snap([text(`${CHAT}/a`, "abcd")], { at: 1000, windowId: CHAT, title: "", app: MESSAGES }));
    m.apply(scheduleForm(2000, ["Notes"]));
    const chat = m.windows.get(CHAT)!;
    expect(windowBudget(chat)).toBe(1);
    // 117 characters, then the value: cut to 120, the goal ends "ab…".
    const goal = `${"The Notes field of the follow-up form holds the code that the chat gave for the meeting room, which is ".padEnd(117, ".")}abcd`;
    const form = m.windows.get(FORM)!;
    const t = { role: "AXTextField", label: "Notes", describe: "the Notes field" };
    expect(targetSnippets(form, m.windows.values(), goal, t, [], [{ text: "abcd", window: chat }])).toBeNull();
    // A goal that does not quote the value asks.
    expect(targetSnippets(form, m.windows.values(), "The Notes field holds the room code", t, [], [{ text: "abcd", window: chat }])).not.toBeNull();
  });
});

describe("B13 review: mail read in a browser is a conversation", () => {
  const CHROME: AppRef = { pid: 9191, bundleId: "com.google.Chrome", name: "Google Chrome" };
  const MAIL = ["From: Dana Whitfield", "Subject: Design review", "Please use dana@example.com for the invitation."];
  const page = (title: string, lines: readonly string[], app: AppRef = CHROME) => {
    const m = new ScreenModel();
    m.apply(snap(lines.map((l, i) => text(`web/${i}`, l)), { at: 1000, windowId: "9191-1", title, app }));
    return m.windows.get("9191-1")!;
  };

  it("F6: a Gmail tab with no reply box and no clock times keeps more than half of itself back", () => {
    // The reviewer's case: as a short card of values it had the whole 1,200 characters.
    const w = page("Design review - Gmail", ["Dana Whitfield", "Design review", "Please use dana@example.com for the invitation."]);
    expect(conversationSign(w)).toBe("webConversation");
    // 95 characters in all, so just under half of them.
    expect(windowBudget(w)).toBe(47);
  });

  it("F6: a mail's header in a browser page is a conversation, whatever the site", () => {
    expect(conversationSign(page("Re: design review", MAIL))).toBe("mailHeader");
  });

  it("F6: leaves a document that names a site in passing, and a mail shown by an app that is not a browser, to the other signs", () => {
    const doc = page("Q4 outlook - Google Docs", ["Revenue outlook for Q4", "Slack adoption grew", "Notes from the planning call"]);
    expect(conversationSign(doc)).toBeNull();
    expect(windowBudget(doc)).toBe(WINDOW_CHARS);
    expect(conversationSign(page("Re: design review", MAIL, NOTES))).toBeNull();
  });
});

describe("B13 review: a field that changes meaning while Jev answers", () => {
  const EMAIL = "dev.caret.fixture/standard/textfield:email~0";
  const VALUES: Record<string, string> = { Name: "Dana Whitfield", Email: "dana.whitfield@example.com" };

  it("F9: drops a field whose descriptor changed while Jev answered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caret-b13-"));
    const store = new Store(dir);
    let release = (): void => {};
    const gate = new Promise<void>((r) => (release = r));
    let asked = 0;
    const answer = fallthrough({ Name: [VALUES.Name as string], Email: [VALUES.Email as string] });
    const askJev: AskJev = async (req) => {
      asked++;
      await gate;
      return answer(req);
    };
    const published: HelperMessage[] = [];
    const okReader = { run: async (v: ReaderVerb): Promise<VerbResult> => ({ type: "verbResult", v: PROTOCOL_VERSION, id: v.kind, at: 0, outcome: "ok", detail: null }) };
    const helper = new Helper({ store, askJev, shadow: false, allowBackgroundFocus: true, readerLink: okReader, publish: (m) => published.push(m) });
    try {
      const rec = loadRecording("offers-fill.ndjson");
      // The focus's fill waits on the gate, so the replay is not awaited until Jev is let answer.
      const replayed = (async () => {
        for (const m of rec) {
          await helper.handleReader(m);
          if ("at" in m) helper.tick(m.at);
        }
      })();
      for (let i = 0; i < 100 && asked < 2; i++) await new Promise((r) => setTimeout(r, 5));
      expect(asked).toBe(2);
      // The app reuses the Email field's key for a Work phone field while Jev answers.
      const form = rec.find((m): m is Snapshot => m.type === "snapshot" && m.window.windowId === "5150-2") as Snapshot;
      const relabelled: ReaderMessage = { ...form, at: 3200, nodes: form.nodes.map((n) => (n.key === EMAIL ? { ...n, label: "Work phone" } : n)) };
      await helper.handleReader(relabelled);
      release();
      await replayed;
      await new Promise((r) => setTimeout(r, 20));
      const p = published.find((m): m is FillProposal => m.type === "fillProposal");
      expect(p).toBeDefined();
      expect(p?.fields.map((f) => f.key)).not.toContain(EMAIL);
      expect(p?.fields.find((f) => f.value === VALUES.Name)).toBeDefined();
    } finally {
      helper.shutdown();
      helper.memory.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("F9: recheckFill refuses a proposal whose field reads differently now", async () => {
    const m = new ScreenModel();
    const rec = loadRecording("offers-fill.ndjson");
    for (const msg of rec) if (msg.type === "snapshot") m.apply(msg);
    const form = rec.find((x): x is Snapshot => x.type === "snapshot" && x.window.windowId === "5150-2") as Snapshot;
    const src = rec.find((x): x is Snapshot => x.type === "snapshot" && x.window.windowId === "6160-1") as Snapshot;
    const emailNode = src.values.find((v) => v.kind === "email");
    expect(emailNode).toBeDefined();
    // I1 (c25943e, AC1's one provenance recheck): a mint records the lines its value was read from, and one with none
    // never holds (contract.ts provenanceStale), so this mint reads them from `m`, as fill's own mints do (test/mint.ts).
    const p = writtenFields(await minted({
      type: "fillProposal",
      v: PROTOCOL_VERSION,
      id: "p1",
      at: 3100,
      pid: form.app.pid,
      windowId: "5150-2",
      bundleId: form.app.bundleId,
      triggerKey: EMAIL,
      fields: [
        {
          key: EMAIL,
          control: "text",
          handoff: null,
          frame: null,
          descriptor: "Text field. Label: 'Email'.",
          choice: "c1",
          confidence: 0.9,
          value: emailNode!.text,
          source: { pid: src.app.pid, windowId: "6160-1", bundleId: src.app.bundleId, appName: src.app.name, windowTitle: src.window.title, nodeKey: emailNode!.nodeKey, kind: "email" },
          withheld: null,
          asks: [],
        },
      ],
      candidates: 1,
      jev: { model: "t", latencyMs: 0, inputTokens: 0, costUsd: 0 },
      cutoff: 0.75,
    } as unknown as FillProposal, m));
    expect(recheckFill(m, p, () => null)).toBeNull();
    m.apply({ ...form, at: 3200, nodes: form.nodes.map((n) => (n.key === EMAIL ? { ...n, label: "Work phone" } : n)) });
    expect(recheckFill(m, p, () => null)).toBe(`the field ${EMAIL} now reads differently`);
  });
});

describe("B13: candidate facts", () => {
  it("does not label a web address with the email line above it, and keeps a real label", () => {
    const m = new ScreenModel();
    const sig = (key: string, label: string, y: number) => text(`sig/${key}`, label, [100, y, 240, 18]);
    m.apply(
      snap([sig("name", "Dana Whitfield", 60), sig("email", "dana@example.com", 120), sig("url", "https://example.com/dana", 140), sig("label", "Website", 200), sig("url2", "https://example.com/docs", 220)], {
        at: 1000,
        windowId: "6464-1",
        title: "Notes",
        app: NOTES,
        values: [value("email", "dana@example.com", "sig/email"), value("url", "https://example.com/dana", "sig/url"), value("url", "https://example.com/docs", "sig/url2")],
      }),
    );
    m.apply(scheduleForm(2000, ["Website"]));
    const by = new Map(collectCandidates(m, FORM, { now: 3000 }).candidates.map((c) => [c.text, c]));
    expect(by.get("https://example.com/dana")?.context).toBeNull();
    expect(by.get("https://example.com/docs")?.context).toBe("Website");
  });
});
