// PopupSpec: a pop-up described as data, a list of blocks from a fixed catalog of eight (Fable plan,
// section 2). The helper builds specs in code and validates them here before they leave; the host
// decodes them with CaretScreenCore's PopupSpec and renders them with its own layout, type and color.
//
// checkPopupSpec is a line-for-line port of the host's decoder (CaretHostCore/PopupSpec.swift on
// v2/host at 4048deb): the same rules, checked in the same order, refused with the same error and
// path. fixtures/golden/popup-specs.json is the host's golden file, copied verbatim; both sides' tests
// decode every spec in it and expect each invalid one to fail with its named error. Zod alone cannot
// name these errors, so the zod schema below runs this check first and then parses the shape.
import * as z from "zod";

// MARK: - the shape, for types and the exported JSON Schema

/** Where a value came from: a screen-model node, a memory entry, or a code derivation of other refs. */
export type PopupRef = { node: string; quote?: string } | { memory: string } | { rule: string; derived: PopupRef[] };
export const PopupRef: z.ZodType<PopupRef> = z.lazy(() =>
  z.union([
    /** `node` is the reader's `<windowId>/<elementKey>`; `quote` is the exact text on screen the value was taken from. */
    z.object({ node: z.string().min(1), quote: z.string().optional() }),
    z.object({ memory: z.string().min(1) }),
    /** `rule` names the code that computed the value from `derived`. */
    z.object({ rule: z.string(), derived: z.array(PopupRef).min(1) }),
  ]),
);

/** Text shown to the user that came from the screen or memory. A value without a ref is refused. */
export const PopupValue = z.object({ text: z.string(), ref: PopupRef });
export type PopupValue = z.infer<typeof PopupValue>;

export const ACTION_KEYS = ["tab", "cmd-1", "cmd-2", "cmd-3", "down"] as const;
export const ActionKey = z.enum(ACTION_KEYS);
export type ActionKey = z.infer<typeof ActionKey>;

/**
 * A fields row's state. `yours` (H5): a control Caret never writes or presses (a select, a radio group, a date), with
 * the value the user sets themselves ("Pizza size: Large").
 */
export const FIELD_STATES = ["ready", "kept", "unsure", "done", "failed", "yours"] as const;
export const STEP_STATES = ["pending", "running", "done", "failed"] as const;
export const BLOCK_CATALOG = ["header", "facts", "fields", "choices", "diff", "steps", "source", "actions"] as const;
export const MAX_CHOICES = 3;

export interface PopupAction {
  id: string;
  /** Written by code from the plan's end state, never by a model. */
  label: string;
  key: ActionKey;
  /** An action that changes the pop-up instead of finishing it: the block with id `replace` becomes `with`. */
  reveal?: { replace: string; with: PopupBlock };
}

type WithId = { id?: string };
export type PopupBlock = WithId &
  (
    | { type: "header"; title: PopupValue }
    | { type: "facts"; rows: { label?: string; value: PopupValue; secondary?: boolean }[] }
    | { type: "fields"; rows: { destination: PopupValue; value?: PopupValue; state: (typeof FIELD_STATES)[number] }[]; more?: number }
    | { type: "choices"; rows: { label: PopupValue; hint?: PopupValue }[]; selected?: number }
    | { type: "diff"; label?: string; before: PopupValue; after: PopupValue }
    | { type: "steps"; rows: { label: string; state: (typeof STEP_STATES)[number] }[] }
    | { type: "source"; value: PopupValue }
    | { type: "actions"; items: PopupAction[] }
  );

export interface PopupSpecT {
  v: 1;
  id: string;
  /** `needsYou` when nothing happens until the user answers (the "which of these three?" picker). */
  figure: "offering" | "needsYou";
  blocks: PopupBlock[];
}

