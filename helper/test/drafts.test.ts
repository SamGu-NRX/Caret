// B30: the checks a drafted text passes before a goal offers it (goals/drafts.ts). Each has one right answer, so each
// is tested alone: what facts code reads, which basis fact covers which, and which word refuses a draft and why.
// Every name, address and number is invented.
import { describe, expect, it } from "vitest";
import type { AskJev, JevRequest } from "../src/fill/jev.ts";
import { addsRecipient, senderOf, checkDraftText, confirmClaims, covers, DraftRefused, factsIn, noClaim, recipientField, restates, sentencesOf, subjectField, type DraftBasis } from "../src/goals/drafts.ts";

const MAIL = {
  title: "Order ORD-2026-48213 arrived damaged",
  text: ["From: Priya Raman <priya.raman@northwind.example>", "Order number: ORD-2026-48213", "Call (512) 555-0147 or see https://help.northwind.example/returns", "Can we meet with Priya on Thursday, October 8, 2026 from 3:00 PM to 3:45 PM PT?", "The replacement costs $45.00."].join("\n"),
};
const basis = (instruction: string, windows = [MAIL], memory: string[] = []): DraftBasis => ({ instruction, windows, memory });
const why = (text: string, b: DraftBasis): [string, string | null] | null => {
  try {
    checkDraftText(text, b);
    return null;
  } catch (e) {
    if (!(e instanceof DraftRefused)) throw e;
    return [e.why, e.word];
  }
};
const kinds = (text: string): string[] => factsIn(text).map((f) => `${f.kind}:${f.text}`);

describe("the facts a text states", () => {
  it.each([
    ["See you Thursday, October 8 at 3:00 PM PT.", ["date:Thursday, October 8", "time:3:00 PM", "name:PT"]],
    ["I'll be there at 4.", ["time:at 4"]],
    ["by five pm, or at noon", ["time:five pm", "time:noon"]],
    ["Yes to the $500 quote, or 1,200 dollars, or five hundred bucks.", ["money:$500", "money:1,200 dollars", "money:five hundred bucks"]],
    ["Order ORD-2026-48213, ticket #4471-B", ["name:Order", "code:ORD-2026-48213", "code:#4471-B"]],
    ["(512) 555-0147 and priya.raman@northwind.example", ["phone:(512) 555-0147", "email:priya.raman@northwind.example"]],
    ["see www.northwind.example/returns", ["url:www.northwind.example/returns"]],
    ["We are 3 on 10/8, 2026-10-08 or the 8th; twenty-five guests", ["number:3", "date:10/8", "date:2026-10-08", "number:8th", "number:twenty-five"]],
    ["tomorrow, next week, this weekend, Friday, and in the morning", ["date:tomorrow", "date:next week", "date:this weekend", "date:Friday", "date:morning"]],
    ["Good morning Priya Raman. Thanks Dana's team.", ["name:Priya Raman", "name:Dana"]],
    ["Hi Priya, I'm in. Sounds good! OK, I'll see.", ["name:Priya"]],
    ["May I join?", ["date:May"]],
  ])("reads %j", (text, want) => {
    expect(kinds(text)).toEqual(want);
  });

  it("reads every digit as part of some fact", () => {
    for (const t of ["a 7 b", "x9y", "3.5 hours", "1st and 22nd", "2026", "0.5", "+1 512 555 0147"]) {
      const covered = factsIn(t).map((f) => f.text).join(" ");
      expect([...t].filter((c) => /\d/.test(c)).every((d) => covered.includes(d)), t).toBe(true);
    }
  });
});

describe("which basis fact covers a draft's fact", () => {
  const one = (t: string) => factsIn(t)[0] as Parameters<typeof covers>[0];
  it.each([
    ["Thursday, October 8, 2026", "October 8", true],
    ["Thursday, October 8, 2026", "Thursday", true],
    ["Thursday, October 8, 2026", "Friday, October 8", false],
    ["Thursday, October 8, 2026", "October 3", false],
    ["October 8", "Oct 8, 2027", false],
    ["3:00 PM", "at 3", true],
    ["3:00 PM", "15:00", true],
    ["at 3", "3 PM", false],
    ["3:00 PM", "3:30 PM", false],
    ["$45.00", "45 dollars", true],
    ["$45.00", "$450", false],
    ["$45.00", "45 euros", false],
    ["3:00 PM", "3", false],
    ["ORD-2026-48213", "ord-2026-48213", true],
    ["(512) 555-0147", "512-555-0147", true],
  ])("%j covers %j: %s", (basisText, draftText, want) => {
    expect(covers(one(basisText), one(draftText))).toBe(want);
  });
});

