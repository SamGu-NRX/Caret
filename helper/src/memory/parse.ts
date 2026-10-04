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
import { AboutFields, OfferKind, PeopleFields, PreferenceFields } from "../protocol.ts";
import { refusal, sensitiveKind, valueKind } from "./sensitive.ts";

export const RECORD_KINDS = ["about", "people", "preference", "skill"] as const;
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
}

export type MemoryRecord = { [K in RecordKind]: { id: string; kind: K; status: RecordStatus; noticed: Noticed | null; fields: FieldsOf[K] } }[RecordKind];

/** A document is named by the helper, never by a path: three fixed files and one file per skill. */
export type DocId = "about-me" | "people" | "preferences" | `skills/${string}`;
export const ROOT_DOCS = ["about-me", "people", "preferences"] as const;

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
  eol: "\n" | "\r\n";
  lines: string[];
  /** Valid records, in document order. */
  records: ParsedRecord[];
  /** Every block that carries an id, valid or not: Caret never writes over a broken one. */
  blocks: Map<string, { start: number; end: number }>;
  /** Ids whose block has an error; their records are disabled. */
  broken: Set<string>;
  diagnostics: Diagnostic[];
}

// MARK: - fields

type Key = "status" | "noticedIn" | "window" | "noticedOn" | "label" | "value" | "source" | "alias" | "name" | "rule" | "valueKind" | "template" | "field" | "use" | "offer" | "app" | "bundleId" | "when";

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

