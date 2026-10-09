// Writes the long-conversation dev set (fixtures/longchat): desks whose source is a chat of 150, 300 or 1,000 messages or
// a long mail thread, with the answer in its recent part, its old part, or a note beside it, and two long bystander
// conversations full of other people's details on every desk. Every name, address and value is invented; addresses and
// mail are example.com and the 555-01xx numbers. The forms are the B24 dev corpus's (fixtures/realfill), and no text
// comes from a held-out set. Deterministic: run again, and the files are the same.
//
//   node scripts/longchat-fixtures.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "../../fixtures/longchat");
const REALFILL = join(here, "../../fixtures/realfill");
const realfill = JSON.parse(readFileSync(join(REALFILL, "corpus.json"), "utf8")) as { forms: { id: string; file: string; fields: { label: string; control: string; options?: string[]; group?: string; expected: string; accept?: string[] }[] }[] };

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MESSAGES = { pid: 7373, bundleId: "com.apple.MobileSMS", name: "Messages" };
const CHROME = { pid: 4100, bundleId: "com.google.Chrome", name: "Google Chrome" };
const TEXTEDIT = { pid: 7001, bundleId: "com.apple.TextEdit", name: "TextEdit" };
const OUTLOOK = { pid: 8282, bundleId: "com.microsoft.Outlook", name: "Microsoft Outlook" };
type Value = { kind: "phone" | "email" | "date" | "address" | "url" | "time"; text: string };
type Line = { text: string; values?: Value[] };

const CHATTER = [
  "haha yes", "ok sounds good", "on my way", "did you see the game last night", "can't make it tonight sorry", "let me check and get back to you",
  "the train is running late again", "who's bringing snacks", "lol", "that's hilarious", "sure, whenever works", "I'll send the photos later",
  "are we still on for Thursday", "running ten minutes behind", "thanks!", "no worries", "the venue changed so double check before you leave",
  "my phone is about to die", "sounds like a plan", "what time works for you", "I'm at the store now, need anything", "great, see you then",
  "can you forward me that link", "ugh traffic", "brb", "perfect", "did anyone hear back from the landlord", "the wifi here is terrible",
  "happy birthday!!", "send me the recipe", "I think it's supposed to rain", "we should book soon before it fills up",
];
const OTHERS = [
  { name: "Priya Raman", phone: "(415) 555-0162", email: "priya.raman@example.com", street: "2201 Mission St", city: "San Francisco" },
  { name: "Marcus Bell", phone: "(206) 555-0118", email: "marcus.bell@example.com", street: "88 Pike St", city: "Seattle" },
  { name: "Ines Lindqvist", phone: "(617) 555-0129", email: "ines.lindqvist@example.org", street: "27 Linden Terrace", city: "Somerville" },
  { name: "Kofi Mensah", phone: "(312) 555-0174", email: "kofi.mensah@example.net", street: "410 W Erie St", city: "Chicago" },
  { name: "Dana Whitfield", phone: "(503) 555-0131", email: "dana.whitfield@example.com", street: "1907 Alameda Ave", city: "Portland" },
];

/** `n` chat messages of chatter, one in `every` a line with another person's phone, email or address. */
function chatter(rand: () => number, n: number, every: number): Line[] {
  const out: Line[] = [];
  for (let i = 0; i < n; i++) {
    if (every > 0 && i % every === every - 1) {
      const o = OTHERS[Math.floor(rand() * OTHERS.length)]!;
      const pick = Math.floor(rand() * 3);
      out.push(pick === 0 ? { text: `${o.name.split(" ")[0]}'s number is ${o.phone}`, values: [{ kind: "phone", text: o.phone }] } : pick === 1 ? { text: `you can reach ${o.name.split(" ")[0]} at ${o.email}`, values: [{ kind: "email", text: o.email }] } : { text: `${o.name.split(" ")[0]} moved to ${o.street}, ${o.city}`, values: [{ kind: "address", text: `${o.street}, ${o.city}` }] });
    } else out.push({ text: CHATTER[Math.floor(rand() * CHATTER.length)]! });
  }
  return out;
}

function snapshot(windowId: string, title: string, app: { pid: number; bundleId: string; name: string }, lines: Line[]): unknown {
  const nodes = lines.map((l, i) => ({ key: `${windowId}/m${i}`, parent: null, role: "AXStaticText", label: l.text, frame: [20, 40 + i * 22, 640, 18] }));
  const values = lines.flatMap((l, i) => (l.values ?? []).map((v) => ({ kind: v.kind, text: v.text, nodeKey: `${windowId}/m${i}` })));
  return { type: "snapshot", v: 1, seq: 1, at: 0, reason: "initial", app, window: { windowId, kind: "standard", title, frame: [0, 0, 700, 900] }, focused: false, root: null, nodes, values, focusedKey: null, stats: { walkMs: 5, visited: nodes.length, truncated: false } };
}