describe("a draft's code checks", () => {
  const reply = basis("draft a reply saying I'm in");

  it("passes a draft whose every fact is in the basis", () => {
    for (const ok of ["Hi Priya, I'm in!", "I'm in for Thursday, October 8 at 3:00 PM PT.", "Sounds good, see you then. Looking forward to it!", "The order ORD-2026-48213 arrived damaged.", "Thanks Priya Raman."]) expect(why(ok, reply), ok).toBeNull();
  });

  it.each([
    ["Hi Dana, I'm in.", "Dana"],
    ["I'm in for October 3.", "October 3"],
    ["I'm in and bringing 3 friends.", "3"],
    ["See you at 3:30 PM.", "3:30 PM"],
    ["See you Friday.", "Friday"],
    ["Reach me at (415) 555-0162.", "(415) 555-0162"],
    ["Please write to dana.whit@example.com.", "dana.whit@example.com"],
    ["See the details at www.example.com/x.", "www.example.com/x"],
    ["Also see ORD-2026-48214.", "ORD-2026-48214"],
    ["Write to me.", "Write"],
    ["I'm in, see you tomorrow.", "tomorrow"],
    ["I'm in. Will bring snacks.", "Will"],
  ])("refuses %j as a new fact, naming %j", (text, word) => {
    expect(why(text, reply)).toEqual(["newFact", word]);
  });

  it("refuses an amount the user typed that no window shows, and takes one a window shows", () => {
    const empty = { title: "Re: Garden quote", text: "From: Lena Ortiz <lena@ortizgardens.example>\nHere is the quote for the backyard work." };
    expect(why("Yes to the $500 quote.", basis("say yes to the $500 quote", [empty]))).toEqual(["money", "$500"]);
    expect(why("Yes to the $45.00 replacement.", basis("say yes to the replacement"))).toBeNull();
    expect(why("Yes, 45 dollars works.", basis("say yes", [], ["$45"]))).toBeNull();
  });

  it("refuses any time when the user's time and the window's differ, either way", () => {
    const b = basis("tell her I'll be there at 4");
    expect(why("I'll be there at 4.", b)).toEqual(["conflict", "at 4"]);
    expect(why("I'll be there at 3:00 PM.", b)).toEqual(["conflict", "at 4"]);
    // No time in the draft: nothing to pick.
    expect(why("I'll be there, Priya.", b)).toBeNull();
    // The user's time matches the window's: no conflict.
    expect(why("See you at 3:00 PM.", basis("tell her I'll be there at 3 pm"))).toBeNull();
  });

  it("refuses a negation the instruction does not have, and a claim of copying or attaching", () => {
    expect(why("I can't make it.", reply)).toEqual(["negation", "can't"]);
    expect(why("Sorry, not this time.", reply)).toEqual(["negation", "not"]);
    expect(why("I can't make it.", basis("tell her I can't make it"))).toBeNull();
    for (const [t, w] of [["I've cc'd Dana.", "cc'd"], ["Copying in my manager.", "Copying in"], ["The receipt is attached.", "attached"], ["I'll forward this to Sam.", "forward this"]]) expect(why(t as string, reply), t).toEqual(["recipientClaim", w]);
    expect(why("Looking forward to it.", reply)).toBeNull();
  });

  it("refuses an empty, long or formatted draft", () => {
    expect(why("  ", reply)?.[0]).toBe("empty");
    expect(why("I'm in. ".repeat(80), reply)?.[0]).toBe("tooLong");
    expect(why("I'm in. ".repeat(75).trim(), reply)).toBeNull(); // 599 characters
    for (const t of ["**I'm in**", "Hi [Name], I'm in", "Subject: Re: Order\nI'm in", "- I'm in", "<b>I'm in</b>", "I'm in {name}", "I'm in.\tThanks", "TBD"]) expect(why(t, reply)?.[0], t).toBe("notProse");
    expect(why("I'm in.\n\n\n\n\n\n\nThanks", reply)?.[0]).toBe("notProse");
  });

  it("says which word, in the user's words", () => {
    try {
      checkDraftText("Hi Dana, I'm in.", reply);
    } catch (e) {
      expect((e as DraftRefused).says).toBe(`the draft says "Dana", which isn't in your instruction or the windows Caret read`);
    }
  });
});

