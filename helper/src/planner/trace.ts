// Where a planned value came from. A plan may write only text the user can already see or already
// said: a window's text, a memory entry, or the instruction itself, each copied verbatim. Code finds
// the source; nothing derived (a reformatted date, a sum, a guess) traces, so it is refused.
import { nodeText, type ScreenModel } from "../model.ts";
import { flat } from "../privacy.ts";
import { splitName } from "../fill/derive.ts";

/** A memory entry's value as the planner may use it: an About value or a person's name. */
export interface MemoryValue {
  id: string;
  /** What the entry is, as the user named it ("Work email", or a person's alias). */
  label: string;
  text: string;
}

export type Trace =
  | { from: "window"; windowId: string; nodeKey: string | null }
  | { from: "memory"; id: string }
  | { from: "instruction" };

const WORD = /[\p{L}\p{N}]/u;

/**
 * Whether `needle` appears in `hay` as whole words: a needle that starts with a letter or digit does
 * not start inside a word, and one that ends with one does not end inside a word. "Dana" is in
 * "Dana Whitfield" but not in "Danae"; "$1,315.50" is in "Total: $1,315.50".
 */
export function occursBounded(hay: string, needle: string): boolean {
  if (needle === "") return false;
  const startsWord = WORD.test(needle[0] as string);
  const endsWord = WORD.test(needle.at(-1) as string);
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = i === 0 ? "" : (hay[i - 1] as string);
    const after = hay[i + needle.length] ?? "";
    if (startsWord && before !== "" && WORD.test(before)) continue;
    if (endsWord && after !== "" && WORD.test(after)) continue;
    return true;
  }
  return false;
}

/**
 * The first source that shows `value` verbatim (whitespace runs collapsed on both sides): a line of
 * a window's text or its title, then a memory value, then the instruction. Windows come first so a
 * plan's sources record the window it charges (Plan.sources). A secure field's text is never a
 * source. Null when nothing shows it, and for an empty value, which would clear a field.
 */
export function traceValue(value: string, model: ScreenModel, memory: readonly MemoryValue[], instruction: string): Trace | null {
  const v = flat(value);
  if (v === "") return null;
  for (const w of model.windows.values()) {
    if (occursBounded(flat(w.window.title), v)) return { from: "window", windowId: w.window.windowId, nodeKey: null };
    for (const n of w.nodes.values()) {
      if (n.states?.includes("secure")) continue;
      for (const line of nodeText(n).split("\n")) {
        if (occursBounded(flat(line), v)) return { from: "window", windowId: w.window.windowId, nodeKey: n.key };
      }
    }
  }
  for (const m of memory) if (flat(m.text) === v) return { from: "memory", id: m.id };
  // A first, middle or last name code split from a remembered name (fill/derive.ts, B24): "Riley" for First
  // name from Name "Riley Okafor". Only those parts, never another substring of a memory value.
  for (const m of memory) {
    const s = splitName(flat(m.text));
    if (s.kind === "split" && [s.first, s.middle, s.last].includes(v)) return { from: "memory", id: m.id };
  }
  if (occursBounded(flat(instruction), v)) return { from: "instruction" };
  return null;
}
