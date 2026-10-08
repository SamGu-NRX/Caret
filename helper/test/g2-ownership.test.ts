import { beforeEach as vercelBeforeEach, afterEach as vercelAfterEach, vi as vercelVi } from "vitest";
// G2: fill's ownership stage, end to end through proposeFill on a page form with the task pages' sources as
// page-loop-eval.ts replays them (a Mail window, then the note the user just left). Jev is a script that answers each
// question by rule and records every request. Imports nothing G2 added, so the same file runs on the code before G2,
// where the tests marked "G2" fail (evidence/screen/g2/whose/ownership-before.txt). Every value is synthetic.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ScreenModel } from "../src/model.ts";
import { memoryWrites, proposeFill } from "../src/fill/fill.ts";
import type { AboutValue } from "../src/fill/about.ts";
import { aboutKind } from "../src/fill/about.ts";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { toWindowSnapshot } from "../src/engines/page-link.ts";
import { EngineSession } from "../src/engines/session.ts";
import { buildFillPopup, fillPlan, recheckFields, recheckFill, writtenFields } from "../src/offers/fill-popup.ts";
import { holds as holdsAfter } from "./recheck.ts";
import { provenanceStale } from "../src/fill/contract.ts";
import { PROTOCOL_VERSION, type PageControl, type PageSnapshot, type Snapshot } from "../src/protocol.ts";
import { assertNoExcludedValue, SecretInRequest } from "../src/privacy.ts";
import { Disclosure, OutOfShape, UnmintedText, type ModelText } from "../src/privacy/disclosure.ts";
import { redactWindow } from "../src/fill/redact.ts";
import { headsRequest, scopeRequest } from "../src/planner/intent-heads.ts";
import { intentSnapshot } from "../src/planner/intent.ts";
import { jevIntentMaker, writerIntentMaker } from "../src/planner/intent-makers.ts";
import { planWithCode } from "../src/planner/codeplan.ts";
import { planTask } from "../src/planner/planner.ts";
import { PlannerError } from "../src/planner/validate.ts";
import { macClock } from "../src/offers/event-time.ts";
import { planGoal } from "../src/goals/propose.ts";
import { GoalError } from "../src/goals/lower.ts";
import { gatewayRoute } from "../src/writer/routes.ts";
import type { WriterPort, WriterRequest } from "../src/writer/port.ts";
import { bareLine, lineDigests } from "../src/fill/line-values.ts";
import { secretText as holdsSecret } from "../src/memory/sensitive.ts";
import { nodeText } from "../src/model.ts";
import { buildDesk, loadCorpus } from "../scripts/realfill-corpus.ts";

const HELPER = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const REALFILL = join(HELPER, "..", "fixtures", "realfill");
const TASKS = join(HELPER, "..", "fixtures", "web-form", "tasks", "expect");
type Mail = { from: string; to: string; subject: string; body: string };
const expectation = (page: string): { sources: { note: string; email: Mail; memory: { key: string; value: string }[] } } => JSON.parse(readFileSync(join(TASKS, `${page}.json`), "utf8"));
const memoryOf = (page: string): AboutValue[] =>
  expectation(page).sources.memory.flatMap((m, i) => {
    const kind = aboutKind(m.key, m.value);
    return kind === null ? [] : [{ id: `about-${i + 1}`, label: m.key, value: m.value, kind }];
  });

const chrome = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const session = new EngineSession({ engine: "eng1", browser: chrome, extensionId: "kcmlnoabcdefghijklmnopabcdefghij", bridgeVersion: "0", connectedAt: 0 }, () => true);
const WIN = "page:eng1:7";
const control = (id: string, name: string, kind: PageControl["kind"] = "text"): PageControl => ({ id, key: `form[apply]/${kind}:${name.toLowerCase()}~0`, strongKey: null, kind, role: kind, name, form: "form#apply", rect: [0, Number(id.slice(1)) * 30, 100, 20], value: "" });
const keyOf = (c: PageControl): string => `f0/${c.key}`;

