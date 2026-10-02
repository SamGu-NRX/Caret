// The risk class of a press target, decided by code from its label (deep plan section 5: a Jev
// yes/no on "would this send or delete" scored 0.55 to 0.62 on every case, which is noise).
// A target whose label reads as send, submit, delete or pay is never pressed by the executor:
// the run stops there and the press is handed to the user (fable55 plan section 3, permission table).

export type RiskClass = "outbound" | "destructive" | "money" | "safe";

/** Whole words or phrases, matched case-insensitively against the trimmed label. */
export const RISK_TABLE: Readonly<Record<Exclude<RiskClass, "safe">, readonly string[]>> = {
  outbound: ["send", "send now", "submit", "post", "publish", "reply all", "share", "invite", "forward"],
  destructive: ["delete", "remove", "erase", "discard", "trash", "move to trash", "empty trash", "clear all", "overwrite", "revoke", "uninstall"],
  money: ["pay", "pay now", "buy", "buy now", "purchase", "checkout", "check out", "place order", "order now", "subscribe", "donate", "transfer", "tip"],
};

const PATTERNS: [Exclude<RiskClass, "safe">, RegExp][] = Object.entries(RISK_TABLE).flatMap(([cls, words]) =>
  words.map((w): [Exclude<RiskClass, "safe">, RegExp] => [cls as Exclude<RiskClass, "safe">, new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w)}($|[^\\p{L}\\p{N}])`, "iu")]),
);

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
}

/** The first risk class whose word or phrase appears in the label, or "safe". */
export function classifyLabel(label: string): RiskClass {
  const t = label.trim();
  for (const [cls, re] of PATTERNS) if (re.test(t)) return cls;
  return "safe";
}
