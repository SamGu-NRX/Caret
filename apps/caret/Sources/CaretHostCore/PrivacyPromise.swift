import Foundation

/// The approved privacy promise, as the build writes it into `Contents/Resources/PrivacyPromise.txt` from
/// `PRIVACY_PROMISE` in `helper/src/privacy.ts`, split into blocks for display. The words are never changed, cut or
/// reordered: joining the blocks with a blank line gives back the text as read.
///
/// The text's only structure is the one the approved draft has: blocks separated by a blank line, where a heading is a
/// block of one line with no closing punctuation (the draft sets those lines in bold). Matching the structure rather
/// than the heading words keeps a second copy of the promise out of Swift; a heading that stopped matching would still
/// be shown, as a paragraph.
public struct PrivacyPromise: Equatable, Sendable {
    public enum Block: Equatable, Sendable {
        case heading(String)
        case paragraph(String)

        public var text: String {
            switch self {
            case .heading(let text), .paragraph(let text): return text
            }
        }
    }

    public static let separator = "\n\n"

    public let blocks: [Block]

    /// Nil for text with nothing but whitespace in it: an empty resource is as broken as a missing one.
    public init?(_ text: String) {
        guard text.contains(where: { !$0.isWhitespace }) else { return nil }
        blocks = text.components(separatedBy: Self.separator).map { block in
            Self.isHeading(block) ? .heading(block) : .paragraph(block)
        }
    }

    /// Decided on the block without its surrounding whitespace, which stays in the block as shown.
    static func isHeading(_ block: String) -> Bool {
        let words = block.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = words.last, !words.contains("\n"), words.contains(where: \.isLetter) else { return false }
        return !".,;:!?\"'\u{201D}\u{2019})".contains(last)
    }
}
