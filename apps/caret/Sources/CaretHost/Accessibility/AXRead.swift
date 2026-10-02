import AppKit
import ApplicationServices

/// Small typed wrappers over `AXUIElementCopyAttributeValue`. KeyType's own helper
/// (`AXCaretHelper`) is internal to MacContextCapture, so the host keeps the handful it needs.
///
/// These calls are safe from any thread. The tap thread never calls them.
enum AXRead {
    /// Bounds every AX call this process makes, so an unresponsive app cannot stall the main
    /// thread or the insertion queue. Setting it on the system-wide element sets the default.
    static func setGlobalMessagingTimeout(seconds: Float) {
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), seconds)
    }

    static func focusedElement() -> AXUIElement? {
        element(kAXFocusedUIElementAttribute, on: AXUIElementCreateSystemWide())
    }

    static func pid(of element: AXUIElement) -> pid_t? {
        var pid: pid_t = 0
        return AXUIElementGetPid(element, &pid) == .success ? pid : nil
    }

    static func element(_ attribute: String, on element: AXUIElement) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    static func string(_ attribute: String, on element: AXUIElement) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success, let value
        else { return nil }
        if let string = value as? String { return string }
        if let attributed = value as? NSAttributedString { return attributed.string }
        return nil
    }

    static func range(_ attribute: String, on element: AXUIElement) -> CFRange? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        let axValue = unsafeBitCast(value, to: AXValue.self)
        var range = CFRange()
        guard AXValueGetType(axValue) == .cfRange, AXValueGetValue(axValue, .cfRange, &range) else { return nil }
        return range
    }

    /// A stable token for an element: equal elements hash equal (CF contract), and re-reading the
    /// focused element returns an equal element while focus stays put.
    static func token(_ element: AXUIElement) -> String {
        String(CFHash(element), radix: 16)
    }
}