/** page-loop-eval.ts's mailWindow: the header lines, then the body as one static text. */
function mailWindow(m: Mail, extra: string[] = []): Snapshot {
  const lines = [`From: ${m.from}`, `To: ${m.to}`, ...extra, `Subject: ${m.subject}`, m.body];
  return {
    type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 800, reason: "initial", app: { pid: 7002, bundleId: "com.apple.mail", name: "Mail" },
    window: { windowId: "task-mail", kind: "standard", title: m.subject, frame: [0, 520, 900, 640] }, focused: false, root: null,
    nodes: lines.map((t, n) => ({ key: `com.apple.mail/standard/statictext:~${n}`, parent: null, role: "AXStaticText", value: t, frame: [20, 560 + n * 24, 860, 18] })),
    values: [], focusedKey: null, stats: { walkMs: 0, visited: lines.length, truncated: false },
  };
}
/** page-loop-eval.ts's noteWindow, focused before the form: the window the user just left. */
const noteWindow = (text: string): Snapshot => ({
  type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 900, reason: "initial", app: { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" },
  window: { windowId: "w4-note", kind: "standard", title: "Application details.txt", frame: [0, 0, 700, 500] }, focused: true, root: null,
  nodes: [{ key: "com.apple.TextEdit/standard/textarea:~0", parent: null, role: "AXTextArea", value: text, editable: true }], values: [], focusedKey: null, stats: { walkMs: 0, visited: 1, truncated: false },
});
function desk(controls: PageControl[], sources: Snapshot[]): ScreenModel {
  const page: PageSnapshot = {
    type: "pageSnapshot", v: PROTOCOL_VERSION, id: "w1", at: 1000, tabId: 7, browserWindowId: 1, active: true, inFocusedWindow: true, title: "Apply",
    frames: [{ frameId: 0, parentFrameId: -1, documentId: "D0", origin: "http://127.0.0.1:4310", path: "/apply", navGen: 1, title: "Apply", headings: ["Apply"], iframes: [], excluded: {}, truncated: false, controls }],
    missing: [], focused: { frameId: 0, id: controls[0]?.id ?? "e1", selection: [0, 0] },
  };
  const m = new ScreenModel();
  for (const s of sources) m.apply(s);
  m.apply(toWindowSnapshot(page, session, 1));
  return m;
}

type Answer = { choice: string; confidence: number };
/**
 * Scripted Jev. `pick` names the value each field takes by its label (the option whose description starts with it);
 * `owner` answers a whose-value question by the value's text and the ask (0 or 1); every whose-details question says
 * the user's at 0.95. Records every request.
 */
function scripted(pick: Record<string, string>, owner: (text: string, ask: number) => Answer): { ask: AskJev; requests: JevRequest[] } {
  const requests: JevRequest[] = [];
  let n = 0;
  const ask: AskJev = async (req) => {
    requests.push(req);
    const which = n++ % 2;
    const answers: Record<string, Answer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      const ins = String(q.instructions);
      if (id.endsWith("_whose")) answers[id] = { choice: "user", confidence: 0.95 };
      else if (id.endsWith("_owner")) answers[id] = owner(/"(.*?)" \(/su.exec(ins)?.[1] ?? "", which);
      else {
        const label = /Label: '(.+?)'\./u.exec(ins)?.[1];
        const want = label === undefined ? undefined : pick[label];
        const hit = want === undefined ? undefined : Object.entries(q.criteria).find(([, d]) => d?.startsWith(`"${want}"`))?.[0];
        answers[id] = { choice: hit ?? "none", confidence: 0.95 };
      }
    }
    return { model: "scripted", answers, inputTokens: 0, latencyMs: 0, costUsd: 0 };
  };
  return { ask, requests };
}
const ownerQuestions = (requests: JevRequest[]): string[] => requests.flatMap((r) => Object.entries(r.questions).filter(([id]) => id.endsWith("_owner")).map(([, q]) => String(q.instructions)));
const ownerQuestionOf = (requests: JevRequest[], text: string): string | undefined => ownerQuestions(requests).find((q) => q.includes(`"${text}" (`));
const written = (p: Awaited<ReturnType<typeof proposeFill>>, key: string): string | null => writtenFields(p).fields.find((f) => f.key === key)?.value ?? null;

describe("exact identity, decided by code (G2)", () => {
  const forty = expectation("forty").sources;
  const email = control("e1", "Email");

  it("G2: writes the user's own To: address in Email although both asks call it someone else's, and asks nothing about it", async () => {
    // LV1 pass 1, forty: the To: address jo.abernathycole@example.com, the user's "primary email" from memory, was
    // called other at 0.70/0.65 and excluded from Email's question.
    const { ask, requests } = scripted({ Email: "jo.abernathycole@example.com" }, () => ({ choice: "other", confidence: 0.8 }));
    const p = await proposeFill(desk([email], [mailWindow(forty.email), noteWindow(forty.note)]), ask, WIN, keyOf(email), 2000, { about: memoryOf("forty") });
    expect(written(p, keyOf(email))).toBe("jo.abernathycole@example.com");
    expect(ownerQuestionOf(requests, "jo.abernathycole@example.com")).toBeUndefined();
  });

  it("never writes someone else's value that matches nothing in the user's identity, whatever Jev says short of both asks calling it the user's", async () => {
    // Memory holds the user's jo.abernathycole@example.com; the mail's sender writes from a near miss and the note holds
    // the husband's. Neither is the user's identity, so code decides nothing and the owner questions are asked.
    const m: Mail = { ...forty.email, from: "Jo Abernathy <jo.abernathycole@example.net>" };
    for (const want of ["jo.abernathycole@example.net", "marcus.cole@example.net"]) {
      const answers: ((text: string, ask: number) => Answer)[] = [
        () => ({ choice: "other", confidence: 0.9 }),
        () => ({ choice: "other", confidence: 0.3 }),
        () => ({ choice: "unclear", confidence: 0.9 }),
        (_, a) => ({ choice: a === 0 ? "user" : "other", confidence: 0.9 }),
        (_, a) => ({ choice: a === 0 ? "user" : "unclear", confidence: 0.9 }),
        () => ({ choice: "user", confidence: 0.3 }),
      ];
      for (const owner of answers) {
        const { ask, requests } = scripted({ Email: want }, (text, a) => (text === want ? owner(text, a) : { choice: "user", confidence: 0.95 }));
        const p = await proposeFill(desk([email], [mailWindow(m), noteWindow(forty.note)]), ask, WIN, keyOf(email), 2000, { about: memoryOf("forty") });
        expect(written(p, keyOf(email)), `${want}, ${owner("", 0).choice}/${owner("", 1).choice}`).not.toBe(want);
        expect(ownerQuestionOf(requests, want)).toBeDefined();
      }
    }
  });
});

describe("structural evidence in whose-value questions (G2)", () => {
  const forty = expectation("forty").sources;
  const fields = [control("e1", "Email"), control("e2", "Mobile phone"), control("e3", "City"), control("e4", "Emergency contact phone"), control("e5", "Full name")];
  const ownerAsk = async (mail: Mail, extra: string[] = [], about: AboutValue[] = []): Promise<JevRequest[]> => {
    const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
    await proposeFill(desk(fields, [mailWindow(mail, extra), noteWindow(forty.note)]), ask, WIN, keyOf(fields[0] as PageControl), 2000, { about });
    return requests;
  };

  it("G2: says a To: value is the mail's only recipient, and that the address is the user's own when memory says so", async () => {
    const header = "Jo Abernathy-Cole <jo.abernathycole@example.com>";
    const plain = await ownerAsk(forty.email);
    for (const t of [header, "Jo Abernathy-Cole", "jo.abernathycole@example.com"]) expect(ownerQuestionOf(plain, t), t).toContain("the only recipient on the To: line of this mail");
    expect(ownerQuestionOf(plain, "Elena Varga")).not.toContain("Where it sits");
    // With the user's email in memory the To: address is decided by code and not asked; the name and the header beside
    // it are still asked, now with both facts.
    const told = await ownerAsk(forty.email, [], memoryOf("forty"));
    expect(ownerQuestionOf(told, "jo.abernathycole@example.com")).toBeUndefined();
    for (const t of [header, "Jo Abernathy-Cole"]) {
      expect(ownerQuestionOf(told, t), t).toContain("the only recipient on the To: line of this mail");
      expect(ownerQuestionOf(told, t), t).toContain("a To: line whose address is the email the user told Caret is theirs");
    }
  });

  it("gives a mail with several recipients, or a Cc:, no structural evidence", async () => {
    const several = await ownerAsk({ ...forty.email, to: "Jo Abernathy-Cole <jo.abernathycole@example.com>, Tamsin Reyes <tamsin.reyes@example.org>" });
    for (const t of ["jo.abernathycole@example.com", "tamsin.reyes@example.org"]) expect(ownerQuestionOf(several, t), t).toBeDefined();
    // HA2: the form's address fields also ask whose the mail's other lines are (its Subject included); only the To: line's
    // values are about recipients here.
    for (const q of ownerQuestions(several).filter((x) => x.includes("Mail window") && x.includes("labelled 'To'"))) expect(q).not.toContain("Where it sits");
    const cc = await ownerAsk(forty.email, ["Cc: Tamsin Reyes <tamsin.reyes@example.org>"]);
    for (const q of ownerQuestions(cc).filter((x) => x.includes("labelled 'To'"))) expect(q).not.toContain("only recipient");
  });

  it("gives no recipient evidence to a mail the user sent, by the From: address in memory", async () => {
    const sent = await ownerAsk({ ...forty.email, from: "Jo Abernathy-Cole <jo.abernathycole@example.com>", to: "Elena Varga <elena.varga@example.org>" }, [], memoryOf("forty"));
    for (const t of ["Elena Varga", "elena.varga@example.org"]) {
      expect(ownerQuestionOf(sent, t), t).toBeDefined();
      expect(ownerQuestionOf(sent, t), t).not.toContain("only recipient");
    }
  });

  it("G2: says which note sentences name someone else; HA2: never that a sentence names no other person", async () => {
    const r = await ownerAsk(forty.email);
    const alone = "names no other person";
    const other = "it is in a sentence that names someone other than the user";
    // HA2: one sentence can't say whose a value is, so code no longer claims it (whose.ts header).
    for (const q of ownerQuestions(r)) expect(q).not.toContain(alone);
    expect(ownerQuestionOf(r, "555-0164")).not.toContain("Where it sits");
    expect(ownerQuestionOf(r, "555-0171")).toContain(other);
    expect(ownerQuestionOf(r, "marcus.cole@example.net")).toContain(other);
    expect(ownerQuestionOf(r, "Marcus Cole")).toContain(other);
  });

  it("reads the sentence, not the line: the user's cell beside a warning about the parents' landline", async () => {
    const w = expectation("wizard-1").sources;
    const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
    const phone = control("e1", "Phone");
    await proposeFill(desk([phone], [mailWindow(w.email), noteWindow(w.note)]), ask, WIN, keyOf(phone), 2000);
    const own = ownerQuestions(requests).find((q) => q.includes(`"555-0147" (`));
    expect(own).not.toContain("names someone other than the user");
  });
});

describe("a date's or a contact's clause (G2)", () => {
  const descriptions = (requests: JevRequest[]): string[] => requests.flatMap((r) => Object.values(r.questions).flatMap((q) => Object.values(q.criteria).filter((d) => typeof d === "string")));

  // Passes before G2 too: on a two-field page the old rule's long-line clause fits. On F1's walked Greenhouse page the
  // note's budget was spent before any clause, and these dates went out bare (evidence/screen/g2/whose/probe-*.json).
  it("shows the School line's dates with the words that make one the start and one the end", async () => {
    const g = expectation("greenhouse").sources;
    const { ask, requests } = scripted({}, () => ({ choice: "user", confidence: 0.95 }));
    const start = control("e1", "Start date year");
    await proposeFill(desk([start, control("e2", "End date year")], [mailWindow(g.email), noteWindow(g.note)]), ask, WIN, keyOf(start), 2000);
    const sept = descriptions(requests).find((d) => d.startsWith(`"September 2016" (`));
    expect(sept).toMatch(/in the line '[^']*September 2016 to May 2020/u);
  });

  it("G2: shows 'August 2022' with the sentence that says it is when the job started, where budget is left after every span", async () => {
    const w = expectation("wizard-2").sources;
    const ask = async (note: string): Promise<string | undefined> => {
      const { ask: jev, requests } = scripted({}, () => ({ choice: "user", confidence: 0.95 }));
      const start = control("e1", "Start date");
      await proposeFill(desk([control("e0", "Employer"), start], [mailWindow(w.email), noteWindow(note)]), jev, WIN, keyOf(start), 2000, { about: memoryOf("wizard-2") });
      return descriptions(requests).find((d) => d.startsWith(`"August 2022" (`));
    };
    // A note of the job line alone leaves budget once its spans are in, and the clause part goes out.
    const job = w.note.split("\n").filter((l) => l.includes("Tallgrass")).join("\n");
    expect(await ask(job)).toContain("in the line 'Started at Tallgrass Mechatronics in August 2022'");
    // On F1's whole note the spans spend the budget first, and the clause, optional context, does not go (G2 review:
    // charged earlier, clauses pushed values out). wizard-2's Start date gets no clause from this change.
    expect(await ask(w.note)).not.toContain("Started at Tallgrass");
  });
});

