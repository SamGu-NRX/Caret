// L1: a page segment's view carries, per row, where its value came from (`source`) and, for a host that declared
// sourceExcerpts, a crop of that source's text with the value's span marked (`excerpt`); and the plan's left items with
// a structured reason (`left`), which the panel draws as a hatch or a dotted blank. Every name and value is invented.
import { afterEach, describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { pageView } from "../src/goals/page-view.ts";
import { goalDigest, type GoalPlan, type GoalSegment, type GoalStep, type LeftItem, type ValueBinding } from "../src/goals/plan.ts";
import type { AppRef, GoalPageView, Node } from "../src/protocol.ts";
import { field, snap } from "./builders.ts";
import { c, chrome, mixedControls, TEXTEDIT, WIN } from "./fake-page.ts";
import { closeRigs, rig, type Segment } from "./page-rig.ts";

afterEach(() => closeRigs());

type Row = GoalPageView["rows"][number] & { source?: { kind: string; name: string }; excerpt?: { text: string; start: number; end: number; name: string; edited: number | null; tab?: { title: string; host: string } } };
type View = GoalPageView & { rows: Row[]; left?: { label: string; why: string; says: string }[] };
type Options = { excerpts: boolean; sourceModel?: ScreenModel; aboutNow?: (id: string) => { value: string; label: string } | null; site?: (windowId: string) => string | null };
const view = pageView as unknown as (m: ScreenModel, p: GoalPlan, s: GoalSegment, o: Options) => View | undefined;

const NOTE_ID = "7001-1";
const TAB_ID = "page:eng1:9";

function model(o: { note?: string; tab?: string; tabTitle?: string } = {}): ScreenModel {
  const m = new ScreenModel();
  m.apply(snap([field("form/text:email~0", "", { role: "AXTextField" })], { at: 1, windowId: WIN, title: "Apply", app: chrome as AppRef, kind: "page" }));
  if (o.note !== undefined) m.apply(snap([field("te/note", o.note, { role: "AXTextArea" })], { at: 1, windowId: NOTE_ID, title: "Robin's details.txt", app: TEXTEDIT as AppRef }));
  if (o.tab !== undefined) m.apply(snap([{ key: "f0/text:about~0", parent: null, role: "AXStaticText", value: o.tab } as Node], { at: 1, windowId: TAB_ID, title: o.tabTitle ?? "Robin Vale - Profile", app: chrome as AppRef, kind: "page" }));
  return m;
}

function value(text: string, from: { window?: string; key?: string; memory?: string; span?: string; context?: string | null } = {}): ValueBinding {
  return {
    ref: "p1",
    text,
    display: text,
    origin: { kind: "span", snapshot: "s1", source: "x", startUTF16: 0, endUTF16: text.length, digest: "d" },
    source: from.window === undefined ? null : { windowId: from.window, key: from.key ?? "te/note", revision: "r" },
    memory: from.memory ?? null,
    event: null,
    draft: null,
    owner: null,
    fill: { span: from.span ?? text, context: from.context ?? null, control: "text" },
  } as ValueBinding;
}

function plan(v: ValueBinding, left: LeftItem[] = []): { plan: GoalPlan; seg: GoalSegment } {
  const domain = { kind: "window" as const, windowId: WIN, pid: chrome.pid, bundleId: chrome.bundleId, appName: chrome.name, title: "Apply", number: null, windowKind: "page", page: true };
  const step = { ref: "s1", index: 0, kind: "write", says: `Email: ${v.text}`, target: { ref: "t1", domain, key: "form/text:email~0", role: "AXTextField", label: "Email", own: "Email", placeholder: null, control: "text", value: "", options: null }, value: v, writes: v.text, effect: null, handoff: null, to: false, gate: "fill" } as GoalStep;
  const seg = { index: 0, domain, reason: "start", steps: [step], plan: {}, slots: {}, digest: "x" } as unknown as GoalSegment;
  const p = { goalId: "g1", instruction: "fill", programHash: "h", page: { windowId: WIN, scope: {}, kind: "all", section: null, keys: [] }, segments: [seg], warnings: [], left, digest: "d", inventory: {} } as unknown as GoalPlan;
  return { plan: p, seg };
}

const rowOf = (m: ScreenModel, v: ValueBinding, o: Partial<Options> = {}): Row | undefined => {
  const { plan: p, seg } = plan(v);
  return view(m, p, seg, { excerpts: true, ...o })?.rows[0];
};

describe("a row's source and excerpt from a native window", () => {
  const NOTE = ["Robin Vale", "Email: robin@example.test", "Phone: 555 0100"].join("\n");

  it("crops the window's text around the value, its offsets on the span, named by the window's title", () => {
    const r = rowOf(model({ note: NOTE }), value("robin@example.test", { window: NOTE_ID }));
    expect(r?.source).toEqual({ kind: "window", name: "TextEdit" });
    const x = r?.excerpt;
    expect(x).toMatchObject({ text: NOTE, name: "Robin's details.txt", edited: null });
    expect(x?.text.slice(x.start, x.end)).toBe("robin@example.test");
    expect(x).not.toHaveProperty("tab");
    expect(x).not.toHaveProperty("pdf");
  });

  it("keeps at most six whole lines, about as many before as after", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: value ${i}`);
    const r = rowOf(model({ note: lines.join("\n") }), value("value 10", { window: NOTE_ID }));
    const x = r?.excerpt;
    const got = x?.text.split("\n") ?? [];
    expect(got).toHaveLength(6);
    expect(x?.text.slice(x.start, x.end)).toBe("value 10");
    const at = got.indexOf("Line 10: value 10");
    expect(at === 2 || at === 3).toBe(true);
    expect(lines.join("\n")).toContain(x?.text);
  });

  it("keeps at most 600 characters, dropping the far lines first", () => {
    const lines = Array.from({ length: 9 }, (_, i) => `${i}`.repeat(150));
    lines[4] = `${"4".repeat(70)}needle${"4".repeat(74)}`;
    const r = rowOf(model({ note: lines.join("\n") }), value("needle", { window: NOTE_ID }));
    const x = r?.excerpt;
    expect(x?.text.length).toBeLessThanOrEqual(600);
    expect(x?.text.split("\n")).toEqual([lines[3], lines[4], lines[5]]);
    expect(x?.text.slice(x.start, x.end)).toBe("needle");
  });

  it("takes a 600-character window of a line longer than that, with no ellipsis", () => {
    const line = `${"a".repeat(1000)}needle${"b".repeat(1000)}`;
    const x = rowOf(model({ note: `first\n${line}\nlast` }), value("needle", { window: NOTE_ID }))?.excerpt;
    expect(x?.text).toHaveLength(600);
    expect(x?.text).not.toContain("…");
    expect(x?.text).not.toContain("\n");
    expect(x?.text.slice(x.start, x.end)).toBe("needle");
  });

  it("has no excerpt for a span longer than 600", () => {
    const long = "z".repeat(601);
    const r = rowOf(model({ note: `x\n${long}\ny` }), value(long, { window: NOTE_ID }));
    expect(r?.source).toEqual({ kind: "window", name: "TextEdit" });
    expect(r).not.toHaveProperty("excerpt");
  });

  it("prefers the span's occurrence at or after its line's label", () => {
    const text = ["Home email: robin@example.test", "Work email: robin@example.test"].join("\n");
    const x = rowOf(model({ note: text }), value("robin@example.test", { window: NOTE_ID, context: "Work email" }))?.excerpt;
    expect(x?.start).toBe(text.indexOf("Work email") + "Work email: ".length);
    expect(x?.text.slice(x.start, x.end)).toBe("robin@example.test");
  });

  it("marks fill's span, not the value the control takes", () => {
    const text = "Start: October 20, 2026";
    const x = rowOf(model({ note: text }), value("2026-10-20", { window: NOTE_ID, span: "October 20, 2026" }))?.excerpt;
    expect(x?.text.slice(x.start, x.end)).toBe("October 20, 2026");
  });

  it("has no excerpt when the span is not in the window's text, and never guesses", () => {
    const r = rowOf(model({ note: NOTE }), value("robin@other.test", { window: NOTE_ID }));
    expect(r?.source).toEqual({ kind: "window", name: "TextEdit" });
    expect(r).not.toHaveProperty("excerpt");
  });

  it("has a source and no excerpt when the host did not ask for excerpts", () => {
    const r = rowOf(model({ note: NOTE }), value("robin@example.test", { window: NOTE_ID }), { excerpts: false });
    expect(r?.source).toEqual({ kind: "window", name: "TextEdit" });
    expect(r).not.toHaveProperty("excerpt");
  });

  it("reads the source from the goal's source model when it has one", () => {
    const sources = model({ note: NOTE });
    const r = rowOf(model(), value("robin@example.test", { window: NOTE_ID }), { sourceModel: sources });
    expect(r?.excerpt?.name).toBe("Robin's details.txt");
  });
});

describe("a row's source and excerpt from a tab", () => {
  const TEXT = "Robin Vale\nEmail: robin@example.test";

  it("is kind tab, named by the browser, with the tab's title and host", () => {
    const r = rowOf(model({ tab: TEXT }), value("robin@example.test", { window: TAB_ID, key: "f0/text:about~0" }), { site: (id) => (id === TAB_ID ? "https://people.example.test/robin" : null) });
    expect(r?.source).toEqual({ kind: "tab", name: chrome.name });
    expect(r?.excerpt).toMatchObject({ name: "Robin Vale - Profile", tab: { title: "Robin Vale - Profile", host: "people.example.test" } });
    expect(r?.excerpt?.text.slice(r.excerpt.start, r.excerpt.end)).toBe("robin@example.test");
  });

  it("keeps the excerpt without `tab` when the tab's address is unknown or unreadable", () => {
    for (const site of [() => null, () => "not a url"]) {
      const r = rowOf(model({ tab: TEXT }), value("robin@example.test", { window: TAB_ID, key: "f0/text:about~0" }), { site });
      expect(r?.source?.kind).toBe("tab");
      expect(r?.excerpt?.name).toBe("Robin Vale - Profile");
      expect(r?.excerpt).not.toHaveProperty("tab");
    }
  });
});

describe("a row's source and excerpt from memory and from the request", () => {
  it("crops what the user told Caret, named by the entry's label", () => {
    const aboutNow = (id: string) => (id === "mem-1" ? { value: "Robin Vale", label: "Name" } : null);
    const r = rowOf(model(), value("Robin Vale", { memory: "mem-1" }), { aboutNow });
    expect(r?.source).toEqual({ kind: "memory", name: "" });
    expect(r?.excerpt).toEqual({ text: "Robin Vale", start: 0, end: 10, name: "Name", edited: null });
  });

  it("marks a part of an entry, and has none for an entry that is gone", () => {
    const aboutNow = (id: string) => (id === "mem-1" ? { value: "Robin Vale", label: "Name" } : null);
    const part = rowOf(model(), value("Vale", { memory: "mem-1#last" }), { aboutNow })?.excerpt;
    expect(part?.text.slice(part.start, part.end)).toBe("Vale");
    const gone = rowOf(model(), value("Robin Vale", { memory: "mem-2" }), { aboutNow });
    expect(gone?.source).toEqual({ kind: "memory", name: "" });
    expect(gone).not.toHaveProperty("excerpt");
  });

  it("names the request, with no excerpt", () => {
    const r = rowOf(model(), value("Canada"));
    expect(r?.source).toEqual({ kind: "request", name: "" });
    expect(r).not.toHaveProperty("excerpt");
  });
});

describe("the view's left items", () => {
  const item = (label: string, mark: string | undefined, windowId = WIN): LeftItem => ({ windowId, key: label, label, why: "dropped", says: `'${label}' is yours: something`, ...(mark === undefined ? {} : { mark }) }) as LeftItem;

  it("are this page's left items that have a reason the panel draws, each with its warning's sentence", () => {
    const { plan: p, seg } = plan(value("Canada"), [item("Why here?", "answer"), item("Gender", "identity"), item("SSN", "sensitive"), item("Nickname", "notFound"), item("Shift", undefined), item("Other", "notFound", "7001-9")]);
    expect(view(model(), p, seg, { excerpts: false })?.left).toEqual([
      { label: "Why here?", why: "answer", says: "'Why here?' is yours: something." },
      { label: "Gender", why: "identity", says: "'Gender' is yours: something." },
      { label: "SSN", why: "sensitive", says: "'SSN' is yours: something." },
      { label: "Nickname", why: "notFound", says: "'Nickname' is yours: something." },
    ]);
  });

  it("are absent when none has such a reason", () => {
    const { plan: p, seg } = plan(value("Canada"), [item("Shift", undefined)]);
    expect(view(model(), p, seg, { excerpts: false })).not.toHaveProperty("left");
  });
});

describe("the page planner marks why it leaves a field", () => {
  const QUESTION = "Why do you want to work here?";

  it("a written answer and a kind Caret never types", async () => {
    const r = await rig({
      controls: () => [...mixedControls().slice(0, 2), c("e20", "textarea", QUESTION, { value: "" }), c("e21", "text", "Social Security number", { value: "" }), ...mixedControls().slice(2)],
      jev: (inner) => async (req) => {
        const a = await inner(req);
        for (const [id, q] of Object.entries(req.questions)) {
          const ins = typeof q.instructions === "string" ? q.instructions : JSON.stringify(q.instructions);
          if (ins.includes(QUESTION)) a.answers[id] = { choice: Object.keys(q.criteria).find((k) => k !== "none") ?? "none", confidence: 0.3 };
        }
        return a;
      },
    });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    const left = (preview.page as View | undefined)?.left ?? [];
    expect(left.find((x) => x.label === QUESTION)).toEqual({ label: QUESTION, why: "answer", says: `'${QUESTION}' is yours to write: Caret doesn't write answers.` });
    expect(left.find((x) => x.label === "Social Security number")?.why).toBe("sensitive");
    // Each `says` is the sentence the item contributes to the warnings, unchanged.
    for (const x of left) expect(preview.warnings).toContain(x.says);
    // A field Caret was unsure of has no structured reason, so no row here.
    expect(left.some((x) => x.label === "Are you over 18?")).toBe(false);
    // The marks are on the kept plan's left items, and its digest is still its program, segments and warnings alone.
    const kept = r.helper.goals.planOf(preview.goalId);
    expect(kept?.left.map((l) => l.mark).filter((m) => m !== undefined)).toEqual(expect.arrayContaining(["answer", "sensitive"]));
    expect(kept === null ? null : goalDigest(kept.programHash, kept.segments.map((x) => x.digest), kept.warnings)).toBe(kept?.digest);
  });

  it("a field with nothing to fill it: a self-identification question, and any other", async () => {
    const r = await rig({ goalFiles: true, note: "", controls: () => [c("e1", "text", "Gender", { value: "" }), c("e2", "text", "Nickname", { value: "" }), c("e13", "file", "Resume", { value: "" })] });
    const preview = (await r.ask("fill out this form from my note")) as Segment;
    expect(preview.event).toBe("segment");
    const left = (preview.page as View | undefined)?.left ?? [];
    expect(left.map((x) => [x.label, x.why])).toEqual([
      ["Gender", "identity"],
      ["Nickname", "notFound"],
    ]);
    for (const x of left) expect(preview.warnings).toContain(x.says);
  });
});
