// The I/O boundary (OUTPUT-LEDGER-SPEC section 6). A request reaches a transport only as the bytes seal made of it for one
// sink: the sink's complete final body (a Jev body, a chat route's messages around a writer's input, a local engine's
// call), rendered from the frozen request, validated whole, measured and admitted, in that order. Transports post those
// bytes through sendable, on every attempt (each retry, each call a queued request makes when it is dequeued), which
// checks the request again as it leaves: no app or site switched off since it was built, and no window opened since that
// it would take past a limit. A store writes a request only through storedLine, which validates the store's whole record.
// test/sc1-boundary.test.ts holds every POST body and every request store in src to them.
import type { WriteFileOptions } from "node:fs";
import { measureBytes, OutOfShape, verifySent, verifyWriterInput, withheldDeep } from "./disclosure.ts";
import { excludedValue } from "./exclude.ts";
import type { ScalarType } from "./shapes.ts";
import type { Measurement } from "./ledger/account.ts";
import { withholdValues } from "./exclude.ts";
import { writeLocalFile } from "./store-path.ts";

/** The mode a caller's write options ask for, if any (the only option the stores honour). */
const modeOf = (o: WriteFileOptions | undefined): { mode?: number } => {
  const m = typeof o === "object" && o !== null ? o.mode : undefined;
  return m === undefined ? {} : { mode: typeof m === "string" ? Number.parseInt(m, 8) : m };
};
import type { ModelValue } from "./disclosure.ts";
import type { ChoiceQuestion, JevRequest, NoulQuestion } from "../fill/jev.ts";

/** A request on its way out: the request (its Disclosure travels with it) and the body it verifies as. */
export type Outbound =
  | { readonly req: { purpose?: string; disclosure?: unknown }; readonly wire: unknown }
  | { readonly writer: { kind: string; disclosure?: unknown; input: unknown } };

/**
 * What one path of a sink's final body may hold, by glob (privacy/shapes.ts childGlob, from the body's root):
 * - wire: the sealed wire itself, exactly;
 * - rendered: text the sink rendered from the wire, made of the wire's own strings and keys and the sink's own wording
 *   (Sink.wording) and nothing else, each string at most `max` characters;
 * - config: the sink's configuration (a model name, provider fields), each string at most `max` characters;
 * - answer: what a model answered, kept by a store, each string at most `max` characters (withheld as it is written);
 * - scalar: a number, boolean or null of these types.
 * A glob segment `*` stands for any key of an object. An object or list on the way to a slot is allowed; any other path
 * refuses. Every string, keys included, is checked for the formats Caret never carries, an answer's withheld instead.
 */
export type EnvelopeSlot =
  | { readonly kind: "wire" }
  | { readonly kind: "rendered"; readonly max: number }
  | { readonly kind: "config"; readonly max: number }
  | { readonly kind: "answer"; readonly max: number }
  | { readonly kind: "scalar"; readonly types: readonly ScalarType[] };
export type Envelope = Readonly<Record<string, EnvelopeSlot>>;

/**
 * A sink: how a request's complete final body is rendered from its frozen wire, and what that body may hold. A
 * transport sends, and a store writes, nothing but the bytes seal made of it.
 */
export interface Sink {
  readonly name: string;
  readonly render: (wire: unknown) => unknown;
  readonly envelope: Envelope;
  /** The sink's own wording a rendered string may hold beside the wire's strings: its prompts and templates. */
  readonly wording: readonly string[];
}

/** A Jev transport's body: the wire itself. */
export const WIRE: Sink = { name: "wire", render: (w: unknown) => w, envelope: { "": { kind: "wire" } }, wording: [] };

/**
 * A request sealed for sending (PV2 re-review): a frozen copy of its wire body and of its sink's final body, taken once,
 * validated and measured. Every send writes the final bytes only, and every store reads the wire from this copy only,
 * so a request changed after it was sealed changes nothing that leaves; each send checks the copy again as it leaves (a
 * switch-off since then refuses it).
 */
export interface Sealed {
  /** The frozen wire body: a Jev body, or a writer's input. */
  readonly wire: unknown;
  readonly out: Outbound;
  /** The sink's complete final body as bytes, taken once: what every send posts, never an object. */
  readonly bytes: string;
  /**
   * What the bytes reveal of each window (OUTPUT-LEDGER-SPEC, the output ledger), by window key, as measured at seal: the
   * request's declared charge. Never sent.
   */
  readonly charged: Readonly<Record<string, number>>;
  /** The seal's measurement itself, positions included, for an operation's union (section 7). Never sent. */
  readonly measurement: Measurement;
}

function freeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
}

function check(o: Outbound): void {
  if ("writer" in o) verifyWriterInput(o.writer);
  else verifySent(o.req, o.wire);
}

