// The B24 real-form corpus (fixtures/realfill): its schema, the window titles its pages and notes get, and the
// mail page each mail source is shown as. Shared by realfill-capture.ts and realfill-eval.ts.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod";

const Control = z.enum(["text", "email", "tel", "url", "textarea", "select", "radio", "checkbox", "date", "time", "file", "combobox"]);
export type Control = z.infer<typeof Control>;

const Field = z
  .object({
    label: z.string(),
    group: z.string().optional(),
    control: Control,
    options: z.array(z.string()).optional(),
    /** The value a careful person fills, "none" to leave it, "handoff" for a control Caret names and leaves, or a checkbox's checked/unchecked. */
    expected: z.string(),
    accept: z.array(z.string()).optional(),
  })
  .strict();
export type CorpusField = z.infer<typeof Field>;

const Source = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("note"), file: z.string() }).strict(),
  z.object({ kind: z.literal("mail"), file: z.string() }).strict(),
  z.object({ kind: z.literal("memory"), about: z.array(z.object({ label: z.string(), value: z.string() }).strict()).min(1) }).strict(),
]);
type RawSource = z.infer<typeof Source>;
/** A source with the title of the window that shows it (a note's file name, a mail's subject); memory has none. */
export type CorpusSource = RawSource & { title?: string };

const Form = z.object({ id: z.string(), file: z.string(), origin: z.string(), source: Source, fields: z.array(Field).min(1) }).strict();
const CorpusFile = z.object({ about: z.string(), decoys: z.array(Source), forms: z.array(Form).min(1) }).strict();

export interface CorpusForm {
  id: string;
  file: string;
  /** The page's <title>, which is how the reader names its Chrome window. */
  title: string;
  source: CorpusSource;
  fields: CorpusField[];
}
export interface Corpus {
  decoys: CorpusSource[];
  forms: CorpusForm[];
}

const Ask = z.object({ id: z.string(), form: z.string(), instruction: z.string().min(1), expected: z.union([z.literal("refuse"), z.record(z.string(), z.string())]) }).strict();
export type CorpusAsk = z.infer<typeof Ask>;

export const Mail = z.object({ from: z.string(), to: z.string(), date: z.string(), subject: z.string(), body: z.string() }).strict();
export type Mail = z.infer<typeof Mail>;

/** "order-note.txt" is shown as "Order note.txt", the way a person names a note. */
export function noteTitle(file: string): string {
  const b = basename(file).replace(/-/g, " ");
  return b.charAt(0).toUpperCase() + b.slice(1);
}

function withTitle(dir: string, s: RawSource): CorpusSource {
  if (s.kind === "note") return { ...s, title: noteTitle(s.file) };
  if (s.kind === "mail") return { ...s, title: Mail.parse(JSON.parse(readFileSync(join(dir, s.file), "utf8"))).subject };
  return s;
}

export function loadCorpus(dir: string): Corpus {
  const raw = CorpusFile.parse(JSON.parse(readFileSync(join(dir, "corpus.json"), "utf8")));
  const forms = raw.forms.map((f) => {
    const html = readFileSync(join(dir, f.file), "utf8");
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
    if (title === undefined || title === "") throw new Error(`${f.file} has no <title>`);
    return { id: f.id, file: f.file, title: decode(title), source: withTitle(dir, f.source), fields: f.fields };
  });
  const ids = new Set<string>();
  for (const f of forms) {
    if (ids.has(f.id)) throw new Error(`two forms are called ${f.id}`);
    ids.add(f.id);
  }
  return { decoys: raw.decoys.map((d) => withTitle(dir, d)), forms };
}

export function loadAsks(dir: string, corpus: Corpus): CorpusAsk[] {
  const asks = z.object({ asks: z.array(Ask) }).strict().parse(JSON.parse(readFileSync(join(dir, "asks.json"), "utf8"))).asks;
  for (const x of asks) {
    const f = corpus.forms.find((ff) => ff.id === x.form);
    if (f === undefined) throw new Error(`ask ${x.id} names form ${x.form}, which the corpus does not have`);
    if (x.expected !== "refuse") for (const label of Object.keys(x.expected)) if (!f.fields.some((ff) => ff.label === label)) throw new Error(`ask ${x.id} names field '${label}', which form ${x.form} does not have`);
  }
  return asks;
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A mail shown the way a webmail reading pane shows it: the subject as the title, header lines, then one block per body line. */
export function mailHtml(m: Mail): string {
  const lines = m.body.split("\n").map((l) => (l.trim() === "" ? "<div class=gap></div>" : `<div>${esc(l)}</div>`));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(m.subject)}</title>
<style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:760px;margin:24px auto;color:#202124}
h1{font-size:20px;font-weight:500}.hdr div{font-size:13px;color:#5f6368;margin:2px 0}.body{margin-top:18px;font-size:14px;line-height:1.5}.gap{height:10px}</style></head>
<body><main aria-label="Message"><h1>${esc(m.subject)}</h1>
<div class=hdr><div>From: ${esc(m.from)}</div><div>To: ${esc(m.to)}</div><div>Date: ${esc(m.date)}</div></div>
<div class=body>${lines.join("\n")}</div></main></body></html>`;
}