const blockId = { id: z.string().optional() };
export const PopupActionShape: z.ZodType<PopupAction> = z.lazy(() =>
  z.object({ id: z.string(), label: z.string(), key: ActionKey, reveal: z.object({ replace: z.string(), with: PopupBlockShape }).optional() }),
);
export const PopupBlockShape: z.ZodType<PopupBlock> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("header"), ...blockId, title: PopupValue }),
    z.object({ type: z.literal("facts"), ...blockId, rows: z.array(z.object({ label: z.string().optional(), value: PopupValue, secondary: z.boolean().optional() })).min(1) }),
    z.object({
      type: z.literal("fields"),
      ...blockId,
      rows: z.array(z.object({ destination: PopupValue, value: PopupValue.optional(), state: z.enum(FIELD_STATES) })).min(1),
      /** Rows not listed: "and 1 more". Builders omit it when zero, as the host encodes it. */
      more: z.number().int().nonnegative().optional(),
    }),
    z.object({
      type: z.literal("choices"),
      ...blockId,
      rows: z.array(z.object({ label: PopupValue, hint: PopupValue.optional() })).min(1).max(MAX_CHOICES),
      /** The highlighted row when the block first appears, zero-based; 0 when absent. Builders always write it, as the host encodes it. */
      selected: z.number().int().nonnegative().optional(),
    }),
    z.object({ type: z.literal("diff"), ...blockId, label: z.string().optional(), before: PopupValue, after: PopupValue }),
    z.object({ type: z.literal("steps"), ...blockId, rows: z.array(z.object({ label: z.string(), state: z.enum(STEP_STATES) })).min(1) }),
    z.object({ type: z.literal("source"), ...blockId, value: PopupValue }),
    z.object({ type: z.literal("actions"), ...blockId, items: z.array(PopupActionShape).min(1) }),
  ]),
);
export const PopupSpecShape = z.object({
  v: z.literal(1),
  id: z.string(),
  figure: z.enum(["offering", "needsYou"]),
  blocks: z.array(PopupBlockShape).min(1),
});

// MARK: - errors

/**
 * Why a spec was refused, as the host names it. `short` is the fixture's form, `case(arg, arg)`;
 * `message` is the host's description. `path` is a JSON path such as `blocks[2].rows[0].value`.
 */
export class PopupSpecError extends Error {
  readonly code: string;
  readonly short: string;
  readonly path: string | null;
  constructor(code: string, short: string, message: string, path: string | null) {
    super(message);
    this.code = code;
    this.short = short;
    this.path = path;
  }
}

const E = {
  malformedJSON: () => new PopupSpecError("malformedJSON", "not JSON", "not JSON", null),
  unsupportedVersion: (v: number) => new PopupSpecError("unsupportedVersion", `unsupportedVersion(${v})`, `unsupported spec version ${v}`, "$.v"),
  wrongType: (path: string, expected: string) => {
    const m = `${path}: expected ${expected}`;
    return new PopupSpecError("wrongType", m, m, path);
  },
  missingField: (path: string) => {
    const m = `${path}: missing`;
    return new PopupSpecError("missingField", m, m, path);
  },
  unknownBlock: (type: string, path: string) =>
    new PopupSpecError("unknownBlock", `unknownBlock(${type}, ${path})`, `${path}: unknown block type "${type}" (catalog: ${BLOCK_CATALOG.join(", ")})`, path),
  missingReference: (path: string) => new PopupSpecError("missingReference", `missingReference(${path})`, `${path}: value has no ref`, path),
  invalidReference: (path: string, reason: string) => new PopupSpecError("invalidReference", `invalidReference(${path})`, `${path}: invalid ref: ${reason}`, path),
  empty: (path: string) => {
    const m = `${path}: empty`;
    return new PopupSpecError("empty", m, m, path);
  },
  tooManyChoices: (path: string, count: number) => new PopupSpecError("tooManyChoices", `tooManyChoices(${path})`, `${path}: ${count} choices, at most ${MAX_CHOICES}`, path),
  selectionOutOfRange: (path: string) => {
    const m = `${path}: selected row does not exist`;
    return new PopupSpecError("selectionOutOfRange", m, m, path);
  },
  missingBlock: (type: string) => new PopupSpecError("missingBlock", `missingBlock(${type})`, `spec has no ${type} block`, null),
  duplicateBlock: (type: string, path: string) => new PopupSpecError("duplicateBlock", `duplicateBlock(${type}, ${path})`, `${path}: second ${type} block`, path),
  duplicateBlockID: (id: string) => {
    const m = `two blocks with id "${id}"`;
    return new PopupSpecError("duplicateBlockID", m, m, null);
  },
  noPrimaryAction: (path: string) => new PopupSpecError("noPrimaryAction", `noPrimaryAction(${path})`, `${path}: no tab action`, path),
  duplicateActionKey: (path: string, key: string) => {
    const m = `${path}: key ${key} used twice`;
    return new PopupSpecError("duplicateActionKey", m, m, path);
  },
  duplicateActionID: (path: string, id: string) => {
    const m = `${path}: action id "${id}" used twice`;
    return new PopupSpecError("duplicateActionID", m, m, path);
  },
  actionKeyConflictsWithChoices: (path: string, key: string) =>
    new PopupSpecError("actionKeyConflictsWithChoices", `actionKeyConflictsWithChoices(${path})`, `${path}: ${key} is taken by the choices block`, path),
  unknownRevealTarget: (path: string, id: string) => new PopupSpecError("unknownRevealTarget", `unknownRevealTarget(${path})`, `${path}: reveal replaces unknown block "${id}"`, path),
  invalidReveal: (path: string, reason: string) => new PopupSpecError("invalidReveal", `invalidReveal(${path})`, `${path}: after the reveal, ${reason}`, path),
};

