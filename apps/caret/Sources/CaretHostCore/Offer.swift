import Foundation

/// A suggestion the user can currently take with Tab, bound to the exact field state it was made
/// for.
///
/// `fieldValue` and `caretUTF16` are the field as read when the offer was published. They stay in
/// memory only; the debug socket reports their digest and length, never the text.
public struct Offer: Equatable, Sendable {
    /// Assigned by `OfferArbiter.publish`.
    public internal(set) var id: UInt64 = 0
    /// The text Tab would insert at the caret.
    public var text: String
    public var kind: OfferKind
    public var target: TargetIdentity
    public var fieldValue: String
    public var caretUTF16: Int
    public var createdAt: Date
    public var maxAgeSeconds: Double

    public init(
        text: String,
        kind: OfferKind = .ghost,
        target: TargetIdentity,
        fieldValue: String,
        caretUTF16: Int,
        createdAt: Date = Date(),
        maxAgeSeconds: Double = 30
    ) {
        self.text = text
        self.kind = kind
        self.target = target
        self.fieldValue = fieldValue
        self.caretUTF16 = caretUTF16
        self.createdAt = createdAt
        self.maxAgeSeconds = maxAgeSeconds
    }

    public func isExpired(at now: Date) -> Bool {
        now.timeIntervalSince(createdAt) > maxAgeSeconds
    }
}

/// A single-use grant to insert one offer, handed out by `OfferArbiter.handleKeyDown` for exactly
/// one Tab press.
public struct Claim: Equatable, Sendable {
    public let claimID: UInt64
    public let offer: Offer
    /// Characters the user typed through (matching the offer's head) after it was published and
    /// before Tab. The field is expected to contain them at the caret.
    public let typedSinceOffer: String
    public let claimedAt: Date

    /// What Tab inserts: the offer minus the part the user already typed.
    public var insertionText: String {
        String(offer.text.dropFirst(typedSinceOffer.count))
    }

    /// The edit this claim authorizes, against the field as it should look now: the published
    /// value with the typed-through characters at the caret.
    ///
    /// Computed off the tap thread because it digests the whole field value.
    public func edit() -> InlineEdit? {
        let total = UTF16Text.length(offer.fieldValue)
        guard let prefix = UTF16Text.slice(offer.fieldValue, start: 0, end: offer.caretUTF16),
              let suffix = UTF16Text.slice(offer.fieldValue, start: offer.caretUTF16, end: total)
        else { return nil }
        let expectedValue = prefix + typedSinceOffer + suffix
        let caret = offer.caretUTF16 + UTF16Text.length(typedSinceOffer)
        var target = offer.target
        target.elementRevision = UTF16Text.digest(expectedValue)
        return InlineEdit(
            target: target,
            replaceStart: caret,
            replaceEnd: caret,
            replacement: insertionText,
            originalDigest: UTF16Text.digest("")
        )
    }
}

/// One key-down as the tap thread sees it, reduced to what the arbiter needs. Built from a
/// `CGEvent` without any Accessibility call.
public struct KeyStroke: Equatable, Sendable {
    public static let tabKeyCode: Int64 = 48
    public static let escapeKeyCode: Int64 = 53
    /// ANSI Z. ⌘Z is matched by key code, not by character as AppKit menus match it, so on a layout
    /// that moves Z (Dvorak, AZERTY) Caret's undo sits on a different key from the host's. Untested
    /// on those layouts.
    public static let zKeyCode: Int64 = 6
    /// ANSI 1, 2, 3.
    public static let digitKeyCodes: [Int64: Int] = [18: 1, 19: 2, 20: 3]

    public var keyCode: Int64
    public var command: Bool
    public var control: Bool
    public var option: Bool
    public var shift: Bool
    /// The plain text the key types, or nil for control, navigation and modified keys.
    public var text: String?
    /// The process the window server will deliver this key to (`kCGEventTargetUnixProcessID`).
    /// Nil when unknown. An offer is only taken by a key headed for the offer's own app.
    public var targetPID: Int32?

    public init(
        keyCode: Int64,
        command: Bool = false,
        control: Bool = false,
        option: Bool = false,
        shift: Bool = false,
        text: String? = nil,
        targetPID: Int32? = nil
    ) {
        self.keyCode = keyCode
        self.command = command
        self.control = control
        self.option = option
        self.shift = shift
        self.text = text
        self.targetPID = targetPID
    }

    public static let tab = KeyStroke(keyCode: tabKeyCode)

    public static func tab(to pid: Int32) -> KeyStroke {
        KeyStroke(keyCode: tabKeyCode, targetPID: pid)
    }

    public static func typing(_ text: String) -> KeyStroke {
        KeyStroke(keyCode: 0, text: text)
    }

    /// Tab with no modifiers. Shift+Tab and other chords keep their native meaning.
    public var isPlainTab: Bool {
        keyCode == Self.tabKeyCode && !command && !control && !option && !shift
    }

    /// ⌘Z alone. ⇧⌘Z (redo) and other chords stay the host's.
    public var isUndo: Bool {
        keyCode == Self.zKeyCode && command && !control && !option && !shift
    }

    public var isPlainEscape: Bool {
        keyCode == Self.escapeKeyCode && !command && !control && !option && !shift
    }

    /// 1, 2 or 3 for ⌘1, ⌘2, ⌘3 with no other modifier; nil otherwise.
    public var commandDigit: Int? {
        guard command, !control, !option, !shift else { return nil }
        return Self.digitKeyCodes[keyCode]
    }

    /// A key with no target or the offer's own target may act on that offer.
    func isHeaded(to pid: Int32) -> Bool {
        targetPID.map { $0 == pid } ?? true
    }
}