describe("a field that asks for no person's details, offered memory (G2)", () => {
  it("G2: asks whose job title Job title wants, not whose name or email", async () => {
    const w = expectation("wizard-2").sources;
    const { ask, requests } = scripted({}, () => ({ choice: "user", confidence: 0.95 }));
    const title = control("e1", "Job title");
    await proposeFill(desk([title], [mailWindow(w.email), noteWindow(w.note)]), ask, WIN, keyOf(title), 2000, { about: memoryOf("wizard-2") });
    const q = requests.flatMap((r) => Object.entries(r.questions)).find(([id]) => id.endsWith("_whose"));
    expect(q?.[1].instructions).toContain("the user's own job title");
    expect(q?.[1].instructions).not.toContain("name or email");
  });
});

describe("G2 review findings", () => {
  const forty = expectation("forty").sources;
  const SAM: AboutValue = { id: "about-email", label: "Email", value: "sam.rivera@example.com", kind: "email" };

  it("1: a just-left note's 'Email:' label never stands in for its owner, in a field that wants the user's email", async () => {
    const email = control("e1", "Email");
    const note = noteWindow("Contact details\nEmail: marcus.cole@example.net");
    for (const scoped of [false, true]) {
      const run = async (owner: Answer): Promise<string | null> => {
        const { ask } = scripted({ Email: "marcus.cole@example.net" }, () => owner);
        const scope = scoped ? { fields: [keyOf(email)], windows: null, memory: true, instruction: "fill out this form", person: null, literals: new Map(), wholeForm: true } : undefined;
        const p = await proposeFill(desk([email], [note]), ask, WIN, keyOf(email), 2000, { about: [SAM], ...(scope === undefined ? {} : { scope }) });
        return written(p, keyOf(email));
      };
      expect(await run({ choice: "unclear", confidence: 0.95 }), `scoped ${scoped}`).toBeNull();
      expect(await run({ choice: "user", confidence: 0.3 }), `scoped ${scoped}`).toBeNull();
      // Both asks calling it the user's at the cutoff still writes it: the owner is settled, by Jev.
      expect(await run({ choice: "user", confidence: 0.95 }), `scoped ${scoped}`).toBe("marcus.cole@example.net");
    }
  });

  it("2: a line that holds a secret contributes nothing to a request, not even its email", async () => {
    const email = control("e1", "Email");
    // Short enough to go out whole as a "Label: value" span, as the review's repro is.
    for (const line of ["Email: robin@example.test password: hunter2 for the staging service", "Email: robin@example.test password: secret@example.test"]) {
      const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
      await proposeFill(desk([email], [noteWindow(`Notes\n${line}\nName: Robin Vale`)]), ask, WIN, keyOf(email), 2000);
      const sent = JSON.stringify(requests.map((r) => [r.state, r.questions, r.snippets]));
      for (const t of ["hunter2", "secret@example.test", "robin@example.test", "password"]) expect(sent, `${line}: ${t}`).not.toContain(t);
      expect(sent).toContain("Robin Vale");
    }
  });

  it("3: a value that is the user's identity keeps its memory entry: the recheck, the pop-up's ref and the write all name it", async () => {
    const email = control("e1", "Email");
    const about = memoryOf("forty");
    const entry = about.find((a) => a.value === "jo.abernathycole@example.com") as AboutValue;
    const { ask } = scripted({ Email: "jo.abernathycole@example.com" }, () => ({ choice: "unclear", confidence: 0.5 }));
    const m = desk([email], [mailWindow(forty.email), noteWindow(forty.note)]);
    const p = await proposeFill(m, ask, WIN, keyOf(email), 2000, { about });
    const f = p.fields.find((x) => x.key === keyOf(email));
    expect(f?.basis?.identity).toEqual({ memoryId: entry.id, kind: "email", key: "jo.abernathycole@example.com" });
    const g = writtenFields(p);
    expect(recheckFill(m, g, (id) => (id === entry.id ? entry : null))).toBeNull();
    expect(recheckFill(m, g, () => null)).toContain(entry.id);
    expect(recheckFill(m, g, (id) => (id === entry.id ? { ...entry, value: "jo.cole@example.com" } : null))).toContain(entry.id);
    expect(JSON.stringify(buildFillPopup(m, g))).toContain(`{"memory":"${entry.id}"}`);
    expect(fillPlan(m, g).plan.steps[0]).toMatchObject({ memory: `${entry.id}~identity` });
  });

  it("4: neither To: fact for several recipients, a Cc: or a mail the user sent, with the user's email in memory", async () => {
    const fields = [control("e1", "Email"), control("e2", "Full name")];
    const ownerAsk = async (mail: Mail, extra: string[] = []): Promise<JevRequest[]> => {
      const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
      await proposeFill(desk(fields, [mailWindow(mail, extra), noteWindow(forty.note)]), ask, WIN, keyOf(fields[0] as PageControl), 2000, { about: memoryOf("forty") });
      return requests;
    };
    const cases = [
      await ownerAsk({ ...forty.email, to: "Jo Abernathy-Cole <jo.abernathycole@example.com>, Tamsin Reyes <tamsin.reyes@example.org>" }),
      await ownerAsk(forty.email, ["Cc: Tamsin Reyes <tamsin.reyes@example.org>"]),
      await ownerAsk(forty.email, ["Bcc: Tamsin Reyes <tamsin.reyes@example.org>"]),
      await ownerAsk({ ...forty.email, from: "Jo Abernathy-Cole <jo.abernathycole@example.com>" }),
    ];
    for (const r of cases) {
      const mailQs = ownerQuestions(r).filter((q) => q.includes("Mail window"));
      expect(mailQs.length).toBeGreaterThan(0);
      for (const q of mailQs) expect(q).not.toContain("Where it sits");
    }
  });

  it("5: a window that shows a quoted message's headers too gives no To: evidence", async () => {
    const fields = [control("e1", "Email"), control("e2", "Full name")];
    const quoted = { ...forty.email, body: `${forty.email.body}\n\nFrom: Tamsin Reyes <tamsin.reyes@example.org>\nTo: Elena Varga <elena.varga@example.org>\nSubject: Riverside\n\nCould you vouch for Jo?` };
    const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
    await proposeFill(desk(fields, [mailWindow(quoted), noteWindow(forty.note)]), ask, WIN, keyOf(fields[0] as PageControl), 2000, { about: memoryOf("forty") });
    const mailQs = ownerQuestions(requests).filter((q) => q.includes("Mail window"));
    expect(mailQs.length).toBeGreaterThan(0);
    for (const q of mailQs) expect(q).not.toContain("To: line");
  });

  it("7: a source sentence that changed around a kept span no longer gives it", () => {
    const source = (text: string) => desk([control("e1", "City")], [noteWindow(text)]);
    const at = { windowId: "w4-note", nodeKey: "com.apple.TextEdit/standard/textarea:~0" };
    const was = "I live in Portland, Maine, not Oregon. Recruiters keep mixing that up.";
    expect(holdsAfter(source, at, was, was, "Portland, Maine")).toBe(true);
    expect(holdsAfter(source, at, was, "I no longer live in Portland, Maine, not Oregon. Recruiters keep mixing that up.", "Portland, Maine")).toBe(false);
  });
});