function noteSnapshot(windowId: string, title: string, lines: Line[]): unknown {
  const key = `${windowId}/textarea`;
  return { type: "snapshot", v: 1, seq: 1, at: 0, reason: "initial", app: TEXTEDIT, window: { windowId, kind: "standard", title, frame: [0, 0, 700, 600] }, focused: false, root: null, nodes: [{ key, parent: null, role: "AXTextArea", value: lines.map((l) => l.text).join("\n"), editable: true }], values: lines.flatMap((l) => (l.values ?? []).map((v) => ({ kind: v.kind, text: v.text, nodeKey: key }))), focusedKey: null, stats: { walkMs: 5, visited: 1, truncated: false } };
}

/**
 * A mail thread of `messages` messages, one a day from Jul 1, 2026, each with its headers and `body` lines; `answer.at`
 * (counted from the oldest) puts `answer` in that message. `newestFirst` draws the newest message at the top, as Mail and
 * Outlook can (conversation.ts messageOrder).
 */
function mailThread(rand: () => number, subject: string, messages: number, bodyLines: number, answer: { at: number; from: string; lines: Line[] } | null, newestFirst = false): Line[] {
  const out: Line[][] = [];
  for (let k = 0; k < messages; k++) {
    const o = OTHERS[k % OTHERS.length]!;
    const own = answer !== null && answer.at === k;
    const day = new Date(Date.UTC(2026, 6, 1 + k)).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    out.push([
      { text: `From: ${own ? answer.from : `${o.name} <${o.email}>`}`, values: own ? [] : [{ kind: "email", text: o.email }] },
      { text: "To: Avery Kim <avery.kim@example.com>" },
      { text: `Date: ${day}` },
      { text: `Subject: ${subject}` },
      ...(own ? answer.lines : []),
      ...chatter(rand, bodyLines, 7),
    ]);
  }
  return (newestFirst ? out.reverse() : out).flat();
}

interface DeskSpec {
  id: string;
  form: string;
  kind: string;
  instruction: string;
  /** Field label to expected value; every other field of the form is "none". */
  expected: Record<string, string>;
  /** Field label to the other spellings of its expected value that count as right; the base form's own are not kept. */
  accept: Record<string, string[]>;
  source: { file: string; snapshot: unknown };
}

const ME = { first: "Jordan", last: "Reyes", email: "jordan.reyes@example.org", phone: "(512) 555-0147", street: "4410 Speedway", city: "Austin", zip: "78751" };
const desks: DeskSpec[] = [];
const chat = (id: string, title: string, n: number, answerAt: "recent" | "old" | null, answer: Line[], seed: number): unknown => {
  const rand = mulberry32(seed);
  const lines = chatter(rand, n - answer.length, 9);
  const at = answerAt === "recent" ? lines.length - 6 : answerAt === "old" ? 5 : lines.length;
  lines.splice(at, 0, ...answer);
  return snapshot(`lc-${id}`, title, MESSAGES, lines);
};
const val = (kind: Value["kind"], text: string): Value => ({ kind, text });

/** "Label: value" lines for `pairs`, each with its typed value when the reader would type one. */
const labelled = (pairs: [string, string, Value["kind"]?][]): Line[] => pairs.map(([l, v, k]) => ({ text: `${l}: ${v}`, ...(k === undefined ? {} : { values: [val(k, v)] }) }));
/** A desk whose answer is `pairs` in the source, and whose expected values are `expected` (the field's value, by label). */
const desk = (id: string, form: string, kind: string, instruction: string, expected: Record<string, string>, snapshotOf: unknown, accept: Record<string, string[]> = {}): void => {
  for (const l of Object.keys(accept)) if (expected[l] === undefined) throw new Error(`${id}: '${l}' has alternatives but no expected value`);
  desks.push({ id, form, kind, instruction, expected, accept, source: { file: `sources/${id}.window.json`, snapshot: snapshotOf } });
};

