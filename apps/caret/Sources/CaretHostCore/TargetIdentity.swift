import Foundation

/// Which text field an offer belongs to, plus a token for its content.
///
/// Same shape and JSON keys as the team repo's `CaretCore.TargetIdentity`, so a later bridge to the
/// Python core can pass it through unchanged.
public struct TargetIdentity: Codable, Equatable, Sendable {
    public var pid: Int32
    public var bundleID: String
    public var windowID: String
    public var elementID: String
    /// Digest of the element's whole value. Two reads sharing this token saw the same text.
    public var elementRevision: String

    public init(pid: Int32, bundleID: String, windowID: String, elementID: String, elementRevision: String) {
        self.pid = pid
        self.bundleID = bundleID
        self.windowID = windowID
        self.elementID = elementID
        self.elementRevision = elementRevision
    }

    enum CodingKeys: String, CodingKey {
        case pid
        case bundleID = "bundle_id"
        case windowID = "window_id"
        case elementID = "element_id"
        case elementRevision = "element_revision"
    }
}

/// A selection in UTF-16 code units. Named apart from `AutocompleteCore.TextSelection`, which holds
/// `String.Index` ranges, so both can be imported in one file.
public struct UTF16Selection: Codable, Equatable, Sendable {
    public var start: Int
    public var end: Int

    public init(start: Int, end: Int) {
        self.start = start
        self.end = end
    }

    public static func caret(_ location: Int) -> UTF16Selection {
        UTF16Selection(start: location, end: location)
    }

    public var isEmpty: Bool { end <= start }
}

/// An edit the host intends to apply: replace `replaceStart..<replaceEnd` (UTF-16) with
/// `replacement`. `originalDigest` covers only the replaced span, so an insertion at the caret
/// carries `UTF16Text.digest("")`.
public struct InlineEdit: Codable, Equatable, Sendable {
    public var target: TargetIdentity
    public var replaceStart: Int
    public var replaceEnd: Int
    public var replacement: String
    public var originalDigest: String

    public init(target: TargetIdentity, replaceStart: Int, replaceEnd: Int, replacement: String, originalDigest: String) {
        self.target = target
        self.replaceStart = replaceStart
        self.replaceEnd = replaceEnd
        self.replacement = replacement
        self.originalDigest = originalDigest
    }

    enum CodingKeys: String, CodingKey {
        case target
        case replaceStart = "replace_start"
        case replaceEnd = "replace_end"
        case replacement
        case originalDigest = "original_digest"
    }
}
