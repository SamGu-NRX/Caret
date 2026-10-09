// b-032's shape in the fill path: the user's own email offered for a field that asks for someone else's (Reference 2
// email). The verifier judges exactness and answered "exact" at 0.85 to 0.89 in W2's eval, so it is no defence here;
// the owner veto is (fill.ts otherPerson). A page form beside the forty task's note and mail, with a scripted Jev that
// picks the user's email for the field and answers each whose question as the case says. All values are synthetic.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { proposeFill } from "../src/fill/fill.ts";
import { aboutKind, type AboutValue } from "../src/fill/about.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { writtenFields } from "../src/offers/fill-popup.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot, type Snapshot } from "../src/protocol.ts";
import { optionIs } from "./builders.ts";

const TASKS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "fixtures", "web-form", "tasks", "expect");
type Mail = { from: string; to: string; subject: string; body: string };
const forty = (JSON.parse(readFileSync(join(TASKS, "forty.json"), "utf8")) as { sources: { note: string; email: Mail; memory: { key: string; value: string }[] } }).sources;
const memory: AboutValue[] = forty.memory.flatMap((m, i) => {
  const kind = aboutKind(m.key, m.value);
  return kind === null ? [] : [{ id: `about-${i + 1}`, label: m.key, value: m.value, kind }];
});
const USERS = "jo.abernathycole@example.com";

const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const WIN = "page:eng1:7";
const control = (id: string, name: string): PageControl => ({ id, key: `form[apply]/text:${name.toLowerCase()}~0`, strongKey: null, kind: "text", role: "text", name, form: "form#apply", rect: [0, Number(id.slice(1)) * 30, 100, 20], value: "" });
const keyOf = (c: PageControl): string => `f0/${c.key}`;

function mailWindow(m: Mail): Snapshot {
  const footer = ["You are receiving this message because you volunteered with the Riverside Food Bank this season.", "To change how often we write to you, reply with the word settings and a coordinator will help.", "Riverside Food Bank, 214 Mill Street, open Tuesday to Saturday from nine in the morning until four."];
  const lines = [`From: ${m.from}`, `To: ${m.to}`, `Subject: ${m.subject}`, m.body, ...footer];
  return {
    type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 800, reason: "initial", app: { pid: 7002, bundleId: "com.apple.mail", name: "Mail" },
    window: { windowId: "task-mail", kind: "standard", title: m.subject, frame: [0, 520, 900, 640] }, focused: false, root: null,
    nodes: lines.map((t, n) => ({ key: `com.apple.mail/standard/statictext:~${n}`, parent: null, role: "AXStaticText", value: t, frame: [20, 560 + n * 24, 860, 18] })),
    values: [], focusedKey: null, stats: { walkMs: 0, visited: lines.length, truncated: false },
  };
}
/** The note the user just left, with the user's own email added on a line of its own, as b-032's source had it. */
const noteWindow = (text: string): Snapshot => ({
  type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 900, reason: "initial", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" },
  window: { windowId: "w4-note", kind: "standard", title: "Application details.txt", frame: [0, 0, 700, 500] }, focused: true, root: null,
  nodes: [{ key: "com.apple.TextEdit/standard/textarea:~0", parent: null, role: "AXTextArea", value: text, editable: true }], values: [], focusedKey: null, stats: { walkMs: 0, visited: 1, truncated: false },
});
function desk(controls: PageControl[]): ScreenModel {
  const page: PageSnapshot = {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/apply", navGen: 1, title: "Apply", headings: ["Apply"], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [], focused: { frameId: 0, id: controls[0]?.id ?? "e1", selection: [0, 0] },
  };
  const m = new ScreenModel();
  m.apply(mailWindow(forty.email));
  m.apply(noteWindow(`${forty.note}\nEmail: ${USERS}`));
  m.apply(toWindowSnapshot(page, session, 1));
  return m;
}

type Answer = { choice: string; confidence: number };
/** Jev: every value question picks the user's email; whose-details answers come from `whose` (by ask), whose-value from `owner`. */
function scripted(whose: (ask: number) => Answer, owner: (ask: number) => Answer): { ask: AskJev; whoseAsked: () => number } {
  let n = 0;
  let whoseAsked = 0;
  const ask: AskJev = async (req) => {
    const which = n++ % 2;
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      if (id.endsWith("_whose")) ((answers[id] = whose(which)), whoseAsked++);
      else if (id.endsWith("_owner")) answers[id] = owner(which);
      else answers[id] = { choice: Object.entries(q.criteria).find(([, d]) => optionIs(d, USERS))?.[0] ?? "none", confidence: 0.95 };
    }
    return { model: "scripted", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  return { ask, whoseAsked: () => whoseAsked };
}
const ref = control("e1", "Reference 2 email");
const fill = async (whose: (ask: number) => Answer, owner: (ask: number) => Answer, about: AboutValue[] = []) => {
  const j = scripted(whose, owner);
  const p = await proposeFill(desk([ref]), j.ask, WIN, keyOf(ref), 2000, { about });
  const row = p.fields.find((f) => f.key === keyOf(ref));
  return { value: writtenFields(p).fields.find((f) => f.key === keyOf(ref))?.value ?? null, withheld: row?.withheld ?? null, whoseAsked: j.whoseAsked() };
};
const same = (a: Answer) => () => a;
const split = (a: Answer, b: Answer) => (ask: number) => (ask === 0 ? a : b);
const OTHER: Answer = { choice: "other", confidence: 0.9 };
const USER: Answer = { choice: "user", confidence: 0.9 };

describe("b-032: the user's email offered for Reference 2 email", () => {
  it("is withheld when both asks say the field wants someone else's and the value is the user's", async () => {
    const r = await fill(same(OTHER), same(USER));
    expect(r.whoseAsked).toBeGreaterThan(0);
    expect(r.value).toBeNull();
  });

  it("is withheld when memory says the email is the user's, whatever the owner asks say", async () => {
    for (const owner of [same(USER), same({ choice: "other", confidence: 0.9 }), same({ choice: "unclear", confidence: 0.5 })]) {
      expect((await fill(same(OTHER), owner, memory)).value).toBeNull();
    }
  });

  it("is withheld when the field's whose answers agree on someone else only below the whose cutoff", async () => {
    // Before the mirror rule (fill.ts otherPerson) both of these wrote the user's email.
    for (const about of [[], memory]) {
      const r = await fill(same({ choice: "other", confidence: 0.4 }), same(USER), about);
      expect(r.value).toBeNull();
      expect(r.withheld).toBe("otherPerson");
    }
  });

  it("is withheld when the field's whose answers split between someone else and the user", async () => {
    // Lead decision (Oct 9): never the user's own detail in a field one wording took for another person's.
    const cases: [(ask: number) => Answer, AboutValue[]][] = [[split(OTHER, USER), []], [split(USER, OTHER), memory], [split({ choice: "other", confidence: 0.3 }, { choice: "unclear", confidence: 0.6 }), memory]];
    for (const [whose, about] of cases) {
      const r = await fill(whose, same(USER), about);
      expect(r.value).toBeNull();
    }
  });

  it("writes it when both asks say the field wants the user's, so each case above differs only in the whose answers", async () => {
    // The control: the same desk, picks and owner answers. Above, where both asks say the field wants someone else's at
    // the cutoff, the veto keeps the email out of the field's options (optionsOf), so its value questions answer none;
    // here it is offered and written. (Without memory the owner judgement didn't see the whole note, so HA2 holds it.)
    expect((await fill(same(USER), same(USER), memory)).value).toBe(USERS);
  });
});
