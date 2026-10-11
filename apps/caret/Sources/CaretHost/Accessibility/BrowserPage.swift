import AppKit
import ApplicationServices
import CaretHostCore

/// The page in front, as Chrome's Accessibility tree names it, for What Caret knows' "The page you
/// were on" (H5). Read once, when the window opens, while the browser is still the front app.
@MainActor
enum BrowserPage {
    /// Elements visited looking for the web area, and how long that may take on the main thread.
    /// Assumed, not measured: Chrome's AXWebArea sits a few levels under the window, after the tab
    /// strip and toolbar, so a breadth-first walk reaches it well within either bound.
    static let maxElements = 300
    static let budget: TimeInterval = 0.2

    /// The origin of the front Chrome window's page, from its web area's AXURL; nil when the front
    /// app is not Chrome, the page is not http or https, or nothing is found within the bounds.
    static func frontOrigin() -> String? {
        guard let app = NSWorkspace.shared.frontmostApplication, let id = app.bundleIdentifier, PageSight.isChrome(bundleID: id),
              let window = AXRead.element(kAXFocusedWindowAttribute, on: AXUIElementCreateApplication(app.processIdentifier)) else { return nil }
        let deadline = Date().addingTimeInterval(budget)
        var queue = [window]
        var visited = 0
        while !queue.isEmpty, visited < maxElements, Date() < deadline {
            let element = queue.removeFirst()
            visited += 1
            if AXRead.string(kAXRoleAttribute, on: element) == "AXWebArea" {
                var value: CFTypeRef?
                guard AXUIElementCopyAttributeValue(element, kAXURLAttribute as CFString, &value) == .success, let url = value as? URL else { return nil }
                return SiteOrigin.of(url)
            }
            queue += AXRead.elements(kAXChildrenAttribute, on: element)
        }
        return nil
    }
}
