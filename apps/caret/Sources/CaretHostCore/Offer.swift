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
    /// Alternatives after the top candidate (`text`), in order. Empty for a single suggestion.
    public var moreCandidates: [String]
    public var source: OfferSource

    /// The top candidate first, then the alternatives.
    public var candidates: [String] { [text] + moreCandidates }

    public init(
        text: String,
        moreCandidates: [String] = [],
        source: OfferSource = .engine,
        kind: OfferKind = .ghost,
        target: TargetIdentity,
        fieldValue: String,
        caretUTF16: Int,
        createdAt: Date = Date(),
        maxAgeSeconds: Double = 30
    ) {
        self.text = text
        self.moreCandidates = moreCandidates
        self.source = source
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

/// Who made an offer. Each producer clears only its own offers.
public enum OfferSource: String, Codable, Sendable {
    /// The ghost-text engine in this process.
    case engine
    /// The helper, over its socket.
    case helper
    /// The debug socket's `inject` test hook. Never reported to the helper.
    case debug
}

/// What the user took with Tab (or ⌥→, or a Command-digit action).
public struct Choice: Equatable, Sendable {
    /// Index into `Offer.candidates`.
    public var candidate: Int
    /// For an action line or pop-up: the action taken.
    public var actionID: String?
    /// For a pop-up with choice rows: the highlighted row when the action was taken.
    public var row: Int?
    /// ⌥→: only the next word of the candidate.
    public var wordOnly: Bool
    /// Command-1 over ghost fill: every empty field.
    public var fillAll: Bool
    /// The reveal applied when the action was taken, so the row can be named by its block.
    public var revealed: String?
    /// The action line had been opened into its variants.
    public var expanded: Bool

    public init(
        candidate: Int = 0, actionID: String? = nil, row: Int? = nil, wordOnly: Bool = false, fillAll: Bool = false,
        revealed: String? = nil, expanded: Bool = false
    ) {
        self.revealed = revealed
        self.expanded = expanded
        self.candidate = candidate
        self.actionID = actionID
        self.row = row
        self.wordOnly = wordOnly
        self.fillAll = fillAll
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
    public var choice: Choice

    public init(claimID: UInt64, offer: Offer, typedSinceOffer: String, claimedAt: Date, choice: Choice = Choice()) {
        self.claimID = claimID
        self.offer = offer
        self.typedSinceOffer = typedSinceOffer
        self.claimedAt = claimedAt
        self.choice = choice
    }

    /// Ghost text, fill values and writing fixes are written into the field; action lines and
    /// pop-ups are handed to the helper. H10: so is a fill value for a page field, which the host
    /// cannot see to write or check (`PageWindow`); the helper's page engine writes it.
    public var insertsText: Bool {
        switch offer.kind {
        case .ghost: return !choice.fillAll
        case .fill(let origin): return !choice.fillAll && !PageWindow.isPage(origin.windowID)
        case .writing: return rangeEdit != nil
        case .action, .popup: return false
        }
    }

    /// What Tab inserts: the offer minus the part the user already typed. For a writing fix, the
    /// chosen replacement.
    public var insertionText: String {
        if let rangeEdit { return rangeEdit.replacement }
        return String(offer.text.dropFirst(typedSinceOffer.count))
    }

    /// The range edit a writing claim applies: the chosen alternative's. Nil for every other kind,
    /// and for Original, which changes nothing.
    public var rangeEdit: RangeEdit? {
        guard let writing = offer.kind.writing, writing.alternatives.indices.contains(choice.candidate) else { return nil }
        return writing.alternatives[choice.candidate].edit
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
    public static let leftKeyCode: Int64 = 123
    public static let rightKeyCode: Int64 = 124
    public static let downKeyCode: Int64 = 125
    public static let upKeyCode: Int64 = 126
    public static let returnKeyCode: Int64 = 36
    public static let deleteKeyCode: Int64 = 51
    public static let spaceKeyCode: Int64 = 49
    /// Shift, Command, Option, Control, Caps Lock and Fn, left and right. They arrive as
    /// flags-changed events, not key-downs; listed so a stray one can never dismiss anything.
    public static let modifierKeyCodes: Set<Int64> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]

    public var keyCode: Int64
    public var command: Bool
    public var control: Bool
    public var option: Bool
    public var shift: Bool
    /// The plain text the key types, or nil for control, navigation and modified keys.
    public var text: String?
    /// The process the window server will deliver this key to (`kCGEventTargetUnixProcessID`).
    /// Nil when unknown, and then the key takes no offer and no undo.
    public var targetPID: Int32?
    /// H11: the key is held and this down is the keyboard's autorepeat, not a new press.
    public var isRepeat: Bool

    public init(
        keyCode: Int64,
        command: Bool = false,
        control: Bool = false,
        option: Bool = false,
        shift: Bool = false,
        text: String? = nil,
        targetPID: Int32? = nil,
        isRepeat: Bool = false
    ) {
        self.keyCode = keyCode
        self.command = command
        self.control = control
        self.option = option
        self.shift = shift
        self.text = text
        self.targetPID = targetPID
        self.isRepeat = isRepeat
    }

    public static let tab = KeyStroke(keyCode: tabKeyCode)

    public static func tab(to pid: Int32) -> KeyStroke {
        KeyStroke(keyCode: tabKeyCode, targetPID: pid)
    }

    public static func typing(_ text: String, to pid: Int32? = nil) -> KeyStroke {
        KeyStroke(keyCode: 0, text: text, targetPID: pid)
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

    /// Only a key known to be headed for `pid` may act on that app's offer or toast. A key whose
    /// target is unknown acts on nothing: guessing the target is how a key meant for one app takes
    /// another app's offer.
    func isHeaded(to pid: Int32) -> Bool {
        targetPID == pid
    }
}
