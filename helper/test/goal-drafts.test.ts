// B30 part 2: a goal plan that writes short text in Caret's own words. The sandbox's draft() makes a value only a goal
// program can make; lowering checks its facts, field and recipients; Jev confirms its claims; the preview shows the
// whole draft marked `drafted`; acceptance writes it and D2-04's undo takes it back; Send stays the user's. Every name
// and number is invented.
import { afterEach, describe, expect, it } from "vitest";
import { runCodePlan } from "../src/codemode/sandbox.ts";
import type { PlanningSnapshot } from "../src/codemode/types.ts";
import type { AskJev } from "../src/fill/jev.ts";
import { YOURS_EFFECT } from "../src/goals/capabilities.ts";
import { GoalProgress, PROTOCOL_VERSION } from "../src/protocol.ts";
import { areaKey, button, fieldKey, goalScene, MAIL, mailWindow, replyWindow, standInJev, textArea, textField, type CannedStep, type DeskWindow, type GoalScene } from "./goal-desk.ts";

const EMAIL = "priya.raman@northwind.example";
const MESSAGE = areaKey(MAIL, "Message");
const TO = fieldKey(MAIL, "To");

/** Jev that answers every yes/no with `p` and confirms every copied value (G2's value gate). */
const jevYes = (p = 0.99): ReturnType<typeof standInJev> => standInJev({ noul: p });

const scenes: GoalScene[] = [];
afterEach(async () => {
  for (const s of scenes.splice(0)) await s.close();
});
function scene(scripts: CannedStep[][], o: { windows?: DeskWindow[]; askJev?: AskJev | null } = {}): GoalScene {
  const sc = goalScene({ scripts, windows: o.windows ?? [mailWindow(), replyWindow()], userWindow: "6161-2", ...(o.askJev === null ? {} : { askJev: o.askJev ?? jevYes() }) });
  scenes.push(sc);
  return sc;
}
const REPLY: CannedStep[] = [
  { fill: { window: "Re: Order", target: "To", value: EMAIL } },
  { draft: { window: "Re: Order", target: "Message", text: "Hi Priya, I'm in for Thursday, October 8 at 3:00 PM.", from: ["Order ORD-2026-48213 arrived damaged"] } },
  { press: { window: "Re: Order", target: "Send", effect: YOURS_EFFECT } },
];
const refusedSays = (g: GoalProgress): string => (g.event === "stopped" && g.reason === "refused" ? g.says : `not refused: ${g.event}`);

describe("draft() in the sandbox", () => {
  const snaps: PlanningSnapshot[] = [
    { snapshot: "s1", window: "w1", revision: "r", title: "Reply", targets: [{ ref: "t1", label: "Message", kind: "text", canFill: true, options: [], allowedPressEffects: [] }], values: [], questions: [] },
    { snapshot: "s2", window: "w2", revision: "r", title: "Mail", targets: [], values: [{ ref: "v1", display: '"Priya"', origin: { kind: "span", snapshot: "s2", source: "x", startUTF16: 0, endUTF16: 5, digest: "d" } }], questions: [] },
  ];
  const program = (body: string): string => `async function main(caret: CaretPlanAPI): Promise<PlanRef> {\n  const a = await caret.readWindow();\n  const b = await caret.readWindow("w2" as WindowRef);\n${body}\n}`;
  const none = async () => null;

  it("is refused outside a goal, so a single-window plan never drafts", async () => {
    const r = await runCodePlan(program(`  const d = caret.draft("I'm in", []);\n  return caret.plan({ basedOn: a.snapshot, steps: [caret.fill("t1" as TargetRef, d)] });`), snaps, none);
    expect(r.ok === false && r.kind).toBe("violation");
    expect(r.ok === false && r.detail).toContain("this plan cannot draft text");
  });

  it("gives a goal a value ref its fill may name, with the text and basis recorded", async () => {
    const r = await runCodePlan(program(`  const d = caret.draft("I'm in", ["w2" as WindowRef, "v1" as ValueRef]);\n  return caret.plan({ basedOn: a.snapshot, steps: [caret.fill("t1" as TargetRef, d)] });`), snaps, none, { multiWindow: true, drafts: true });
    expect(r.ok && r.plan.drafts).toEqual([{ ref: "d1", text: "I'm in", from: ["w2", "v1"] }]);
    expect(r.ok && r.plan.steps).toEqual([{ ref: "step:1", kind: "fill", target: "t1", value: "d1" }]);
  });

  it.each([
    [`caret.draft(42 as never, [])`, "text must be a string"],
    [`caret.draft("x", ["w9" as WindowRef])`, "from names w9"],
    [`caret.draft("x".repeat(2001), [])`, "a draft is far shorter"],
    [`caret.draft("a", []); caret.draft("b", []); caret.draft("c", [])`, "at most 2 drafts"],
  ])("refuses %s", async (call, why) => {
    const r = await runCodePlan(program(`  ${call};\n  return caret.plan({ basedOn: a.snapshot, steps: [caret.fill("t1" as TargetRef, "v1" as ValueRef)] });`), snaps, none, { multiWindow: true, drafts: true });
    expect(r.ok === false && r.detail).toContain(why);
  });
});

