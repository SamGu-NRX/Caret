import AppKit
import ApplicationServices
import CaretHostCore
import CaretScreenCore

/// H10: the page field the user is in, for every reader of focus in the host (fill, the surfaces, `Visibility`), as
/// the helper's page engine last said (`PageField`). Chrome shows Accessibility no web content and no focused element
/// while a page field has focus (evidence/host/h10/probe), so this is the only way the host knows it.
@MainActor
enum PageFocusSource {
    static let book = PageFocusBook()

    /// The page field with focus in browser `pid`, while the page has the browser's focus. When Accessibility names a
    /// focused element outside any web area, the user is in the browser's own toolbar (its address bar, a menu), and
    /// the page's last focused field is not where typing goes.
    static func current(pid: Int32) -> PageField? {
        guard let field = book.field(pid: pid) else { return nil }
        if let element = AXRead.focusedElement(pid: pid), !inWebArea(element) { return nil }
        return field
    }

    /// Whether an AXWebArea is among the element's ancestors (or is the element): web content, which Chrome exposes only
    /// when some assistive app turned its accessibility on. At most 40 parents.
    static func inWebArea(_ element: AXUIElement) -> Bool {
        var e: AXUIElement? = element
        for _ in 0..<40 {
            guard let cur = e else { return false }
            switch AXRead.string(kAXRoleAttribute, on: cur) {
            case "AXWebArea"?: return true
            case kAXWindowRole?: return false
            default: e = AXRead.element(kAXParentAttribute, on: cur)
            }
        }
        return false
    }
}
