// The B24 real-form corpus (fixtures/realfill): its schema, the window titles its pages and notes get, and the
// mail page each mail source is shown as. Shared by realfill-capture.ts and realfill-eval.ts.
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as z from "zod";
import { ScreenModel, type WindowState } from "../src/model.ts";
import { forgetWindows } from "../src/privacy.ts";
import { aboutKind, type AboutValue } from "../src/fill/about.ts";
import type { Node, Snapshot } from "../src/protocol.ts";

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

/** Why a must-refuse ask is refused, so the scoreboard can check the sentence the user reads (planner/says.ts, B26). */
export const REFUSE_REASONS = ["neverTyped", "payment", "submit", "send", "whichPerson", "noSuchField", "notOnScreen"] as const;
const Ask = z
  .object({ id: z.string(), form: z.string(), instruction: z.string().min(1), expected: z.union([z.literal("refuse"), z.record(z.string(), z.string())]), reason: z.enum(REFUSE_REASONS).optional() })
  .strict();
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

/** An ask set: asks.json (B24's, tuned on since) or asks-heldout.json (B25's, written blind). */
export function loadAsks(dir: string, corpus: Corpus, file = "asks.json"): CorpusAsk[] {
  const asks = z.object({ asks: z.array(Ask) }).strict().parse(JSON.parse(readFileSync(join(dir, file), "utf8"))).asks;
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

/** The replay's clock: every desk is built as if the form were focused at this instant. */
export const T0 = 1_800_000_000_000;

/** One form on a replayed desk: the screen model, the form's window and the field it is focused on, and its memory. */
export interface Desk {
  model: ScreenModel;
  form: WindowState;
  source: WindowState | null;
  trigger: Node;
  /** A memory source's entries as fill offers them (About values), and as the planner reads them. */
  about: AboutValue[];
  memory: { id: string; label: string; text: string; whose: "user" }[];
}

/**
 * Replays the recorded windows (realfill-capture.ts) into a fresh model for one form: the shared decoys focused
 * minutes ago, the form's source focused just before the form (the window the user just left), and the form
 * focused on its first empty text field, as a person arrives at a form after reading their note.
 */
/**
 * `page`: the form as the page engine reads it (D2-04: a snapshot accept.ts --sites took of the corpus page, through
 * engines/page-link.ts toWindowSnapshot), in place of the reader's recorded window, so a Fill all's writes of selects,
 * radios, boxes and dates are measured where Caret makes them.
 */
export function buildDesk(corpus: Corpus, snaps: readonly Snapshot[], form: CorpusForm, page?: Snapshot): Desk {
  const windowOf = (title: string): Snapshot => {
    const hits = snaps.filter((s) => s.window.title === title || s.window.title.startsWith(`${title} - `));
    if (hits.length !== 1) throw new Error(`${hits.length} recorded windows are titled '${title}'`);
    return hits[0] as Snapshot;
  };
  const sourceSnap = (s: CorpusSource): Snapshot | null => (s.kind === "memory" ? null : windowOf(s.title ?? ""));
  forgetWindows();
  const model = new ScreenModel();
  const put = (s: Snapshot, at: number, focusedKey: string | null = null): void => {
    model.apply({ ...s, at, focused: true, focusedKey });
  };
  corpus.decoys.forEach((d, i) => {
    const s = sourceSnap(d);
    if (s !== null) put(s, T0 - 600_000 + i * 60_000);
  });
  const src = sourceSnap(form.source);
  if (src !== null) put(src, T0 - 30_000);
  const formSnap = page ?? windowOf(form.title);
  const trigger = formSnap.nodes.find((n) => n.editable === true && (n.role === "AXTextField" || n.role === "AXTextArea") && (n.value ?? "") === "" && n.parent !== null && !n.key.includes("address and search bar"));
  if (trigger === undefined) throw new Error(`form ${form.id} has no empty text field to start from`);
  put(formSnap, T0, trigger.key);
  // The host names the app the user is in (appSwitch); here, the form's.
  model.frontmostPid = formSnap.app.pid;
  const entries = form.source.kind === "memory" ? form.source.about : [];
  const about = entries.flatMap((x, i) => {
    const kind = aboutKind(x.label, x.value);
    return kind === null ? [] : [{ id: `about-${i + 1}`, label: x.label, value: x.value, kind }];
  });
  return {
    model,
    form: model.windows.get(formSnap.window.windowId) as WindowState,
    source: src === null ? null : (model.windows.get(src.window.windowId) ?? null),
    trigger,
    about,
    // The corpus's memory is what the user told Caret about themselves.
    memory: entries.map((x, i) => ({ id: `about-${i + 1}`, label: x.label, text: x.value, whose: "user" as const })),
  };
}

/**
 * Required markers, a trailing colon and "(optional)" are not part of what a label says. The job form marks required
 * fields with a heavy asterisk (U+2731), which B24's scorer kept, so its Full name, Email, Phone and visa question
 * were never matched to the corpus ("not found" on the fill scoreboard, an unexpected write on the Ask one; B25).
 */
export const normLabel = (s: string): string =>
  s
    .replace(/\((?:required|optional)\)/gi, "")
    .replace(/[*:\u2731\u2217]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/** The nodes a corpus field is: the control whose label is the field's, or for a radio group its container and buttons. */
export function nodesFor(w: WindowState, f: CorpusField): Node[] {
  const want = normLabel(f.label);
  const nodes = [...w.nodes.values()];
  if (f.control === "radio") {
    const group = nodes.find((n) => n.subrole === "AXFieldset" && normLabel(n.label ?? "") === want);
    return group === undefined ? [] : [group, ...nodes.filter((n) => n.parent === group.key && n.role === "AXRadioButton")];
  }
  const roles: Record<string, readonly string[]> = {
    select: ["AXPopUpButton"],
    checkbox: ["AXCheckBox"],
    date: ["AXDateField"],
    time: ["AXTimeField"],
    combobox: ["AXComboBox"],
    file: ["AXButton", "AXGroup"],
  };
  const ok = roles[f.control] ?? ["AXTextField", "AXTextArea"];
  const groupKey = f.group === undefined ? null : (nodes.find((n) => n.subrole === "AXFieldset" && normLabel(n.label ?? "") === normLabel(f.group ?? ""))?.key ?? null);
  return nodes.filter((n) => ok.includes(n.role) && normLabel(n.label ?? "") === want && (groupKey === null || n.parent === groupKey));
}