// MARK: - parsing, in the host's order

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const isObj = (j: unknown): j is Obj => typeof j === "object" && j !== null && !Array.isArray(j);
const has = (o: Obj, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** Present and not null, as the host's `self[key]` with `!= .null`. */
const present = (o: Obj, k: string): boolean => has(o, k) && o[k] !== null;

function object(j: unknown, path: string): Obj {
  if (!isObj(j)) throw E.wrongType(path, "object");
  return j;
}
function required(o: Obj, k: string, at: string): Json {
  if (!present(o, k)) throw E.missingField(`${at}.${k}`);
  return o[k] as Json;
}
function str(o: Obj, k: string, at: string): string {
  const v = required(o, k, at);
  if (typeof v !== "string") throw E.wrongType(`${at}.${k}`, "string");
  return v;
}
function optStr(o: Obj, k: string, at: string): string | undefined {
  if (!present(o, k)) return undefined;
  const v = o[k];
  if (typeof v !== "string") throw E.wrongType(`${at}.${k}`, "string");
  return v;
}
function int(o: Obj, k: string, at: string): number {
  const v = required(o, k, at);
  if (typeof v !== "number" || !Number.isInteger(v)) throw E.wrongType(`${at}.${k}`, "integer");
  return v;
}
function optInt(o: Obj, k: string, at: string): number | undefined {
  if (!present(o, k)) return undefined;
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw E.wrongType(`${at}.${k}`, "non-negative integer");
  return v;
}
function optBool(o: Obj, k: string, at: string): boolean | undefined {
  if (!present(o, k)) return undefined;
  const v = o[k];
  if (typeof v !== "boolean") throw E.wrongType(`${at}.${k}`, "boolean");
  return v;
}
function arr(o: Obj, k: string, at: string): Json[] {
  const v = required(o, k, at);
  if (!Array.isArray(v)) throw E.wrongType(`${at}.${k}`, "array");
  return v;
}
function nonEmpty(o: Obj, k: string, at: string): Json[] {
  const a = arr(o, k, at);
  if (a.length === 0) throw E.empty(`${at}.${k}`);
  return a;
}
function value(o: Obj, k: string, at: string): PopupValue {
  return parseValue(required(o, k, at), `${at}.${k}`);
}
function optValue(o: Obj, k: string, at: string): PopupValue | undefined {
  return present(o, k) ? parseValue(o[k] as Json, `${at}.${k}`) : undefined;
}

export function parseValue(j: unknown, path: string): PopupValue {
  // A bare string where a value belongs is the commonest way to drop the reference.
  if (typeof j === "string") throw E.missingReference(path);
  const o = object(j, path);
  const text = str(o, "text", path);
  if (!present(o, "ref")) throw E.missingReference(path);
  return { text, ref: parseRef(o.ref, `${path}.ref`) };
}

export function parseRef(j: unknown, path: string): PopupRef {
  const o = object(j, path);
  const kinds = ["node", "memory", "derived"].filter((k) => has(o, k));
  if (kinds.length !== 1) throw E.invalidReference(path, "needs exactly one of node, memory, derived");
  switch (kinds[0]) {
    case "node": {
      const node = str(o, "node", path);
      if (node === "") throw E.invalidReference(path, "empty node key");
      const quote = optStr(o, "quote", path);
      return quote === undefined ? { node } : { node, quote };
    }
    case "memory": {
      const memory = str(o, "memory", path);
      if (memory === "") throw E.invalidReference(path, "empty memory id");
      return { memory };
    }
    default: {
      const rule = str(o, "rule", path);
      const sources = arr(o, "derived", path);
      if (sources.length === 0) throw E.invalidReference(path, "a derived value names no sources");
      return { rule, derived: sources.map((s, i) => parseRef(s, `${path}.derived[${i}]`)) };
    }
  }
}

function withId<T extends object>(id: string | undefined, b: T): T & WithId {
  return id === undefined ? b : { ...b, id };
}

export function parseBlock(j: unknown, path: string): PopupBlock {
  const o = object(j, path);
  const type = str(o, "type", path);
  const id = optStr(o, "id", path);
  switch (type) {
    case "header":
      return withId(id, { type, title: value(o, "title", path) });
    case "facts":
      return withId(id, {
        type,
        rows: nonEmpty(o, "rows", path).map((raw, i) => {
          const rp = `${path}.rows[${i}]`;
          const row = object(raw, rp);
          const label = optStr(row, "label", rp);
          const v = value(row, "value", rp);
          const secondary = optBool(row, "secondary", rp) ?? false;
          return { ...(label === undefined ? {} : { label }), value: v, ...(secondary ? { secondary: true as const } : {}) };
        }),
      });
    case "fields": {
      const rows = nonEmpty(o, "rows", path).map((raw, i) => {
        const rp = `${path}.rows[${i}]`;
        const row = object(raw, rp);
        const state = str(row, "state", rp);
        if (!(FIELD_STATES as readonly string[]).includes(state)) throw E.wrongType(`${rp}.state`, "ready, kept, unsure, done, failed or yours");
        const destination = value(row, "destination", rp);
        const v = optValue(row, "value", rp);
        return { destination, ...(v === undefined ? {} : { value: v }), state: state as (typeof FIELD_STATES)[number] };
      });
      const more = optInt(o, "more", path) ?? 0;
      return withId(id, { type, rows, ...(more > 0 ? { more } : {}) });
    }
    case "choices": {
      const raw = nonEmpty(o, "rows", path);
      if (raw.length > MAX_CHOICES) throw E.tooManyChoices(`${path}.rows`, raw.length);
      const rows = raw.map((r, i) => {
        const rp = `${path}.rows[${i}]`;
        const row = object(r, rp);
        const label = value(row, "label", rp);
        const hint = optValue(row, "hint", rp);
        return { label, ...(hint === undefined ? {} : { hint }) };
      });
      const selected = optInt(o, "selected", path) ?? 0;
      if (selected >= rows.length) throw E.selectionOutOfRange(`${path}.selected`);
      return withId(id, { type, rows, selected });
    }
    case "diff": {
      const label = optStr(o, "label", path);
      const before = value(o, "before", path);
      const after = value(o, "after", path);
      return withId(id, { type, ...(label === undefined ? {} : { label }), before, after });
    }
    case "steps":
      return withId(id, {
        type,
        rows: nonEmpty(o, "rows", path).map((raw, i) => {
          const rp = `${path}.rows[${i}]`;
          const row = object(raw, rp);
          const state = str(row, "state", rp);
          if (!(STEP_STATES as readonly string[]).includes(state)) throw E.wrongType(`${rp}.state`, "pending, running, done or failed");
          return { label: str(row, "label", rp), state: state as (typeof STEP_STATES)[number] };
        }),
      });
    case "source":
      return withId(id, { type, value: value(o, "value", path) });
    case "actions":
      return withId(id, { type, items: nonEmpty(o, "items", path).map((raw, i) => parseAction(raw, `${path}.items[${i}]`)) });
    default:
      throw E.unknownBlock(type, path);
  }
}

export function parseAction(j: unknown, path: string): PopupAction {
  const o = object(j, path);
  const keyName = str(o, "key", path);
  if (!(ACTION_KEYS as readonly string[]).includes(keyName)) throw E.wrongType(`${path}.key`, "tab, cmd-1, cmd-2, cmd-3 or down");
  let reveal: PopupAction["reveal"];
  if (present(o, "reveal")) {
    const rp = `${path}.reveal`;
    const r = object(o.reveal, rp);
    if (!has(r, "with")) throw E.missingField(`${rp}.with`);
    reveal = { replace: str(r, "replace", rp), with: parseBlock(r.with, `${rp}.with`) };
  }
  const id = str(o, "id", path);
  const label = str(o, "label", path);
  return { id, label, key: keyName as ActionKey, ...(reveal === undefined ? {} : { reveal }) };
}

const DIGIT_KEYS: ReadonlySet<ActionKey> = new Set(["cmd-1", "cmd-2", "cmd-3"]);

export function specActions(spec: PopupSpecT): PopupAction[] {
  for (const b of spec.blocks) if (b.type === "actions") return b.items;
  return [];
}

export function specChoices(spec: PopupSpecT): Extract<PopupBlock, { type: "choices" }> | undefined {
  for (const b of spec.blocks) if (b.type === "choices") return b;
  return undefined;
}

/** The spec after `actionId`'s reveal: its target block replaced and the revealing action gone from the bar. */
export function applyingReveal(spec: PopupSpecT, actionId: string): PopupSpecT {
  const action = specActions(spec).find((a) => a.id === actionId);
  const reveal = action?.reveal;
  if (reveal === undefined) return spec;
  return {
    ...spec,
    blocks: spec.blocks.map((b) => {
      if (b.id === reveal.replace) return reveal.with;
      if (b.type === "actions") return { ...b, items: b.items.filter((a) => a.id !== actionId) };
      return b;
    }),
  };
}

/** Rules across blocks: one header, one actions block with one Tab action, unique ids and keys, and Command-digits left to a choices block. */
export function checkStructure(spec: PopupSpecT): void {
  const seen = new Map<string, string>();
  const ids = new Set<string>();
  spec.blocks.forEach((b, i) => {
    const path = `blocks[${i}]`;
    // One choices block: the arrows and Command-digits act on a single set of rows.
    if ((b.type === "header" || b.type === "actions" || b.type === "source" || b.type === "choices") && seen.has(b.type)) throw E.duplicateBlock(b.type, path);
    seen.set(b.type, path);
    if (b.id !== undefined) {
      if (ids.has(b.id)) throw E.duplicateBlockID(b.id);
      ids.add(b.id);
    }
  });
  if (!seen.has("header")) throw E.missingBlock("header");
  const actionsPath = seen.get("actions");
  if (actionsPath === undefined) throw E.missingBlock("actions");
  const items = specActions(spec);
  if (!items.some((a) => a.key === "tab")) throw E.noPrimaryAction(actionsPath);
  const keys = new Set<ActionKey>();
  const actionIds = new Set<string>();
  const choices = specChoices(spec);
  items.forEach((a, i) => {
    const path = `${actionsPath}.items[${i}]`;
    if (keys.has(a.key)) throw E.duplicateActionKey(path, a.key);
    keys.add(a.key);
    if (actionIds.has(a.id)) throw E.duplicateActionID(path, a.id);
    actionIds.add(a.id);
    if (choices !== undefined && DIGIT_KEYS.has(a.key)) throw E.actionKeyConflictsWithChoices(path, a.key);
    if (a.reveal !== undefined) {
      if (!ids.has(a.reveal.replace)) throw E.unknownRevealTarget(`${path}.reveal`, a.reveal.replace);
      // What the reveal leads to must itself be a valid pop-up.
      try {
        checkStructure(applyingReveal(spec, a.id));
      } catch (e) {
        if (e instanceof PopupSpecError) throw E.invalidReveal(`${path}.reveal`, e.message);
        throw e;
      }
    }
  });
}

/** Decodes and validates one spec, as the host does. Throws PopupSpecError, never anything else. */
export function parsePopupSpec(j: unknown): PopupSpecT {
  const root = object(j, "$");
  const v = int(root, "v", "$");
  if (v !== 1) throw E.unsupportedVersion(v);
  const id = str(root, "id", "$");
  const figure = str(root, "figure", "$");
  if (figure !== "offering" && figure !== "needsYou") throw E.wrongType("$.figure", "offering or needsYou");
  const raw = arr(root, "blocks", "$");
  if (raw.length === 0) throw E.empty("$.blocks");
  const spec: PopupSpecT = { v: 1, id, figure, blocks: raw.map((b, i) => parseBlock(b, `blocks[${i}]`)) };
  checkStructure(spec);
  return spec;
}

/** parsePopupSpec on a JSON string: text that is not JSON is malformedJSON. */
export function decodePopupSpec(text: string): PopupSpecT {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw E.malformedJSON();
  }
  return parsePopupSpec(j);
}

