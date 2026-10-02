import AppKit
import ApplicationServices
import CaretHostCore

/// The focused text field as the insertion guard needs it: who it is, its whole value and its
/// selection in UTF-16.
///
/// Both ends of an offer use this one reader: the coordinator when it publishes, and the insertion
/// queue when it rereads after Tab. Using the same reader is what makes the two identities
/// comparable.
struct FieldState: Sendable {
    let identity: TargetIdentity
    let value: String
    let selection: UTF16Selection
    let role: String?
    let secure: Bool

    var liveField: InsertionGuard.LiveField {
        InsertionGuard.LiveField(target: identity, value: value, selection: selection, secure: secure)
    }
}

enum FieldReader {
    private static let secureSubrole = "AXSecureTextField"

    /// Reads the system-wide focused element. Nil when nothing is focused or the element exposes
    /// no string value and selection, which is the guard's "cannot verify" case.
    static func readFocused() -> FieldState? {
        AXRead.focusedElement().flatMap(read)
    }

    static func read(_ element: AXUIElement) -> FieldState? {
        guard let pid = AXRead.pid(of: element),
              let value = AXRead.string(kAXValueAttribute, on: element),
              let range = AXRead.range(kAXSelectedTextRangeAttribute, on: element),
              range.location >= 0, range.length >= 0
        else { return nil }

        let role = AXRead.string(kAXRoleAttribute, on: element)
        let subrole = AXRead.string(kAXSubroleAttribute, on: element)
        let window = AXRead.element(kAXWindowAttribute, on: element)
        let bundleID = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "pid:\(pid)"
        let identity = TargetIdentity(
            pid: pid,
            bundleID: bundleID,
            windowID: window.map(AXRead.token) ?? "none",
            elementID: AXRead.token(element),
            elementRevision: UTF16Text.digest(value)
        )
        return FieldState(
            identity: identity,
            value: value,
            selection: UTF16Selection(start: range.location, end: range.location + range.length),
            role: role,
            secure: subrole == secureSubrole || role == secureSubrole
        )
    }
}
