// Compaction turns a raw accessibility tree into the compact node list the helper receives,
// following T3 SnapShot's rules (deep plan section 3): default states dropped, values equal to
// the name dropped, unnamed groups collapsed so their children attach to the nearest kept
// ancestor. It also assigns every kept node its element key. It is pure, so tests can feed it
// trees directly and the AX walker only has to read.
import Foundation

/// One element as read from Accessibility, before compaction.
public struct RawNode: Sendable {
    public var role: String
    public var subrole: String?
    public var title: String?
    public var description: String?
    /// The string value. Nil when absent, not a string, or deliberately unread (secure fields).
    public var value: String?
    public var placeholder: String?
    /// Text of the element named by AXTitleUIElement, read only for editable fields.
    public var titleElementText: String?
    public var frame: Frame?
    public var enabled: Bool
    public var focused: Bool
    public var selected: Bool
    public var checked: Bool
    public var secure: Bool
    public var children: [RawNode]
    /// The walker's index for the live element, so callers can map elements to keys afterwards.
    public var handle: Int?

    public init(role: String, subrole: String? = nil, title: String? = nil, description: String? = nil, value: String? = nil,
                placeholder: String? = nil, titleElementText: String? = nil, frame: Frame? = nil, enabled: Bool = true,
                focused: Bool = false, selected: Bool = false, checked: Bool = false, secure: Bool = false,
                children: [RawNode] = [], handle: Int? = nil) {
        self.role = role; self.subrole = subrole; self.title = title; self.description = description; self.value = value
        self.placeholder = placeholder; self.titleElementText = titleElementText; self.frame = frame; self.enabled = enabled
        self.focused = focused; self.selected = selected; self.checked = checked; self.secure = secure
        self.children = children; self.handle = handle
    }
}

public enum Roles {
    public static let editable: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]
    /// Collapsed when unnamed: their children attach to the nearest kept ancestor.
    public static let containers: Set<String> = [
        "AXGroup", "AXScrollArea", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXRow", "AXCell",
        "AXColumn", "AXList", "AXTable", "AXOutline", "AXTabGroup", "AXToolbar", "AXGenericElement", "AXSection",
    ]
    /// Dropped with everything under them: chrome that carries no content.
    public static let skipped: Set<String> = [
        "AXScrollBar", "AXMenuBar", "AXMenu", "AXGrowArea", "AXSplitter", "AXValueIndicator", "AXRuler", "AXRulerMarker",
    ]
    /// Kept even when unnamed, because they can be acted on.
    public static let actionable: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXLink", "AXTab",
        "AXDisclosureTriangle", "AXIncrementor", "AXSegmentedControl", "AXTextField", "AXTextArea", "AXComboBox",
        "AXSearchField", "AXDateField", "AXColorWell",
    ]
    /// Roles whose AXValue is read. Everything else is skipped to save a round trip per node.
    public static let valueBearing: Set<String> = [
        "AXStaticText", "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXPopUpButton", "AXCheckBox",
        "AXRadioButton", "AXDateField", "AXHeading",
    ]
}

/// Where a kept node sits, so a later walk of just its subtree can reproduce the same keys.
public struct KeyContext: Sendable, Equatable {
    public var key: String
    public var parent: String?
    /// The chain its descendants use: its own chain plus its segment when it is named.
    public var childChain: [String]
    public var named: Bool
    public var leaf: Bool
    public var normalizedLabel: String
    public var role: String
}

public struct CompactResult: Sendable {
    public var nodes: [Node]
    /// Raw handle to the key context of the kept node it became.
    public var contexts: [Int: KeyContext]
    public var focusedKey: String?
}

public struct Compactor {
    /// The "<app>/<window kind>" prefix of every key in this window.
    public let prefix: String

    public init(app: String, windowKind: String) {
        prefix = "\(app)/\(windowKind)"
    }

    /// Compacts the children of a window element.
    public func compact(windowChildren: [RawNode]) -> CompactResult {
        var state = State()
        for c in windowChildren { visit(c, chain: [], parent: nil, state: &state) }
        return state.result()
    }

    /// Compacts one subtree whose root was a kept node of an earlier walk, reusing that node's key.
    /// Returns nil when the root would now get a different key or is no longer kept, so the
    /// caller must walk the whole window instead.
    public func compactSubtree(_ root: RawNode, context: KeyContext) -> CompactResult? {
        guard let info = describe(root), info.normalizedLabel == context.normalizedLabel, root.role == context.role else { return nil }
        var state = State()
        let parentChain = context.named ? Array(context.childChain.dropLast()) : context.childChain
        emit(root, info: info, key: context.key, chain: parentChain, parent: context.parent, state: &state)
        return state.result()
    }