describe("a goal that drafts a reply", () => {
  it("previews the whole draft, marked drafted, and writes nothing before acceptance", async () => {
    const sc = scene([REPLY]);
    const g = await sc.request("draft a reply to Priya saying I'm in");
    expect(g.event).toBe("segment");
    const steps = (g as Extract<GoalProgress, { event: "segment" }>).steps;
    expect(steps).toEqual([
      { index: 0, kind: "write", says: `To: ${EMAIL}` },
      { index: 1, kind: "write", says: "Message: Hi Priya, I'm in for Thursday, October 8 at 3:00 PM.", drafted: "Hi Priya, I'm in for Thursday, October 8 at 3:00 PM." },
      { index: 2, kind: "handoff", says: "'Send' reads as outbound; you press it" },
    ]);
    expect(GoalProgress.safeParse(g).success).toBe(true);
    expect(sc.desk.writes).toEqual([]);
  });

  it("writes it on acceptance, leaves Send to the user, and D2-04's undo takes it back", async () => {
    const sc = scene([REPLY]);
    const g = await sc.request("draft a reply to Priya saying I'm in");
    await sc.accept(g.goalId);
    expect(sc.desk.node("6161-2", MESSAGE)?.value).toBe("Hi Priya, I'm in for Thursday, October 8 at 3:00 PM.");
    expect(sc.desk.pressed).toEqual([]);
    expect(sc.goals.at(-1)).toMatchObject({ event: "finished", outcome: "handoff" });
    const undo = await sc.helper.handleTask({ type: "taskControl", v: PROTOCOL_VERSION, taskId: `${g.goalId}:s0`, action: "undo" }, sc.session);
    expect(undo).toMatchObject({ restored: 2, notRestored: [] });
    expect(sc.desk.node("6161-2", MESSAGE)?.value).toBeUndefined();
    expect(sc.desk.node("6161-2", TO)?.value).toBeUndefined();
  });

  it("asks Jev about each claim, and is refused when Jev doubts one or is not there", async () => {
    const j = jevYes();
    await scene([REPLY], { askJev: j }).request("draft a reply to Priya saying I'm in");
    expect(j.claimCalls).toBe(2);
    const doubted = await scene([REPLY], { askJev: jevYes(0.5) }).request("draft a reply to Priya saying I'm in");
    expect(refusedSays(doubted)).toBe(`Caret couldn't confirm you asked to say "Hi Priya, I'm in for Thursday, October 8 at 3:00 PM."`);
    const alone = await scene([REPLY], { askJev: null }).request("draft a reply to Priya saying I'm in");
    expect(refusedSays(alone)).toContain("Caret can't check the draft's sentence");
  });

  it.each([
    ["a new name", "Hi Dana, I'm in.", `The draft says "Dana", which isn't in your instruction or the windows Caret read`],
    ["a new date", "I'm in for October 3.", `The draft says "October 3", which isn't in your instruction or the windows Caret read`],
    ["a fact from a window it did not name", "I'm in about ORD-2026-48213.", `The draft says "ORD-2026-48213", which isn't in your instruction or the windows Caret read`],
  ])("refuses a draft with %s, naming the word, and writes nothing", async (_, text, says) => {
    const steps: CannedStep[] = [{ draft: { window: "Re: Order", target: "Message", text, from: [] } }];
    const sc = scene([steps]);
    const g = await sc.request("draft a reply saying I'm in");
    expect(refusedSays(g)).toBe(says);
    expect(sc.desk.writes).toEqual([]);
  });

  it("refuses the user's time when the message says another", async () => {
    const steps: CannedStep[] = [{ draft: { window: "Re: Order", target: "Message", text: "I'll be there at 4.", from: ["Order ORD-2026-48213 arrived damaged"] } }];
    const g = await scene([steps]).request("tell her I'll be there at 4");
    expect(refusedSays(g)).toBe(`You said "at 4" and 'Order ORD-2026-48213 arrived damaged' says "3:00 PM", so Caret didn't write that part. Write it yourself`);
  });
});

