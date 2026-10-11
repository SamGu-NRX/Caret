import AppKit
import CaretHostCore
import CaretScreenCore
import SwiftUI

// Renders for v3 part 1 that are about where a slip sits rather than what it says: a slip at the
// edges of the screen and of its host window, placed by `FieldPanelPlacement` exactly as the host
// places it, and H5's comparison of Caret's voice in New York and SF Pro over two real-looking
// documents. Synthetic content only.

/// A synthetic screen with a host window and a caret near one of its edges, and the slip where
/// the placement rule puts it. The scene exposes the rule's choice, so tests check the frame and
/// the render shows it (LEAD-REVIEW defect 3: the prototype's slip ran off the screen).
struct SlipEdgeScene: View {
    enum Edge: String, CaseIterable {
        /// The caret near the screen's right edge: the slip is pushed left to stay 8 pt inside.
        case screenRight
        /// The caret near the screen's bottom edge: the slip flips above the caret's line.
        case screenBottom
        /// The caret near the host window's right edge, with screen to spare: the slip is pushed
        /// left to stay 8 pt inside what is visible of the window.
        case windowRight
        /// The caret on the host window's last line.
        case windowBottom
    }

    var edge: Edge
    var character: FigureCharacter = .pebble
    @Environment(\.colorScheme) private var scheme

    static let screen = CGRect(x: 0, y: 0, width: 620, height: 300)

    var window: CGRect {
        switch edge {
        case .screenRight, .screenBottom: return CGRect(x: 120, y: 20, width: 500, height: 280)
        case .windowRight, .windowBottom: return CGRect(x: 30, y: 30, width: 520, height: 180)
        }
    }

    /// The caret: one 16 pt line, in a field the width of the window's text area.
    var caret: CGRect {
        let w = window
        switch edge {
        case .screenRight: return CGRect(x: Self.screen.maxX - 40, y: 90, width: 1, height: 16)
        case .screenBottom: return CGRect(x: w.minX + 120, y: Self.screen.maxY - 22, width: 1, height: 16)
        case .windowRight: return CGRect(x: w.maxX - 30, y: w.minY + 70, width: 1, height: 16)
        case .windowBottom: return CGRect(x: w.minX + 90, y: w.maxY - 24, width: 1, height: 16)
        }
    }

    /// A full-window text view: the field is the window below its title bar.
    var field: CGRect { CGRect(x: window.minX, y: window.minY + 28, width: window.width, height: window.height - 28) }

    static let sentence = "I'll grab coffee with Dana on Thursday at 3"
    static let sentenceWidth = ceil((sentence as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 13)]).width)

    static let content = LineContent(figure: .offering, app: "Calendar", text: "Coffee with Dana, Thursday 3:00 to 3:30", hints: [Hint(key: "Tab")])

    var size: CGSize { NSHostingView(rootView: LineView(content: Self.content, character: character, animated: false)).fittingSize }

    /// Where the host's rule puts the slip: in a text view it hangs from the caret's line, inside
    /// what is visible (`caretLineSpot`), else around the field (`choose`) with nothing in the way.
    var choice: FieldPanelPlacement.Choice {
        // As the host reads it: the text view's frame clipped to its window and the screen.
        let visible = field.intersection(Self.screen)
        return FieldPanelPlacement.caretLineSpot(field: field, caret: caret, size: size, visible: visible)
            ?? FieldPanelPlacement.choose(field: field, caret: caret, size: size, narrow: nil, bounds: Self.screen, obstacles: { _ in [] })
    }

    var body: some View {
        let dark = scheme == .dark
        let spot = choice.frame
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x26282C : 0xC9CCD2)))
            HostWindow(title: "Notes", dark: dark)
                .frame(width: window.width, height: window.height)
                .offset(x: window.minX, y: window.minY)
            Text(Self.sentence)
                .font(.system(size: 13))
                .foregroundStyle(Color(nsColor: Tokens.srgb(dark ? 0xDFDFE0 : 0x1D1D1F)))
                .fixedSize()
                .offset(x: max(field.minX + 8, caret.minX - Self.sentenceWidth), y: caret.minY)
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0xDFDFE0 : 0x1D1D1F))).frame(width: 1, height: caret.height)
                .offset(x: caret.minX, y: caret.minY)
            LineView(content: Self.content, character: character, animated: false)
                .offset(x: spot.minX, y: spot.minY)
        }
        .frame(width: Self.screen.width, height: Self.screen.height, alignment: .topLeading)
        .clipped()
    }
}