/** The request whose Disclosure measures an outbound body. */
const owner = (o: Outbound): { purpose?: string; kind?: string; disclosure?: unknown } => ("writer" in o ? o.writer : o.req);

/** Every string of a JSON value, and every key, in order. */
function stringsOf(v: unknown, out: string[] = [], keys: string[] = []): { strings: string[]; keys: string[] } {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, keys);
  else if (typeof v === "object" && v !== null) {
    for (const [k, x] of Object.entries(v)) {
      keys.push(k);
      stringsOf(x, out, keys);
    }
  }
  return { strings: out, keys };
}

const LETTER = /\p{L}/u;
const letterAt = (t: string, i: number): boolean => i >= 0 && i < t.length && LETTER.test(t[i]!);

/** `text` with every occurrence of `piece` that does not cut a word (no letter runs into it on either side) blanked. */
function blanked(text: string, piece: string): string {
  let out = "";
  let from = 0;
  for (let at = text.indexOf(piece); at >= 0; at = text.indexOf(piece, at + 1)) {
    if (at < from) continue;
    const cuts = (letterAt(piece, 0) && letterAt(text, at - 1)) || (letterAt(piece, piece.length - 1) && letterAt(text, at + piece.length));
    if (cuts) continue;
    out += `${text.slice(from, at)}\u0000`;
    from = at + piece.length;
  }
  return out + text.slice(from);
}

/**
 * Whether `text` is made of the sink's own wording and the wire's strings and keys (as written, or as JSON writes
 * them), with nothing between them but punctuation, spaces, digits and JSON's words. The wording's texts go first, then
 * the wire's pieces, longest first, each where it does not cut a word; what is left must be words of the wording.
 */
function renderedFrom(text: string, pieces: readonly string[], wording: { texts: readonly string[]; words: ReadonlySet<string> }): boolean {
  let rest = text;
  for (const t of wording.texts) rest = rest.split(t).join("\u0000");
  for (const p of pieces) if (p !== "") rest = blanked(rest, p);
  for (const w of rest.split(/[^\p{L}]+/u)) if (w !== "" && !wording.words.has(w)) return false;
  return true;
}

/** The sink's own wording: its texts, longest first, and their words with JSON's. */
function wordsOf(texts: readonly string[]): { texts: readonly string[]; words: ReadonlySet<string> } {
  return {
    texts: [...texts].filter((t) => t !== "").sort((a, b) => b.length - a.length),
    words: new Set(["true", "false", "null", ...texts.flatMap((t) => t.split(/[^\p{L}]+/u).filter((w) => w !== ""))]),
  };
}

