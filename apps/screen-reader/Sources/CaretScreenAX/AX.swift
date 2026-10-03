// Small wrappers over the Accessibility C API. Nothing here keeps state.
import ApplicationServices
import CaretScreenCore
import Foundation

/// An AXUIElement usable as a dictionary key and across queues. Equality is CFEqual, which is
/// identity of the remote element, so a later notification naming the same element finds it.
public struct AXRef: Hashable, @unchecked Sendable {
    public let el: AXUIElement
    public init(_ el: AXUIElement) { self.el = el }
    public static func == (a: AXRef, b: AXRef) -> Bool { CFEqual(a.el, b.el) }
    public func hash(into h: inout Hasher) { h.combine(CFHash(el)) }
}

public enum AX {
    /// How long one Accessibility message to an app may block before it fails. Set on every element
    /// the walker touches, so one hung app costs at most this per element and the walk deadline caps the total.
    public static let elementTimeout: Float = 0.25

    public static func copy(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
    }

    public static func string(_ e: AXUIElement, _ name: String) -> String? { copy(e, name) as? String }

    /// True for a password field, by role or subrole. Apps differ in which of the two they set.
    public static func isSecure(role: String?, subrole: String?) -> Bool {
        role == "AXSecureTextField" || subrole == "AXSecureTextField"
    }

    public static func isSecure(_ e: AXUIElement) -> Bool {
        isSecure(role: string(e, kAXRoleAttribute), subrole: string(e, kAXSubroleAttribute))
    }

    /// The element's string value, never requested for a secure field. Every value read outside the
    /// walker's batch goes through here; the walker applies the same test to the role and subrole it already has.
    public static func valueUnlessSecure(_ e: AXUIElement) -> String? {
        isSecure(e) ? nil : string(e, kAXValueAttribute)
    }

    /// An attribute read that tells "the element has no such value" apart from "the read failed".
    /// The executor's rechecks use it so an unreadable field is never treated as empty or not secure.
    public enum Read {
        case value(CFTypeRef)
        case absent
        case failed(AXError)
    }

    public static func read(_ e: AXUIElement, _ name: String) -> Read {
        var v: CFTypeRef?
        let err = AXUIElementCopyAttributeValue(e, name as CFString, &v)
        switch err {
        case .success: return v.map(Read.value) ?? .absent
        case .noValue, .attributeUnsupported: return .absent
        default: return .failed(err)
        }
    }

    public static func element(_ e: AXUIElement, _ name: String) -> AXUIElement? {
        guard let v = copy(e, name), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return (v as! AXUIElement)
    }

    public static func elements(_ e: AXUIElement, _ name: String) -> [AXUIElement]? {
        copy(e, name) as? [AXUIElement]
    }

    /// One round trip for several attributes. A failed attribute comes back as nil in its slot.
    public static func batch(_ e: AXUIElement, _ names: [String]) -> [CFTypeRef?]? {
        var out: CFArray?
        let err = AXUIElementCopyMultipleAttributeValues(e, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &out)
        guard err == .success, let arr = out as [AnyObject]?, arr.count == names.count else { return nil }
        return arr.map { isError($0) ? nil : ($0 as CFTypeRef) }
    }

    static func isError(_ v: AnyObject) -> Bool {
        CFGetTypeID(v) == AXValueGetTypeID() && AXValueGetType(v as! AXValue) == .axError
    }

    public static func point(_ v: CFTypeRef?) -> CGPoint? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        return AXValueGetValue(v as! AXValue, .cgPoint, &p) ? p : nil
    }

    public static func size(_ v: CFTypeRef?) -> CGSize? {
        guard let v, CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
        var s = CGSize.zero
        return AXValueGetValue(v as! AXValue, .cgSize, &s) ? s : nil
    }

    public static func frame(_ posValue: CFTypeRef?, _ sizeValue: CFTypeRef?) -> Frame? {
        guard let p = point(posValue), let s = size(sizeValue) else { return nil }
        return Frame(x: p.x.rounded(), y: p.y.rounded(), width: s.width.rounded(), height: s.height.rounded())
    }

    public static func frame(of e: AXUIElement) -> Frame? {
        frame(copy(e, kAXPositionAttribute), copy(e, kAXSizeAttribute))
    }

    /// The window server's number for a window element (its CGWindowID), or nil when the app does not
    /// give one. There is no public call for this; `_AXUIElementGetWindow` is the private one window
    /// managers use, and it only reads.
    public static func windowNumber(of e: AXUIElement) -> Int? {
        var id: CGWindowID = 0
        guard _AXUIElementGetWindow(e, &id) == .success, id != 0 else { return nil }
        return Int(id)
    }
}

@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

public func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