// The user's own details (name, email, phone, address) go to fields the owner rule judges (HA2: a conversation's value is
// never owner-judged, so those are withheld from a chat); each desk also holds values no owner rule touches (a time, a
// code, a link, a note), which only the conversation's reading decides.
desk("lc-01", "httpbin-pizza", "chat150-recent", "fill this in from what I just texted Sam",
  { "Customer name": "Jordan Reyes", Telephone: ME.phone, "E-mail address": ME.email, "Preferred delivery time": "19:30", "Delivery instructions": "side door, ring twice" },
  chat("01", "Sam Ortiz", 150, "recent", [{ text: "ok ordering the pizza now, here's my info for the form" }, ...labelled([["Name", "Jordan Reyes"], ["Phone", ME.phone, "phone"], ["Email", ME.email, "email"], ["Delivery time", "7:30 pm", "time"], ["Delivery instructions", "side door, ring twice"]])], 101));
desk("lc-02", "greenhouse-apply", "chat300-recent", "fill in my details from my chat with Priya",
  { "First Name": ME.first, "Last Name": ME.last, Email: ME.email, Phone: ME.phone, "Graduation Date (MM/YYYY)": "05/2027", "LinkedIn Profile": "https://www.linkedin.com/in/jordan-reyes-dev" },
  chat("02", "Priya Raman", 300, "recent", [{ text: "here's what I'm putting on the application, can you double check" }, ...labelled([["First Name", ME.first], ["Last Name", ME.last], ["Email", ME.email, "email"], ["Phone", ME.phone, "phone"], ["Graduation Date", "05/2027"], ["LinkedIn", "https://www.linkedin.com/in/jordan-reyes-dev", "url"]])], 202));
desk("lc-03", "event-rsvp", "chat1000-recent", "RSVP using the details I sent Bea",
  { "Your full name": "Jordan Reyes", Email: ME.email, Phone: ME.phone, "Approximate arrival time": "19:45", "Dietary restrictions or allergies": "no shellfish" },
  chat("03", "Bea Sutherland", 1000, "recent", [{ text: "for the RSVP form, use these" }, ...labelled([["Full name", "Jordan Reyes"], ["Email", ME.email, "email"], ["Phone", ME.phone, "phone"], ["Arrival time", "7:45 pm", "time"], ["Dietary restrictions", "no shellfish"]])], 303));
desk("lc-04", "checkout-shipping", "chat300-old", "ship it to the address I gave Marcus a while back",
  { "First name": ME.first, "Last name": ME.last, Address: ME.street, City: ME.city, "ZIP code": ME.zip, "Add a gift note": "Happy housewarming, Sam!" },
  chat("04", "Marcus Bell", 300, "old", [{ text: "my shipping info for the order:" }, ...labelled([["First name", ME.first], ["Last name", ME.last], ["Address", ME.street], ["City", ME.city], ["ZIP code", ME.zip], ["Gift note", "Happy housewarming, Sam!"]])], 404));
desk("lc-05", "job-application", "chat1000-old", "fill in my details from my old chat with Kofi",
  { "Full name": "Jordan Reyes", Email: ME.email, Phone: ME.phone, "GitHub URL": "https://github.com/jordan-reyes-dev", "Earliest start date": "2027-01-04", "Desired salary": "$145,000" },
  chat("05", "Kofi Mensah", 1000, "old", [{ text: "for the referral form you need:" }, ...labelled([["Full name", "Jordan Reyes"], ["Email", ME.email, "email"], ["Phone", ME.phone, "phone"], ["GitHub", "https://github.com/jordan-reyes-dev", "url"], ["Earliest start date", "Jan 4, 2027", "date"], ["Desired salary", "$145,000"]])], 505),
  { "GitHub URL": ["github.com/jordan-reyes-dev"] });
desk("lc-06", "car-service-booking", "chat150-old", "book the service with the car details I texted Dana",
  { "Full name": "Jordan Reyes", Email: ME.email, "Mobile phone": ME.phone, VIN: "1HGCM82633A004352", "Current mileage": "59,870", "Comments for your service advisor": "the brakes squeal when cold" },
  chat("06", "Dana Whitfield", 150, "old", [{ text: "car stuff for the booking:" }, ...labelled([["Full name", "Jordan Reyes"], ["Email", ME.email, "email"], ["Mobile phone", ME.phone, "phone"], ["VIN", "1HGCM82633A004352"], ["Current mileage", "59,870"], ["Comments", "the brakes squeal when cold"]])], 606),
  { "Current mileage": ["59870"] });