describe("fields and instructions about who a message goes to", () => {
  it.each([
    ["To", "to"], ["To:", "to"], ["Recipients", "to"], ["Send to", "to"], ["Reply-To", "to"],
    ["Cc", "copy"], ["Bcc:", "copy"], ["CC/BCC", "copy"],
    ["Message", null], ["Description", null], ["Topic", null], ["Order number", null], ["Contact email", null],
  ])("reads %j as %s", (label, want) => {
    expect(recipientField(label)).toBe(want);
  });
  it("reads subject lines", () => {
    expect(["Subject", "Subject:", "subject line", "Subject (optional)", "Email subject"].map(subjectField)).toEqual([true, true, true, true, true]);
    expect(["Message", "Subject area", "Description"].map(subjectField)).toEqual([false, false, false]);
  });
  it.each([
    ["reply and cc dana@example.com", true],
    ["reply to Priya and bcc my manager", true],
    ["loop Dana in on the reply", true],
    ["copy my manager in", true],
    ["forward it to Sam", true],
    ["add Dana to the thread", true],
    ["include my boss on the reply", true],
    ["reply to Priya saying I'm in", false],
    ["copy the order number into the case", false],
    ["add this meeting to my calendar", false],
  ])("%j adds a recipient: %s", (instruction, want) => {
    expect(addsRecipient(instruction)).toBe(want);
  });
});

describe("the claims Jev checks", () => {
  const d = (text: string, b: DraftBasis = basis("reply to Priya Raman")) => ({ text, basis: b });
  it("leaves out greetings, thanks, sign-offs and a name alone, and keeps every other sentence", () => {
    const s = sentencesOf("Hi Priya,\nI'm in! See you Thursday.\nThanks,\nSam");
    expect(s).toEqual(["Hi Priya,", "I'm in!", "See you Thursday.", "Thanks,", "Sam"]);
    const b = basis("reply to Priya, signed Sam");
    expect(s.filter((x) => !noClaim(x, b))).toEqual(["I'm in!", "See you Thursday."]);
    expect(["Yes.", "Sure!", "Best,", "Best regards, Sam", "Thank you so much!"].map((x) => noClaim(x, b))).toEqual([false, false, true, true, true]);
  });

  const jev = (yes: (text: string) => number) => {
    const seen: JevRequest[] = [];
    const ask: AskJev = async (req) => {
      seen.push(req);
      return { model: "jev-test", answers: {}, nouls: Object.fromEntries(Object.entries(req.nouls ?? {}).map(([id, n]) => [id, yes(String(n.instructions))])), inputTokens: 10, latencyMs: 1, costUsd: 0.0001 };
    };
    return { ask, seen };
  };

  it("asks both wordings about each claim and passes only what both confirm at the floor", async () => {
    const j = jev(() => 0.97);
    // An instruction neither sentence restates (G2: a restatement is not asked about).
    await expect(confirmClaims("draft a reply that accepts", [d("Hi Priya, I'm in! See you then.")], j.ask, [])).resolves.toMatchObject({ calls: 2 });
    expect(j.seen.map((r) => Object.keys(r.nouls ?? {}))).toEqual([["c1", "c2"], ["c1", "c2"]]);
  });

  it("refuses a sentence one wording doubts, naming it", async () => {
    let n = 0;
    const ask: AskJev = async (req) => ({ model: "jev-test", answers: {}, nouls: Object.fromEntries(Object.keys(req.nouls ?? {}).map((id) => [id, n++ === 1 ? 0.6 : 0.99])), inputTokens: 1, latencyMs: 1, costUsd: 0 });
    await expect(confirmClaims("say I'm in", [d("I'm in. I'll bring dessert.")], ask, [])).rejects.toMatchObject({ why: "claim", word: "I'll bring dessert." });
  });

  it("refuses on doubt when there is no Jev or Jev fails, and asks nothing for a draft with no claim", async () => {
    await expect(confirmClaims("say yes", [d("I'm in.")], null, [])).rejects.toMatchObject({ why: "unchecked" });
    await expect(confirmClaims("say yes", [d("I'm in.")], async () => { throw new Error("HTTP 500"); }, [])).rejects.toMatchObject({ why: "unchecked" });
    // G2: a sentence that only restates the instruction has nothing to confirm either.
    await expect(confirmClaims("say I'm in", [d("I'm in.")], null, [])).resolves.toEqual({ calls: 0, costUsd: 0 });
    await expect(confirmClaims("say thanks", [d("Thanks, Priya!")], null, [])).resolves.toEqual({ calls: 0, costUsd: 0 });
  });

  it("carries only the declared snippets its text holds, charged to their windows", async () => {
    const j = jev(() => 0.99);
    await confirmClaims("accept for me", [d("Priya Raman, I'm in.")], j.ask, [{ windowId: "m1", kind: "candidate", text: "Priya Raman" }, { windowId: "m2", kind: "candidate", text: "Dana Whitfield" }]);
    expect(j.seen[0]?.snippets.map((x) => x.text)).toEqual(["Priya Raman"]);
    expect(j.seen[0]?.charged).toEqual({ m1: 11 });
  });
});

