// The reader's own check of a press, at its boundary (B22, S1 audit #10). The helper classifies every press
// before it asks (helper/src/executor/risk.ts) and never asks for one it would hand off; this table is the
// last word, asked right before AXPress with the label read from the element itself. A press goes through
// only when the table positively allows it: a control of a pressable role, in a window that is not a system
// prompt, whose whole label is one of `safePresses` and reads as none of the risk classes. Anything else, an
// unknown or translated label and a test fixture's included, is refused. fixtures/golden/press-risk.json
// holds the cases both tables must agree on.
import Foundation

public enum RiskTable {
    /// helper/src/executor/risk.ts RISK_TABLE, word for word: whole words or phrases, matched case-insensitively.
    public static let words: [(risk: String, phrases: [String])] = [
        ("outbound", ["send", "send now", "submit", "post", "publish", "reply all", "share", "invite", "forward"]),
        ("destructive", ["delete", "remove", "erase", "discard", "trash", "move to trash", "empty trash", "clear all", "overwrite", "revoke", "uninstall"]),
        ("money", ["pay", "pay now", "buy", "buy now", "purchase", "checkout", "check out", "place order", "order now", "subscribe", "donate", "transfer", "tip"]),
        ("system", ["allow", "always allow", "allow once", "authorize", "approve", "grant", "grant access", "trust", "install", "open anyway", "unlock"]),
    ]

    /// risk.ts SAFE_PRESSES, word for word: the whole labels of the presses the reader makes. Assumed, not measured.
    public static let safePresses: Set<String> = ["next", "next page", "previous", "previous page", "back", "more", "show more", "load more", "expand", "collapse", "archive", "add note", "save draft"]

    /// Window subroles of system dialogs and floating system panels: every press in one is the user's.
    public static let systemSubroles: Set<String> = ["AXSystemDialog", "AXSystemFloatingWindow"]

    /// risk.ts SYSTEM_PROMPT_APPS: processes that show the system's own prompts (privacy, notifications,
    /// authentication, Gatekeeper, Accessibility). A bundle id equal to one or under it as a prefix.
    public static let systemPromptApps: [String] = [
        "com.apple.UserNotificationCenter",
        "com.apple.SecurityAgent",
        "com.apple.coreservices.uiagent",
        "com.apple.LocalAuthentication.UIAgent",
        "com.apple.accessibility.universalAccessAuthWarn",
    ]

    /// Each phrase as an ICU pattern for a whole word or phrase: no letter or digit on either side, as risk.ts's \p{L}\p{N} classes say.
    private static let patterns: [(risk: String, pattern: String)] = words.flatMap { entry in
        entry.phrases.map { phrase in
            let body = NSRegularExpression.escapedPattern(for: phrase).replacingOccurrences(of: " ", with: "\\s+")
            return (entry.risk, "(^|[^\\p{L}\\p{N}])\(body)($|[^\\p{L}\\p{N}])")
        }
    }

    /// Whether a window, by its subrole and its app's bundle id, is a system prompt.
    public static func isSystemPrompt(windowSubrole: String?, bundleId: String) -> Bool {
        if let s = windowSubrole, systemSubroles.contains(s) { return true }
        return systemPromptApps.contains { bundleId == $0 || bundleId.hasPrefix($0 + ".") }
    }

    /// The press's class as risk.ts classifyPress names it: "system" anywhere in a system prompt, else the first
    /// risk class whose phrase the trimmed label holds, else "safe" when the whole label is a safe press, else
    /// "unclassified".
    public static func classify(label: String, windowSubrole: String?, bundleId: String) -> String {
        if isSystemPrompt(windowSubrole: windowSubrole, bundleId: bundleId) { return "system" }
        let t = label.trimmingCharacters(in: .whitespacesAndNewlines)
        for p in patterns where t.range(of: p.pattern, options: [.regularExpression, .caseInsensitive]) != nil { return p.risk }
        let whole = t.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ").lowercased()
        return safePresses.contains(whole) ? "safe" : "unclassified"
    }

    /// Nil when the reader may press this control; otherwise why not, worded for a verbResult's detail.
    public static func refusal(label: String, role: String, windowSubrole: String?, bundleId: String) -> String? {
        guard Roles.pressable.contains(role) else { return "a \(role) is not a control the reader presses" }
        let t = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return "the control has no label, so its risk cannot be classified" }
        let risk = classify(label: t, windowSubrole: windowSubrole, bundleId: bundleId)
        switch risk {
        case "safe": return nil
        case "system": return "the control is in a permission dialog or system prompt; that press is the user's"
        case "unclassified": return "'\(t.prefix(80))' is not a press the reader knows to be safe; that press is the user's"
        default: return "'\(t.prefix(80))' reads as \(risk); that press is the user's"
        }
    }
}