desk("lc-07", "rental-application", "note-beside-long-chats", "fill out this application from my note",
  { "First name": ME.first, "Last name": ME.last, "Email address": ME.email, "Mobile phone": ME.phone, "Street address": ME.street, City: ME.city, "ZIP code": ME.zip },
  noteSnapshot("lc-07", "Rental details.txt", labelled([["First name", ME.first], ["Last name", ME.last], ["Email address", ME.email, "email"], ["Mobile phone", ME.phone, "phone"], ["Street address", ME.street], ["City", ME.city], ["ZIP code", ME.zip]])));
desk("lc-08", "clinic-intake", "note-beside-long-chats", "fill in my contact info from my note",
  { "Patient full name (legal)": "Jordan Reyes", Email: ME.email, "Mobile phone": ME.phone, "Street address": ME.street, City: ME.city, "ZIP code": ME.zip },
  noteSnapshot("lc-08", "Clinic intake.txt", labelled([["Patient full name (legal)", "Jordan Reyes"], ["Email", ME.email, "email"], ["Mobile phone", ME.phone, "phone"], ["Street address", ME.street], ["City", ME.city], ["ZIP code", ME.zip]])));
desk("lc-09", "course-enrollment", "mail-thread-recent", "enroll me with the details from the registrar thread",
  { "First name": ME.first, "Last name": ME.last, Email: ME.email, Phone: ME.phone, "Student ID (returning students)": "LC-204417" },
  snapshot("lc-09", "Re: Lakeside enrollment - Mail - Google Chrome", CHROME, mailThread(mulberry32(909), "Re: Lakeside enrollment", 40, 6, { at: 39, from: `Jordan Reyes <${ME.email}>`, lines: labelled([["First name", ME.first], ["Last name", ME.last], ["Email", ME.email, "email"], ["Phone", ME.phone, "phone"], ["Student ID", "LC-204417"]]) })));
desk("lc-10", "b2b-demo-request", "mail-thread-old", "request the demo with my details from the vendor thread",
  { "First name": ME.first, "Last name": ME.last, "Work email": ME.email, "Phone number": ME.phone, "Company website": "https://lumenlabs.example.com", "Anything else we should know?": "we run 40 entities across 3 currencies" },
  snapshot("lc-10", "Re: Demo for Lumen Labs - Mail - Google Chrome", CHROME, mailThread(mulberry32(1010), "Re: Demo for Lumen Labs", 120, 4, { at: 0, from: `Jordan Reyes <${ME.email}>`, lines: labelled([["First name", ME.first], ["Last name", ME.last], ["Work email", ME.email, "email"], ["Phone number", ME.phone, "phone"], ["Company website", "https://lumenlabs.example.com", "url"], ["Anything else", "we run 40 entities across 3 currencies"]]) })));
desk("lc-11", "support-ticket", "chat300-superseded", "file the ticket with my current email from my chat with Ines",
  { "Your name": "Jordan Reyes", "Email address": "jordan.reyes@example.net", "Workspace URL": "https://lumen.example.com", Subject: "CSV export fails over 10k rows" },
  (() => {
    const rand = mulberry32(1111);
    const lines = chatter(rand, 288, 9);
    lines.splice(4, 0, ...labelled([["Name", "Jordan Reyes"], ["Email address", ME.email, "email"]]));
    lines.splice(lines.length - 5, 0, { text: "heads up, I switched emails, the old one is gone" }, ...labelled([["Email address", "jordan.reyes@example.net", "email"], ["Workspace URL", "https://lumen.example.com", "url"], ["Subject", "CSV export fails over 10k rows"]]));
    return snapshot("lc-11", "Ines Lindqvist", MESSAGES, lines);
  })());
desk("lc-12", "conference-registration", "chat1000-recent-other-person-old", "register me with the details I sent Marcus",
  { "First name": ME.first, "Last name": ME.last, "Email address": ME.email, "Job title": "Senior Product Designer", "Company or organization": "Lumen Labs" },
  (() => {
    const rand = mulberry32(1212);
    const lines = chatter(rand, 985, 9);
    // Another person's registration, long before.
    lines.splice(8, 0, { text: "Marcus registered with:" }, ...labelled([["First name", "Marcus"], ["Last name", "Bell"], ["Email address", "marcus.bell@example.com", "email"], ["Job title", "Staff Engineer"], ["Company or organization", "Harbor Analytics"]]));
    lines.splice(lines.length - 6, 0, { text: "ok here's mine for the conference form" }, ...labelled([["First name", ME.first], ["Last name", ME.last], ["Email address", ME.email, "email"], ["Job title", "Senior Product Designer"], ["Company or organization", "Lumen Labs"]]));
    return snapshot("lc-12", "Marcus Bell", MESSAGES, lines);
  })());

