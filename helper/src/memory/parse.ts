// The markdown form of personal memory (plan section 6). A document is ordinary markdown; a record is a
// level-2 heading ending in a stable comment, followed by "- Field: value" lines:
//
//   ## Preferred name <!-- caret:id=about-7f76b73e kind=about -->
//   - Label: Preferred name
//   - Value: Alex Rivera
//   - Source: typed
//   - Status: active
//
//   I use this name in messages.            <- prose: kept, shown, never a value
//
// Only the field lines of a record with a valid comment are read. Prose, other headings, fenced code and
// unknown fields are kept byte for byte and never supply a value; an unknown field gets a warning, so
// typing "- On its own: true" into a skill grants nothing and says so. A record with any error (a missing or
// invalid field, a value Caret never keeps, a duplicate id) is disabled until it is fixed, and every error
// names the file, the line and the field.
//
// Caret's own writes patch only the lines of the record they change (applyRecord, removeRecord): the
// heading's title when the user kept Caret's, the record's field lines, nothing else.
import { createHash } from "node:crypto";
import * as z from "zod";
import { AboutFields, AnswerFields, OfferKind, PeopleFields, PreferenceFields } from "../protocol.ts";
import { refusal, sensitiveKind, valueKind, type SensitiveKind } from "./sensitive.ts";

export const RECORD_KINDS = ["about", "people", "preference", "skill", "answer"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export type RecordStatus = "active" | "noticed" | "paused";

/** Where Caret saw a fact it noticed itself: the app, the window's title when known, and when. */
export interface Noticed {
  app: string | null;
  window: string | null;
  at: number;
}

export const SkillText = z.object({ name: z.string().trim().min(1).max(80), trigger: z.string().min(1).max(300) });
export type SkillText = z.infer<typeof SkillText>;

export interface FieldsOf {
  about: z.infer<typeof AboutFields>;
  people: z.infer<typeof PeopleFields>;
  preference: z.infer<typeof PreferenceFields>;
  skill: SkillText;
  answer: AnswerFields;
}

export type MemoryRecord = { [K in RecordKind]: { id: string; kind: K; status: RecordStatus; noticed: Noticed | null; fields: FieldsOf[K] } }[RecordKind];

/** A document is named by the helper, never by a path: four fixed files and one file per skill. */
export type DocId = "about-me" | "people" | "preferences" | "answers" | `skills/${string}`;
export const ROOT_DOCS = ["about-me", "people", "preferences", "answers"] as const;

/** A record id, which is also a skill's file name: letters, digits, "-" and "_", 3 to 80 characters. */
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,79}$/;

export const MAX_LINE_CHARS = 8192;
export const MAX_RECORDS_PER_DOC = 2000;

export function isDocId(s: string): s is DocId {
  if ((ROOT_DOCS as readonly string[]).includes(s)) return true;
  return s.startsWith("skills/") && ID_RE.test(s.slice("skills/".length));
}

export const fileOf = (doc: DocId): string => `${doc}.md`;

export function docKind(doc: DocId): RecordKind {
  if (doc === "about-me") return "about";
  if (doc === "people") return "people";
  if (doc === "preferences") return "preference";
  if (doc === "answers") return "answer";
  return "skill";
}

export function docFor(r: Pick<MemoryRecord, "id" | "kind">): DocId {
  switch (r.kind) {
    case "about":
      return "about-me";
    case "people":
      return "people";
    case "preference":
      return "preferences";
    case "skill":
      return `skills/${r.id}`;
    case "answer":
      return "answers";
  }
}

export interface Diagnostic {
  file: string;
  /** 1-based. */
  line: number;
  field: string | null;
  severity: "error" | "warning";
  message: string;
  /** The record it concerns, when it concerns one. */
  id: string | null;
}

export const formatDiagnostic = (d: Diagnostic): string => `${d.file}:${d.line}: ${d.field === null ? "" : `${d.field}: `}${d.message}`;

