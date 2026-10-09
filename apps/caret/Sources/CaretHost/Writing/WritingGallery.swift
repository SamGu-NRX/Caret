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
            Item(name: "writing-line-choice", view: AnyView(WritingChoiceScene(character: character))),
            Item(name: "writing-not-fixed", view: AnyView(
                LineView(content: WritingCopy.error(WritingCopy.notFixed("revisionChanged")), character: character, animated: false)
            )),
            Item(name: "rewrite-working", view: AnyView(RewriteScene(moment: .working, character: character))),
            Item(name: "rewrite-open", view: AnyView(RewriteScene(moment: .open(downs: 0), character: character))),
            Item(name: "rewrite-open-second", view: AnyView(RewriteScene(moment: .open(downs: 1), character: character))),
            Item(name: "rewrite-open-original", view: AnyView(RewriteScene(moment: .open(downs: 3), character: character))),
            Item(name: "rewrite-toast", view: AnyView(RewriteScene(moment: .toast, character: character))),
            Item(name: "rewrite-none", view: AnyView(
                LineView(content: WritingCopy.error(WritingCopy.noRewrite), character: character, animated: false)
            )),
        ]
    }

    static let rewriteText = "Sorry for the late reply, I was out of the office on Monday."
    /// From the rewrite probe's list mode on this sentence's neighbors (02f3cda9), edited to three distinct ones.
    static let rewriteAlternatives = [
        "I'm sorry for the delayed response; I was out of the office on Monday.",
        "Apologies for the slow reply, I was out of the office on Monday.",
        "Sorry it took me a while to reply. I was out of the office on Monday.",
    ]

    /// The rewrites of `rewriteText`, opened and moved `downs` times.
    static func rewriteOffer(downs: Int = 0) -> WritingOffer {
        let text = rewriteText
        let target = TargetIdentity(pid: 4242, bundleID: "com.apple.TextEdit", windowID: "4242-1", elementID: "body", elementRevision: UTF16Text.digest(text))
        let live = RangeEdit.Live(target: target, value: text, selection: .caret(UTF16Text.length(text)))
        // Synthetic content built from the same values every time; it cannot fail to make an offer.
        var offer = WritingOffer.rewrite(span: UTF16Span(start: 0, end: UTF16Text.length(text)), rewrites: rewriteAlternatives, live: live, now: StillClock().now)!
        for _ in 0..<downs { _ = offer.send(.down) }
        return offer
    }

    static let choiceText = "Can you adress the feedback?"

    /// A misspelling whose checker answers disagree (lead decision 2): both on the line, no Tab.
    static func choiceOffer() -> WritingOffer {
        let text = choiceText
        let target = TargetIdentity(pid: 4242, bundleID: "com.apple.TextEdit", windowID: "4242-1", elementID: "body", elementRevision: UTF16Text.digest(text))
        let live = RangeEdit.Live(target: target, value: text, selection: .caret(UTF16Text.length(text)))
        let mark = WritingCorrection(
            span: UTF16Span((text as NSString).range(of: "adress")), original: "adress", replacement: "address",
            otherReplacements: ["dress"], kind: .spelling, reason: WritingCopy.notInDictionary, source: .spellChecker, needsChoice: true
        )
        // Synthetic content built from the same values every time; it cannot fail to make an offer.
        return WritingOffer.correction(marks: [mark], checkedRevision: UTF16Text.digest(text), live: live, now: StillClock().now)!
    }
}

/// The sentence with its one mark, and the line naming both answers under it.
struct WritingChoiceScene: View {
    var character: FigureCharacter

    var body: some View {
        let offer = Gallery.choiceOffer()
        VStack(alignment: .leading, spacing: 6) {
            MarkedSentence(text: Gallery.choiceText, marks: offer.marks, active: offer.active)
            CorrectionLineView(preview: offer.linePreview, hints: offer.lineHints, spoken: offer.spokenLine, character: character, choices: offer.lineChoices)
                .padding(.leading, max(0, WritingScene.width(of: "Can you ") - 30))
        }
        .fixedSize()
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

/// The sentence with the caret at its end, and under it the rewrite key's working line, the open
/// rewrites, or the toast after Tab, placed as the host places them: rows under the sentence.
struct RewriteScene: View {
    enum Moment: Equatable {
        case working, toast
        case open(downs: Int)
    }

    var moment: Moment
    var character: FigureCharacter

    var body: some View {
        let offer = Gallery.rewriteOffer(downs: { if case .open(let d) = moment { return d } else { return 0 } }())
        VStack(alignment: .leading, spacing: 6) {
            MarkedSentence(text: moment == .toast ? Gallery.rewriteAlternatives[0] : Gallery.rewriteText, marks: [], active: nil)
            Group {
                switch moment {
                case .working:
                    LineView(content: LineContent(figure: .working, text: WritingCopy.rewriting, emphasis: .secondary), character: character, animated: false)
                case .open:
                    WritingAlternativesView(offer: offer)
                case .toast:
                    if let content = WritingOffer.toast(after: offer.alternatives[0]) {
                        LineView(content: content, character: character, animated: false)
                    }
                }
            }
            .padding(.leading, 0)
        }
        .fixedSize()
    }
}
