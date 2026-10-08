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

/** A mail thread of `messages` messages, each with its headers and `body` lines; `answerAt` puts `answer` in that message. */
function mailThread(rand: () => number, subject: string, messages: number, bodyLines: number, answer: { at: number; from: string; lines: Line[] } | null): Line[] {
  const out: Line[] = [];
  for (let k = 0; k < messages; k++) {
    const o = OTHERS[k % OTHERS.length]!;
    const own = answer !== null && answer.at === k;
    out.push({ text: `From: ${own ? answer.from : `${o.name} <${o.email}>`}`, values: own ? [] : [{ kind: "email", text: o.email }] });
    out.push({ text: "To: Avery Kim <avery.kim@example.com>" });
    out.push({ text: `Date: Oct ${1 + (k % 28)}, 2026` });
    out.push({ text: `Subject: ${subject}` });
    if (own) out.push(...answer.lines);
    out.push(...chatter(rand, bodyLines, 7));
  }
  return out;
}

interface DeskSpec {
  id: string;
  form: string;
  kind: string;
  instruction: string;
  /** Field label to expected value; every other field of the form is "none". */
  expected: Record<string, string>;
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

desks.push({
  id: "lc-01", form: "httpbin-pizza", kind: "chat150-recent", instruction: "fill this in from what I just texted Sam",
  expected: { "Customer name": "Jordan Reyes", Telephone: ME.phone, "E-mail address": ME.email, "Delivery instructions": "side door, ring twice" },
  source: { file: "sources/lc-01.window.json", snapshot: chat("01", "Sam Ortiz", 150, "recent", [{ text: "ok ordering the pizza now, here's my info for the form" }, { text: "Name: Jordan Reyes" }, { text: `Phone: ${ME.phone}`, values: [val("phone", ME.phone)] }, { text: `Email: ${ME.email}`, values: [val("email", ME.email)] }, { text: "Delivery instructions: side door, ring twice" }], 101) },
});
desks.push({
  id: "lc-02", form: "greenhouse-apply", kind: "chat300-recent", instruction: "fill in my contact details from my chat with Priya",
  expected: { "First Name": ME.first, "Last Name": ME.last, Email: ME.email, Phone: ME.phone, "LinkedIn Profile": "https://www.linkedin.com/in/jordan-reyes-dev" },
  source: { file: "sources/lc-02.window.json", snapshot: chat("02", "Priya Raman", 300, "recent", [{ text: "here's what I'm putting on the application, can you double check" }, { text: "First Name: Jordan" }, { text: "Last Name: Reyes" }, { text: `Email: ${ME.email}`, values: [val("email", ME.email)] }, { text: `Phone: ${ME.phone}`, values: [val("phone", ME.phone)] }, { text: "LinkedIn: https://www.linkedin.com/in/jordan-reyes-dev", values: [val("url", "https://www.linkedin.com/in/jordan-reyes-dev")] }], 202) },
});
desks.push({
  id: "lc-03", form: "event-rsvp", kind: "chat1000-recent", instruction: "RSVP using the details I sent Bea",
  expected: { "Your full name": "Jordan Reyes", Email: ME.email, Phone: ME.phone },
  source: { file: "sources/lc-03.window.json", snapshot: chat("03", "Bea Sutherland", 1000, "recent", [{ text: "for the RSVP form, use these" }, { text: "Full name: Jordan Reyes" }, { text: `Email: ${ME.email}`, values: [val("email", ME.email)] }, { text: `Phone: ${ME.phone}`, values: [val("phone", ME.phone)] }], 303) },
});
desks.push({
  id: "lc-04", form: "checkout-shipping", kind: "chat300-old", instruction: "ship it to the address I gave Marcus a while back",
  expected: { "First name": ME.first, "Last name": ME.last, Address: ME.street, City: ME.city, "ZIP code": ME.zip },
  source: { file: "sources/lc-04.window.json", snapshot: chat("04", "Marcus Bell", 300, "old", [{ text: "my shipping info for the order:" }, { text: "First name: Jordan" }, { text: "Last name: Reyes" }, { text: `Address: ${ME.street}`, values: [val("address", `${ME.street}, ${ME.city}, TX ${ME.zip}`)] }, { text: `City: ${ME.city}` }, { text: `ZIP code: ${ME.zip}` }], 404) },
});
desks.push({
  id: "lc-05", form: "job-application", kind: "chat1000-old", instruction: "fill in my details from my old chat with Kofi",
  expected: { "Full name": "Jordan Reyes", Email: ME.email, Phone: ME.phone, "GitHub URL": "https://github.com/jordan-reyes-dev" },
  source: { file: "sources/lc-05.window.json", snapshot: chat("05", "Kofi Mensah", 1000, "old", [{ text: "for the referral form you need:" }, { text: "Full name: Jordan Reyes" }, { text: `Email: ${ME.email}`, values: [val("email", ME.email)] }, { text: `Phone: ${ME.phone}`, values: [val("phone", ME.phone)] }, { text: "GitHub: https://github.com/jordan-reyes-dev", values: [val("url", "https://github.com/jordan-reyes-dev")] }], 505) },
});
desks.push({
  id: "lc-06", form: "car-service-booking", kind: "chat150-old", instruction: "book the service with the car details I texted Dana",
  expected: { "Full name": "Jordan Reyes", Email: ME.email, "Mobile phone": ME.phone, VIN: "1HGCM82633A004352", "Current mileage": "59,870" },
  source: { file: "sources/lc-06.window.json", snapshot: chat("06", "Dana Whitfield", 150, "old", [{ text: "car stuff for the booking:" }, { text: "Full name: Jordan Reyes" }, { text: `Email: ${ME.email}`, values: [val("email", ME.email)] }, { text: `Mobile phone: ${ME.phone}`, values: [val("phone", ME.phone)] }, { text: "VIN: 1HGCM82633A004352" }, { text: "Current mileage: 59,870" }], 606) },
});
desks.push({
  id: "lc-07", form: "rental-application", kind: "note-beside-long-chats", instruction: "fill out this application from my note",
  expected: { "First name": ME.first, "Last name": ME.last, "Email address": ME.email, "Mobile phone": ME.phone, "Street address": ME.street, City: ME.city, "ZIP code": ME.zip },
  source: { file: "sources/lc-07.window.json", snapshot: noteSnapshot("lc-07", "Rental details.txt", [{ text: "First name: Jordan" }, { text: "Last name: Reyes" }, { text: `Email address: ${ME.email}`, values: [val("email", ME.email)] }, { text: `Mobile phone: ${ME.phone}`, values: [val("phone", ME.phone)] }, { text: `Street address: ${ME.street}` }, { text: `City: ${ME.city}` }, { text: `ZIP code: ${ME.zip}` }]) },
});
desks.push({
  id: "lc-08", form: "clinic-intake", kind: "note-beside-long-chats", instruction: "fill in my contact info from my note",
  expected: { "Patient full name (legal)": "Jordan Reyes", Email: ME.email, "Mobile phone": ME.phone, "Street address": ME.street, City: ME.city, "ZIP code": ME.zip },
  source: { file: "sources/lc-08.window.json", snapshot: noteSnapshot("lc-08", "Clinic intake.txt", [{ text: "Patient full name (legal): Jordan Reyes" }, { text: `Email: ${ME.email}`, values: [val("email", ME.email)] }, { text: `Mobile phone: ${ME.phone}`, values: [val("phone", ME.phone)] }, { text: `Street address: ${ME.street}` }, { text: `City: ${ME.city}` }, { text: `ZIP code: ${ME.zip}` }]) },
});
desks.push({
  id: "lc-09", form: "course-enrollment", kind: "mail-thread-recent", instruction: "enroll me with the details from the registrar thread",
  expected: { "First name": ME.first, "Last name": ME.last, Email: ME.email, Phone: ME.phone },
  source: { file: "sources/lc-09.window.json", snapshot: snapshot("lc-09", "Re: Lakeside enrollment - Mail - Google Chrome", CHROME, mailThread(mulberry32(909), "Re: Lakeside enrollment", 40, 6, { at: 39, from: `Jordan Reyes <${ME.email}>`, lines: [{ text: "First name: Jordan" }, { text: "Last name: Reyes" }, { text: `Email: ${ME.email}`, values: [val("email", ME.email)] }, { text: `Phone: ${ME.phone}`, values: [val("phone", ME.phone)] }] })) },
});
desks.push({
  id: "lc-10", form: "b2b-demo-request", kind: "mail-thread-old", instruction: "request the demo with my details from the vendor thread",
  expected: { "First name": ME.first, "Last name": ME.last, "Work email": ME.email, "Phone number": ME.phone },
  source: { file: "sources/lc-10.window.json", snapshot: snapshot("lc-10", "Re: Demo for Lumen Labs - Mail - Google Chrome", CHROME, mailThread(mulberry32(1010), "Re: Demo for Lumen Labs", 120, 4, { at: 0, from: `Jordan Reyes <${ME.email}>`, lines: [{ text: "First name: Jordan" }, { text: "Last name: Reyes" }, { text: `Work email: ${ME.email}`, values: [val("email", ME.email)] }, { text: `Phone number: ${ME.phone}`, values: [val("phone", ME.phone)] }] })) },
});
desks.push({
  id: "lc-11", form: "support-ticket", kind: "chat300-superseded", instruction: "file the ticket with my current email from my chat with Ines",
  expected: { "Your name": "Jordan Reyes", "Email address": "jordan.reyes@example.net" },
  source: { file: "sources/lc-11.window.json", snapshot: (() => {
    const rand = mulberry32(1111);
    const lines = chatter(rand, 290, 9);
    lines.splice(4, 0, { text: "Name: Jordan Reyes" }, { text: `Email address: ${ME.email}`, values: [val("email", ME.email)] });
    lines.splice(lines.length - 5, 0, { text: "heads up, I switched emails, the old one is gone" }, { text: "Email address: jordan.reyes@example.net", values: [val("email", "jordan.reyes@example.net")] });
    return snapshot("lc-11", "Ines Lindqvist", MESSAGES, lines);
  })() },
});
desks.push({
  id: "lc-12", form: "conference-registration", kind: "chat1000-recent-other-person-old", instruction: "register me with the details I sent Marcus",
  expected: { "First name": ME.first, "Last name": ME.last, "Email address": ME.email, "Job title": "Senior Product Designer", "Company or organization": "Lumen Labs" },
  source: { file: "sources/lc-12.window.json", snapshot: (() => {
    const rand = mulberry32(1212);
    const lines = chatter(rand, 985, 9);
    // Another person's registration, long before.
    lines.splice(8, 0, { text: "Marcus registered with:" }, { text: "First name: Marcus" }, { text: "Last name: Bell" }, { text: "Email address: marcus.bell@example.com", values: [val("email", "marcus.bell@example.com")] }, { text: "Job title: Staff Engineer" }, { text: "Company or organization: Harbor Analytics" });
    lines.splice(lines.length - 6, 0, { text: "ok here's mine for the conference form" }, { text: "First name: Jordan" }, { text: "Last name: Reyes" }, { text: `Email address: ${ME.email}`, values: [val("email", ME.email)] }, { text: "Job title: Senior Product Designer" }, { text: "Company or organization: Lumen Labs" });
    return snapshot("lc-12", "Marcus Bell", MESSAGES, lines);
  })() },
});

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
    fields: base.fields.map((f) => ({ ...f, expected: d.expected[f.label] ?? "none", ...(f.accept === undefined ? {} : { accept: f.accept }) })),
  };
});
if (new Set(forms.map((f) => f.id)).size !== forms.length) throw new Error("two desks on one form: each form's page walk is keyed by its id");
writeFileSync(join(OUT, "corpus.json"), `${JSON.stringify({ about: "Long-conversation dev set (scripts/longchat-fixtures.ts): the B24 forms with long chats and mail threads as sources and bystanders. Synthetic only.", decoys: decoys.map((d) => ({ kind: "window", file: d.file })), forms }, null, 1)}\n`);
writeFileSync(join(OUT, "asks.json"), `${JSON.stringify({ asks: desks.map((d) => ({ id: d.id, form: d.form, instruction: d.instruction, expected: d.expected, kind: d.kind })) }, null, 1)}\n`);
console.log(`wrote ${desks.length} desks and ${decoys.length} bystanders to ${OUT}`);
