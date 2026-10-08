// Value settlement (design/ask/VALUE-SETTLEMENT.md): an Ask's value question lists exact proposed outputs, one option
// each. Two candidates that convert to the same output for a field (a whole date and the month split from it, both
// selecting "April") are one option only when nothing could tell them apart: the same output bytes, the same source
// evidence unit, where the value came from, the label it was read beside, its owner and every assumption code made.
// There is no fuzzy or semantic matching: "Apt 2" and "apt 2" stay two options. Pure.

/** One candidate's proposed output for one field, with what makes it this candidate. */
export interface OptionMember {
  /** The candidate's option id in the first wording (c3, m1, d2). */
  id: string;
  /** Exactly what the field would hold. */
  output: string;
  /** The source evidence unit: a window unit (note-unit.ts unitKey), a memory entry's id, or the instruction. */
  evidence: string;
  origin: "window" | "memory" | "instruction";
  /** The label the value was read beside, or null. */
  label: string | null;
  /** Whose both owner answers say it is, or null when unsettled or not asked. */
  owner: string | null;
  /** Every choice code made deriving the output (Provenance says), in order. */
  assumptions: readonly string[];
  /** Whether the output needs the verifier (no exemption mints it). */
  verifier: boolean;
}

/** One option: its id is its first member's, and every member stays, so each keeps its own provenance and rechecks. */
export interface ValueOption<M extends OptionMember = OptionMember> {
  id: string;
  output: string;
  members: readonly M[];
  /** The strictest obligation of its members: any member that needs the verifier makes the option need it. */
  verifier: boolean;
}

/** Groups `members` into options, in the order each option's first member comes. */
export function groupOptions<M extends OptionMember>(members: readonly M[]): ValueOption<M>[] {
  const byKey = new Map<string, M[]>();
  for (const m of members) {
    const key = JSON.stringify([m.output, m.evidence, m.origin, m.label, m.owner, m.assumptions]);
    const group = byKey.get(key);
    if (group === undefined) byKey.set(key, [m]);
    else group.push(m);
  }
  return [...byKey.values()].map((ms) => {
    const first = ms[0] as M;
    return { id: first.id, output: first.output, members: ms, verifier: ms.some((m) => m.verifier) };
  });
}