/** Validates a sink's final body against its envelope (Sink.envelope). Throws UnmintedText naming the path, never text. */
function validate(where: string, body: unknown, wire: unknown, sink: Pick<Sink, "name" | "envelope" | "wording">, formatsRefuse = true): void {
  const fromWire = stringsOf(wire);
  // Longest first, so a string inside a longer one does not cut the longer one's occurrences.
  const pieces = [...new Set([...fromWire.strings, ...fromWire.keys].flatMap((x) => [x, JSON.stringify(x).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  const wording = wordsOf(sink.wording);
  const fail = (path: string, why: string): never => {
    throw new OutOfShape(`${where}: ${path === "" ? "the body" : path} ${why}; it was not sent`);
  };
  const known = (glob: string): boolean => Object.keys(sink.envelope).some((g) => g === glob || g.startsWith(`${glob}.`) || g.startsWith(`${glob}[`) || (glob === "" && g !== ""));
  // A sink refuses a value in a format Caret never carries; a store withholds it as it writes (withheldDeep).
  const formats = (path: string, x: string): void => {
    if (formatsRefuse && excludedValue(x) !== null) fail(path, "holds a value in a format Caret never carries");
  };
  const under = (v: unknown, path: string, slot: EnvelopeSlot): void => {
    if (slot.kind === "wire") {
      if (JSON.stringify(v) !== JSON.stringify(wire)) fail(path, "is not the sealed request");
      return;
    }
    if (slot.kind === "scalar") {
      const type = v === null ? "null" : typeof v;
      if (!(slot.types as readonly string[]).includes(type)) fail(path, `holds a ${type}, which the ${sink.name} body does not allow there`);
      return;
    }
    const all = stringsOf(v);
    for (const k of all.keys) if (slot.kind !== "answer") formats(path, k);
    for (const x of all.strings) {
      if (slot.kind !== "answer") formats(path, x);
      if (x.length > slot.max) fail(path, `holds ${x.length} characters, more than the ${sink.name} body's ${slot.max}`);
      if (slot.kind === "rendered" && !renderedFrom(x, pieces, wording)) fail(path, `holds text that is neither the request's nor the ${sink.name} sink's own wording`);
    }
  };
  const go = (v: unknown, path: string, glob: string): void => {
    const slot = sink.envelope[glob];
    if (slot !== undefined) return under(v, path, slot);
    if (v !== null && typeof v === "object" && known(glob)) {
      if (Array.isArray(v)) return v.forEach((x, i) => go(x, `${path}[${i}]`, `${glob}[*]`));
      for (const [k, x] of Object.entries(v)) {
        formats(path, k);
        const named = glob === "" ? k : `${glob}.${k}`;
        const any = glob === "" ? "*" : `${glob}.*`;
        go(x, path === "" ? k : `${path}.${k}`, known(named) || sink.envelope[named] !== undefined ? named : any);
      }
      return;
    }
    fail(path, `is no part of the ${sink.name} body`);
  };
  go(body, "", "");
}

/**
 * Seals a request for one sink (OUTPUT-LEDGER-SPEC section 6), in this order: freezes a copy of its wire body; verifies
 * the wire (membership, shape, keys, types, lengths, the switch-off policy); renders the sink's complete final body
 * from the frozen wire; validates that body against the sink's envelope and the formats Caret never carries; then
 * measures the final bytes with the output ledger (lexically, and the declared spans of every minted unit the wire
 * holds) and admits them, committing to the operation's ledger only then. Throws UnmintedText (LedgerRefused for the
 * ledger, OutOfShape for the envelope); nothing is kept of a refused seal.
 */
export function seal(o: Outbound, sink: Sink = WIRE): Sealed {
  const wireBytes = JSON.stringify("writer" in o ? o.writer.input : o.wire);
  const wire = freeze(JSON.parse(wireBytes) as unknown);
  const out: Outbound = "writer" in o ? { writer: { ...o.writer, input: wire } } : { req: o.req, wire };
  check(out);
  const who = owner(out);
  const body = sink.render(wire);
  validate(who.purpose ?? who.kind ?? "a request", body, wire, sink);
  const bytes = JSON.stringify(body);
  const measurement = measureBytes(who, bytes, stringsOf(wire).strings);
  return Object.freeze({ wire, out, bytes, charged: Object.freeze({ ...measurement.charged }), measurement });
}

/** The sealed wire read again, a fresh value, checked as it leaves (a switch-off since refuses it). */
function fromBytes(s: Sealed): unknown {
  const wire = JSON.parse(JSON.stringify(s.wire)) as unknown;
  check("writer" in s.out ? { writer: { ...s.out.writer, input: wire } } : { req: s.out.req, wire });
  return wire;
}

/**
 * The bytes a transport posts, on every attempt: the sealed final bytes, unchanged, after the wire is checked again (a
 * switch-off since the seal refuses) and the bytes are measured against the registry as it is now (a window opened
 * since the seal can refuse them); this measure commits nothing more. Throws UnmintedText (LedgerRefused for the ledger)
 * when they may not leave.
 */
export function sendable(s: Sealed): string {
  const wire = fromBytes(s);
  measureBytes(owner(s.out), s.bytes, stringsOf(wire).strings, false);
  return s.bytes;
}

/** A store's record of a sealed request: how it is built from the frozen wire, and what it may hold (Sink's envelope). */
export interface StoreRecord {
  readonly name: string;
  readonly build: (wire: unknown) => unknown;
  readonly envelope: Envelope;
  readonly wording: readonly string[];
}

/**
 * A store's check (OUTPUT-LEDGER-SPEC section 6, the coordinator's 2026-10-07 ruling): membership, shape, the
 * switch-off policy and the never-carried formats, but not the per-window budget. The budget governs bytes sent to a
 * provider; a local file is not a provider disclosure, and the request bytes a record holds were measured when they were
 * sealed for sending. A store that could leave the Mac on its own would be a provider, so every store path is held to
 * local, non-synced roots (privacy/store-path.ts).
 *
 * The line a store writes, checked as it is written: the store's complete record, built from the frozen wire (the
 * request, beside what came back), validated whole against the record's envelope, then written as JSON with every value
 * in a format Caret never carries withheld, and a newline.
 */
export function storedLine(s: Sealed, record: StoreRecord): string {
  const wire = fromBytes(s);
  const kept = record.build(wire);
  validate(`${record.name} record`, kept, wire, record, false);
  return `${JSON.stringify(withheldDeep(kept))}\n`;
}

/** storedLine written to `path` (a request store's whole file), after the store-path check (privacy/store-path.ts). */
export function writeStoredLine(path: string, s: Sealed, record: StoreRecord, o?: WriteFileOptions): void {
  writeLocalFile(path, storedLine(s, record), modeOf(o));
}

/** storedLine appended to `path` (a request log), after the store-path check (privacy/store-path.ts). */
export function appendStoredLine(path: string, s: Sealed, record: StoreRecord, o?: WriteFileOptions): void {
  writeLocalFile(path, storedLine(s, record), { ...modeOf(o), append: true });
}

/**
 * A request's record for a store, read from the sealed bytes (frozenRequest over a fresh parse), checked as it is
 * written, with every value in a format Caret never carries withheld: never built from an object a caller holds.
 */
export function storedRequest<T>(s: Sealed, req: JevRequest, build: (frozen: JevRequest) => T): T {
  const wire = fromBytes(s);
  return withheldDeep(build(frozenRequest(req, wire, s.charged))) as T;
}

/**
 * PV2 (the lead's ruling on local and provider responses): the only way an evaluation script writes a text file. What a
 * model answered, a local model drafted or a run reported is kept with every value in a format Caret never carries
 * withheld (privacy/exclude.ts withholdValues), whatever the file. A request in it goes through storedLine or
 * storableRequest first. test/sc1-boundary.test.ts holds every script's text write to these. For raw text only: a JSON
 * or NDJSON store goes through writeStoreJson, appendStoreJson or writeStoreNdjson, which withhold inside its strings.
 */
export function writeStore(path: string, text: string, o?: WriteFileOptions): void {
  writeLocalFile(path, withholdValues(text), modeOf(o));
}

/** writeStore's append. */
export function appendStore(path: string, text: string, o?: WriteFileOptions): void {
  writeLocalFile(path, withholdValues(text), { ...modeOf(o), append: true });
}

/** Two keys of one object that withholding made the same: the store refuses rather than drop one of them. */
export class StoreKeyCollision extends Error {
  constructor() {
    super("two keys of one object in a store record withhold to the same text; nothing was written");
    this.name = "StoreKeyCollision";
  }
}

function withheldStructure(v: unknown): unknown {
  if (typeof v === "string") return withholdValues(v);
  if (Array.isArray(v)) return v.map(withheldStructure);
  if (typeof v === "object" && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const key = withholdValues(k);
      if (Object.hasOwn(out, key)) throw new StoreKeyCollision();
      Object.defineProperty(out, key, { value: withheldStructure(x), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return v;
}

/**
 * A structured record as a store writes it: the value as JSON sees it (toJSON applied, undefined dropped), with every
 * string in it, keys included, withheld as withholdValues withholds text, then encoded once. Numbers, booleans and null
 * are never touched, so the result always parses. Withholding the encoded text instead (writeStore over a
 * JSON.stringify) can cut into a number: B31's live scoreboard on v2/int1 held `382.[withheld]` and did not parse
 * (~/.caret-run/evidence/screen/int1/live-b31/realfill-asks.json).
 */
export function storeJson(value: unknown, space?: number): string {
  const plain = JSON.parse(JSON.stringify(value) ?? "null") as unknown;
  return JSON.stringify(withheldStructure(plain), null, space);
}

/** A .json store: storeJson's text and a newline. */
export function writeStoreJson(path: string, value: unknown, space?: number, o?: WriteFileOptions): void {
  writeLocalFile(path, `${storeJson(value, space)}\n`, modeOf(o));
}

/** One record appended to an .ndjson store, on one line. */
export function appendStoreJson(path: string, value: unknown, o?: WriteFileOptions): void {
  writeLocalFile(path, `${storeJson(value)}\n`, { ...modeOf(o), append: true });
}

/** An .ndjson store of these records, one line each. */
export function writeStoreNdjson(path: string, values: readonly unknown[], o?: WriteFileOptions): void {
  writeLocalFile(path, values.map((v) => `${storeJson(v)}\n`).join(""), modeOf(o));
}

/**
 * A request as its sealed wire body says it (privacy/send.ts seal): its state, choice questions and yes/no questions read
 * back from the frozen copy, with the live request's Disclosure and declarations. Anything that renders or records a
 * request after it was sealed reads this, never the live request.
 */
export function frozenRequest(req: JevRequest, wire: unknown, charged?: Readonly<Record<string, number>>): JevRequest {
  const w = wire as { state: ModelValue; questions: Record<string, ChoiceQuestion | NoulQuestion> };
  const questions: Record<string, ChoiceQuestion> = {};
  const nouls: Record<string, NoulQuestion> = {};
  for (const [id, q] of Object.entries(w.questions)) {
    if (q.type === "noul") nouls[id] = q;
    else questions[id] = q;
  }
  // Frozen, deep: a caller holding the snapshot cannot change what it says (defence in depth; stores read the bytes).
  // The declared charge is the seal's, when there is one: what the sealed bytes reveal, not what minting estimated.
  return Object.freeze({ ...req, ...(charged === undefined ? {} : { charged }), state: freeze(w.state), questions: freeze(questions), ...(req.nouls === undefined ? {} : { nouls: freeze(nouls) }) });
}
