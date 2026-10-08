// PV2 re-review, the I/O boundary: a request's bytes reach a transport or a store only through these, called in the
// transport call or the store write itself, on every attempt (each retry, each call a queued request makes when it is
// dequeued). Each checks the request as it leaves: every string minted for it, in its shape, and no app or site
// switched off since it was built (Disclosure.verify). So a request built before a switch-off never reaches a model or a
// disk, however long it waited. test/sc1-boundary.test.ts holds every POST body and every request store in src to them.
import type { WriteFileOptions } from "node:fs";
import { verifySent, verifyWriterInput, withheldDeep } from "./disclosure.ts";
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
 * A request sealed for sending (PV2 re-review): a frozen copy of its wire body, taken once and verified. Every send and
 * every store writes from this copy only, never from the live request, so a request changed after it was sealed changes
 * nothing that leaves; and each send or store checks the copy again as it leaves (a switch-off since then refuses it).
 */
export interface Sealed {
  /** The frozen wire body: a Jev body, or a writer's input. */
  readonly wire: unknown;
  readonly out: Outbound;
  /** The wire body as bytes, taken once: what every send posts and every store parses, never an object. */
  readonly bytes: string;
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

/** Seals a request: copies its wire body once, freezes the copy and verifies it. Throws UnmintedText as a send would. */
export function seal(o: Outbound): Sealed {
  const bytes = JSON.stringify("writer" in o ? o.writer.input : o.wire);
  const wire = freeze(JSON.parse(bytes) as unknown);
  const out: Outbound = "writer" in o ? { writer: { ...o.writer, input: wire } } : { req: o.req, wire };
  check(out);
  return Object.freeze({ wire, out, bytes });
}

/** The sealed wire read again from its bytes, a fresh value, checked as it leaves (a switch-off since refuses it). */
function fromBytes(s: Sealed): unknown {
  const wire = JSON.parse(s.bytes) as unknown;
  check("writer" in s.out ? { writer: { ...s.out.writer, input: wire } } : { req: s.out.req, wire });
  return wire;
}

/**
 * The body a transport posts, checked as it leaves: the frozen wire, or what `render` makes of it (a chat route's
 * messages, a local engine's prompt), rendered from the frozen copy only. Throws UnmintedText when it may not leave.
 */
export function sealedBody(s: Sealed, render?: (wire: unknown) => unknown): string {
  const wire = fromBytes(s);
  return render === undefined ? s.bytes : JSON.stringify(render(wire));
}

/**
 * A store's check (OUTPUT-LEDGER-SPEC section 6, the coordinator's 2026-10-07 ruling): membership, shape, the
 * switch-off policy and the never-carried formats, but not the per-window budget. The budget governs bytes sent to a
 * provider; a local file is not a provider disclosure, and the request bytes a record holds were measured when they were
 * sealed for sending. A store that could leave the Mac on its own would be a provider, so every store path is held to
 * local, non-synced roots (privacy/store-path.ts).
 *
 * The line a store writes, checked as it is written: what `build` makes of the frozen wire (the store's record of the
 * request, beside what came back), as JSON with every value in a format Caret never carries withheld, and a newline.
 */
export function storedLine(s: Sealed, build: (wire: unknown) => unknown): string {
  return `${JSON.stringify(withheldDeep(build(fromBytes(s))))}\n`;
}

/** storedLine written to `path` (a request store's whole file), after the store-path check (privacy/store-path.ts). */
export function writeStoredLine(path: string, s: Sealed, build: (wire: unknown) => unknown, o?: WriteFileOptions): void {
  writeLocalFile(path, storedLine(s, build), modeOf(o));
}

/** storedLine appended to `path` (a request log), after the store-path check (privacy/store-path.ts). */
export function appendStoredLine(path: string, s: Sealed, build: (wire: unknown) => unknown, o?: WriteFileOptions): void {
  writeLocalFile(path, storedLine(s, build), { ...modeOf(o), append: true });
}

/**
 * A request's record for a store, read from the sealed bytes (frozenRequest over a fresh parse), checked as it is
 * written, with every value in a format Caret never carries withheld: never built from an object a caller holds.
 */
export function storedRequest<T>(s: Sealed, req: JevRequest, build: (frozen: JevRequest) => T): T {
  const wire = fromBytes(s);
  return withheldDeep(build(frozenRequest(req, wire))) as T;
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
export function frozenRequest(req: JevRequest, wire: unknown): JevRequest {
  const w = wire as { state: ModelValue; questions: Record<string, ChoiceQuestion | NoulQuestion> };
  const questions: Record<string, ChoiceQuestion> = {};
  const nouls: Record<string, NoulQuestion> = {};
  for (const [id, q] of Object.entries(w.questions)) {
    if (q.type === "noul") nouls[id] = q;
    else questions[id] = q;
  }
  // Frozen, deep: a caller holding the snapshot cannot change what it says (defence in depth; stores read the bytes).
  return Object.freeze({ ...req, state: freeze(w.state), questions: freeze(questions), ...(req.nouls === undefined ? {} : { nouls: freeze(nouls) }) });
}
