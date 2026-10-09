import Foundation

/// Brief item 1: a suggestion is painted at 4 tokens, then extended once, in place, toward the end of the sentence.
///
/// Measured on this Mac with `Caret --probe-length` (8-line corpus typed key by key, 876 keystrokes per mode;
/// ~/.caret-run/evidence/host/inline/length-88d52c2b): raising the single-request cap from 4 to 8, 16 or 32 tokens left the
/// mean suggestion at 2.4 words and moved p50 from 88 to about 150 ms and p95 from 144 to 320-390 ms. KeyType's beam
/// scores cumulative log probability, so a short branch that ends the sentence wins whatever the cap. Painting 4
/// tokens, then asking again from the end of what is shown, kept the first word at p50 95 / p95 155 ms and gave a full
/// suggestion at p50 117 / p95 391 ms, mean 3.0 words, with 153 suggestions of 5 to 7 words against 90.
public enum GhostExtend {
    /// The extension's token cap: the probe's `extend-4+28` row. Long enough to reach the end of a sentence; the
    /// beam stops sooner at a real sentence end.
    public static let tokens = 28

    /// Whether a shown suggestion is worth extending: it does not already end a sentence, and nothing but whitespace
    /// follows the caret on its line (mid-line suggestions stay short, KeyType's ADR-116).
    public static func shouldExtend(_ shown: String, afterCursor: String) -> Bool {
        guard let last = shown.trimmingCharacters(in: .whitespaces).last, !".!?".contains(last) else { return false }
        return afterCursor.prefix { !$0.isNewline }.allSatisfy(\.isWhitespace)
    }

    /// Why an extension that came back is not drawn, or nil when it may be. It is appended only to the offer it was
    /// asked for, while that offer is still on screen untouched: nothing typed since, the same field state, and Tab not
    /// yet pressed (Tab takes whatever was drawn when it was pressed, and a late extension never changes that).
    public static func refusal(askedFor offerID: UInt64, current: UInt64?, typedSinceOffer: String, keyedSince: Bool,
                               sameField: Bool, more: String) -> String? {
        if more.trimmingCharacters(in: .whitespaces).isEmpty { return "empty" }
        if keyedSince || !typedSinceOffer.isEmpty { return "typed" }
        guard current == offerID else { return "offerGone" }
        guard sameField else { return "fieldMoved" }
        return nil
    }
}