describe("G2 review round 2: one disclosure rule", () => {
  const forty = expectation("forty").sources;

  /** A source window of static texts and fields, each with a frame, as a reader shows a form left open in another app. */
  const sourceWindow = (nodes: Snapshot["nodes"]): Snapshot => ({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 900, reason: "initial", app: { pid: 7003, bundleId: "dev.caret.other", name: "Other" }, window: { windowId: "other", kind: "standard", title: "Setup", frame: [0, 0, 500, 300] }, focused: true, root: null, nodes, values: [], focusedKey: null, stats: { walkMs: 0, visited: nodes.length, truncated: false } }) as Snapshot;
  /** Every request a fill of a harmless "Full name" makes beside `source`; there must be some, so a miss cannot pass vacuously. */
  const requestsBeside = async (source: Snapshot): Promise<string> => {
    const name = control("e1", "Full name");
    const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
    await proposeFill(desk([name], [source, noteWindow("Name: Kenji Watanabe")]), ask, WIN, keyOf(name), 2000);
    expect(requests.length).toBeGreaterThan(0);
    const sent = JSON.stringify(requests.map((r) => [r.state, r.questions, r.snippets]));
    expect(sent).toContain("Kenji Watanabe");
    return sent;
  };

  it("1: a source field whose own label, placeholder or nearest label names a secret gives nothing, its value included", async () => {
    const f = (extra: Record<string, unknown>, value: string) => ({ key: "other/standard/textfield:~0", parent: null, role: "AXTextField", value, editable: true as const, frame: [200, 40, 160, 20] as [number, number, number, number], ...extra });
    for (const node of [f({ label: "My password is hunter2" }, "hunter2"), f({ label: "My password is hunter2" }, "Robin Vale"), f({ placeholder: "token: hunter2" }, "hunter2")]) {
      const sent = await requestsBeside(sourceWindow([node]));
      expect(sent, JSON.stringify(node)).not.toContain("hunter2");
      expect(sent, JSON.stringify(node)).not.toContain(node.value);
    }
    // A real nearest label: a static text "My PIN is" to the left of an unlabelled field holding the number, and a static
    // "PIN" above a static "7319" (no shape filter: the label holds a digit, or the value is not a field).
    const pinField = sourceWindow([
      { key: "other/standard/statictext:~0", parent: null, role: "AXStaticText", value: "My PIN is", frame: [20, 40, 120, 20] },
      { key: "other/standard/textfield:~1", parent: null, role: "AXTextField", value: "7319", editable: true, frame: [150, 40, 120, 20] },
      { key: "other/standard/statictext:~2", parent: null, role: "AXStaticText", value: "PIN 2", frame: [20, 80, 120, 20] },
      { key: "other/standard/statictext:~3", parent: null, role: "AXStaticText", value: "8462", frame: [20, 104, 120, 20] },
    ]);
    const sent = await requestsBeside(pinField);
    for (const t of ["7319", "8462", "PIN"]) expect(sent, t).not.toContain(t);
  });

  it("1: a value the anchor moves to the note the user just left never takes a block head that states a secret", async () => {
    const name = control("e1", "Full name");
    // The mail is read first (a conversation's names go before other windows' lines), then the note the user just left
    // labels the same name, and the anchor moves its description there (fill.ts labelledCandidate).
    const mail = { ...forty.email, from: "Robin Vale <robin.vale@example.test>", to: "Jo Abernathy-Cole <jo.abernathycole@example.com>", body: "Hi Jo,\nRobin Vale here, as promised.\nRobin" };
    const note = noteWindow("Password: hunter2\nName: Robin Vale");
    const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
    await proposeFill(desk([name], [mailWindow(mail), note]), ask, WIN, keyOf(name), 2000);
    const sent = JSON.stringify(requests.map((r) => [r.state, r.questions, r.snippets]));
    expect(sent).toContain("Robin Vale");
    expect(sent).not.toContain("hunter2");
  });

  it("b: a request that still carries a secret marker is refused where it is built, loudly and without the text", () => {
    // SC1: a block head the redacted view dropped is text no Disclosure minted, so sealing the request throws, naming the
    // path. The client no longer checks words on the wire (privacy.ts assertNoExcludedValue checks formats).
    const d = new Disclosure([]);
    const req = { purpose: "fill.values" as const, state: { task: d.own("t") }, questions: { f1: { type: "choice" as const, instructions: d.own("Field."), criteria: { c1: `"Robin" (in a block that starts 'Password: hunter2')` as ModelText, none: d.own("None.") } } } };
    expect(() => d.seal(req)).toThrow(UnmintedText);
    expect(() => d.seal(req)).toThrow(/questions\.f1\.criteria\.c1/u);
    try {
      d.seal(req);
    } catch (e) {
      expect(String(e)).not.toContain("hunter2");
    }
    // A value in a format Caret never carries throws at the client's last line; a marker word alone is prose there.
    expect(() => assertNoExcludedValue({ state: { task: "t" }, questions: { f1: { type: "choice", instructions: "Card: 4111 1111 1111 1111.", criteria: { none: "None." } } } })).toThrow(SecretInRequest);
    expect(() => assertNoExcludedValue({ state: { task: "t" }, questions: { f1: { type: "choice", instructions: "Field: 'Password'.", criteria: { none: "None." } } } })).not.toThrow();
  });

  // G2 round-3 review: lines that name a secret anywhere, not only as their leading label, each beside an ordinary value.
  const MARKED = ["password", "passcode", "PIN", "token", "secret", "API key", "private key", "SSN", "security code", "CVV", "access token", "routing number"].flatMap((m, i) => [
    `Email: robin${i}@example.test staging authentication ${m}: Zq${i}x7Kw`,
    `Phone: 555-01${String(10 + i)} and my ${m} is Rv${i}y3Lp`,
    `Backup ${m} = Ht${i}m2Qc for the office`,
  ]);

  it("c: over every task page and corpus form, no request carries any text unique to a line the predicate flags", async () => {
    /**
     * The values of each flagged line found in no other line of the desk's sources or memory (its tokens with a digit:
     * a secret, an email, a phone): what would show it leaked.
     */
    const tells = (sources: string[], memory: string[]): string[] => {
      const lines = sources.flatMap((t) => t.split("\n")).map(bareLine).filter((l) => l !== "");
      // A generated marked line counts as flagged whatever the predicate says, so a predicate that misses one fails here.
      const marked = (l: string): boolean => holdsSecret(l) || MARKED.includes(l);
      const flagged = lines.filter(marked);
      const rest = [...lines.filter((l) => !marked(l)), ...memory].join(" \u0000 ").toLowerCase();
      return [...new Set(flagged.flatMap((l) => l.split(/[\s,;:=]+/u)).filter((w) => w.length >= 4 && /\d/u.test(w) && !rest.includes(w.toLowerCase())))];
    };
    const check = (requests: JevRequest[], words: string[], where: string): void => {
      const sent = JSON.stringify(requests.map((r) => [r.state, r.questions, r.nouls ?? {}, r.snippets])).toLowerCase();
      for (const w of words) expect(sent.includes(w.toLowerCase()), `${where}: '${w}'`).toBe(false);
    };
    const fields = [control("e1", "Email"), control("e2", "Full name"), control("e3", "Phone"), control("e4", "Start date"), control("e5", "Notes", "textarea")];
    for (const page of ["wizard-1", "wizard-2", "reveal", "forty", "greenhouse", "ashby"]) {
      const e = expectation(page).sources;
      for (let k = 0; k < MARKED.length; k += 3) {
        const lines = e.note.split("\n");
        lines.splice(1, 0, ...MARKED.slice(k, k + 3));
        const note = lines.join("\n");
        const mail = { ...e.email, body: `${e.email.body}\n${MARKED[(k + 3) % MARKED.length]}` };
        const words = tells([note, mail.from, mail.to, mail.body], e.memory.map((m) => m.value));
        expect(words.length, page).toBeGreaterThan(0);
        const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
        await proposeFill(desk(fields, [mailWindow(mail), noteWindow(note)]), ask, WIN, keyOf(fields[0] as PageControl), 2000, { about: memoryOf(page) });
        check(requests, words, `${page} #${k}`);
      }
    }
    // The corpus's 14 forms, each with its recorded source and decoys, and a note of marked lines beside them.
    const corpus = loadCorpus(REALFILL);
    const snaps = readFileSync(join(HELPER, "fixtures", "recorded", "realfill-windows.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Snapshot);
    for (const form of corpus.forms) {
      const d = buildDesk(corpus, snaps, form);
      const secretNote = { ...noteWindow(MARKED.join("\n")), at: 999_999, window: { windowId: "secret-note", kind: "standard", title: "Accounts.txt", frame: [0, 0, 700, 500] as [number, number, number, number] } };
      d.model.apply(secretNote);
      const sources = [...d.model.windows.values()].filter((x) => x.window.windowId !== d.form.window.windowId).flatMap((x) => [...x.nodes.values()].map((n) => nodeText(n)));
      const words = tells(sources, d.about.map((a) => a.value));
      const trigger = [...d.form.nodes.values()].find((n) => n.editable === true && n.role === "AXTextField" && (n.value ?? "") === "")?.key;
      if (trigger === undefined) continue;
      const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
      try {
        await proposeFill(d.model, ask, d.form.window.windowId, trigger, 1_800_000_001_000, { about: d.about });
      } catch (err) {
        if (!(err instanceof Error && "why" in err)) throw err;
      }
      check(requests, words, form.id);
    }
  }, 60_000);

  it("2: a line that names a secret anywhere is flagged, and so is every generated one", () => {
    for (const l of ["Email: robin@example.test staging authentication PIN: 7319", "Email: robin@example.test staging token: hunter2", ...MARKED]) expect(holdsSecret(l), l).toBe(true);
    // Conservative by design (lead): "Pin it to the board" is dropped too. A word that only starts like a marker is not one.
    for (const l of ["Email: robin@example.test", "Secretary: Dana Whitfield", "Passwordless sign-in works"]) expect(holdsSecret(l), l).toBe(false);
  });
});

describe("G2 review round 2: provenance", () => {
  const forty = expectation("forty").sources;
  const KEY = "com.apple.TextEdit/standard/textarea:~0";

  it("3: a named-person Ask puts that person's email in a scoped 'Your email', and only with both asks saying it is theirs", async () => {
    const email = control("e1", "Your email");
    // The one email on screen is his, so no other rule (oneOfSeveral, personHasSeveral) has a say.
    const m = desk([email], [noteWindow("Marcus Cole\nmarcus.cole@example.net")]);
    const run = async (owner: (t: string) => Answer, person: string | null): Promise<string | null> => {
      const { ask } = scripted({ "Your email": "marcus.cole@example.net" }, (t) => owner(t));
      const scope = { fields: [keyOf(email)], windows: null, memory: true, instruction: person === null ? "fill my email" : "use Marcus's details", person, literals: new Map() };
      return written(await proposeFill(m, ask, WIN, keyOf(email), 2000, { scope }), keyOf(email));
    };
    // Only his email itself is his: the whole emergency-contact line would be a second email of his, which the Ask must
    // tell apart from the field's own words (fill.ts personHasSeveral).
    expect(await run((t) => ({ choice: t === "marcus.cole@example.net" ? "person" : "other", confidence: 0.95 }), "Marcus")).toBe("marcus.cole@example.net");
    expect(await run(() => ({ choice: "unclear", confidence: 0.95 }), "Marcus")).toBeNull();
    // Outside a named-person Ask the user-owner rule stands.
    expect(await run(() => ({ choice: "other", confidence: 0.95 }), null)).toBeNull();
  });

  it("4: a first and last name split from the user's full name name the entry and part in every execution step", async () => {
    const first = control("e1", "First Name");
    const last = control("e2", "Last Name");
    const g = expectation("greenhouse").sources;
    const about = [{ id: "about-name", label: "full name", value: "Dmitri Halvorsen", kind: "name" as const }];
    const { ask } = scripted({ "First Name": "Dmitri", "Last Name": "Halvorsen" }, () => ({ choice: "unclear", confidence: 0.5 }));
    const m = desk([first, last], [mailWindow(g.email), noteWindow(g.note)]);
    const p = await proposeFill(m, ask, WIN, keyOf(first), 2000, { about });
    const steps = fillPlan(m, writtenFields(p)).plan.steps;
    expect(steps.map((s) => (s as { memory?: string }).memory)).toEqual(["about-name#first~identity", "about-name#last~identity"]);
    expect(memoryWrites("Dmitri Halvorsen", "first", "Dmitri", "identity")).toBe(true);
    expect(memoryWrites("Dima Halvorsen", "first", "Dmitri", "identity")).toBe(false);
  });

  /** Whether `now` still gives `span` as fill read it from `was` (I1: the write contract's recheck, test/recheck.ts). */
  const holds = (was: string, now: string, span: string): boolean => holdsAfter((t) => desk([control("e1", "Phone")], [noteWindow(t)]), { windowId: "w4-note", nodeKey: KEY }, was, now, span);

  it("6: a new warning in the value's sentence, or a new sentence that holds it, refuses it", () => {
    const was = "Mobile 555-0164 (no landline anymore).";
    expect(holds(was, was, "555-0164")).toBe(true);
    expect(holds(was, "Mobile 555-0164 is my old number.", "555-0164")).toBe(false);
    expect(holds(was, "Do not use: 555-0164", "555-0164")).toBe(false);
    expect(holds(was, `${was}\nDo not use: 555-0164`, "555-0164")).toBe(false);
    const ref = "Put me down as Elena Varga; the best way to reach me is my cell, 555-0139, or this email.";
    expect(holds(ref, ref.replace("or this email.", "but not after May."), "555-0139")).toBe(false);
  });

  it("7: an unchanged value passes: a wrapped sentence, double spaces, a multiline address, a 'but' or its own label", () => {
    for (const [was, span] of [
      ["Orientation for new volunteers is Sunday,\nOctober 18, 2026, so start then.", "October 18, 2026"],
      ["Mobile  555-0164 (no landline anymore).", "555-0164"],
      ["2210 Willow Bend Drive\nApt 5B\nPortland, Oregon 97214", "Apt 5B"],
      ["Previous name: Ana Ruiz", "Ana Ruiz"],
      ["Name: Josephine Abernathy-Cole, but everyone calls me Jo.", "Josephine"],
      ["Work authorization: authorized to work in the United States. I do not need visa sponsorship.\nLocation: Oakland, California, United States", "United States"],
    ] as const) {
      expect(holds(was, was, span), was).toBe(true);
      // Trailing white space is not an edit; anything else on the lines is (lead, round 4).
      expect(holds(was, was.replace(/\n/gu, "  \n"), span), was).toBe(true);
    }
  });

  it("8: a pop-up names the identity entry of every row, past 'and N more' too", async () => {
    const fields = ["Phone", "City", "ZIP code", "Apartment", "Street", "Mobile phone", "Email"].map((n, i) => control(`e${i + 1}`, n));
    const about = memoryOf("forty");
    const entry = about.find((a) => a.value === "jo.abernathycole@example.com") as AboutValue;
    const pick: Record<string, string> = { Phone: "555-0164", City: "Portland", "ZIP code": "97214", Apartment: "Apt 5B", Street: "2210 Willow Bend Drive", "Mobile phone": "555-0164", Email: "jo.abernathycole@example.com" };
    const { ask } = scripted(pick, () => ({ choice: "user", confidence: 0.95 }));
    // HA2: the owner questions must show the whole note, and a note with a line over 80 characters is prose, of which a
    // fill on focus sends under half; its values for the user's fields are withheld (fill.ts NOTE_UNSHOWN). This test is
    // about the pop-up's rows, so it reads the note's card lines alone, which may go whole.
    const card = forty.note.split("\n").filter((l) => l.length <= 80).join("\n");
    const m = desk(fields, [mailWindow(forty.email), noteWindow(card)]);
    const p = await proposeFill(m, ask, WIN, keyOf(fields[0] as PageControl), 2000, { about });
    const g = writtenFields(p);
    expect(g.fields.length).toBeGreaterThan(5);
    const popup = JSON.stringify(buildFillPopup(m, g));
    expect(popup).toContain(`{"memory":"${entry.id}"}`);
  });
});

describe("G2 review round 3: what the recheck compares", () => {
  const KEY = "com.apple.TextEdit/standard/textarea:~0";

  it("3: digests are of the source as Jev judged it, not as the model reads after the asks", async () => {
    const email = control("e1", "Email");
    const m = desk([email], [noteWindow("Email: robin@example.test")]);
    const later = noteWindow("Email: robin@example.test is my old address");
    let changed = false;
    const { ask } = scripted({ Email: "robin@example.test" }, () => ({ choice: "user", confidence: 0.95 }));
    // The note changes while the asks are out.
    const racing: AskJev = async (req) => {
      if (!changed) {
        changed = true;
        m.apply({ ...later, at: 950 });
      }
      return ask(req);
    };
    const p = await proposeFill(m, racing, WIN, keyOf(email), 2000);
    const f = writtenFields(p).fields.find((x) => x.key === keyOf(email));
    expect(f?.checked.provenance).toMatchObject({ kind: "window", lines: lineDigests("Email: robin@example.test", "robin@example.test") });
    // So the recheck, on the note as it reads now, refuses it.
    expect(recheckFill(m, writtenFields(p), () => null)).not.toBeNull();
  });

  it("4: a value with double spaces and a full name joined from two lines recheck as unchanged, and fail once changed", async () => {
    const full = control("e1", "Full name");
    for (const [note, want, after] of [
      ["Name: Robin  Vale", "Robin Vale", "Name: Robin Vane"],
      ["First name: Kenji\nLast name: Watanabe", "Kenji Watanabe", "First name: Kenji\nLast name: Tanaka"],
    ] as const) {
      const m = desk([full], [noteWindow(note)]);
      const { ask } = scripted({ "Full name": want }, () => ({ choice: "user", confidence: 0.95 }));
      const p = await proposeFill(m, ask, WIN, keyOf(full), 2000);
      const g = writtenFields(p);
      expect(g.fields.find((x) => x.key === keyOf(full))?.value, note).toBe(want);
      expect(recheckFill(m, g, () => null), note).toBeNull();
      m.apply({ ...noteWindow(after), at: 2500 });
      expect(recheckFill(m, g, () => null), after).not.toBeNull();
    }
  });
});

describe("G2 round 4: the redacted view, generated", () => {
  /** A small seeded generator, so a failure names its case and reruns it. */
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const MARKERS = ["password", "Passcode", "PIN", "pin#", "token", "Secret", "API key", "api_key", "private key", "SSN", "security code", "CVV", "routing number", "Access-Token", "OTP"];
  const SEPS = [": ", " is ", " = ", " ", ":", " - ", " -> ", "\t", "\n"];
  const QUOTES = [["", ""], ['"', '"'], ["'", "'"], ["(", ")"], ["[", "]"], ["<", ">"], ["`", "`"]];

  it("no request carries a value planted beside a marker word, whatever the separator, quoting or role", async () => {
    const r = rng(7);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
    for (let i = 0; i < 240; i++) {
      const planted = `Qv${i}x${Math.floor(r() * 9000 + 1000)}`;
      const m = pick(MARKERS);
      const [o, c] = pick(QUOTES) as [string, string];
      const line = `${pick(["", "my ", "Staging ", "Email: robin@example.test "])}${m}${pick(SEPS)}${o}${planted}${c}`;
      const role = pick(["note", "mail", "label", "placeholder", "nearest", "cell", "cellLabel", "split", "blankOpener", "sender", "splitAttrs", "hiddenLabel"] as const);
      const at = [20, 40, 120, 20] as [number, number, number, number];
      const source: Snapshot =
        role === "note" ? noteWindow(`Notes\n${line}\nName: Kenji Watanabe`)
        : role === "sender" ? mailWindow({ from: `Robin Vale; ${m}: ${planted}`, to: "Kenji Watanabe <kenji@example.org>", subject: "Hi", body: "Name: Kenji Watanabe" })
        : role === "mail" ? mailWindow({ from: "Dana Park <dana@example.org>", to: "Kenji Watanabe <kenji@example.org>", subject: "Hi", body: `Hi Kenji,\n${line}\nDana` })
        : ({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 800, reason: "initial", app: { pid: 7003, bundleId: "dev.caret.other", name: "Other" }, window: { windowId: "other", kind: "standard", title: "Setup", frame: [0, 0, 500, 300] }, focused: false, root: null, values: [], focusedKey: null, stats: { walkMs: 0, visited: 2, truncated: false },
            nodes:
              role === "splitAttrs" ? [{ key: "o/c", parent: null, role: "AXCell", label: "API", value: `key: ${planted}`, frame: at }]
              : role === "hiddenLabel" ? [{ key: "o/l", parent: null, role: "AXStaticText", value: m, frame: [0, 40, 80, 20] }, { key: "o/d", parent: null, role: "AXStaticText", value: "A short\ndocument", frame: [85, 40, 35, 20] }, { key: "o/f", parent: null, role: "AXTextField", editable: true, value: planted, frame: [125, 40, 100, 20] }]
              : role === "label" ? [{ key: "o/f", parent: null, role: "AXTextField", editable: true, value: planted, label: `${m}${pick(SEPS)}`, frame: at }]
              : role === "placeholder" ? [{ key: "o/f", parent: null, role: "AXTextField", editable: true, value: planted, placeholder: m, frame: at }]
              : role === "nearest" ? [{ key: "o/l", parent: null, role: "AXStaticText", value: `${o}${m}${c}`, frame: at }, { key: "o/f", parent: null, role: pick(["AXTextField", "AXStaticText", "AXCell"]), ...(r() < 0.5 ? { editable: true as const } : {}), value: planted, frame: [150, 40, 120, 20] }]
              : role === "cellLabel" ? [{ key: "o/c", parent: null, role: pick(["AXCell", "AXStaticText"]), label: `${o}${m}${c}`, value: planted, ...(r() < 0.5 ? { frame: at } : {}) }]
              : role === "split" ? [{ key: "o/t", parent: null, role: "AXTextArea", editable: true as const, value: `Notes\n${m.split(/[\s_-]+/u).join("\n")}${pick(SEPS)}${o}${planted}${c}\nCity: Austin`, frame: at }]
              : role === "blankOpener" ? [{ key: "o/t", parent: null, role: "AXTextArea", editable: true as const, value: `Notes${pick(["\n", "\r\n"])}${m}:${pick(["\n\n", "\r\n\r\n", "\n \n"])}${o}${planted}${c}\nCity: Austin`, frame: at }]
              : [{ key: "o/c", parent: null, role: "AXCell", value: line, frame: at }],
          } as Snapshot);
      const name = control("e1", "Full name");
      const others = role === "note" ? [source] : [source, noteWindow("Name: Kenji Watanabe")];
      const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
      const model = desk([name, control("e2", "Notes", "textarea")], others);
      await proposeFill(model, ask, WIN, keyOf(name), 2000);
      const snap = intentSnapshot("Fill all fields", model, model.windows.get(WIN)!, []);
      requests.push(headsRequest(snap), scopeRequest(snap, 0), scopeRequest(snap, 1));
      await jevIntentMaker(ask).make(snap);
      const writes: WriterRequest[] = [];
      const writer: WriterPort = {
        route: gatewayRoute("openai/gpt-oss-120b"),
        async write(req) {
          writes.push(req);
          return { model: "fixture", provider: "fixture", output: { program: null, reply: "", json: { route: "refuse", why: "nothingToFill", scope: "none", section: "none", fields: [], sources: [], whose: "user", literals: [] } }, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
        },
      };
      await writerIntentMaker(writer, () => "fixture").make(snap);
      // These writers stop after their request, before any program runs. A secret guard failure must not be hidden
      // as an expected planner failure: all three requests must reach the stand-in.
      await expect(planWithCode("Fill all fields", model, { values: () => [] }, { writer, askJev: ask, offerKey: "fixture", windowId: WIN, now: 2000 })).rejects.toBeInstanceOf(PlannerError);
      await expect(planGoal(model, { goalId: "fixture", instruction: "Fill all fields", writer, askJev: ask, windows: [WIN], memory: [], calendar: null, clock: macClock(new Date(2000)), now: 2000, readerSession: 0 })).rejects.toBeInstanceOf(GoalError);
      expect(writes, `case ${i}: all writer builders reached`).toHaveLength(3);
      try {
        await planTask("Fill all fields", model, { values: () => [] }, { askJev: ask, offerKey: "fixture", windowId: WIN, now: 2000 });
      } catch (e) {
        expect(e).toBeInstanceOf(PlannerError);
      }
      expect(requests.some((r) => r.purpose === "planner.fields"), `case ${i}: planner built a request`).toBe(true);
      const sent = JSON.stringify([requests.map((x) => [x.state, x.questions, x.nouls ?? {}, x.snippets]), writes.map((w) => [w.input, w.disclosed])]);
      expect(sent.includes(planted), `case ${i} (${role}): ${JSON.stringify(line)}`).toBe(false);
    }
  });

  it("the redacted view's cost on the corpora: the lines it drops, and the right values they held", () => {
    const REAL = join(REALFILL, "sources");
    const texts: [string, string][] = [];
    for (const f of readdirSync(REAL)) {
      const raw = readFileSync(join(REAL, f), "utf8");
      texts.push([f, f.endsWith(".json") ? Object.values(JSON.parse(raw) as Record<string, string>).join("\n") : raw]);
    }
    const keys: string[] = [];
    for (const page of ["wizard-1", "wizard-2", "wizard-3", "reveal", "forty", "greenhouse", "ashby"]) {
      const e = JSON.parse(readFileSync(join(TASKS, `${page}.json`), "utf8")) as { sources: { note: string; email: Mail; memory: { value: string }[] }; expected: Record<string, string> };
      texts.push([page, [e.sources.note, e.sources.email.from, e.sources.email.to, e.sources.email.body, ...e.sources.memory.map((m) => m.value)].join("\n")]);
      keys.push(...Object.values(e.expected).filter((v) => v !== "none" && v !== "true" && v !== "false"));
    }
    for (const f of loadCorpus(REALFILL).forms) keys.push(...f.fields.map((x) => x.expected).filter((v) => !["none", "handoff", "checked", "unchecked"].includes(v)));
    const lines = texts.flatMap(([f, t]) => t.split("\n").map((l) => [f, l] as const)).filter(([, l]) => l.trim() !== "");
    const dropped = lines.filter(([, l]) => holdsSecret(l));
    expect(lines.length).toBe(276);
    expect(dropped.map(([f, l]) => `${f}: ${l}`)).toEqual(["ashby: Incident question: use the token-leak story, write it fresh."]);
    expect(keys.filter((k) => dropped.some(([, l]) => l.includes(k)))).toEqual([]);
  });
});

describe("G2 round 4: recheck by neighbourhood", () => {
  it("refuses a joined name once a line goes between its parts, and a phone once a warning line is added beside it", async () => {
    const full = control("e1", "Full name");
    const phone = control("e2", "Phone");
    const note = "First name: Kenji\nLast name: Watanabe\nPhone: 555-0164\nCity: Austin";
    const m = desk([full, phone], [noteWindow(note)]);
    const { ask } = scripted({ "Full name": "Kenji Watanabe", Phone: "555-0164" }, () => ({ choice: "user", confidence: 0.95 }));
    const g = writtenFields(await proposeFill(m, ask, WIN, keyOf(full), 2000));
    expect(g.fields.map((f) => f.value)).toEqual(["Kenji Watanabe", "555-0164"]);
    expect(recheckFields(m, g, () => null)).toMatchObject({ dropped: [] });
    const after = (text: string): string[] => {
      m.apply({ ...noteWindow(text), at: 2500 + text.length });
      const r = recheckFields(m, g, () => null);
      return "stale" in r ? ["stale"] : r.dropped.map((d) => d.key);
    };
    expect(after("First name: Kenji\nLandlord\nLast name: Watanabe\nPhone: 555-0164\nCity: Austin")).toContain(keyOf(full));
    // HA2 review P1: each value is also bound to the whole note its owner questions showed, so any edit of the note refuses
    // every value from it; the neighbourhood rule above still names its own cause first.
    expect(after("First name: Kenji\nLast name: Watanabe\nPhone: 555-0164\nDo not use this old number\nCity: Austin")).toEqual([keyOf(full), keyOf(phone)]);
    expect(after("First name: Kenji\nLast name: Watanabe\nPhone: 555-0164\nCity: Austin\nZIP: 78751")).toEqual([keyOf(full), keyOf(phone)]);
  });
});

describe("G2 round 5", () => {
  const leaks = async (sources: Snapshot[], planted: string[]): Promise<string[]> => {
    const name = control("e1", "Full name");
    const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
    await proposeFill(desk([name, control("e2", "Street address")], [...sources, noteWindow("Name: Kenji Watanabe")]), ask, WIN, keyOf(name), 2000);
    expect(requests.length).toBeGreaterThan(0);
    const sent = JSON.stringify(requests.map((r) => [r.state, r.questions, r.nouls ?? {}, r.snippets]));
    return planted.filter((t) => sent.includes(t));
  };
  const other = (nodes: Snapshot["nodes"]): Snapshot => ({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 800, reason: "initial", app: { pid: 7003, bundleId: "dev.caret.other", name: "Other" }, window: { windowId: "other", kind: "standard", title: "Setup", frame: [0, 0, 600, 300] }, focused: false, root: null, nodes, values: [], focusedKey: null, stats: { walkMs: 0, visited: nodes.length, truncated: false } }) as Snapshot;

  it("1: a line an opener takes opens in turn, with LF or CRLF", async () => {
    for (const nl of ["\n", "\r\n"]) {
      const text = ["Accounts", "Password:", "PIN:", "violet-orchard-seven", "City: Austin"].join(nl);
      expect(await leaks([{ ...other([{ key: "o/t", parent: null, role: "AXTextArea", editable: true, value: text, frame: [0, 0, 400, 200] }]) }], ["violet-orchard-seven"]), JSON.stringify(nl)).toEqual([]);
    }
  });

  it("2: a typed value over several lines goes when a line it covers was dropped", async () => {
    const text = "Accounts\nPassword:\n4410 Speedway\napt 2, Austin, TX 78751\nCity: Austin";
    const s = other([{ key: "o/t", parent: null, role: "AXTextArea", editable: true, value: text, frame: [0, 0, 400, 200] }]);
    expect(await leaks([{ ...s, values: [{ kind: "address", text: "4410 Speedway\napt 2, Austin, TX 78751", nodeKey: "o/t" }] }], ["4410 Speedway"])).toEqual([]);
  });

  it("3: a label over 60 characters that names a secret keeps the field beside it out", async () => {
    const label = "The staging account password for the shared deploy box is in here";
    expect(label.length).toBeGreaterThan(60);
    const s = other([
      { key: "o/l", parent: null, role: "AXStaticText", value: label, frame: [20, 40, 300, 20] },
      { key: "o/f", parent: null, role: "AXTextField", editable: true, value: "Qz7-Lime-River", frame: [330, 40, 160, 20] },
    ]);
    expect(await leaks([s], ["Qz7-Lime-River"])).toEqual([]);
  });

  it("4: a span over several lines has digests of all its lines, and a value with none is never held", () => {
    const text = "Home\n4410 Speedway\napt 2, Austin\nPhone: 555-0164";
    expect(lineDigests(text, "4410 Speedway\napt 2, Austin")).toHaveLength(1);
    const m = desk([control("e1", "Street")], [noteWindow(text)]);
    const KEY = "com.apple.TextEdit/standard/textarea:~0";
    expect(holdsAfter(() => m, { windowId: "w4-note", nodeKey: KEY }, text, text, "555-0164")).toBe(true);
    const window = { kind: "window" as const, windowId: "w4-note", nodeKey: KEY, app: "", title: "", span: "555-0164", label: null, line: null, partOf: null, context: null };
    expect(provenanceStale(m, { ...window, lines: [], sentences: [] })).not.toBeNull();
  });

  it("5: acceptance refuses a source the redacted view no longer admits", async () => {
    const name = control("e1", "Full name");
    const field = (placeholder?: string): Snapshot => other([{ key: "o/f", parent: null, role: "AXTextField", editable: true, value: "Robin Vale", label: "Name", ...(placeholder === undefined ? {} : { placeholder }), frame: [20, 40, 200, 20] }]);
    const m = desk([name], [{ ...field(), focused: true, at: 900 }]);
    const { ask } = scripted({ "Full name": "Robin Vale" }, () => ({ choice: "user", confidence: 0.95 }));
    const g = writtenFields(await proposeFill(m, ask, WIN, keyOf(name), 2000));
    expect(g.fields.map((f) => f.value)).toEqual(["Robin Vale"]);
    expect(recheckFill(m, g, () => null)).toBeNull();
    m.apply({ ...field("Password"), at: 2500 });
    expect(recheckFill(m, g, () => null)).not.toBeNull();
  });

  it("8: Caret's own wording passes only where its request's shape has a slot for it", () => {
    const d = new Disclosure([]);
    const refuse = d.own("Something Caret must not or cannot do here: pay, give a card number, a password, a one-time code or a Social Security number, or fill a field this form does not have.");
    // SC1 2c: the shape (privacy/shapes.ts) says where a request may carry text; Caret's wording is minted by own().
    expect(() => d.seal({ purpose: "intent.route", state: { task: d.own("t") }, questions: { scope: { type: "choice", instructions: d.own("Which?"), criteria: { refuse } } } })).not.toThrow();
    expect(() => d.seal({ purpose: "intent.route", state: { screenText: refuse }, questions: {} })).toThrow(OutOfShape);
  });
});

describe("G2 round 6: what the view keeps", () => {
  const view = (nodes: Snapshot["nodes"], values: Snapshot["values"] = []) => {
    const m = new ScreenModel();
    m.apply({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 800, reason: "initial", app: { pid: 7003, bundleId: "dev.caret.other", name: "Other" }, window: { windowId: "other", kind: "standard", title: "Setup", frame: [0, 0, 600, 300] }, focused: false, root: null, nodes, values, focusedKey: null, stats: { walkMs: 0, visited: nodes.length, truncated: false } } as Snapshot);
    return redactWindow(m.windows.get("other")!);
  };

  it("a: a static document with one secret line keeps its other lines", () => {
    const v = view([{ key: "o/d", parent: null, role: "AXStaticText", label: "Name: Kenji Watanabe\nPassword: violet-orchard-seven\nPhone: 555-0164", frame: [20, 40, 300, 60] }]);
    expect(nodeText(v.nodes.get("o/d")!)).toBe("Name: Kenji Watanabe\nPhone: 555-0164");
    // A one-line label that names a secret still keeps the field beside it out.
    const f = view([
      { key: "o/l", parent: null, role: "AXStaticText", value: "PIN", frame: [20, 40, 60, 20] },
      { key: "o/f", parent: null, role: "AXTextField", editable: true, value: "7319", frame: [90, 40, 120, 20] },
    ]);
    expect([...f.nodes.keys()]).toEqual([]);
  });

  it("b: a typed value goes only when a line it stands on was dropped, never for a dropped line's text", () => {
    // The opener drops the line "Austin" below it; the address on the next two lines stands on neither dropped line.
    const text = "Password:\nAustin\n4410 Speedway\napt 2, Austin, TX 78751";
    const v = view([{ key: "o/t", parent: null, role: "AXTextArea", editable: true, value: text, frame: [0, 0, 400, 200] }], [{ kind: "address", text: "4410 Speedway\napt 2, Austin, TX 78751", nodeKey: "o/t" }]);
    expect(v.values.map((x) => x.text)).toEqual(["4410 Speedway\napt 2, Austin, TX 78751"]);
    const opened = view([{ key: "o/t", parent: null, role: "AXTextArea", editable: true, value: "Password:\n4410 Speedway\napt 2, Austin, TX 78751", frame: [0, 0, 400, 200] }], [{ kind: "address", text: "4410 Speedway\napt 2, Austin, TX 78751", nodeKey: "o/t" }]);
    expect(opened.values).toEqual([]);
  });

  it("c: a span with a blank line inside it has its digests", () => {
    expect(lineDigests("Home\n4410 Speedway\n\napt 2, Austin\nPhone", "4410 Speedway\n\napt 2, Austin")).toHaveLength(1);
  });
});

describe("G2 round 6: a label that opens its node's value", () => {
  it("takes a static text or cell whose own label names a secret, value and all", () => {
    const m = new ScreenModel();
    m.apply({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 800, reason: "initial", app: { pid: 7003, bundleId: "dev.caret.other", name: "Other" }, window: { windowId: "other", kind: "standard", title: "Setup", frame: [0, 0, 600, 300] }, focused: false, root: null, nodes: [
      { key: "o/a", parent: null, role: "AXStaticText", label: "Password", value: "violet-orchard-seven", frame: [20, 40, 300, 20] },
      { key: "o/b", parent: null, role: "AXCell", label: "PIN:", value: "7319\nCity: Austin", frame: [20, 200, 300, 40] },
    ], values: [], focusedKey: null, stats: { walkMs: 0, visited: 2, truncated: false } } as Snapshot);
    const v = redactWindow(m.windows.get("other")!);
    const all = [...v.nodes.values()].map((n) => nodeText(n)).join("\n");
    expect(all).not.toContain("violet-orchard-seven");
    expect(all).not.toContain("7319");
    // Lead (G2 round 6 review): an own label that names a secret takes the node whole, its other lines too.
    expect(all).not.toContain("City: Austin");
  });
});

describe("G2 round 6 review: own labels, documents, and older gaps", () => {
  const win = (nodes: Snapshot["nodes"], values: Snapshot["values"] = []): Snapshot => ({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 800, reason: "initial", app: { pid: 7003, bundleId: "dev.caret.other", name: "Other" }, window: { windowId: "other", kind: "standard", title: "Setup", frame: [0, 0, 600, 300] }, focused: false, root: null, nodes, values, focusedKey: null, stats: { walkMs: 0, visited: nodes.length, truncated: false } }) as Snapshot;
  const view = (s: Snapshot) => {
    const m = new ScreenModel();
    m.apply(s);
    return redactWindow(m.windows.get("other")!);
  };
  const shown = (s: Snapshot): string => [...view(s).nodes.values()].map((n) => nodeText(n)).join("\n");
  const sentBeside = async (s: Snapshot): Promise<string> => {
    const name = control("e1", "Full name");
    const { ask, requests } = scripted({}, () => ({ choice: "unclear", confidence: 0.5 }));
    await proposeFill(desk([name, control("e2", "Email")], [s, noteWindow("Name: Kenji Watanabe")]), ask, WIN, keyOf(name), 2000);
    expect(requests.length).toBeGreaterThan(0);
    return JSON.stringify(requests.map((r) => [r.state, r.questions, r.nouls ?? {}, r.snippets]));
  };
  const EMAIL = "violet.orchard.seven.backup.account@example.test";

  it("BLOCKER: a node whose own label or placeholder names a secret goes with its value, whatever its role", async () => {
    for (const node of [
      { key: "o/c", parent: null, role: "AXCell", label: "Password", value: EMAIL, frame: [20, 40, 300, 20] as [number, number, number, number] },
      { key: "o/s", parent: null, role: "AXStaticText", label: "Password", value: EMAIL },
      { key: "o/p", parent: null, role: "AXCell", placeholder: "Password", value: EMAIL, frame: [20, 40, 300, 20] as [number, number, number, number] },
    ]) {
      expect(shown(win([node])), node.key).not.toContain(EMAIL);
      expect(await sentBeside(win([node])), node.key).not.toContain(EMAIL);
    }
  });

  it("a document labels nothing: a field beside it keeps its value; a one-line secret label beside a document takes it", () => {
    const doc = { key: "o/d", parent: null, role: "AXStaticText", label: "Name: Kenji\nPassword: violet-orchard-seven\nCity: Austin", frame: [20, 40, 200, 60] as [number, number, number, number] };
    const beside = { key: "o/f", parent: null, role: "AXTextField", editable: true as const, value: "Robin Vale", frame: [230, 60, 160, 20] as [number, number, number, number] };
    const t = shown(win([doc, beside]));
    expect(t).toContain("Robin Vale");
    expect(t).not.toContain("violet-orchard-seven");
    const pin = { key: "o/l", parent: null, role: "AXStaticText", value: "PIN", frame: [20, 10, 60, 20] as [number, number, number, number] };
    expect(shown(win([pin, { ...doc, label: "Name: Kenji\n7319\nCity: Austin" }]))).not.toContain("7319");
  });

  it("a marker split across a line break, and an opener over blank lines, take their value", () => {
    for (const text of ["Notes\nAPI\nkey: violet-orchard-seven\nCity: Austin", "Notes\nPassword:\n\n\nviolet-orchard-seven\nCity: Austin", "Notes\r\nPassword:\r\n\r\nviolet-orchard-seven\r\nCity: Austin"]) {
      const t = shown(win([{ key: "o/t", parent: null, role: "AXTextArea", editable: true, value: text, frame: [0, 0, 400, 200] }]));
      expect(t, JSON.stringify(text)).not.toContain("violet-orchard-seven");
      expect(t, JSON.stringify(text)).toContain("City: Austin");
    }
  });

  it("a typed value whose line endings differ from its node's still goes with its dropped line", () => {
    const v = view(win([{ key: "o/t", parent: null, role: "AXTextArea", editable: true, value: "Password:\n4410 Speedway\napt 2, Austin, TX 78751", frame: [0, 0, 400, 200] }], [{ kind: "address", text: "4410 Speedway\r\napt 2, Austin, TX 78751", nodeKey: "o/t" }]));
    expect(v.values).toEqual([]);
  });
});

describe("G2 round 7: last fixes", () => {
  const win = (nodes: Snapshot["nodes"], values: Snapshot["values"] = []): Snapshot => ({ type: "snapshot", v: PROTOCOL_VERSION, seq: 1, at: 800, reason: "initial", app: { pid: 7003, bundleId: "dev.caret.other", name: "Other" }, window: { windowId: "other", kind: "standard", title: "Setup", frame: [0, 0, 600, 300] }, focused: false, root: null, nodes, values, focusedKey: null, stats: { walkMs: 0, visited: nodes.length, truncated: false } }) as Snapshot;
  const view = (s: Snapshot) => {
    const m = new ScreenModel();
    m.apply(s);
    return redactWindow(m.windows.get("other")!);
  };
  const shown = (s: Snapshot): string => [...view(s).nodes.values()].map((n) => nodeText(n)).join("\n");
  const area = (value: string) => [{ key: "o/t", parent: null, role: "AXTextArea", editable: true as const, value, frame: [0, 0, 400, 200] as [number, number, number, number] }];

  it("a reader value whole in one attribute is kept though another lost lines", () => {
    const v = view(win([{ key: "o/c", parent: null, role: "AXCell", label: "Mailing address: 4410 Speedway", value: "Password:\nviolet-orchard-seven\nCity: Austin", frame: [0, 0, 400, 80] }], [{ kind: "address", text: "4410 Speedway", nodeKey: "o/c" }]));
    expect(v.values.map((x) => x.text)).toEqual(["4410 Speedway"]);
  });

  it("a private key block goes through its END fence, and END opens nothing", () => {
    const t = shown(win(area("Keys\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow3fakekeybody\nAbCdEf123456\n-----END RSA PRIVATE KEY-----\n\nName: Kenji Watanabe\nCity: Austin")));
    expect(t).not.toContain("MIIEow3fakekeybody");
    expect(t).not.toContain("AbCdEf123456");
    expect(t).toContain("Name: Kenji Watanabe");
    expect(t).toContain("City: Austin");
  });

  it("joins a split marker only across its own words, never a heading to a labelled record", () => {
    expect(shown(win(area("Event\nCard\nNumber of attendees: 4")))).toContain("Number of attendees: 4");
    for (const text of ["Notes\nAPI\nkey: violet-orchard-seven", "Notes\nmy private\nkey violet-orchard-seven", "Notes\nAPI\nkey\nviolet-orchard-seven"]) expect(shown(win(area(text))), JSON.stringify(text)).not.toContain("violet-orchard-seven");
  });

  it("a container labelled for a secret takes everything under it", () => {
    const t = shown(win([
      { key: "o/g", parent: null, role: "AXGroup", label: "Recovery codes", frame: [0, 0, 400, 200] },
      { key: "o/g/a", parent: "o/g", role: "AXStaticText", value: "violet-orchard-seven", frame: [10, 10, 200, 20] },
      { key: "o/x", parent: null, role: "AXStaticText", value: "City: Austin", frame: [0, 220, 200, 20] },
    ]));
    expect(t).toContain("City: Austin");
    const g = shown(win([
      { key: "o/g", parent: null, role: "AXGroup", label: "Password", frame: [0, 0, 400, 200] },
      { key: "o/g/a", parent: "o/g", role: "AXStaticText", value: "violet-orchard-seven", frame: [10, 300, 200, 20] },
      { key: "o/g/b", parent: "o/g/a", role: "AXStaticText", value: "deeper-secret-value", frame: [10, 330, 200, 20] },
      { key: "o/x", parent: null, role: "AXStaticText", value: "City: Austin", frame: [0, 400, 200, 20] },
    ]));
    expect(g).not.toContain("violet-orchard-seven");
    expect(g).not.toContain("deeper-secret-value");
    expect(g).toContain("City: Austin");
  });
});

// These provider-shaping tests use fake transports; gateway execution requires an explicit dev opt-in.
vercelBeforeEach(() => { vercelVi.stubEnv("CARET_DEV_VERCEL_GEMINI", "1"); vercelVi.stubEnv("CARET_RELEASE_HOST", "0"); });
vercelAfterEach(() => vercelVi.unstubAllEnvs());
