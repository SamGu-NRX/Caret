// The risk class of a press target, decided by code from its label (deep plan section 5: a Jev
// yes/no on "would this send or delete" scored 0.55 to 0.62 on every case, which is noise).
// A target whose label reads as send, submit, delete or pay is never pressed by the executor:
// the run stops there and the press is handed to the user (fable55 plan section 3, permission table).
// `system` (B22, S1 audit #10): a permission dialog or system prompt, found by the window's subrole and
// the process that shows it, not only by English words: "Allow" in a privacy prompt grants an app access
// to the user's data, whatever it is called in their language. A press is `safe` only when its whole label is
// one of SAFE_PRESSES; any other label is `unclassified`, and Caret leaves that press to the user too (B22
// review: "Transmit" or "Enviar" matches no risk word, which is no evidence it is safe). The reader keeps the
// same table (CaretScreenCore/RiskTable.swift) and refuses at its own boundary any press it does not
// positively allow; fixtures/golden/press-risk.json is the cases both sides must agree on.

export type RiskClass = "outbound" | "destructive" | "money" | "system" | "safe";

/** Whole words or phrases, matched case-insensitively against the trimmed label. */
export const RISK_TABLE: Readonly<Record<Exclude<RiskClass, "safe">, readonly string[]>> = {
  outbound: ["send", "send now", "submit", "post", "publish", "reply all", "share", "invite", "forward"],
  destructive: ["delete", "remove", "erase", "discard", "trash", "move to trash", "empty trash", "clear all", "overwrite", "revoke", "uninstall"],
  money: ["pay", "pay now", "buy", "buy now", "purchase", "checkout", "check out", "place order", "order now", "subscribe", "donate", "transfer", "tip"],
  // What permission and security prompts press: grant access, trust or install something, or open what the system blocked.
  system: ["allow", "always allow", "allow once", "authorize", "approve", "grant", "grant access", "trust", "install", "open anyway", "unlock"],
};

/**
 * The presses Caret may make: reversible navigation and annotation, each the control's whole label. Assumed, not
 * measured: the labels the executor's own plans press (executor-eval, real-target-eval: Next page, Archive, Add
 * note) and their plain neighbours. The generated planner and routines hand every press to the user.
 */
export const SAFE_PRESSES: readonly string[] = ["next", "next page", "previous", "previous page", "back", "more", "show more", "load more", "expand", "collapse", "archive", "add note", "save draft"];

/**
 * Window subroles of system dialogs and floating system panels (AXSystemDialog, AXSystemFloatingWindow), as
 * the reader's window kind spells them (ElementKey.windowKind: the subrole without "AX" and "window",
 * lowercased, then any identifier in brackets).
 */
export const SYSTEM_WINDOW_KINDS: readonly string[] = ["systemdialog", "systemfloating"];

/**
 * Processes that show the system's own prompts: privacy (TCC) and notification permission requests,
 * authentication, Gatekeeper, and Accessibility access. Any press in their windows is a system prompt.
 */
export const SYSTEM_PROMPT_APPS: readonly string[] = [
  "com.apple.UserNotificationCenter",
  "com.apple.SecurityAgent",
  "com.apple.coreservices.uiagent",
  "com.apple.LocalAuthentication.UIAgent",
  "com.apple.accessibility.universalAccessAuthWarn",
];

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

/** Whether a window, by its kind (subrole) and its app's bundle id, is a system prompt. */
export function isSystemPrompt(windowKind: string, bundleId: string): boolean {
  const kind = windowKind.replace(/\[.*$/, "");
  return SYSTEM_WINDOW_KINDS.includes(kind) || SYSTEM_PROMPT_APPS.some((b) => bundleId === b || bundleId.startsWith(`${b}.`));
}

/**
 * A press's class: `system` anywhere in a system prompt, whatever the button says; a risk class its label reads
 * as; `safe` only when the whole label is one of SAFE_PRESSES; otherwise `unclassified`.
 */
export function classifyPress(p: { label: string; windowKind: string; bundleId: string }): RiskClass | "unclassified" {
  if (isSystemPrompt(p.windowKind, p.bundleId)) return "system";
  const risk = classifyLabel(p.label);
  if (risk !== "safe") return risk;
  return SAFE_PRESSES.includes(p.label.trim().replace(/\s+/g, " ").toLowerCase()) ? "safe" : "unclassified";
}
