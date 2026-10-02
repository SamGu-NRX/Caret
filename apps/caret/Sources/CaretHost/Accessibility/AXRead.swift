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

    /// The focused element of one app, whether or not it is frontmost. Every read that leads to a
    /// write goes through this, so the write's target is the app the offer was made for and never
    /// whichever app happens to be in front.
    static func focusedElement(pid: pid_t) -> AXUIElement? {
        element(kAXFocusedUIElementAttribute, on: AXUIElementCreateApplication(pid))
    }

    static func elements(_ attribute: String, on element: AXUIElement) -> [AXUIElement] {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let array = value as? [AnyObject]
        else { return [] }
        return array.compactMap { item in
            CFGetTypeID(item) == AXUIElementGetTypeID() ? unsafeBitCast(item, to: AXUIElement.self) : nil
        }
    }

    /// Position and size in global top-left-origin points, as the reader reports frames.
    static func frame(of element: AXUIElement) -> CGRect? {
        guard let origin = axValue(kAXPositionAttribute, on: element, type: .cgPoint, as: CGPoint.self),
              let size = axValue(kAXSizeAttribute, on: element, type: .cgSize, as: CGSize.self)
        else { return nil }
        return CGRect(origin: origin, size: size)
    }

    private static func axValue<T>(_ attribute: String, on element: AXUIElement, type: AXValueType, as: T.Type) -> T? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXValueGetTypeID()
        else { return nil }
        let axValue = unsafeBitCast(value, to: AXValue.self)
        guard AXValueGetType(axValue) == type else { return nil }
        let pointer = UnsafeMutablePointer<T>.allocate(capacity: 1)
        defer { pointer.deallocate() }
        return AXValueGetValue(axValue, type, pointer) ? pointer.pointee : nil
    }

    @discardableResult
    static func setString(_ attribute: String, _ string: String, on element: AXUIElement) -> AXError {
        AXUIElementSetAttributeValue(element, attribute as CFString, string as CFString)
    }

    @discardableResult
    static func setRange(_ attribute: String, location: Int, length: Int, on element: AXUIElement) -> AXError {
        var range = CFRange(location: location, length: length)
        guard let value = AXValueCreate(.cfRange, &range) else { return .failure }
        return AXUIElementSetAttributeValue(element, attribute as CFString, value)
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
