import Foundation

/// The user's preferred amount of inline text. Token caps bound generation, not the number of words shown.
public enum SuggestionLength: String, Codable, CaseIterable, Sendable {
    case short, medium, long

    public var title: String { rawValue.capitalized }

    public enum Path: Equatable, Sendable { case native, page }
    public struct Budget: Equatable, Sendable {
        public let firstTokens: Int
        /// The token cap of the second request, made from the end of the first suggestion. Nil means no extension.
        public let extendTokens: Int?
    }

    // Chosen, not measured: Short reduces the first request; Long doubles Medium's native caps.
    // Medium preserves the existing 4 + 28 native requests and 4-token page request.
    private static let shortFirst = 2
    private static let mediumFirst = 4
    private static let mediumExtend = 28
    private static let longFirst = 8
    private static let longExtend = 56

    public func budget(for path: Path) -> Budget {
        switch self {
        case .short: return Budget(firstTokens: Self.shortFirst, extendTokens: nil)
        case .medium: return Budget(firstTokens: Self.mediumFirst, extendTokens: path == .native ? Self.mediumExtend : nil)
        case .long: return Budget(firstTokens: Self.longFirst, extendTokens: Self.longExtend)
        }
    }
}