desk("lc-13", "hubspot-contact", "mail-thread-newest-first", "fill in the contact form from my thread with the Lumen team",
  { "First Name": ME.first, "Last Name": ME.last, Email: ME.email, "Phone number": ME.phone, "Company name": "Lumen Labs", "Website URL": "https://lumenlabs.example.com", "How can we help?": "we need SSO for 300 seats by March" },
  snapshot("lc-13", "Re: Lumen Labs onboarding - Outlook", OUTLOOK, mailThread(mulberry32(1313), "Re: Lumen Labs onboarding", 60, 5, { at: 59, from: `Jordan Reyes <${ME.email}>`, lines: labelled([["First name", ME.first], ["Last name", ME.last], ["Email", ME.email, "email"], ["Phone", ME.phone, "phone"], ["Company name", "Lumen Labs"], ["Website", "https://lumenlabs.example.com", "url"], ["How can we help", "we need SSO for 300 seats by March"]]) }, true)));

// The two long bystanders on every desk: a 1,000-message group chat and a 600-line mail thread, other people's details only.
const decoys = [
  { file: "sources/weekend-crew.window.json", snapshot: snapshot("lc-group", "Weekend crew", MESSAGES, chatter(mulberry32(77), 1000, 6)) },
  { file: "sources/offsite-thread.window.json", snapshot: snapshot("lc-thread", "Re: Q4 offsite planning - Mail - Google Chrome", CHROME, mailThread(mulberry32(78), "Re: Q4 offsite planning", 60, 6, null)) },
];

mkdirSync(join(OUT, "sources"), { recursive: true });
for (const s of [...desks.map((d) => d.source), ...decoys]) writeFileSync(join(OUT, s.file), `${JSON.stringify(s.snapshot)}\n`);
const forms = desks.map((d) => {
  const base = realfill.forms.find((f) => f.id === d.form);
  if (base === undefined) throw new Error(`no B24 form ${d.form}`);
  for (const l of Object.keys(d.expected)) if (!base.fields.some((f) => f.label === l)) throw new Error(`${d.id}: ${d.form} has no field '${l}'`);
  return {
    id: d.form,
    file: `../realfill/${base.file}`,
    origin: `the B24 dev corpus's ${d.form}, with ${d.id}'s long-conversation source`,
    source: { kind: "window", file: d.source.file },
    // The base form's alternatives were for its own source's values, so none is kept (one accepted another person's URL).
    fields: base.fields.map(({ accept: _base, ...f }) => ({ ...f, expected: d.expected[f.label] ?? "none", ...(d.accept[f.label] === undefined ? {} : { accept: d.accept[f.label] }) })),
  };
});
if (new Set(forms.map((f) => f.id)).size !== forms.length) throw new Error("two desks on one form: each form's page walk is keyed by its id");
writeFileSync(join(OUT, "corpus.json"), `${JSON.stringify({ about: "Long-conversation dev set (scripts/longchat-fixtures.ts): the B24 forms with long chats and mail threads as sources and bystanders. Synthetic only.", decoys: decoys.map((d) => ({ kind: "window", file: d.file })), forms }, null, 1)}\n`);
writeFileSync(join(OUT, "asks.json"), `${JSON.stringify({ asks: desks.map((d) => ({ id: d.id, form: d.form, instruction: d.instruction, expected: d.expected, kind: d.kind })) }, null, 1)}\n`);
// The same desks with no bystanders (fixtures/longchat-solo): what a long source alone costs, apart from what two long
// bystanders full of other people's details cut.
const SOLO = join(here, "../../fixtures/longchat-solo");
mkdirSync(SOLO, { recursive: true });
writeFileSync(join(SOLO, "corpus.json"), `${JSON.stringify({ about: "The long-conversation dev set's desks with no bystanders (scripts/longchat-fixtures.ts). Synthetic only.", decoys: [], forms: forms.map((f) => ({ ...f, file: `../realfill/${f.file.replace(/^\.\.\/realfill\//u, "")}`, source: { kind: "window", file: `../longchat/${f.source.file}` } })) }, null, 1)}\n`);
writeFileSync(join(SOLO, "asks.json"), `${JSON.stringify({ asks: desks.map((d) => ({ id: d.id, form: d.form, instruction: d.instruction, expected: d.expected, kind: d.kind })) }, null, 1)}\n`);
console.log(`wrote ${desks.length} desks and ${decoys.length} bystanders to ${OUT}`);
