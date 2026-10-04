import Foundation

/// Other apps that take Tab for completions of their own.
///
/// Q1 (A18, bugs 17 and 18) saw one word go in per Tab while the host's `tap.consumed` and
/// `offers.claimed` stayed at 0: Caret never took those Tabs. Cotypist was running on that Mac, and
/// its `CompletionManager_acceptPartialCompletionShortcut` default is key code 48 with no
/// modifiers, which is Tab taking one word (read from its defaults on 2026-10-04). The debug state
/// lists such apps so a run can tell their Tab from Caret's.
public enum OtherTabOwners {
    /// Bundle ids known to accept their own completions with Tab.
    public static let bundleIDs: [String: String] = [
        "app.cotypist.Cotypist": "Cotypist",
    ]

    /// The known Tab owners among `running` bundle ids, by name, sorted.
    public static func running(in running: [String]) -> [String] {
        Set(running.compactMap { bundleIDs[$0] }).sorted()
    }

    /// The one line onboarding's try-it step and the menu show while such an app runs (`running`'s
    /// names), or nil when none does. It names the app and what to do; Caret never touches the
    /// other app itself.
    public static func notice(_ names: [String]) -> String? {
        switch names.count {
        case 0: return nil
        case 1: return "\(names[0]) also uses Tab. Quit it or change its shortcut so Tab reaches Caret."
        default:
            let list = names.dropLast().joined(separator: ", ") + " and " + names.last!
            return "\(list) also use Tab. Quit them or change their shortcuts so Tab reaches Caret."
        }
    }
}
