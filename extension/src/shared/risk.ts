// Which presses the extension makes, from the name the user sees. The same table as the helper's
// (helper/src/executor/risk.ts RISK_TABLE and SAFE_PRESSES) and the reader's, checked against the shared cases in
// helper/fixtures/golden/press-risk.json (test/risk.test.ts). A press is made only when the whole visible name is
// on the safe list and reads as no risk class; everything else is handed to the user. Pages add one rule of their
// own: a control that submits a form is a hand-off whatever it is called (memo lead decision: any button that sends
// data to the site stays a hand-off in v1).

export type RiskClass = "outbound" | "destructive" | "money" | "system";

export const RISK_TABLE: Readonly<Record<RiskClass, readonly string[]>> = {
  outbound: ["send", "send now", "submit", "post", "publish", "reply all", "share", "invite", "forward"],
  destructive: ["delete", "remove", "erase", "discard", "trash", "move to trash", "empty trash", "clear all", "overwrite", "revoke", "uninstall"],
  money: ["pay", "pay now", "buy", "buy now", "purchase", "checkout", "check out", "place order", "order now", "subscribe", "donate", "transfer", "tip"],
  system: ["allow", "always allow", "allow once", "authorize", "approve", "grant", "grant access", "trust", "install", "open anyway", "unlock"],
};

export const SAFE_PRESSES: readonly string[] = ["next", "next page", "previous", "previous page", "back", "more", "show more", "load more", "expand", "collapse", "archive", "add note", "save draft"];

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
const PATTERNS: [RiskClass, RegExp][] = (Object.entries(RISK_TABLE) as [RiskClass, readonly string[]][]).flatMap(([cls, words]) =>
  words.map((w): [RiskClass, RegExp] => [cls, new RegExp(`(^|[^\\p{L}\\p{N}])${escape(w)}($|[^\\p{L}\\p{N}])`, "iu")]),
);

/** A press's class from its visible name: a risk class, `safe` only for a whole safe-list name, else `unclassified`. */
export function classifyPress(name: string): RiskClass | "safe" | "unclassified" {
  const t = name.trim();
  for (const [cls, re] of PATTERNS) if (re.test(t)) return cls;
  return SAFE_PRESSES.includes(t.replace(/\s+/g, " ").toLowerCase()) ? "safe" : "unclassified";
}
