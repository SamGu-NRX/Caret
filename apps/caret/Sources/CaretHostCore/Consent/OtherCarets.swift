import Foundation

/// Other apps on this Mac that System Settings also lists as "Caret". Sam's own beta ran 3.5 hours untrusted because
/// the switch he flipped belonged to the hackathon build (dev.caret.hackathon) beside Caret 2, both named Caret in
/// /Applications. Onboarding names the copy that is running, and says plainly when a different one was turned on.
public struct OtherCaret: Equatable, Sendable {
    public var bundleID: String
    public var path: String

    public init(bundleID: String, path: String) {
        self.bundleID = bundleID
        self.path = path
    }

    /// "Caret Hackathon.app in /Applications".
    public var place: String {
        let url = URL(fileURLWithPath: path)
        return "\(url.lastPathComponent) in \(url.deletingLastPathComponent().path)"
    }
}

public enum OtherCarets {
    /// Bundle identifiers of other Caret builds that show up in System Settings as "Caret".
    public static let knownIDs = ["dev.caret.hackathon", "dev.caret.host"]

    /// Every installed copy (`installed`: bundle id and path pairs from LaunchServices) except the one running at
    /// `runningPath`.
    public static func others(installed: [OtherCaret], runningPath: String) -> [OtherCaret] {
        let mine = URL(fileURLWithPath: runningPath).standardizedFileURL.path
        var seen = Set<String>()
        return installed.filter { c in
            let p = URL(fileURLWithPath: c.path).standardizedFileURL.path
            guard p != mine, !seen.contains(p) else { return false }
            seen.insert(p)
            return true
        }
    }

    /// macOS said an entry changed, yet this process is still not trusted, and another Caret is installed: the switch
    /// that was turned on was most likely the other one.
    public static func wrongOneTurnedOn(changeNoticed: Bool, trusted: Bool, others: [OtherCaret]) -> Bool {
        changeNoticed && !trusted && !others.isEmpty
    }
}