export interface ParsedRecord {
  record: MemoryRecord;
  /** 0-based line index of the heading. */
  start: number;
  /** 0-based index of the first line after the record's block. */
  end: number;
  digest: string;
}

export interface ParsedDocument {
  doc: DocId;
  file: string;
  /** The text as read; Caret's patches keep every byte outside the record they change. */
  text: string;
  eol: "\n" | "\r\n";
  /** Lines without their terminators; `starts[i]` is where line i begins in `text`, `starts[lines.length]` its end. */
  lines: string[];
  starts: number[];
  /** Lines inside fenced code or an HTML comment: never a heading, never a field. */
  hidden: Set<number>;
  /** Valid records, in document order. */
  records: ParsedRecord[];
  /** Every block that carries an id, valid or not: Caret never writes over a broken one. */
  blocks: Map<string, { start: number; end: number }>;
  /** Ids whose block has an error; their records are disabled. */
  broken: Set<string>;
  diagnostics: Diagnostic[];
}

// MARK: - fields

type Key = "status" | "noticedIn" | "window" | "noticedOn" | "label" | "value" | "source" | "alias" | "name" | "rule" | "valueKind" | "template" | "field" | "use" | "offer" | "app" | "bundleId" | "when" | "question" | "answer" | "site" | "form" | "savedOn";

/** How each field is written, in the order Caret writes them. */
const KEY_NAMES: Record<Key, string> = {
  label: "Label",
  value: "Value",
  source: "Source",
  alias: "Alias",
  name: "Name",
  rule: "Rule",
  valueKind: "Value kind",
  template: "Template",
  field: "Field",
  use: "Use entry",
  offer: "Offer",
  app: "App",
  bundleId: "Bundle id",
  when: "When",
  question: "Question",
  answer: "Answer",
  site: "Site",
  form: "Form",
  savedOn: "Saved on",
  status: "Status",
  noticedIn: "Noticed in",
  window: "Window",
  noticedOn: "Noticed on",
};
const KEY_BY_NAME = new Map(Object.entries(KEY_NAMES).map(([k, n]) => [n.toLowerCase(), k as Key]));
const COMMON: Key[] = ["status", "noticedIn", "window", "noticedOn"];
const KIND_KEYS: Record<RecordKind, Key[]> = {
  about: ["label", "value", "source", ...COMMON],
  people: ["alias", "name", ...COMMON],
  preference: ["rule", "valueKind", "template", "field", "use", "offer", "app", "bundleId", ...COMMON],
  skill: ["name", "when", "status"],
  // S1: a saved answer is never something Caret noticed on its own, so it has no noticed fields.
  answer: ["question", "answer", "site", "form", "savedOn", "status"],
};

/** The record's fields as Caret writes them, in order. Absent optional fields are left out. */
export function fieldPairs(r: MemoryRecord): [Key, string][] {
  const out: [Key, string][] = [];
  switch (r.kind) {
    case "about":
      out.push(["label", r.fields.label], ["value", r.fields.value], ["source", r.fields.source]);
      break;
    case "people":
      out.push(["alias", r.fields.alias], ["name", r.fields.name]);
      break;
    case "preference": {
      const f = r.fields;
      out.push(["rule", f.rule]);
      if (f.rule === "format") out.push(["valueKind", f.valueKind], ["template", f.template]);
      else if (f.rule === "useInstead") out.push(["field", f.field], ["use", f.aboutId]);
      else out.push(["offer", f.offerKind], ["app", f.appName], ["bundleId", f.bundleId]);
      break;
    }
    case "skill":
      out.push(["name", r.fields.name], ["when", r.fields.trigger]);
      break;
    case "answer":
      out.push(["question", r.fields.question], ["answer", r.fields.answer]);
      if (r.fields.site !== null) out.push(["site", r.fields.site]);
      if (r.fields.form !== null) out.push(["form", r.fields.form]);
      out.push(["savedOn", r.fields.savedOn]);
      break;
  }
  out.push(["status", r.status]);
  if (r.noticed !== null) {
    if (r.noticed.app !== null) out.push(["noticedIn", r.noticed.app]);
    if (r.noticed.window !== null) out.push(["window", r.noticed.window]);
    out.push(["noticedOn", new Date(r.noticed.at).toISOString()]);
  }
  return out;
}

