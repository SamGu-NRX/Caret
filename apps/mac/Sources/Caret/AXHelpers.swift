import ApplicationServices
import AppKit

enum AXHelpers {
    static func stringValue(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(element, attribute, &value)
        guard result == .success, let value else { return nil }
        return value as? String
    }

    static func hasAttribute(_ element: AXUIElement, _ attribute: CFString) -> Bool {
        var names: CFArray?
        guard AXUIElementCopyAttributeNames(element, &names) == .success,
              let names = names as? [String]
        else { return false }
        return names.contains(attribute as String)
    }

    static func focusedElement(in app: NSRunningApplication) -> AXUIElement? {
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        if let focused = copyElement(appElement, kAXFocusedUIElementAttribute as CFString) {
            return focused
        }
        let system = AXUIElementCreateSystemWide()
        if let focused = copyElement(system, kAXFocusedUIElementAttribute as CFString) {
            return focused
        }
        return copyElement(appElement, kAXFocusedWindowAttribute as CFString)
    }

    static func copyElement(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success,
              let value
        else { return nil }
        return (value as! AXUIElement)
    }

    static func frame(_ element: AXUIElement) -> CGRect? {
        var posRef: CFTypeRef?
        var sizeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
              AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
              let posRef, let sizeRef
        else { return nil }

        var position = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(posRef as! AXValue, .cgPoint, &position),
              AXValueGetValue(sizeRef as! AXValue, .cgSize, &size)
        else { return nil }

        return cocoaRect(fromAX: CGRect(origin: position, size: size))
    }

    static func selectedTextBounds(_ element: AXUIElement) -> CGRect? {
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &rangeRef) == .success,
              let rangeRef
        else { return nil }

        var boundsRef: CFTypeRef?
        let result = AXUIElementCopyParameterizedAttributeValue(
            element,
            kAXBoundsForRangeParameterizedAttribute as CFString,
            rangeRef,
            &boundsRef
        )
        guard result == .success, let boundsRef else { return nil }

        var rect = CGRect.zero
        guard AXValueGetValue(boundsRef as! AXValue, .cgRect, &rect) else { return nil }
        guard rect.width > 0 || rect.height > 0 else { return nil }
        return cocoaRect(fromAX: rect)
    }

    static func cocoaRect(fromAX axRect: CGRect) -> CGRect {
        let primaryHeight = NSScreen.screens.first(where: { $0.frame.origin == .zero })?.frame.height
            ?? NSScreen.main?.frame.height
            ?? 0
        return CGRect(
            x: axRect.origin.x,
            y: primaryHeight - axRect.origin.y - axRect.height,
            width: axRect.width,
            height: axRect.height
        )
    }

    static func clamp(_ rect: CGRect, to visible: CGRect) -> CGRect {
        var result = rect
        if result.maxX > visible.maxX { result.origin.x = visible.maxX - result.width - 4 }
        if result.minX < visible.minX { result.origin.x = visible.minX + 4 }
        if result.maxY > visible.maxY { result.origin.y = visible.maxY - result.height - 4 }
        if result.minY < visible.minY { result.origin.y = visible.minY + 4 }
        return result
    }

    static func screen(containing point: CGPoint) -> NSScreen? {
        NSScreen.screens.first { $0.frame.contains(point) } ?? NSScreen.main
    }

    static func isTrusted() -> Bool {
        AccessibilityTrust.isTrusted()
    }

    static func openAccessibilitySettings() {
        AccessibilityTrust.openSettings()
    }
}