    // MARK: - internals

    struct Info {
        var label: String?
        var normalizedLabel: String
        var value: String?
        var editable: Bool
        var states: [NodeState]
    }

    struct State {
        var nodes: [Node] = []
        var contexts: [Int: KeyContext] = [:]
        var ordinals: [String: Int] = [:]
        var focusedKey: String?
        func result() -> CompactResult { CompactResult(nodes: nodes, contexts: contexts, focusedKey: focusedKey) }
    }

    func describe(_ n: RawNode) -> Info? {
        if Roles.skipped.contains(n.role) { return nil }
        let isStatic = n.role == "AXStaticText"
        let label = firstNonEmpty(n.title, n.description, n.titleElementText, isStatic ? n.value : nil)
        var value = (isStatic || n.secure) ? nil : nonEmpty(n.value)
        if value != nil, value == label { value = nil }
        let editable = Roles.editable.contains(n.role)
        let placeholder = nonEmpty(n.placeholder)
        let unnamed = label == nil && value == nil
        if unnamed && Roles.containers.contains(n.role) { return nil }
        if unnamed && placeholder == nil && !Roles.actionable.contains(n.role) && !editable {
            // An unnamed leaf with nothing to show (decorative image, empty text) is dropped;
            // an unnamed node with children is collapsed like a group.
            return nil
        }
        var states: [NodeState] = []
        if n.focused { states.append(.focused) }
        if n.selected { states.append(.selected) }
        if !n.enabled { states.append(.disabled) }
        if n.checked { states.append(.checked) }
        if n.secure { states.append(.secure) }
        return Info(label: label, normalizedLabel: ElementKey.normalizeLabel(label ?? ""), value: value, editable: editable, states: states)
    }

    private func visit(_ n: RawNode, chain: [String], parent: String?, state: inout State) {
        if Roles.skipped.contains(n.role) { return }
        guard let info = describe(n) else {
            for c in n.children { visit(c, chain: chain, parent: parent, state: &state) }
            return
        }
        let seg = "\(ElementKey.shortRole(n.role)):\(info.normalizedLabel)"
        let scope = ([prefix] + chain).joined(separator: "/")
        let ordinalKey = "\(scope)/\(seg)"
        let ordinal = state.ordinals[ordinalKey, default: 0]
        state.ordinals[ordinalKey] = ordinal + 1
        let key = "\(ordinalKey)~\(ordinal)"
        emit(n, info: info, key: key, chain: chain, parent: parent, state: &state, ordinal: ordinal)
    }

    private func emit(_ n: RawNode, info: Info, key: String, chain: [String], parent: String?, state: inout State, ordinal: Int? = nil) {
        let named = info.label != nil
        let seg = "\(ElementKey.shortRole(n.role)):\(info.normalizedLabel)"
        // An ancestor's segment carries its ordinal only when it is not the first, so two sibling
        // groups with the same name give their children distinct, self-contained scopes.
        let ord = ordinal ?? Int(key.split(separator: "~").last ?? "0") ?? 0
        let childChain = named ? chain + [ord == 0 ? seg : "\(seg)~\(ord)"] : chain
        state.nodes.append(Node(key: key, parent: parent, role: n.role, subrole: n.subrole, label: info.label, value: info.value,
                                placeholder: nonEmpty(n.placeholder), frame: n.frame, editable: info.editable, states: info.states))
        if n.focused { state.focusedKey = key }
        let before = state.nodes.count
        if !n.secure {
            for c in n.children { visit(c, chain: childChain, parent: key, state: &state) }
        }
        let leaf = state.nodes.count == before
        if let h = n.handle {
            state.contexts[h] = KeyContext(key: key, parent: parent, childChain: childChain, named: named, leaf: leaf,
                                           normalizedLabel: info.normalizedLabel, role: n.role)
        }
    }
}

private func nonEmpty(_ s: String?) -> String? {
    guard let s else { return nil }
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.isEmpty ? nil : s
}

private func firstNonEmpty(_ xs: String?...) -> String? {
    for x in xs { if let v = nonEmpty(x) { return v } }
    return nil
}