describe("who a message goes to", () => {
  const withCc = (): DeskWindow => ({ ...replyWindow(), nodes: [textField(MAIL, "To"), textField(MAIL, "Cc"), textField(MAIL, "Subject"), textArea(MAIL, "Message"), button(MAIL, "Send")] });

  it("refuses a draft in To or Subject, and any value in Cc", async () => {
    const intoTo = await scene([[{ draft: { window: "Re: Order", target: "To", text: "Priya", from: ["Order ORD-2026-48213 arrived damaged"] } }]]).request("reply to Priya");
    expect(refusedSays(intoTo)).toBe("Caret puts only the sender of the message you're answering in 'To'");
    const intoSubject = await scene([[{ draft: { window: "Re: Order", target: "Subject", text: "Thursday works", from: ["Order ORD-2026-48213 arrived damaged"] } }]], { windows: [mailWindow(), withCc()] }).request("reply to Priya");
    expect(refusedSays(intoSubject)).toBe("Caret doesn't write subject lines");
    const cc = await scene([[{ fill: { window: "Re: Order", target: "Cc", value: EMAIL } }]], { windows: [mailWindow(), withCc()] }).request("reply to Priya");
    expect(refusedSays(cc)).toBe("Caret doesn't add people to a message. Add them yourself");
  });

  it("puts in To only an address its source shows as the sender", async () => {
    const note: DeskWindow = { windowId: "6161-7", app: MAIL, title: "Contacts note", nodes: [{ key: "n1", parent: null, role: "AXStaticText", label: "Dana: dana.whit@example.com" }], values: [{ kind: "email", text: "dana.whit@example.com", nodeKey: "n1" }] };
    const g = await scene([[{ fill: { window: "Re: Order", target: "To", value: "dana.whit@example.com" } }]], { windows: [mailWindow(), replyWindow(), note] }).request("reply to Dana");
    expect(refusedSays(g)).toBe("Caret puts only the sender of the message you're answering in 'To'");
  });

  it("refuses an instruction that adds someone before any plan is written", async () => {
    const sc = scene([REPLY]);
    const g = await sc.request("reply to Priya saying I'm in and cc dana.whit@example.com");
    expect(refusedSays(g)).toBe("Caret doesn't add people to a message. Add them yourself, then ask again for the rest");
    expect(sc.writer.requests).toEqual([]);
  });
});

describe("a draft whose basis changed before acceptance", () => {
  it("stops before writing when the window it was drafted from closed", async () => {
    const sc = scene([REPLY]);
    const g = await sc.request("draft a reply to Priya saying I'm in");
    sc.desk.close("6161-1");
    await sc.accept(g.goalId);
    expect(sc.desk.writes).toEqual([]);
    expect(sc.goals.find((x) => x.event === "stopped")).toMatchObject({ reason: expect.stringMatching(/sourceChanged|windowGone/) });
  });

  it("stops before writing when a fact the draft states left that window", async () => {
    const sc = scene([REPLY]);
    const g = await sc.request("draft a reply to Priya saying I'm in");
    const mail = sc.desk.windows.get("6161-1") as DeskWindow;
    const n = mail.nodes.find((x) => x.label?.includes("October 8"));
    if (n === undefined) throw new Error("no meeting line");
    n.label = "Can we meet with Priya next week instead?";
    mail.values = (mail.values ?? []).filter((v) => v.kind !== "date" && v.kind !== "time");
    sc.desk.show(mail);
    await sc.accept(g.goalId);
    expect(sc.desk.writes).toEqual([]);
    expect(sc.goals.find((x) => x.event === "stopped")).toMatchObject({ reason: "sourceChanged" });
  });
});

