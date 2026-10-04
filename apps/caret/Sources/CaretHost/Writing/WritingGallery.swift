import AppKit
import CaretHostCore
import SwiftUI

/// Off-screen renders of the writing offer, from a synthetic sentence: the marks alone, the
/// correction line, the alternatives open on the fix and on Fix all, and the toast after Tab.
@MainActor
extension Gallery {
    static let writingText = "At the the cafe, we was planning to meet."

    /// The sentence's two errors, as the static rules and the system checker would report them.
    nonisolated static func writingMarks(in text: String = writingText) -> [WritingCorrection] {
        let ns = text as NSString
        return [
            WritingCorrection(
                span: UTF16Span(ns.range(of: "the the")), original: "the the", replacement: "the",
                kind: .grammar, reason: WritingCopy.repeatedWord, source: .rule(.doubledWord)
            ),
            WritingCorrection(
                span: UTF16Span(ns.range(of: "was")), original: "was", replacement: "were", otherReplacements: ["are"],
                kind: .grammar, reason: "“we” takes “were”", source: .spellChecker
            ),
        ]
    }

    /// The offer with the caret at the sentence's end, opened and moved `downs` times.
    static func writingOffer(downs: Int = 0) -> WritingOffer {
        let text = writingText
        let target = TargetIdentity(pid: 4242, bundleID: "com.apple.TextEdit", windowID: "4242-1", elementID: "body", elementRevision: UTF16Text.digest(text))
        let live = RangeEdit.Live(target: target, value: text, selection: .caret(UTF16Text.length(text)))
        // Synthetic content built from the same values every time; it cannot fail to make an offer.
        var offer = WritingOffer.correction(marks: writingMarks(), checkedRevision: UTF16Text.digest(text), live: live, now: StillClock().now)!
        for _ in 0..<downs { _ = offer.send(.down) }
        return offer
    }

    static func writing(_ character: FigureCharacter = .pebble) -> [Item] {
        let fixAllRow = writingOffer().alternatives.count - 1
        return [
            Item(name: "writing-mark", view: AnyView(WritingScene(moment: .mark, character: character))),
            Item(name: "writing-line", view: AnyView(WritingScene(moment: .line, character: character))),
            Item(name: "writing-open-fix", view: AnyView(WritingScene(moment: .open(downs: 1), character: character))),
            Item(name: "writing-open-fix-all", view: AnyView(WritingScene(moment: .open(downs: 1 + fixAllRow), character: character))),
            Item(name: "writing-toast", view: AnyView(WritingScene(moment: .toast, character: character))),
        ]
    }
}

/// The sentence at text size with its marks and the caret, and under the active error whatever
/// the moment shows, placed the way the host would place it: left edge on the error.
struct WritingScene: View {
    enum Moment: Equatable {
        case mark, line, toast
        case open(downs: Int)
    }

    var moment: Moment
    var character: FigureCharacter

    static let font = NSFont.systemFont(ofSize: 13)

    var body: some View {
        let offer = Gallery.writingOffer(downs: { if case .open(let d) = moment { return d } else { return 0 } }())
        let text = moment == .toast ? fixedText(offer) : Gallery.writingText
        let marks = moment == .toast ? Gallery.writingMarks(in: text).filter { $0.original != offer.active.original } : offer.marks
        VStack(alignment: .leading, spacing: 6) {
            MarkedSentence(text: text, marks: marks, active: moment == .toast ? nil : offer.active)
            panel(offer).padding(.leading, max(0, leading(offer, in: text)))
        }
        .fixedSize()
    }

    @ViewBuilder private func panel(_ offer: WritingOffer) -> some View {
        switch moment {
        case .mark:
            EmptyView()
        case .line:
            CorrectionLineView(preview: offer.linePreview, hints: offer.lineHints, spoken: offer.spokenLine, character: character)
        case .open:
            WritingAlternativesView(offer: offer)
        case .toast:
            if let content = WritingOffer.toast(after: offer.alternatives[0]) {
                LineView(content: content, character: character, animated: false)
            }
        }
    }

    /// Where the panel starts, so its words line up with the sentence's: the line's preview under
    /// the context word, the list's rows under the error. The offsets are each panel's own inset
    /// to its text (line: padding 8, figure 14, gap 8; list: padding 12, indent 22).
    private func leading(_ offer: WritingOffer, in text: String) -> CGFloat {
        let start = offer.active.span.start
        switch moment {
        case .line, .toast:
            let context = start - UTF16Text.length(offer.linePreview.before)
            return Self.width(of: UTF16Text.slice(text, start: 0, end: context) ?? "") - 30
        case .open, .mark:
            return Self.width(of: UTF16Text.slice(text, start: 0, end: start) ?? "") - 34
        }
    }

    /// The sentence after Tab took the active fix.
    private func fixedText(_ offer: WritingOffer) -> String {
        let text = Gallery.writingText
        guard let edit = offer.alternatives[0].edit,
              let prefix = UTF16Text.slice(text, start: 0, end: edit.replace.start),
              let suffix = UTF16Text.slice(text, start: edit.replace.end, end: UTF16Text.length(text))
        else { return text }
        return prefix + edit.replacement + suffix
    }

    static func width(of text: String) -> CGFloat {
        (text as NSString).size(withAttributes: [.font: font]).width
    }
}

/// A one-line sentence with a mark under each error and the caret at its end.
struct MarkedSentence: View {
    var text: String
    var marks: [WritingCorrection]
    var active: WritingCorrection?

    private struct Piece {
        let text: String
        let mark: Bool
        let active: Bool
    }

    private var pieces: [Piece] {
        var out: [Piece] = []
        var at = 0
        for mark in marks.sorted(by: { $0.span.start < $1.span.start }) {
            if let gap = UTF16Text.slice(text, start: at, end: mark.span.start), !gap.isEmpty { out.append(Piece(text: gap, mark: false, active: false)) }
            out.append(Piece(text: mark.original, mark: true, active: mark == active))
            at = mark.span.end
        }
        if let rest = UTF16Text.slice(text, start: at, end: UTF16Text.length(text)), !rest.isEmpty { out.append(Piece(text: rest, mark: false, active: false)) }
        return out
    }

    var body: some View {
        HStack(alignment: .lastTextBaseline, spacing: 0) {
            ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                Text(piece.text)
                    .foregroundStyle(Color(token: Tokens.ink))
                    // Under the descenders, never over the letters.
                    .overlay(alignment: .bottomLeading) {
                        if piece.mark {
                            WritingMark(width: WritingScene.width(of: piece.text), active: piece.active).offset(y: 3)
                        }
                    }
            }
            Rectangle().fill(Color(token: Tokens.ink)).frame(width: 1, height: 15).offset(y: 3)
        }
        .font(.system(size: 13))
        .fixedSize()
    }
}