/** A value as one line: as typed when that reads back the same, else a JSON string. */
export function encodeValue(v: string): string {
  if (v !== "" && v === v.trim() && !CONTROL.test(v) && !v.startsWith('"')) return v;
  return JSON.stringify(v);
}

function decodeValue(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  if (!raw.startsWith('"')) return { ok: true, value: raw };
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "string") return { ok: true, value: v };
  } catch {
    // Falls through to the message.
  }
  return { ok: false, message: 'a value that starts with " must be one quoted string, like "  two spaces"' };
}

const fieldLine = (k: Key, v: string): string => `- ${KEY_NAMES[k]}: ${encodeValue(v)}`;

/** Control characters and the Unicode line and paragraph separators: a value with one is written quoted. */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
/** "- Field: value", "* Field: value" or "+ Field:", unindented. Group 1 the field name, group 2 the value. */
const FIELD_RE = /^[-*+][ \t]+([A-Za-z][A-Za-z ']{0,30}?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
/** An ATX heading, indented up to three spaces as CommonMark allows. */
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** A fence opening: three or more backticks (no backtick in the info string) or tildes. */
const FENCE_RE = /^ {0,3}(?:(`{3,})[^`]*|(~{3,}).*)$/;
const COMMENT_RE = /<!--\s*caret:(.*?)-->/;
const ATTRS_RE = /^\s*id=(\S+)\s+kind=(\S+)\s*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

// MARK: - parsing

export function parseDocument(doc: DocId, text: string): ParsedDocument {
  const file = fileOf(doc);
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const { lines, starts } = splitLines(text);
  const hidden = new Set<number>();
  const out: ParsedDocument = { doc, file, text, eol, lines, starts, hidden, records: [], blocks: new Map(), broken: new Set(), diagnostics: [] };
  const diag = (line: number, field: string | null, severity: Diagnostic["severity"], message: string, id: string | null = null): void => {
    out.diagnostics.push({ file, line: line + 1, field, severity, message, id });
  };

  // Headings outside fenced code and HTML comments, with their levels. A fence closes only with its own marker, at
  // least as long, and nothing after it; a comment that opens without closing on its line hides lines until "-->".
  const headings: { at: number; level: number; text: string }[] = [];
  let fence: { char: string; len: number } | null = null;
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.length > MAX_LINE_CHARS) diag(i, null, "error", `the line is over ${MAX_LINE_CHARS} characters`);
    if (comment) {
      hidden.add(i);
      if (l.includes("-->")) comment = false;
      continue;
    }
    if (fence !== null) {
      hidden.add(i);
      if (closesFence(l, fence)) fence = null;
      continue;
    }
    const f = FENCE_RE.exec(l);
    if (f !== null) {
      const mark = (f[1] ?? f[2]) as string;
      fence = { char: mark[0] as string, len: mark.length };
      hidden.add(i);
      continue;
    }
    // An HTML comment block starts at the start of a line (CommonMark HTML block type 2) and runs to "-->"; a "<!--"
    // inside a field's value or a sentence is text.
    if (/^ {0,3}<!--/.test(l) && !l.includes("-->", l.indexOf("<!--") + 4)) {
      comment = true;
      hidden.add(i);
      continue;
    }
    const h = HEADING_RE.exec(l);
    if (h !== null) headings.push({ at: i, level: (h[1] as string).length, text: h[2] ?? "" });
  }

  const wanted = docKind(doc);
  const seen = new Map<string, number>();
  let count = 0;
  headings.forEach((h, hi) => {
    const c = COMMENT_RE.exec(h.text);
    if (c === null) {
      if (/caret:/.test(h.text)) diag(h.at, null, "error", "this heading mentions caret: but has no <!-- caret:id=… kind=… --> comment Caret can read");
      return;
    }
    // The block runs to the next heading of level 1 or 2, or the next heading that names a record of its own.
    let end = lines.length;
    for (const n of headings.slice(hi + 1)) {
      if (n.level <= 2 || n.text.includes("caret:")) {
        end = n.at;
        break;
      }
    }
    const attrs = ATTRS_RE.exec(c[1] as string);
    const id = attrs?.[1] ?? null;
    if (id !== null && ID_RE.test(id)) out.blocks.set(id, { start: h.at, end });
    const broke = (field: string | null, message: string): void => {
      diag(h.at, field, "error", message, id);
      if (id !== null) out.broken.add(id);
    };
    if (attrs === null) return broke(null, "the comment must read <!-- caret:id=… kind=… -->");
    if (h.level !== 2) return broke(null, "a record's heading starts with ## (two #)");
    if (h.text.slice((c.index ?? 0) + c[0].length).trim() !== "") return broke(null, "the <!-- caret:… --> comment must end the heading");
    if (id === null || !ID_RE.test(id)) return broke(null, `the id "${String(id)}" must be 3 to 80 letters, digits, - or _`);
    const kind = attrs[2] as string;
    if (!(RECORD_KINDS as readonly string[]).includes(kind)) return broke(null, `kind "${kind}" is not one of ${RECORD_KINDS.join(", ")}`);
    if (kind !== wanted) return broke(null, `${file} holds ${wanted} records, not ${kind}`);
    if (wanted === "skill" && `skills/${id}` !== doc) return broke(null, `the skill in ${file} must have the id ${doc.slice("skills/".length)}`);
    if (++count > MAX_RECORDS_PER_DOC) return broke(null, `${file} holds more than ${MAX_RECORDS_PER_DOC} records; the rest are not read`);
    const prior = seen.get(id);
    if (prior !== undefined) {
      // Both are quarantined: Caret cannot tell which one the user meant.
      broke(null, `the id ${id} is also used at line ${prior + 1}; neither record is used until one is changed`);
      out.broken.add(id);
      diag(prior, null, "error", `the id ${id} is also used at line ${h.at + 1}; neither record is used until one is changed`, id);
      return;
    }
    seen.set(id, h.at);
    const r = readRecord(lines, hidden, h.at, end, id, kind as RecordKind, diag);
    if (r === null) out.broken.add(id);
    else out.records.push({ record: r, start: h.at, end, digest: recordDigest(r) });
  });
  // A duplicate found later disables the first one too.
  out.records = out.records.filter((p) => !out.broken.has(p.record.id));
  if (fence !== null) diag(lines.length - 1, null, "warning", "a ``` code block is never closed; everything after it is read as code");
  if (comment) diag(lines.length - 1, null, "warning", "an HTML comment <!-- is never closed; everything after it is hidden");
  return out;
}

