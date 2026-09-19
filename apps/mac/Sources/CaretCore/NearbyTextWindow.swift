import CryptoKit
import Foundation

/// UTF-16 arithmetic shared by capture and by the pre-insertion check.
///
/// Every offset that crosses to the core is a UTF-16 code unit, because that is
/// what `kAXSelectedTextRange` reports. Swift's `String` indexes by character,
/// so all slicing here goes through `String.UTF16View` and refuses to split a
/// surrogate pair rather than producing a lone half.
public enum UTF16Text {
    public static func length(_ text: String) -> Int { text.utf16.count }

    /// Slice by UTF-16 code units. Returns nil for an out-of-range or
    /// surrogate-splitting range.
    public static func slice(_ text: String, start: Int, end: Int) -> String? {
        guard start >= 0, end >= start, end <= text.utf16.count else { return nil }
        let view = text.utf16
        guard let from = view.index(view.startIndex, offsetBy: start, limitedBy: view.endIndex),
              let to = view.index(view.startIndex, offsetBy: end, limitedBy: view.endIndex)
        else { return nil }
        // A String initializer from a UTF16View slice fails when either bound
        // lands inside a surrogate pair.
        return String(view[from..<to])
    }

    /// The core's content digest: first 16 hex characters of SHA-256 over UTF-8.
    /// Logs and wire records carry this, never the text.
    public static func digest(_ text: String) -> String {
        let hash = SHA256.hash(data: Data(text.utf8))
        return hash.map { String(format: "%02x", $0) }.joined().prefix(16).description
    }
}

/// A bounded window of the field's value around the caret.
///
/// The core rejects an oversized frame rather than truncating it, because
/// truncating would shift the offsets an edit is applied at. So the app does
/// the bounding, and it must produce a window that still contains the caret and
/// the whole selection.
public struct NearbyTextWindow: Equatable, Sendable {
    public var text: String
    /// Where this window starts inside the full value, in UTF-16 units.
    public var offset: Int

    public var length: Int { UTF16Text.length(text) }
    public var end: Int { offset + length }

    public init(text: String, offset: Int) {
        self.text = text
        self.offset = offset
    }

    public enum Failure: Error, Equatable {
        /// The caret or selection lies outside the value we read.
        case caretOutsideValue
        /// The selection alone exceeds the bound, so no legal window exists.
        /// Capture is suppressed rather than sending a window the core refuses.
        case selectionExceedsLimit(units: Int, limit: Int)
        /// A window boundary fell inside a surrogate pair and could not be
        /// nudged to a whole character.
        case unsplittable
    }

    /// Builds the largest legal window that contains `selection`, centered on
    /// the caret. Boundaries move outward off a surrogate pair so the window is
    /// always whole characters.
    public static func around(
        value: String,
        caret: Int,
        selection: TextSelection,
        limit: Int = CoreLimits.nearbyTextUnits
    ) -> Result<NearbyTextWindow, Failure> {
        let total = UTF16Text.length(value)
        guard caret >= 0, caret <= total,
              selection.start >= 0, selection.end >= selection.start, selection.end <= total
        else { return .failure(.caretOutsideValue) }

        let mustInclude = (start: min(selection.start, caret), end: max(selection.end, caret))
        let required = mustInclude.end - mustInclude.start
        guard required <= limit else { return .failure(.selectionExceedsLimit(units: required, limit: limit)) }

        if total <= limit {
            return .success(NearbyTextWindow(text: value, offset: 0))
        }

        // Spend the remaining budget evenly on either side of what must be in.
        let slack = limit - required
        var start = max(0, mustInclude.start - slack / 2)
        var end = min(total, start + limit)
        start = max(0, min(start, end - limit))

        // Nudge off a surrogate boundary. At most one unit on each side is
        // needed: a pair is two units.
        for _ in 0..<2 {
            if UTF16Text.slice(value, start: start, end: end) != nil { break }
            if start > 0, start > mustInclude.start - 1, UTF16Text.slice(value, start: start, end: start) == nil {
                start -= 1
            } else if end < total {
                end -= 1
            } else {
                start += 1
            }
        }
        guard let text = UTF16Text.slice(value, start: start, end: end),
              start <= mustInclude.start, mustInclude.end <= start + UTF16Text.length(text)
        else { return .failure(.unsplittable) }
        return .success(NearbyTextWindow(text: text, offset: start))
    }
}