describe("G2: which sentences only restate the instruction", () => {
  const b = basis("reply to Priya Raman");
  it.each([
    ["I'm in.", "draft a reply saying I'm in", true],
    ["I am in.", "draft a reply saying I'm in", true],
    ["Hi Priya, I'm in for the workshop!", "draft an RSVP saying I'm in for the workshop", true],
    ["I'm in, Priya Raman.", "reply to Priya saying I'm in", true],
    ["I'll be there at 4.", "copy her address and tell her I'll be there at 4", true],
    ["I can't make it.", "tell her I can't make it. Do not send", true],
    ["I'm in.", 'reply "I\'m in"', true],
    ["The workshop.", "draft an RSVP saying I'm in for the workshop", false],
    ["I'm in.", "draft an RSVP saying I'm in for the workshop", false],
    ["Friday works.", "tell her I can't do Friday but Monday works", false],
    ["I can make it.", "tell her I can't make it", false],
    ["I'm in.", "do not say I'm in", false],
    ["I'm in.", "if the time works, say I'm in", false],
    ["I'm in.", "say I'm out or in", false],
    ["You're in.", "draft a reply saying I'm in", false],
    ["Hi Dana, I'm in.", "draft a reply saying I'm in", false],
    ["I'm in.", "tell Priya I'm in", true],
    ["Cancel the meeting.", "say we should cancel the meeting", false],
    ["I'm in.", "I'm in", false],
    ["I'm in.", "copy her address into To and draft an RSVP saying I'm in. Do not send", true],
    ["I'm in.", "draft an RSVP saying I'm in, and do not send it", false],
    ["I'm in.", "say I'm in, if they pay", false],
    // G2 review: what follows "avoid saying", "I deny that" or a quoted example is not asked for.
    ["I'm in.", "Avoid saying I'm in", false],
    ["I agree.", "Reply saying I deny that I agree", false],
    ["I deny that I agree.", "Reply saying I deny that I agree", true],
    ["I'll handle it.", 'Never make this promise: "Sure. Say I\'ll handle it."', false],
    ["Sure, I'll handle it.", 'reply "Sure, I\'ll handle it"', true],
    ["Thanks!", "say thanks", false],
  ] as const)("%s for '%s': %s", (sentence, instruction, want) => {
    expect(restates(sentence, instruction, b)).toBe(want);
  });
});