function closesFence(l: string, f: { char: string; len: number }): boolean {
  const m = /^ {0,3}(`+|~+)[ \t]*$/.exec(l);
  return m !== null && (m[1] as string)[0] === f.char && (m[1] as string).length >= f.len;
}

/** Lines without terminators, and where each begins, so a patch can keep every other byte as it was. */
function splitLines(text: string): { lines: string[]; starts: number[] } {
  const lines: string[] = [];
  const starts: number[] = [];
  const re = /\r?\n/g;
  let at = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    starts.push(at);
    lines.push(text.slice(at, m.index));
    at = m.index + m[0].length;
  }
  starts.push(at);
  lines.push(text.slice(at));
  starts.push(text.length);
  return { lines, starts };
}

/** The terminator after line i: "\n", "\r\n", or "" for the last line. */
const lineEnd = (p: ParsedDocument, i: number): string => p.text.slice((p.starts[i] as number) + (p.lines[i] as string).length, p.starts[i + 1] as number);

function readRecord(lines: string[], hidden: Set<number>, start: number, end: number, id: string, kind: RecordKind, diag: (line: number, field: string | null, severity: Diagnostic["severity"], message: string, id?: string | null) => void): MemoryRecord | null {
  const allowed = new Set(KIND_KEYS[kind]);
  const got = new Map<Key, { value: string; line: number }>();
  let ok = true;
  const err = (line: number, field: string | null, message: string): void => {
    diag(line, field, "error", message, id);
    ok = false;
  };
  // Every occurrence of every field, duplicates and unknown fields included, for the secret check below.
  const seen: { key: Key | null; name: string; value: string; line: number }[] = [];
  for (let i = start + 1; i < end; i++) {
    if (hidden.has(i)) continue;
    const l = lines[i] as string;
    if (l.length > MAX_LINE_CHARS) {
      ok = false;
      continue;
    }
    const m = FIELD_RE.exec(l);
    if (m === null) continue;
    const name = (m[1] as string).trim();
    const key = KEY_BY_NAME.get(name.toLowerCase().replace(/\s+/g, " "));
    const raw = decodeValue(m[2] ?? "");
    seen.push({ key: key ?? null, name, value: raw.ok ? raw.value : (m[2] ?? ""), line: i });
    if (key === undefined || !allowed.has(key)) {
      diag(i, name, "warning", `not a field Caret reads in ${kind === "about" ? "an" : "a"} ${kind} record; it changes nothing`, id);
      continue;
    }
    if (got.has(key)) {
      err(i, KEY_NAMES[key], `appears twice in this record (first at line ${(got.get(key)?.line ?? 0) + 1})`);
      continue;
    }
    const v = decodeValue(m[2] ?? "");
    if (!v.ok) {
      err(i, KEY_NAMES[key], v.message);
      continue;
    }
    got.set(key, { value: v.value, line: i });
  }
  // What Caret never keeps is flagged even in a record broken for another reason, on the line that holds it: any
  // field by its value's shape, an unknown field by its own name ("- Password: …"), and a Value under any Label
  // the record carries, a second one included.
  // A saved answer's question is its label (S1).
  const labels = seen.filter((x) => x.key === "label" || x.key === "question").map((x) => x.value);
  for (const x of seen) {
    const s = x.key === "value" || x.key === "answer" ? (labels.map((label) => sensitiveKind(label, x.value)).find((k) => k !== null) ?? valueKind(x.value)) : x.key === null ? sensitiveKind(x.name, x.value) : valueKind(x.value);
    if (s !== null) err(x.line, x.key === null ? x.name : KEY_NAMES[x.key], `${refusal(s)}, so this record is not used`);
  }
  if (!ok) return null;

  const need = (k: Key): string | null => {
    const g = got.get(k);
    if (g === undefined) {
      err(start, KEY_NAMES[k], "is missing");
      return null;
    }
    return g.value;
  };
  const at = (k: Key): number => got.get(k)?.line ?? start;
  const check = <T>(schema: z.ZodType<T>, value: unknown, keyOf: (path: PropertyKey[]) => Key | null): T | null => {
    const r = schema.safeParse(value);
    if (r.success) return r.data;
    for (const issue of r.error.issues) {
      const k = keyOf(issue.path);
      err(k === null ? start : at(k), k === null ? null : KEY_NAMES[k], issue.message);
    }
    return null;
  };

  const status = need("status");
  const twoStates = kind === "skill" || kind === "answer";
  if (status !== null && !(twoStates ? ["active", "paused"] : ["active", "noticed", "paused"]).includes(status)) {
    err(at("status"), "Status", twoStates ? "must be active or paused" : "must be active, noticed or paused");
  }
  let noticed: Noticed | null = null;
  const on = got.get("noticedOn");
  if (on !== undefined) {
    const t = ISO_RE.test(on.value) ? Date.parse(on.value) : Number.NaN;
    if (Number.isNaN(t)) err(on.line, "Noticed on", "must be a date and time like 2026-10-04T15:20:00.000Z");
    else noticed = { app: emptyToNull(got.get("noticedIn")?.value), window: emptyToNull(got.get("window")?.value), at: t };
  } else if (status === "noticed") err(start, "Noticed on", "is missing; a noticed record says when Caret noticed it");

  let fields: unknown = null;
  switch (kind) {
    case "about": {
      const [label, value, source] = [need("label"), need("value"), need("source")];
      if (label === null || value === null || source === null) break;
      fields = check(AboutFields, { label, value, source }, (p) => (p[0] === "label" ? "label" : p[0] === "value" ? "value" : p[0] === "source" ? "source" : null));
      break;
    }
    case "people": {
      const [alias, name] = [need("alias"), need("name")];
      if (alias === null || name === null) break;
      fields = check(PeopleFields, { alias, name }, (p) => (p[0] === "alias" ? "alias" : p[0] === "name" ? "name" : null));
      break;
    }
    case "preference": {
      const rule = need("rule");
      if (rule === null) break;
      const raw =
        rule === "format"
          ? { rule, valueKind: need("valueKind"), template: need("template") }
          : rule === "useInstead"
            ? { rule, field: need("field"), aboutId: need("use") }
            : rule === "dontOffer"
              ? { rule, offerKind: need("offer"), appName: need("app"), bundleId: need("bundleId") }
              : null;
      if (raw === null) {
        err(at("rule"), "Rule", "must be format, useInstead or dontOffer");
        break;
      }
      if (Object.values(raw).includes(null)) break;
      // Fields of another rule are left over from an edit; they would read as part of this one.
      for (const k of ["valueKind", "template", "field", "use", "offer", "app", "bundleId"] as const) {
        const own = rule === "format" ? ["valueKind", "template"] : rule === "useInstead" ? ["field", "use"] : ["offer", "app", "bundleId"];
        if (got.has(k) && !own.includes(k)) err(at(k), KEY_NAMES[k], `is not a field of a ${rule} preference`);
      }
      if (rule === "dontOffer" && !OfferKind.safeParse(raw.offerKind).success) {
        err(at("offer"), "Offer", `must be one of ${OfferKind.options.join(", ")}`);
        break;
      }
      const keyOf = (p: PropertyKey[]): Key | null => {
        const k = { valueKind: "valueKind", template: "template", field: "field", aboutId: "use", offerKind: "offer", appName: "app", bundleId: "bundleId" }[String(p[0])];
        return (k as Key | undefined) ?? null;
      };
      fields = check(PreferenceFields, raw, keyOf);
      break;
    }
    case "skill": {
      const [name, when] = [need("name"), need("when")];
      if (name === null || when === null) break;
      fields = check(SkillText, { name, trigger: when }, (p) => (p[0] === "name" ? "name" : p[0] === "trigger" ? "when" : null));
      if (fields !== null && CONTROL.test(name)) err(at("name"), "Name", "must be one line of text");
      break;
    }
    case "answer": {
      const [question, answer, savedOn] = [need("question"), need("answer"), need("savedOn")];
      if (question === null || answer === null || savedOn === null) break;
      const raw = { question, answer, site: emptyToNull(got.get("site")?.value), form: emptyToNull(got.get("form")?.value), savedOn };
      fields = check(AnswerFields, raw, (p) => ({ question: "question", answer: "answer", site: "site", form: "form", savedOn: "savedOn" })[String(p[0])] as Key | undefined ?? null);
      break;
    }
  }
  if (!ok || fields === null || status === null) return null;
  return { id, kind, status: status as RecordStatus, noticed, fields } as MemoryRecord;
}

/**
 * The first field of a record that holds what Caret never keeps (sensitive.ts): an About value by its label and shape,
 * every other string Caret would write by its shape, provenance included. Null when there is none.
 */
export function recordSecret(r: MemoryRecord): { field: string; kind: SensitiveKind } | null {
  for (const [k, v] of fieldPairs(r)) {
    const s = k === "value" && r.kind === "about" ? sensitiveKind(r.fields.label, v) : k === "answer" && r.kind === "answer" ? sensitiveKind(r.fields.question, v) : valueKind(v);
    if (s !== null) return { field: KEY_NAMES[k], kind: s };
  }
  return null;
}

const emptyToNull = (s: string | undefined): string | null => (s === undefined || s.trim() === "" ? null : s);

/** A short digest of what a record means, ignoring how it is laid out: the same digest is the same record. */
export function recordDigest(r: MemoryRecord): string {
  return createHash("sha256").update(JSON.stringify([r.id, r.kind, r.status, r.noticed, canonical(r.fields)])).digest("hex").slice(0, 32);
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)]));
}

// MARK: - rendering and patching

const DOC_TITLES: Record<"about" | "people" | "preference" | "answer", string> = { about: "About me", people: "People", preference: "Preferences", answer: "Saved answers" };

const PREFACE =
  "Caret reads the records below and uses them in what it offers. Change a value, or set Status to paused, and Caret follows. " +
  "Status noticed means Caret saw it itself; it is used, and each offer shows where it came from. " +
  "Keep each <!-- caret:… --> comment: it is how Caret knows a record. Other lines are yours; Caret never reads a value from them.";
const SKILL_PREFACE =
  "Caret runs this skill from what it learned, not from this file. Editing the record below puts the skill back on Tab: " +
  "it asks before each run until you let it run on its own again from Caret's memory window.";
const ANSWERS_PREFACE =
  "Your own answers to questions on forms, kept when you said yes. When a form asks the same question, Caret shows you the whole answer before it fills it in, and never changes your words. " +
  "An answer that names another organization, or is longer than the field allows, is not offered. Set Status to paused to stop Caret offering one. " +
  "Keep each <!-- caret:… --> comment: it is how Caret knows an answer. Other lines are yours; Caret never reads a value from them.";

/** The heading's title for a record, without markdown or comment syntax in it. */
export function recordTitle(r: MemoryRecord): string {
  let t: string;
  switch (r.kind) {
    case "about":
      t = r.fields.label;
      break;
    case "people":
      t = r.fields.alias;
      break;
    case "preference":
      t = r.fields.rule === "format" ? "Phone format" : r.fields.rule === "useInstead" ? `Use instead in ${r.fields.field}` : `Don't offer ${r.fields.offerKind} in ${r.fields.appName}`;
      break;
    case "skill":
      t = r.fields.name;
      break;
    case "answer":
      t = r.fields.question;
      break;
  }
  const clean = t.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replaceAll("<!--", "").replaceAll("-->", "").replace(/^#+/, "").trim().slice(0, 80);
  return clean === "" ? "Untitled" : clean;
}

const headingLine = (r: MemoryRecord): string => `## ${recordTitle(r)} <!-- caret:id=${r.id} kind=${r.kind} -->`;

/** The lines Caret writes for a new record. */
export function renderRecord(r: MemoryRecord): string[] {
  return [headingLine(r), ...fieldPairs(r).map(([k, v]) => fieldLine(k, v))];
}

/** A new document holding these records. */
export function newDocument(doc: DocId, records: readonly MemoryRecord[]): string {
  const kind = docKind(doc);
  const head = kind === "skill" ? ["# Skill", "", SKILL_PREFACE] : [`# ${DOC_TITLES[kind]}`, "", kind === "answer" ? ANSWERS_PREFACE : PREFACE];
  const body = records.flatMap((r, i) => [...(i === 0 ? [] : [""]), ...renderRecord(r)]);
  return [...head, "", ...body, ""].join("\n");
}

/**
 * The document with `r` written into it: the record's own lines changed in place when it is there, else appended.
 * Throws when the id's block is broken, since Caret would be guessing which lines are the record.
 */
export function applyRecord(p: ParsedDocument, r: MemoryRecord): string {
  if (p.broken.has(r.id)) throw new Error(`${p.file}: the record ${r.id} has errors; fix it there first`);
  const cur = p.records.find((x) => x.record.id === r.id);
  if (cur === undefined) return appendRecord(p, r);
  const block = p.lines.slice(cur.start, cur.end);
  // The title follows the record only while it is still the one Caret wrote.
  const h = HEADING_RE.exec(block[0] as string);
  const title = (h?.[2] ?? "").replace(COMMENT_RE, "").trim();
  if (title === recordTitle(cur.record)) block[0] = headingLine(r);
  const want = fieldPairs(r);
  const wantKeys = new Set(want.map(([k]) => k));
  const allowed = new Set(KIND_KEYS[r.kind]);
  // Where each known field is, outside fenced code and comments: the same lines the parser read.
  const at = new Map<Key, number>();
  for (let i = 1; i < block.length; i++) {
    if (p.hidden.has(cur.start + i)) continue;
    const l = block[i] as string;
    const m = FIELD_RE.exec(l);
    const key = m === null ? undefined : KEY_BY_NAME.get((m[1] as string).trim().toLowerCase().replace(/\s+/g, " "));
    if (key !== undefined && allowed.has(key)) at.set(key, i);
  }
  const drop = new Set<number>();
  for (const [k, i] of at) if (!wantKeys.has(k)) drop.add(i);
  let last = Math.max(0, ...[...at.entries()].filter(([k]) => wantKeys.has(k)).map(([, i]) => i));
  const inserts = new Map<number, string[]>();
  for (const [k, v] of want) {
    const i = at.get(k);
    if (i !== undefined) {
      block[i] = fieldLine(k, v);
      last = Math.max(last, i);
    } else {
      const list = inserts.get(last) ?? [];
      list.push(fieldLine(k, v));
      inserts.set(last, list);
    }
  }
  // Only the record's changed field lines differ: every other line keeps its bytes and its own line ending, and a
  // new field line takes the heading's. A line inserted after the file's last, unterminated line gets one first.
  const eol = lineEnd(p, cur.start) || p.eol;
  let out = "";
  block.forEach((l, i) => {
    const end = lineEnd(p, cur.start + i);
    const ins = inserts.get(i) ?? [];
    if (!drop.has(i)) out += l + (end === "" && ins.length > 0 ? eol : end);
    ins.forEach((x, j) => (out += x + (j < ins.length - 1 || end !== "" ? (end === "" ? eol : end) : "")));
  });
  return p.text.slice(0, p.starts[cur.start]) + out + p.text.slice(p.starts[cur.end]);
}

function appendRecord(p: ParsedDocument, r: MemoryRecord): string {
  const base = p.text.replace(/(?:\r?\n[ \t]*)+$/, "");
  if (base.trim() === "") return newDocument(p.doc, [r]).replaceAll("\n", p.eol);
  return `${base}${p.eol}${p.eol}${renderRecord(r).join(p.eol)}${p.eol}`;
}

/** The document without the record's block: its heading, fields and the prose under it. */
export function removeRecord(p: ParsedDocument, id: string): string {
  const b = p.blocks.get(id);
  if (b === undefined) return p.text;
  const blank = (i: number): boolean => i >= 0 && i < p.lines.length && (p.lines[i] as string).trim() === "";
  // One blank line between what was before and after it, not two.
  const to = blank(b.start - 1) && blank(b.end) ? (p.starts[b.end + 1] as number) : (p.starts[b.end] as number);
  return p.text.slice(0, p.starts[b.start]) + p.text.slice(to);
}
