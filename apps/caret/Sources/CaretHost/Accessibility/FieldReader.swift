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

    private static func value(of element: AXUIElement) -> String? {
        var raw: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &raw)
        let string = error == .success ? ((raw as? String) ?? (raw as? NSAttributedString)?.string) : nil
        let count = error == .noValue ? AXRead.int("AXNumberOfCharacters", on: element) : nil
        return emptyOrValue(string, error: error, characterCount: count)
    }

    /// The value as read, or "" for an empty Mac Catalyst text view: with no text it answers AXValue
    /// with `kAXErrorNoValue` while its AXNumberOfCharacters is 0 (the VM's CatFix UITextView, run
    /// 20261009T103304Z-38308; with text it returns the string). Any other missing value is unreadable.
    static func emptyOrValue(_ string: String?, error: AXError, characterCount: Int?) -> String? {
        if let string { return string }
        return error == .noValue && characterCount == 0 ? "" : nil
    }

    /// Reads the system-wide focused element. Nil when nothing is focused or the element exposes
    /// no string value and selection, which is the guard's "cannot verify" case.
    static func readFocused() -> FieldState? {
        AXRead.focusedElement().flatMap(read)
    }

    /// The focused field of one app. The insertion queue rereads an offer's target through this,
    /// so a Tab can only ever write into the app the offer was made for.
    static func readFocused(pid: pid_t) -> (element: AXUIElement, field: FieldState)? {
        guard let element = AXRead.focusedElement(pid: pid), let field = read(element), field.identity.pid == pid else { return nil }
        return (element, field)
    }

    static func read(_ element: AXUIElement) -> FieldState? {
        guard let pid = AXRead.pid(of: element),
              let value = value(of: element),
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