/// A window, roughly: a title bar with three dots and a title over a plain body.
struct HostWindow: View {
    var title: String
    var dark: Bool
    var body_: UInt32?
    var bar: UInt32?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                ForEach(0..<3, id: \.self) { _ in Circle().fill(Color(nsColor: Tokens.srgb(dark ? 0x5A5A5E : 0xC4C4C8))).frame(width: 11, height: 11) }
                Text(title).font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color(nsColor: Tokens.srgb(dark ? 0xA1A1A6 : 0x6E6E73))).padding(.leading, 8)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(Color(nsColor: Tokens.srgb(bar ?? (dark ? 0x2C2C30 : 0xECECEE))))
            Rectangle().fill(Color(nsColor: Tokens.srgb(body_ ?? (dark ? 0x1F1F24 : 0xFFFFFF))))
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.black.opacity(dark ? 0.6 : 0.15), lineWidth: 1))
    }
}

/// H5: Caret's voice over a real-looking document, in one face. `xcode` is a dark source editor
/// (SF Mono 12 on `#1F1F24`, Caret in dark appearance); `pages` a white page in Pages' default
/// body face, Helvetica Neue 13 (Caret in light appearance). Two carets: the offer under one, a
/// result under the other, each hung as the host hangs a slip, `x - 15` and 5 pt under the line.
/// The two faces differ only in the slips' words.
struct VoiceScene: View {
    enum Host: String, CaseIterable { case xcode, pages }

    var host: Host
    var face: Tokens.VoiceFace
    var character: FigureCharacter = .pebble

    static let size = CGSize(width: 860, height: 340)

    private var dark: Bool { host == .xcode }
    private var font: NSFont { dark ? .monospacedSystemFont(ofSize: 12, weight: .regular) : NSFont(name: "Helvetica Neue", size: 13) ?? .systemFont(ofSize: 13) }
    private var lineHeight: CGFloat { dark ? 18 : 20 }
    private var origin: CGPoint { CGPoint(x: dark ? 48 : 84, y: 64) }

    /// Plain lines of the document, each with its color runs.
    private var lines: [[(String, UInt32)]] {
        let plain: UInt32 = dark ? 0xDFDFE0 : 0x1D1D1F
        guard dark else {
            return [
                [("I'll grab coffee with Dana on Thursday at 3, then finish the draft", plain)],
                [("for Friday's review. The notes from Monday still need a pass", plain)],
                [("before they go out to the team.", plain)],
                [("", plain)],
                [("Ask Marcus about the room for the offsite.", plain)],
                [("Book the room for Thursday afternoon.", plain)],
                [("", plain)],
                [("Send the agenda on Wednesday.", plain)],
            ]
        }
        let key: UInt32 = 0xFC5FA3, str: UInt32 = 0xFC6A5D, note: UInt32 = 0x6C7986
        return [
            [("// Coffee with Dana on Thursday at 3", note)],
            [("func ", key), ("schedule(_ event: Event) {", plain)],
            [("    let ", key), ("title = ", plain), ("\"Coffee with Dana\"", str)],
            [("    calendar.add(event, at: ", plain), ("\"Thursday 3:00\"", str), (")", plain)],
            [("}", plain)],
            [("", plain)],
            [("// Book the room for Thursday afternoon", note)],
            [("let ", key), ("next = queue.first", plain)],
        ]
    }

