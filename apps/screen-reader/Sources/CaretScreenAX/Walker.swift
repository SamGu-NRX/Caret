// Reads a window (or one subtree) into RawNodes. One batched message per element, plus one for the
// value of text-bearing roles, so a secure field's value is never requested at all. Tables and
// outlines are walked by their visible rows only. The walk stops at its deadline or node budget and
// says so in `truncated`.
import ApplicationServices
import CaretScreenCore
import Foundation

public struct WalkLimits: Sendable {
    public var deadline: TimeInterval
    public var maxVisited: Int
    public var maxDepth: Int
    public var maxChildren: Int
    public var maxValueChars: Int

    /// Focused-window walks measured about 100 ms for 2,700 nodes (deep plan section 2); 400 ms leaves room under load.
    public static let focused = WalkLimits(deadline: 0.4, maxVisited: 6000, maxDepth: 64, maxChildren: 400, maxValueChars: 20_000)
    /// Background walks may take longer, but a 4 s cap was hit on long tables in the probe, so stop well before that.
    public static let background = WalkLimits(deadline: 1.0, maxVisited: 6000, maxDepth: 64, maxChildren: 400, maxValueChars: 20_000)
    /// Walks for the executor, which needs a complete read to judge an act and waits for it anyway.
    /// One focused-limit walk in about 80 was cut short on a loaded Mac; 2 s is assumed, not measured.
    public static let request = WalkLimits(deadline: 2.0, maxVisited: 6000, maxDepth: 64, maxChildren: 400, maxValueChars: 20_000)
}

public final class Walker {
    public private(set) var elements: [AXUIElement] = []
    public private(set) var visited = 0
    public private(set) var truncated = false
    /// True when a child list or the depth limit cut part of the tree without the deadline or budget
    /// running out. Background walks accept that; the executor's walks refuse to judge a clipped tree.
    public private(set) var clipped = false
    private let limits: WalkLimits
    private let focused: AXUIElement?
    private let start = CFAbsoluteTimeGetCurrent()

    private static let batchNames: [String] = [
        kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue",
        kAXEnabledAttribute, kAXSelectedAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXChildrenAttribute,
    ]
    private static let rowContainers: Set<String> = ["AXTable", "AXOutline"]
    private static let visibleChildContainers: Set<String> = ["AXList", "AXBrowser", "AXGrid"]

    public init(limits: WalkLimits, focused: AXUIElement?) {
        self.limits = limits
        self.focused = focused
    }

    public var elapsedMs: Double { (CFAbsoluteTimeGetCurrent() - start) * 1000 }

    public func readChildren(of window: AXUIElement) -> [RawNode] {
        AXUIElementSetMessagingTimeout(window, AX.elementTimeout)
        guard let kids = AX.elements(window, kAXChildrenAttribute) else { return [] }
        if kids.count > limits.maxChildren { clipped = true }
        return kids.prefix(limits.maxChildren).compactMap { read($0, depth: 1, parentRole: nil) }
    }

    public func readSubtree(_ e: AXUIElement) -> RawNode? { read(e, depth: 1, parentRole: nil) }

    private func read(_ e: AXUIElement, depth: Int, parentRole: String?) -> RawNode? {
        if visited >= limits.maxVisited || CFAbsoluteTimeGetCurrent() - start > limits.deadline {
            truncated = true
            return nil
        }
        visited += 1
        AXUIElementSetMessagingTimeout(e, AX.elementTimeout)
        guard let a = AX.batch(e, Self.batchNames), let role = a[0] as? String else { return nil }
        let subrole = a[1] as? String
        let secure = AX.isSecure(role: role, subrole: subrole)
        var node = RawNode(role: role, subrole: subrole, title: a[2] as? String, description: a[3] as? String,
                           placeholder: a[4] as? String, frame: AX.frame(a[7], a[8]),
                           enabled: (a[5] as? Bool) ?? true, selected: (a[6] as? Bool) ?? false, secure: secure)
        if let f = focused, CFEqual(f, e) { node.focused = true }

        if Roles.valueBearing.contains(role) && !secure, let v = AX.copy(e, kAXValueAttribute) {
            if let s = v as? String {
                node.value = s.count > limits.maxValueChars ? String(s.prefix(limits.maxValueChars)) : s
            } else if let n = v as? NSNumber, role == "AXCheckBox" || role == "AXRadioButton" {
                node.checked = n.intValue == 1
            }
        }
        if Roles.editable.contains(role), (node.title ?? "").isEmpty, (node.description ?? "").isEmpty,
           let te = AX.element(e, kAXTitleUIElementAttribute) {
            AXUIElementSetMessagingTimeout(te, AX.elementTimeout)
            node.titleElementText = AX.valueUnlessSecure(te) ?? AX.string(te, kAXTitleAttribute)
        }

        node.handle = elements.count
        elements.append(e)

        // V4: a pop-up button's own menu is read for its items, the button's options (Roles.popUpMenu); other menus are not.
        if secure || (Roles.skipped.contains(role) && !Roles.popUpMenu(role, parentRole: parentRole)) { return node }
        if depth >= limits.maxDepth {
            if let k = a[9] as? [AXUIElement], !k.isEmpty { clipped = true }
            return node
        }
        var kids = (a[9] as? [AXUIElement]) ?? []
        if Self.rowContainers.contains(role), let rows = AX.elements(e, kAXVisibleRowsAttribute), !rows.isEmpty {
            kids = rows
        } else if Self.visibleChildContainers.contains(role), let vis = AX.elements(e, kAXVisibleChildrenAttribute), !vis.isEmpty {
            kids = vis
        }
        if kids.count > limits.maxChildren { clipped = true }
        for k in kids.prefix(limits.maxChildren) {
            if let c = read(k, depth: depth + 1, parentRole: role) { node.children.append(c) }
            if truncated { break }
        }
        return node
    }
}
