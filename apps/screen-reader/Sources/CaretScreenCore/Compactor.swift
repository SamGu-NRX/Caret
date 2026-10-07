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
    /// Dropped with everything under them: chrome that carries no content. An AXMenu is kept only as a pop-up
    /// button's own (popUpMenu).
    public static let skipped: Set<String> = [
        "AXScrollBar", "AXMenuBar", "AXMenu", "AXGrowArea", "AXSplitter", "AXValueIndicator", "AXRuler", "AXRulerMarker",
    ]
    /// V4: whether a node is a pop-up button's own menu, whose items are that button's options. An app that keeps a
    /// closed pop-up's items in its tree shows them here without the menu being opened; the reader never opens one.
    /// Chrome shows only a closed menu's selected item (evidence/screen/b24/capture-2 probe), which the helper reads as
    /// no option list. Every other menu (a context menu, a menu bar's) stays dropped.
    public static func popUpMenu(_ role: String, parentRole: String?) -> Bool {
        role == "AXMenu" && parentRole == "AXPopUpButton"
    }
    /// Kept even when unnamed, because they can be acted on.
    public static let actionable: Set<String> = [
        "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXLink", "AXTab",
        "AXDisclosureTriangle", "AXIncrementor", "AXSegmentedControl", "AXTextField", "AXTextArea", "AXComboBox",
        "AXSearchField", "AXDateField", "AXColorWell",
    ]
    /// Kept even when unnamed, because their presence matters: a sheet over a window blocks acting in it,
    /// and a progress or busy indicator marks the window as showing unfinished work (pending-state watch).
    public static let presence: Set<String> = ["AXSheet", "AXProgressIndicator", "AXBusyIndicator"]
    /// Roles a user's click presses (B20 press watch): the element under a click, or its nearest ancestor
    /// with one of these roles, is what the reader reports as the press.
    public static let pressable: Set<String> = ["AXButton", "AXLink", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton"]
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
    /// Normalized window title. A label equal to it is a document title, not a name, and stays out of keys.
    let titleLabel: String?

    public init(app: String, windowKind: String, windowTitle: String? = nil) {
        prefix = "\(app)/\(windowKind)"
        titleLabel = windowTitle.map(ElementKey.normalizeLabel).flatMap { $0.isEmpty ? nil : $0 }
    }

    /// The label a node contributes to keys. Web areas carry the page title and browsers name their
    /// top group after the window title; both change on every navigation or unread count, and in E8
    /// they moved every key in a Chrome page at once. Such labels are left out of keys.
    func keyLabel(role: String, normalized: String) -> String {
        if role == "AXWebArea" || normalized == titleLabel { return "" }
        return normalized
    }

    /// Compacts the children of a window element.
    public func compact(windowChildren: [RawNode]) -> CompactResult {
        var state = State()
        for c in windowChildren { visit(c, chain: [], parent: nil, parentRole: nil, state: &state) }
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
        let editable = Roles.editable.contains(n.role)
        var value = (isStatic || n.secure) ? nil : nonEmpty(n.value)
        // An editable field's value is its content, so it stays even when it repeats the label;
        // otherwise a filled field would look empty.
        if value != nil, value == label, !editable { value = nil }
        let placeholder = nonEmpty(n.placeholder)
        let unnamed = label == nil && value == nil
        if unnamed && Roles.containers.contains(n.role) { return nil }
        if unnamed && placeholder == nil && !Roles.actionable.contains(n.role) && !Roles.presence.contains(n.role) && !editable {
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
        return Info(label: label, normalizedLabel: keyLabel(role: n.role, normalized: ElementKey.normalizeLabel(label ?? "")),
                    value: value, editable: editable, states: states)
    }

    private func visit(_ n: RawNode, chain: [String], parent: String?, parentRole: String?, state: inout State) {
        if Roles.popUpMenu(n.role, parentRole: parentRole) {
            // V4: the menu itself is collapsed; its items attach to the pop-up button, as the helper reads options
            // (fill/controls.ts formControls: AXMenuItem children of an AXPopUpButton). A submenu stays dropped.
            for c in n.children where c.role == "AXMenuItem" { visit(c, chain: chain, parent: parent, parentRole: n.role, state: &state) }
            return
        }
        if Roles.skipped.contains(n.role) { return }
        guard let info = describe(n) else {
            for c in n.children { visit(c, chain: chain, parent: parent, parentRole: n.role, state: &state) }
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
        let named = !info.normalizedLabel.isEmpty
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
            for c in n.children { visit(c, chain: childChain, parent: key, parentRole: n.role, state: &state) }
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