// B30 review 1: each input the reviewer showed passing, now refused.
describe("review 1: drafts that slipped a fact through", () => {
  const none = (instruction: string, windows: { title: string; text: string }[] = []): DraftBasis => ({ instruction, windows, memory: [] });

  it("reads a greeting's or thanks' remainder as a claim unless it is a name the basis shows", async () => {
    const b = none("say thanks");
    for (const t of ["Thanks, I'll pay.", "Thanks, I refuse.", "Thanks mallory."]) expect(noClaim(t, b), t).toBe(false);
    await expect(confirmClaims("say thanks", [{ text: "Thanks, I'll pay.", basis: b }], null, [])).rejects.toMatchObject({ why: "unchecked" });
    expect(why("Thanks mallory.", b)).toEqual(["newFact", "mallory"]);
    expect(noClaim("Thanks Priya.", none("thank Priya"))).toBe(true);
    expect(noClaim("Thanks Priya.", none("say thanks"))).toBe(false);
  });

  it.each([
    ["See you October third.", "say thanks", "October 8\n3 guests", "October third"],
    ["See you at half past three.", "confirm the meeting time", "at three", "half past three"],
    ["See you next Friday.", "say thanks", "last Friday", "next Friday"],
    ["See you the 3rd of October.", "say thanks", "October 8\n3 guests", "the 3rd of October"],
  ])("reads %j whole, not as pieces the basis has", (draft, instruction, text, word) => {
    expect(why(draft, none(instruction, [{ title: "Note", text: text.replace("\\n", "\n") }]))).toEqual(["newFact", word]);
  });

  it.each([
    ["I have ９９ guests.", ["unreadable", "９"]],
    ["I have ⁹ guests.", ["unreadable", "⁹"]],
    ["I have ٩٩ guests.", ["unreadable", "٩"]],
    ["I came thirteenth.", ["newFact", "thirteenth"]],
    ["The chapter xvi is ready.", ["newFact", "xvi"]],
    ["The chapter XVI is ready.", ["newFact", "XVI"]],
    ["Thanks 李雷.", ["newFact", "李雷"]],
    ["Please see evil.xyz.", ["newFact", "evil.xyz"]],
    ["Please write mallory at evil dot xyz.", ["newFact", "mallory at evil dot xyz"]],
  ])("refuses %j", (draft, want) => {
    expect(why(draft, none("say thanks"))).toEqual(want);
  });

  it("refuses digits split by invisible characters", () => {
    expect(why("Please call 5\u200b5\u200b5\u200b1\u200b2\u200b3\u200b4.", none("say thanks", [{ title: "Note", text: "1 2 3 4 5" }]))?.[0]).toBe("notProse");
  });

  it("compares amounts and numbers exactly, and reads a currency code as money", () => {
    expect(why("The quote is $45.009.", none("say thanks", [{ title: "Quote", text: "$45.00" }]))).toEqual(["newFact", "$45.009"]);
    expect(why("I have 9007199254740993 items.", none("say thanks", [{ title: "Stock", text: "9007199254740992 items" }]))).toEqual(["newFact", "9007199254740993"]);
    expect(why("The price is USD 500.", none("say the price is USD 500"))).toEqual(["money", "USD 500"]);
    expect(why("Yes to the 500 quote.", none("say yes to the 500 quote"))).toEqual(["money", "500 quote"]);
    expect(why("The quote is $45.00.", none("say thanks", [{ title: "Quote", text: "$45.00" }]))).toBeNull();
  });
});