/** A JSON path as zod's issue path: `blocks[2].rows[0]` becomes ["blocks", 2, "rows", 0]. */
function zodPath(path: string | null): (string | number)[] {
  if (path === null) return [];
  return path
    .replace(/^\$\.?/, "")
    .split(/\.|(?=\[)/)
    .filter((s) => s !== "")
    .map((s) => (s.startsWith("[") ? Number(s.slice(1, -1)) : s));
}

/**
 * The spec as a zod schema: the host's rules first, each failure an issue whose message is the host's
 * short error name (`missingReference(blocks[1].rows[0].value)`) at that path; then the shape.
 */
export const PopupSpec = z
  .unknown()
  .superRefine((v, ctx) => {
    try {
      parsePopupSpec(v);
    } catch (e) {
      if (!(e instanceof PopupSpecError)) throw e;
      ctx.addIssue({ code: "custom", message: e.short, path: zodPath(e.path), params: { popupError: e.code } });
    }
  })
  .pipe(PopupSpecShape);
export type PopupSpec = z.infer<typeof PopupSpecShape>;

/**
 * The bar of an action line, held to the rules of a pop-up's actions block: the same item shape, a Tab
 * action, and no key or id used twice. Throws PopupSpecError with paths under `path`.
 */
export function checkActionBar(j: unknown, path: string): PopupAction[] {
  if (!Array.isArray(j)) throw E.wrongType(path, "array");
  if (j.length === 0) throw E.empty(path);
  const items = j.map((raw, i) => parseAction(raw, `${path}[${i}]`));
  if (!items.some((a) => a.key === "tab")) throw E.noPrimaryAction(path);
  const keys = new Set<string>();
  const ids = new Set<string>();
  items.forEach((a, i) => {
    if (keys.has(a.key)) throw E.duplicateActionKey(`${path}[${i}]`, a.key);
    keys.add(a.key);
    if (ids.has(a.id)) throw E.duplicateActionID(`${path}[${i}]`, a.id);
    ids.add(a.id);
  });
  return items;
}

/** The zod form of checkActionBar, for the action message. */
export const ActionBar = z
  .unknown()
  .superRefine((v, ctx) => {
    try {
      checkActionBar(v, "actions");
    } catch (e) {
      if (!(e instanceof PopupSpecError)) throw e;
      ctx.addIssue({ code: "custom", message: e.short, path: zodPath(e.path).slice(1), params: { popupError: e.code } });
    }
  })
  .pipe(z.array(PopupActionShape).min(1));

/** A value checked as the host checks one: `{text, ref}` with exactly one kind of ref. */
export const CheckedValue = z
  .unknown()
  .superRefine((v, ctx) => {
    try {
      parseValue(v, "value");
    } catch (e) {
      if (!(e instanceof PopupSpecError)) throw e;
      ctx.addIssue({ code: "custom", message: e.short, path: zodPath(e.path).slice(1), params: { popupError: e.code } });
    }
  })
  .pipe(PopupValue);