// B30 review 1: goals the reviewer brought to a preview, now refused or stopped.
describe("review 1: goals that slipped a fact or a recipient through", () => {
  it("reads a value named as a draft's basis as its source: an instruction's amount stays the instruction's", async () => {
    const steps: CannedStep[] = [{ draft: { window: "Re: Order", target: "Message", text: "Yes to the $500 quote.", from: ["value:$500"] } }];
    const g = await scene([steps]).request('say yes to the "$500" quote');
    expect(refusedSays(g)).toBe(`The draft says "$500", and no window Caret read shows that amount`);
  });

  it("brings a window's value's window into the basis, so its time conflicts with the user's", async () => {
    const steps: CannedStep[] = [{ draft: { window: "Re: Order", target: "Message", text: "See you at 4.", from: ["value:3:00 PM to 3:45 PM PT"] } }];
    const g = await scene([steps]).request("tell her I will be there at 4");
    expect(refusedSays(g)).toContain(`You said "at 4" and 'Order ORD-2026-48213 arrived damaged' says`);
  });

  it("stops before writing when the window behind a basis value closed", async () => {
    const steps: CannedStep[] = [{ draft: { window: "Re: Order", target: "Message", text: "Thanks Priya.", from: ["value:priya.raman@northwind.example"] } }];
    const sc = scene([steps]);
    const g = await sc.request("thank Priya");
    expect(g.event).toBe("segment");
    sc.desk.close("6161-1");
    await sc.accept(g.goalId);
    expect(sc.desk.writes).toEqual([]);
  });

  it("refuses recipient fields by meaning, and a From address of a message the reply does not answer", async () => {
    const reply = (labels: string[]): DeskWindow => ({ ...replyWindow(), nodes: [...labels.map((l) => textField(MAIL, l)), textArea(MAIL, "Message"), button(MAIL, "Send")] });
    const other: DeskWindow = { windowId: "6161-8", app: MAIL, title: "Contacts", nodes: [{ key: "c1", parent: null, role: "AXStaticText", label: "From: Mallory <mallory@example.com>" }], values: [{ kind: "email", text: "mallory@example.com", nodeKey: "c1" }] };
    for (const label of ["To email", "Carbon copy", "Email"]) {
      const g = await scene([[{ fill: { window: "Re: Order", target: label, value: "mallory@example.com" } }]], { windows: [mailWindow(), reply([label]), other] }).request("reply to Priya");
      expect(refusedSays(g), label).toMatch(/^Caret (puts only the sender|doesn't add people)/);
    }
    const g = await scene([[{ fill: { window: "Re: Order", target: "To", value: "mallory@example.com" } }]], { windows: [mailWindow(), replyWindow(), other] }).request("reply to Priya");
    expect(refusedSays(g)).toBe("Caret puts only the sender of the message you're answering in 'To'");
  });

  it("refuses a copied value in a subject line", async () => {
    const withSubject: DeskWindow = { ...replyWindow(), nodes: [textField(MAIL, "To"), textField(MAIL, "Subject"), textArea(MAIL, "Message"), button(MAIL, "Send")] };
    const g = await scene([[{ fill: { window: "Re: Order", target: "Subject", value: "ORD-2026-48213" } }]], { windows: [mailWindow(), withSubject] }).request("reply to Priya");
    expect(refusedSays(g)).toBe("Caret doesn't write subject lines");
  });
});

describe("review 1 re-check: To at acceptance", () => {
  it("stops before writing To when the message no longer shows that sender", async () => {
    const sc = scene([REPLY]);
    const g = await sc.request("draft a reply to Priya saying I'm in");
    const mail = sc.desk.windows.get("6161-1") as DeskWindow;
    const from = mail.nodes[0];
    if (from === undefined) throw new Error("no From line");
    from.label = `To: Priya Raman <${EMAIL}>`;
    sc.desk.show(mail);
    await sc.accept(g.goalId);
    expect(sc.desk.writes).toEqual([]);
    expect(sc.goals.find((x) => x.event === "stopped")).toMatchObject({ reason: "sourceChanged" });
  });

  it("refuses Reply-To and a Carbon-copy or Subject (optional) label", async () => {
    const mail: DeskWindow = { ...mailWindow(), nodes: [...mailWindow().nodes.slice(0, 1), { key: "rt", parent: null, role: "AXStaticText", label: "Reply-To: Mallory <mallory@example.com>" }, ...mailWindow().nodes.slice(1)], values: [...(mailWindow().values ?? []), { kind: "email", text: "mallory@example.com", nodeKey: "rt" }] };
    const g = await scene([[{ fill: { window: "Re: Order", target: "To", value: "mallory@example.com" } }]], { windows: [mail, replyWindow()] }).request("reply to Priya");
    expect(refusedSays(g)).toBe("Caret puts only the sender of the message you're answering in 'To'");
    for (const label of ["Carbon-copy", "Subject (optional)"]) {
      const w: DeskWindow = { ...replyWindow(), nodes: [textField(MAIL, "To"), textField(MAIL, label), textArea(MAIL, "Message"), button(MAIL, "Send")] };
      const r = await scene([[{ fill: { window: "Re: Order", target: label, value: EMAIL } }]], { windows: [mailWindow(), w] }).request("reply to Priya");
      expect(refusedSays(r), label).toMatch(/^Caret doesn't (add people|write subject lines)/);
    }
  });
});

describe("third check: recipients", () => {
  it("refuses Recipients (Bcc) and Title of the message, and lets a toolbar before the header stand", async () => {
    for (const label of ["Recipients (Bcc)", "Title of the message"]) {
      const w: DeskWindow = { ...replyWindow(), nodes: [textField(MAIL, "To"), textField(MAIL, label), textArea(MAIL, "Message"), button(MAIL, "Send")] };
      const value = label.startsWith("Title") ? "ORD-2026-48213" : EMAIL;
      const r = await scene([[{ fill: { window: "Re: Order", target: label, value } }]], { windows: [mailWindow(), w] }).request("reply to Priya");
      expect(refusedSays(r), label).toMatch(/^Caret doesn't (add people|write subject lines)/);
    }
    const mail: DeskWindow = { ...mailWindow(), nodes: [button(MAIL, "Reply"), ...mailWindow().nodes] };
    const g = await scene([[{ fill: { window: "Re: Order", target: "To", value: EMAIL } }]], { windows: [mail, replyWindow()] }).request("reply to Priya");
    expect(g.event).toBe("segment");
  });
});

describe("G2: a draft that only restates the instruction", () => {
  /** Jev that confirms every copied value and doubts every claim: a draft that reaches it is refused. */
  const doubting = (): ReturnType<typeof standInJev> => standInJev({ noul: 0 });
  const reply = (text: string): CannedStep[][] => [[{ draft: { window: "Re: Order", target: "Message", text, from: [] } }]];

  it.each([
    ["the instruction's own words", "draft an RSVP saying I'm in for the workshop", "I'm in for the workshop."],
    ["a greeting and a name before them", "draft a reply to Priya saying I'm in", "Hi Priya, I'm in."],
    ["a name after them", "draft a reply to Priya saying I'm in", "I'm in, Priya!"],
    ["a quoted reply", 'draft a reply to Priya saying "I\'m in"', "I'm in."],
  ])("is accepted without asking Jev: %s", async (_, instruction, text) => {
    const j = doubting();
    const g = await scene(reply(text), { askJev: j }).request(instruction);
    expect(g.event === "segment" && g.steps.at(-1)).toEqual({ index: 1, kind: "write", says: `Message: ${text}`, drafted: text });
    expect(j.claimCalls).toBe(0);
  });

  it.each([
    ["words in another order", "tell her I can't do Friday but Monday works", "Friday works."],
    ["the instruction's words cut off before a condition", "draft a reply saying I'm in if the time works", "I'm in."],
    ["the instruction's words after a negation", "do not tell her I'm in", "I'm in."],
    ["the instruction's words after a condition", "if Priya confirms the time, reply saying I'm in", "I'm in."],
    ["a word the instruction does not say", "draft a reply to Priya saying I'm in", "I'm in, see you soon."],
  ])("still goes to Jev, and is refused when Jev doubts it: %s", async (_, instruction, text) => {
    const j = doubting();
    const g = await scene(reply(text), { askJev: j }).request(instruction);
    expect(refusedSays(g)).toMatch(/^Caret couldn't confirm you asked to say /);
    expect(j.claimCalls).toBe(2);
  });

  it("keeps the fact checks as strict: a restated time or amount still needs its source", async () => {
    const time = await scene(reply("I'm in at 4."), { askJev: doubting() }).request("draft a reply saying I'm in");
    expect(refusedSays(time)).toBe(`The draft says "at 4", which isn't in your instruction or the windows Caret read`);
    const money = await scene(reply("The $500 quote works."), { askJev: doubting() }).request('draft a reply saying "the $500 quote works"');
    expect(refusedSays(money)).toBe(`The draft says "$500", and no window Caret read shows that amount`);
  });
});