// B30 re-check of review 1: what the first fixes still let through, now refused.
describe("review 1 re-check", () => {
  const none = (instruction: string, windows: { title: string; text: string }[] = []): DraftBasis => ({ instruction, windows, memory: [] });

  it("binds a reply's To to the From of the message it answers, in the header only", () => {
    const msg = (message: string, title = "Invoice") => ({ title, message });
    expect(senderOf("Re: Invoice", msg("From: Priya <priya@example.com>\nReply-To: Mallory <mallory@example.com>"), "priya@example.com")).toBe(true);
    expect(senderOf("Re: Invoice", msg("From: Priya <priya@example.com>\nReply-To: Mallory <mallory@example.com>"), "mallory@example.com")).toBe(false);
    expect(senderOf("Re: Invoice", msg("From: Mallory <mallory@example.com>\nHere is a sample:\nSubject: Invoice", "Unrelated"), "mallory@example.com")).toBe(false);
    expect(senderOf("Re: Invoice", msg("Hello\nFrom: Mallory <mallory@example.com>"), "mallory@example.com")).toBe(false);
    expect(senderOf("Invoice", msg("From: Priya <priya@example.com>"), "priya@example.com")).toBe(false);
    expect(senderOf("Re: Re: Invoice", msg("From: Priya <priya@example.com>\nSubject: Invoice", "Mail"), "priya@example.com")).toBe(true);
  });

  it("reads label variants by their words", () => {
    expect(["Carbon-copy", "Blind carbon copy", "CC (optional)", "cc_list"].map(recipientField)).toEqual(["copy", "copy", "copy", "copy"]);
    expect(["To (required)", "To*", "Recipient(s)"].map(recipientField)).toEqual(["to", "to", "to"]);
    expect(["Subject area", "Topic"].map(subjectField)).toEqual([false, false]);
  });

  it("refuses text whose checked form differs from what is written, and keeps a number's sign", () => {
    expect(why("I need ½ liters.", none("say I need 1 or 2 liters"))).toEqual(["unreadable", "½"]);
    expect(why("The code is AB¹².", none("say thanks", [{ title: "Code", text: "AB12" }]))).toEqual(["unreadable", "¹"]);
    expect(why("I have -5 items.", none("say I have 5 items"))).toEqual(["newFact", "-5"]);
    expect(why("It is 5 degrees.", none("say it is 5 degrees"))).toBeNull();
  });

  it("does not invent a currency, and reads an amount in words beside a money word", () => {
    expect(why("The price is 500 euros.", none("say the price", [{ title: "Quote", text: "price 500" }]))).toEqual(["newFact", "500 euros"]);
    expect(why("The price is five hundred.", none("say the price is five hundred"))).toEqual(["money", "price is five hundred"]);
  });

  it("reads a date with what places it", () => {
    expect(why("See you next October.", none("confirm the date", [{ title: "Note", text: "October" }]))).toEqual(["newFact", "next October"]);
    expect(why("See you Friday after next.", none("confirm the date", [{ title: "Note", text: "Friday" }]))).toEqual(["newFact", "Friday after next"]);
    expect(why("See you next Friday.", none("confirm the date", [{ title: "Note", text: "next Friday" }]))).toBeNull();
  });

  it("keeps a link's path case", () => {
    expect(why("Please see https://example.com/SECRET.", none("share the link", [{ title: "Note", text: "https://example.com/secret" }]))).toEqual(["newFact", "https://example.com/SECRET"]);
    expect(why("Please see https://EXAMPLE.com/secret.", none("share the link", [{ title: "Note", text: "https://example.com/secret" }]))).toBeNull();
  });
});

// B30 third check: what the second fixes broke or let through.
describe("third check", () => {
  const none = (instruction: string, windows: { title: string; text: string }[] = []): DraftBasis => ({ instruction, windows, memory: [] });
  it("keeps words in parentheses when reading a label", () => {
    expect(["Recipients (Bcc)", "Send to (cc)"].map(recipientField)).toEqual(["copy", "copy"]);
    expect(["Title of the message", "Title of the email", "Subject (required)"].map(subjectField)).toEqual([true, true, true]);
    expect(["Title", "Job title"].map(subjectField)).toEqual([false, false]);
  });
  it("does not read a count beside a money word as money", () => {
    expect(why("The price is 5.", none("describe the note", [{ title: "Note", text: "The total is five participants." }]))).toEqual(["newFact", "price is 5"]);
    expect(why("The total is five participants.", none("describe the note", [{ title: "Note", text: "There are five participants." }]))).toBeNull();
  });
  it("reads a date phrase the same however it is spaced", () => {
    expect(why("See you Friday after next at 3 PM.", none("confirm", [{ title: "Note", text: "Friday  after next at 3 PM" }]))).toBeNull();
  });
});