    /// Where the caret sits: after `upTo` characters of line `row`.
    private func caret(row: Int, upTo: Int) -> CGRect {
        let text = lines[row].map(\.0).joined()
        let before = String(text.prefix(upTo))
        let width = (before as NSString).size(withAttributes: [.font: font]).width
        let h = ceil(font.ascender - font.descender)
        return CGRect(x: origin.x + width, y: origin.y + CGFloat(row) * lineHeight + (lineHeight - h) / 2, width: 1, height: h)
    }

    var body: some View {
        let offer = LineContent(figure: .offering, app: "Calendar", text: "Coffee with Dana, Thursday 3:00 to 3:30", hints: [Hint(key: "Tab")])
        let done = WorkLines.done(app: "Calendar", undo: true).content
        let first = caret(row: 0, upTo: dark ? 36 : 43)
        let second = caret(row: dark ? 6 : 5, upTo: dark ? 39 : 37)
        let ink = Color(nsColor: Tokens.srgb(dark ? 0xDFDFE0 : 0x1D1D1F))
        return ZStack(alignment: .topLeading) {
            Rectangle().fill(Color(nsColor: Tokens.srgb(dark ? 0x141416 : 0xD5D7DB)))
            HostWindow(title: dark ? "Scheduler.swift" : "Plans for the week", dark: dark, body_: dark ? 0x1F1F24 : 0xFFFFFF)
                .frame(width: Self.size.width - 40, height: Self.size.height - 30)
                .offset(x: 20, y: 15)
            ForEach(Array(lines.enumerated()), id: \.offset) { row, runs in
                runs.reduce(Text("")) { $0 + Text($1.0).foregroundColor(Color(nsColor: Tokens.srgb($1.1))) }
                    .font(Font(font))
                    .fixedSize()
                    .frame(height: lineHeight)
                    .offset(x: origin.x, y: origin.y + CGFloat(row) * lineHeight)
            }
            ForEach([first, second], id: \.minY) { c in
                Rectangle().fill(ink).frame(width: 1, height: c.height).offset(x: c.minX, y: c.minY)
            }
            LineView(content: offer, character: character, animated: false)
                .offset(x: first.minX - FieldPanelPlacement.caretInset, y: first.maxY + 5)
            LineView(content: done, character: character, animated: false)
                .offset(x: second.minX - FieldPanelPlacement.caretInset, y: second.maxY + 5)
        }
        .environment(\.voiceFace, face)
        .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
        .clipped()
    }
}

extension Gallery {
    /// The slip at each edge (A3).
    static func slipEdges(_ character: FigureCharacter = .pebble) -> [Item] {
        SlipEdgeScene.Edge.allCases.map { Item(name: "slip-edge-\($0.rawValue)", view: AnyView(SlipEdgeScene(edge: $0, character: character))) }
    }

    /// A long alternative in a narrow field: the figure and ticks are dropped, never wrapped, and
    /// the underline stops at the field (A3).
    static func alternativesEdges(_ character: FigureCharacter = .pebble) -> [Item] {
        let long = ["before lunch", "after the call and loop Dana in on the slides and the room booking for Thursday", "tonight", "tomorrow"]
        return [
            Item(name: "alternatives-long-open", view: AnyView(AlternativesScene(character: character, fieldWidth: 640, candidates: long))),
            Item(name: "alternatives-long-quoted", view: AnyView(AlternativesScene(character: character, collapsed: true, fieldWidth: 520,
                candidates: ["after the call and loop Dana in on the slides and the room booking", "x"]))),
        ]
    }

    /// The figure at every state and size.
    static func figures() -> [Item] {
        [Item(name: "figure-states", view: AnyView(FigureGalleryView()))]
    }

    /// H5's four images: two hosts, two faces. The host decides the theme (dark Xcode, light Pages).
    static func voice() -> [(name: String, dark: Bool, view: AnyView)] {
        VoiceScene.Host.allCases.flatMap { host in
            Tokens.VoiceFace.allCases.map { face in
                ("h5-\(host.rawValue)-\(face.rawValue)", host == .xcode, AnyView(VoiceScene(host: host, face: face)))
            }
        }
    }
}
