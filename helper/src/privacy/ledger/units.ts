// The output ledger's decoded units (OUTPUT-LEDGER-SPEC section 3): the text a receiver reads from a request's exact
// final UTF-8 JSON bytes. Every object key and every string value is its own unit, and so is the spelling of every
// number, true, false and null, so turning a string into a JSON scalar cannot make a reproduced value free. JSON
// delimiters give structure, not adjacency: no match runs from one unit into the next.
//
// The parser is strict and its own: malformed UTF-8 (a fatal decoder), malformed JSON, a duplicate key or a lone
// surrogate escape refuses, with LedgerEncodingError naming the byte offset, never the text. Escapes are decoded once;
// a string that happens to look like JSON is not parsed again (a declared nested payload is the transport shape's job).
import { LedgerEncodingError } from "./normalize.ts";

export type UnitPath = readonly (string | number)[];

export interface DecodedUnit {
  /** Where the unit stands: the path of the value it is, or of the object whose key it is. */
  readonly path: UnitPath;
  readonly kind: "key" | "string" | "scalar";
  readonly text: string;
}

export interface Decoded {
  readonly value: unknown;
  readonly units: readonly DecodedUnit[];
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes a request's final bytes into its value and its measured units, in document order. */
export function decodeUnits(bytes: Uint8Array | string): Decoded {
  let text: string;
  if (typeof bytes === "string") {
    text = bytes;
  } else {
    try {
      text = decoder.decode(bytes);
    } catch {
      throw new LedgerEncodingError("the request's bytes are not well-formed UTF-8");
    }
  }
  const units: DecodedUnit[] = [];
  let i = 0;
  const fail = (what: string): never => {
    throw new LedgerEncodingError(`the request is not one well-formed JSON value: ${what} at offset ${i}`);
  };
  const ws = (): void => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const str = (): string => {
    if (text[i] !== '"') fail("expected a string");
    i++;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("an unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        break;
      }
      if (c < 0x20) fail("a control character in a string");
      if (c !== 0x5c) {
        out += text[i];
        i++;
        continue;
      }
      const e = text[i + 1];
      i += 2;
      if (e === '"' || e === "\\" || e === "/") out += e;
      else if (e === "b") out += "\b";
      else if (e === "f") out += "\f";
      else if (e === "n") out += "\n";
      else if (e === "r") out += "\r";
      else if (e === "t") out += "\t";
      else if (e === "u") {
        const h = text.slice(i, i + 4);
        if (!/^[0-9a-fA-F]{4}$/u.test(h)) fail("a bad \\u escape");
        out += String.fromCharCode(Number.parseInt(h, 16));
        i += 4;
      } else fail("a bad escape");
    }
    // A lone surrogate, written raw or escaped, is not text the ledger can measure.
    if (!out.isWellFormed()) fail("an unpaired surrogate in a string");
    return out;
  };
  const value = (path: UnitPath): unknown => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const o: Record<string, unknown> = {};
      const keys = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return o;
      }
      for (;;) {
        ws();
        const k = str();
        if (keys.has(k)) fail("a duplicate key");
        keys.add(k);
        units.push({ path, kind: "key", text: k });
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        const v = value([...path, k]);
        Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return o;
        }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return a;
      }
      for (;;) {
        a.push(value([...path, a.length]));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return a;
        }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') {
      const s = str();
      units.push({ path, kind: "string", text: s });
      return s;
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(text.slice(i, i + 400));
    if (m === null) fail("an unexpected token");
    const spelled = m![0];
    i += spelled.length;
    units.push({ path, kind: "scalar", text: spelled });
    return spelled === "true" ? true : spelled === "false" ? false : spelled === "null" ? null : Number(spelled);
  };
  const v = value([]);
  ws();
  if (i !== text.length) fail("text after the value");
  return { value: v, units };
}
