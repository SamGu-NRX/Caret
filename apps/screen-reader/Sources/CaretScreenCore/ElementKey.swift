// Caret's own element key. Only 1.8% of nodes carry an AXIdentifier and keys built from tree
// position changed between two walks 15 s apart (deep plan section 2), so a key is built from
// what a person would use to point at the element:
//
//   <app>/<window kind>/<named ancestor>/.../<role>:<normalized label>~<ordinal>
//
// Unnamed containers do not appear, so wrapping an element in another unnamed group keeps its key.
// The ordinal counts earlier elements with the same role and label under the same named ancestors.
import Foundation

public enum ElementKey {
    /// Labels longer than this are cut. Long labels are content, and the prefix is enough to tell siblings apart.
    public static let maxLabel = 40

    /// Lowercased, digit runs replaced by "#", whitespace collapsed, trailing colon dropped, cut to `maxLabel`.
    /// Digit runs are masked so counters and dates ("3 unread", "Inbox (12)") do not move the key.
    public static func normalizeLabel(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(min(s.count, maxLabel))
        var lastSpace = true
        var lastDigit = false
        for ch in s.precomposedStringWithCompatibilityMapping.lowercased() {
            if ch.isNumber {
                if !lastDigit { out.append("#") }
                lastDigit = true; lastSpace = false
                continue
            }
            lastDigit = false
            if ch.isWhitespace || ch == "/" || ch == "~" {
                if !lastSpace { out.append(" ") }
                lastSpace = true
                continue
            }
            out.append(ch)
            lastSpace = false
            if out.count >= maxLabel + 1 { break }
        }
        var t = out.trimmingCharacters(in: .whitespaces)
        while t.hasSuffix(":") { t.removeLast(); t = t.trimmingCharacters(in: .whitespaces) }
        if t.count > maxLabel { t = String(t.prefix(maxLabel)).trimmingCharacters(in: .whitespaces) }
        return t
    }

    /// "AXTextField" becomes "textfield".
    public static func shortRole(_ role: String) -> String {
        (role.hasPrefix("AX") ? String(role.dropFirst(2)) : role).lowercased()
    }

    public static func segment(role: String, label: String) -> String {
        "\(shortRole(role)):\(normalizeLabel(label))"
    }

    /// The window part of every key: subrole plus the window's normalized AXIdentifier when it has one.
    public static func windowKind(subrole: String?, identifier: String?) -> String {
        let sub = shortRole(subrole ?? "AXStandardWindow").replacingOccurrences(of: "window", with: "")
        let base = sub.isEmpty ? "standard" : sub
        guard let id = identifier, !id.isEmpty else { return base }
        return "\(base)[\(normalizeLabel(id))]"
    }

    /// The bundle identifier, or a stand-in for processes without one.
    public static func appPart(bundleId: String?, name: String?) -> String {
        if let b = bundleId, !b.isEmpty { return b }
        return "unbundled.\(normalizeLabel(name ?? "unknown").replacingOccurrences(of: " ", with: "-"))"
    }
}