/** "- Field: value", "* Field: value" or "+ Field:", unindented. Group 1 the field name, group 2 the value. */
/** Control characters and the Unicode line and paragraph separators: a value with one is written quoted. */
const CONTROL = /[\p{Cc}\u2028\u2029]/u;
const FIELD_RE = /^[-*+][ \t]+([A-Za-z][A-Za-z ']{0,30}?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;
const HEADING_RE = /^(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const COMMENT_RE = /<!--\s*caret:(.*?)-->/;
const ATTRS_RE = /^\s*id=(\S+)\s+kind=(\S+)\s*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

// MARK: - parsing

export function parseDocument(doc: DocId, text: string): ParsedDocument {
  const file = fileOf(doc);
  const eol: "\n" | "\r\n" = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const out: ParsedDocument = { doc, file, eol, lines, records: [], blocks: new Map(), broken: new Set(), diagnostics: [] };
  const diag = (line: number, field: string | null, severity: Diagnostic["severity"], message: string, id: string | null = null): void => {
    out.diagnostics.push({ file, line: line + 1, field, severity, message, id });
  };

  // Headings outside fenced code, with their levels.
  const headings: { at: number; level: number; text: string }[] = [];
  const fenced = new Set<number>();
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (l.length > MAX_LINE_CHARS) diag(i, null, "error", `the line is over ${MAX_LINE_CHARS} characters`);
    const f = FENCE_RE.exec(l);
    if (f !== null) {
      const mark = (f[1] as string)[0] as string;
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      fenced.add(i);
      continue;
    }
    if (fence !== null) {
      fenced.add(i);
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
    // The block runs to the next heading of level 1 or 2.
    let end = lines.length;
    for (const n of headings.slice(hi + 1)) {
      if (n.level <= 2) {
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
    const r = readRecord(lines, fenced, h.at, end, id, kind as RecordKind, diag);
    if (r === null) out.broken.add(id);
    else out.records.push({ record: r, start: h.at, end, digest: recordDigest(r) });
  });
  // A duplicate found later disables the first one too.
  out.records = out.records.filter((p) => !out.broken.has(p.record.id));
  if (fence !== null) diag(lines.length - 1, null, "warning", "a ``` code block is never closed; everything after it is read as code");
  return out;
}

function readRecord(lines: string[], fenced: Set<number>, start: number, end: number, id: string, kind: RecordKind, diag: (line: number, field: string | null, severity: Diagnostic["severity"], message: string, id?: string | null) => void): MemoryRecord | null {
  const allowed = new Set(KIND_KEYS[kind]);
  const got = new Map<Key, { value: string; line: number }>();
  let ok = true;
  const err = (line: number, field: string | null, message: string): void => {
    diag(line, field, "error", message, id);
    ok = false;
  };
  for (let i = start + 1; i < end; i++) {
    if (fenced.has(i)) continue;
    const l = lines[i] as string;
    if (l.length > MAX_LINE_CHARS) {
      ok = false;
      continue;
    }
    const m = FIELD_RE.exec(l);
    if (m === null) continue;
    const name = (m[1] as string).trim();
    const key = KEY_BY_NAME.get(name.toLowerCase().replace(/\s+/g, " "));
    if (key === undefined || !allowed.has(key)) {
      diag(i, name, "warning", `not a field Caret reads in a ${kind} record; it changes nothing`, id);
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
  if (status !== null && !(kind === "skill" ? ["active", "paused"] : ["active", "noticed", "paused"]).includes(status)) {
    err(at("status"), "Status", kind === "skill" ? "must be active or paused" : "must be active, noticed or paused");
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
      const s = sensitiveKind(label, value);
      if (s !== null) err(at("value"), "Value", `${refusal(s)}, so this record is not used`);
      break;
    }
    case "people": {
      const [alias, name] = [need("alias"), need("name")];
      if (alias === null || name === null) break;
      fields = check(PeopleFields, { alias, name }, (p) => (p[0] === "alias" ? "alias" : p[0] === "name" ? "name" : null));
      const s = valueKind(alias) ?? valueKind(name);
      if (s !== null) err(at("name"), "Name", `${refusal(s)}, so this record is not used`);
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
  }
  if (!ok || fields === null || status === null) return null;
  return { id, kind, status: status as RecordStatus, noticed, fields } as MemoryRecord;
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

const DOC_TITLES: Record<"about" | "people" | "preference", string> = { about: "About me", people: "People", preference: "Preferences" };

const PREFACE =
  "Caret reads the records below and uses them in what it offers. Change a value, or set Status to paused, and Caret follows. " +
  "Status noticed means Caret saw it itself; it is used, and each offer shows where it came from. " +
  "Keep each <!-- caret:… --> comment: it is how Caret knows a record. Other lines are yours; Caret never reads a value from them.";
const SKILL_PREFACE =
  "Caret runs this skill from what it learned, not from this file. Editing the record below puts the skill back on Tab: " +
  "it asks before each run until you let it run on its own again from Caret's memory window.";

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
  const head = kind === "skill" ? ["# Skill", "", SKILL_PREFACE] : [`# ${DOC_TITLES[kind]}`, "", PREFACE];
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
  const lines = [...p.lines];
  const block = lines.slice(cur.start, cur.end);
  // The title follows the record only while it is still the one Caret wrote.
  const h = HEADING_RE.exec(block[0] as string);
  const title = (h?.[2] ?? "").replace(COMMENT_RE, "").trim();
  if (title === recordTitle(cur.record)) block[0] = headingLine(r);
  const want = fieldPairs(r);
  const wantKeys = new Set(want.map(([k]) => k));
  const allowed = new Set(KIND_KEYS[r.kind]);
  // Where each known field is, outside fenced code.
  const at = new Map<Key, number>();
  let fence: string | null = null;
  for (let i = 1; i < block.length; i++) {
    const l = block[i] as string;
    const f = FENCE_RE.exec(l);
    if (f !== null) {
      const mark = (f[1] as string)[0] as string;
      fence = fence === null ? mark : fence === mark ? null : fence;
      continue;
    }
    if (fence !== null) continue;
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
  const next: string[] = [];
  block.forEach((l, i) => {
    if (!drop.has(i)) next.push(l);
    for (const x of inserts.get(i) ?? []) next.push(x);
  });
  lines.splice(cur.start, cur.end - cur.start, ...next);
  return lines.join(p.eol);
}

function appendRecord(p: ParsedDocument, r: MemoryRecord): string {
  const lines = [...p.lines];
  while (lines.length > 0 && (lines[lines.length - 1] as string).trim() === "") lines.pop();
  if (lines.length === 0) return newDocument(p.doc, [r]).replaceAll("\n", p.eol);
  return [...lines, "", ...renderRecord(r), ""].join(p.eol);
}

/** The document without the record's block: its heading, fields and the prose under it. */
export function removeRecord(p: ParsedDocument, id: string): string {
  const b = p.blocks.get(id);
  if (b === undefined) return p.lines.join(p.eol);
  const lines = [...p.lines];
  lines.splice(b.start, b.end - b.start);
  // One blank line between what was before and after it, not two.
  if (b.start > 0 && (lines[b.start - 1] ?? "x").trim() === "" && (lines[b.start] ?? "x").trim() === "") lines.splice(b.start, 1);
  let text = lines.join(p.eol);
  if (!text.endsWith(p.eol)) text += p.eol;
  return text;
}
