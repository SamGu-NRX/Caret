import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// L1: v41's page panel and its crop. Every state against its reference, light and dark; contrast from pixels for each
/// text token and mark over a white page, a dark editor and a busy striped page; what the crop marks for a row; and
/// where TextKit puts a span.
@MainActor
final class L1RenderTests: XCTestCase {
    func testL1StatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.l1())
    }

    /// v41 2.3's three hosts: a white page, a dark code editor, and a black-and-white striped page with saturated shapes.
    static let grounds: [(String, AnyView)] = [
        ("white page", AnyView(Color(nsColor: Tokens.srgb(0xFFFFFF)))),
        ("dark editor", AnyView(Color(nsColor: Tokens.srgb(0x1E1E1E)))),
        ("busy page", AnyView(BusyPage())),
    ]

    func testTextAndMarksMeetTheirContrastOverThreeHosts() throws {
        let text = 4.5, mark = 3.0
        let views = Dictionary(uniqueKeysWithValues: Gallery.l1().map { ($0.name, $0.view) })
        let surfaces: [(String, AnyView, [ContrastRenderTests.Probe])] = [
            ("Preview with crop", views["l1-page-task-preview"]!, [
                .init(name: "Ink, title, values, caption name", token: CaretColor.ink, minimum: text),
                .init(name: "Ink 2, labels, meta, owners, keys", token: CaretColor.ink2, minimum: text),
            ]),
            ("Progress", views["l1-page-task-progress"]!, [.init(name: "Carrot, writing rule and dot", token: CaretColor.carrot, minimum: mark)]),
            // The hand-off's crop shows its settled spans with no fade over them (a span under the window's top fade is
            // faded on purpose, and measures as such).
            ("Hand-off", views["l1-page-task-handoff"]!, [.init(name: "Pencil, settled underlines in the crop", token: CaretColor.pencil, minimum: mark),
                                                         .init(name: "Pencil thread at rest, over the page", token: CaretColor.pencilThread, minimum: 0)]),
            // Reported, not gated: the thread crosses the page itself between the panel and the crop.
            ("Progress, the thread", views["l1-page-task-progress"]!, [.init(name: "Carrot thread over the page (a tie, not the progress)", token: CaretColor.carrotThread, minimum: 0)]),
            ("Done", views["l1-page-task-done"]!, [.init(name: "Carrot text, the result word", token: CaretColor.carrotText, minimum: text)]),
            ("Next page, found nothing", views["l1-next-page-notfound"]!, [.init(name: "Ink 3, ring, bracket, dotted blank", token: CaretColor.ink3, minimum: mark)]),
            ("Opaque (Reduce Transparency)", views["l1-reduce-transparency"]!, [.init(name: "Ink 2", token: CaretColor.ink2, minimum: text)]),
        ]
        var table = ["| Surface | Token | Light, white | Light, dark editor | Light, busy | Dark, white | Dark, dark editor | Dark, busy | Needs |",
                     "|---|---|---|---|---|---|---|---|---|"]
        var failures: [String] = []
        for (surface, view, probes) in surfaces {
            for probe in probes {
                var cells: [String] = []
                for dark in [false, true] {
                    for (ground, backdrop) in Self.grounds {
                        let ratio = try Self.measure(view, token: probe.token, dark: dark, backdrop: backdrop)
                        cells.append(ratio.map { String(format: "%.2f", $0) } ?? "none drawn")
                        if let ratio, ratio < probe.minimum {
                            failures.append("\(surface), \(probe.name), \(dark ? "dark" : "light") over \(ground): \(String(format: "%.2f", ratio))")
                        }
                        if ratio == nil { failures.append("\(surface), \(probe.name): nothing drawn in that token") }
                    }
                }
                table.append("| \(surface) | \(probe.name) | " + cells.joined(separator: " | ") + " | \(probe.minimum == text ? "4.5 text" : probe.minimum == mark ? "3 mark" : "reported") |")
            }
        }
        if let out = SnapshotTests.outDir {
            try SnapshotTests.write(Data((table.joined(separator: "\n") + "\n").utf8), to: out.appendingPathComponent("contrast-l1.md"))
            for dark in [false, true] {
                for (ground, backdrop) in Self.grounds {
                    let data = try XCTUnwrap(Gallery.png(views["l1-page-task-preview"]!, dark: dark, backdrop: backdrop))
                    try SnapshotTests.write(data, to: out.appendingPathComponent("l1-over-\(ground.replacingOccurrences(of: " ", with: "-"))-\(dark ? "dark" : "light").png"))
                }
            }
        }
        XCTAssertEqual(failures, [], table.joined(separator: "\n"))
    }

    /// `ContrastRenderTests.measure` over a drawn backdrop: the weakest shape's ratio against what is behind it.
    static func measure(_ view: AnyView, token: NSColor, dark: Bool, backdrop: AnyView) throws -> Double? {
        let shown = try Pixels(XCTUnwrap(Gallery.png(view, dark: dark, backdrop: backdrop)))
        Tokens.hidden = token
        defer { Tokens.hidden = nil }
        let hidden = try Pixels(XCTUnwrap(Gallery.png(view, dark: dark, backdrop: backdrop)))
        precondition(shown.width == hidden.width && shown.height == hidden.height)
        var changed = [Bool](repeating: false, count: shown.width * shown.height)
        for i in changed.indices where Pixels.distance(shown.rgb(i), hidden.rgb(i)) > 6 { changed[i] = true }
        var seen = [Bool](repeating: false, count: changed.count)
        var weakest: Double?
        for start in changed.indices where changed[start] && !seen[start] {
            var stack = [start], members: [Int] = []
            seen[start] = true
            while let i = stack.popLast() {
                members.append(i)
                let x = i % shown.width, y = i / shown.width
                for dy in -1...1 { for dx in -1...1 {
                    let nx = x + dx, ny = y + dy
                    guard nx >= 0, ny >= 0, nx < shown.width, ny < shown.height else { continue }
                    let j = ny * shown.width + nx
                    if changed[j] && !seen[j] { seen[j] = true; stack.append(j) }
                }}
            }
            guard members.count >= 6 else { continue }
            var grounds: [Int: Int] = [:]
            func bucket(_ p: (Double, Double, Double)) -> Int { (Int(p.0) >> 3) << 10 | (Int(p.1) >> 3) << 5 | Int(p.2) >> 3 }
            for i in members { grounds[bucket(hidden.rgb(i)), default: 0] += 1 }
            let ground = grounds.max { $0.value < $1.value }!.key
            let best = members.filter { bucket(hidden.rgb($0)) == ground }.map { Pixels.contrast(shown.rgb($0), hidden.rgb($0)) }.max() ?? 0
            weakest = min(weakest ?? .infinity, best)
        }
        return weakest
    }

    // MARK: - The crop

    func testTheCropMarksTheRowsOfOneDrawing() throws {
        let panels = Dictionary(uniqueKeysWithValues: Gallery.l1Panels())
        let progress = try XCTUnwrap(panels["page-task-progress"])
        let writing = try XCTUnwrap(progress.sections[0].lines.first { $0.state == .writing })
        XCTAssertEqual(writing.label, "Start date")
        let content = try XCTUnwrap(PageTaskGroupView.cropContent(progress, step: try XCTUnwrap(writing.step)))
        guard case .source(let e, let kind, let app, let marks) = content.body else { return XCTFail("a source crop") }
        XCTAssertEqual(kind, .window)
        XCTAssertEqual(app, "Notes")
        XCTAssertEqual(e.spanText, "2026-10-20")
        // The rows written from the same note are settled marks; the writing row's is last and draws the rule.
        XCTAssertEqual(marks.last?.kind, .writing)
        XCTAssertEqual(marks.filter { $0.kind == .done }.count, 5, "Full name, Email, Phone, Country, and City, which was already so")
        // A row from another source, or a blank, gets its own crop; a row with no excerpt gets none.
        let preview = try XCTUnwrap(panels["page-task-preview"])
        let school = try XCTUnwrap(preview.sections[0].lines.first { $0.label == "School" }?.step)
        guard case .source(_, .memory?, nil, let only)? = PageTaskGroupView.cropContent(preview, step: school)?.body else { return XCTFail("a memory crop") }
        XCTAssertEqual(only.map(\.kind), [.focus])
        let why = try XCTUnwrap(preview.sections[0].lines.first { $0.kind == .blank }?.step)
        guard case .blank(_, .hatch, let sentence)? = PageTaskGroupView.cropContent(preview, step: why)?.body else { return XCTFail("a blank crop") }
        XCTAssertTrue(sentence.hasPrefix("'Why do you want to work here?' is yours to write"))
        let tick = try XCTUnwrap(preview.sections[0].lines.first { $0.kind == .step }?.step)
        XCTAssertNil(PageTaskGroupView.cropContent(preview, step: tick))
    }

    func testTextKitFindsTheSpanAndThePanShowsIt() throws {
        let text = "Robin's details\nRobin Vale\nrobin@example.test\n+1 512 555 0142\n123 King St W, Toronto, Ontario M5V 2T6, Canada\nCan start 2026-10-20"
        let span = (text as NSString).range(of: "2026-10-20")
        let layout = CropLayout(text: text, spans: [span], style: .of(kind: .window, pdf: false), width: 228)
        XCTAssertGreaterThan(layout.lines.count, 6, "the address wraps at the crop's width")
        let rect = try XCTUnwrap(layout.rects(span).first)
        let line = try XCTUnwrap(layout.line(of: span))
        XCTAssertEqual(rect.minY, layout.lines[line].top, accuracy: 0.5)
        XCTAssertTrue(layout.lines[line].text.contains("2026-10-20"))
        let pan = layout.pan(to: span, window: LookShape.cropWindow)
        XCTAssertGreaterThan(pan, 0)
        // A line's padding above a line top, never mid-line, unless the span's own line needs the drawing's very end.
        XCTAssertTrue(layout.lines.contains { $0.top - layout.style.top == pan } || pan == layout.height - LookShape.cropWindow, "pan \(pan)")
        XCTAssertLessThanOrEqual(rect.maxY - pan, LookShape.cropWindow, "the span is in the window")
        XCTAssertGreaterThanOrEqual(rect.minY - pan, 14, "and clear of the top fade")
        // A span higher up pans to a whole line.
        let phone = (text as NSString).range(of: "+1 512 555 0142")
        let p2 = CropLayout(text: text, spans: [phone], style: .of(kind: .window, pdf: false), width: 228).pan(to: phone, window: LookShape.cropWindow)
        XCTAssertTrue(layout.lines.contains { $0.top - layout.style.top == p2 }, "pan \(p2)")
    }
}

/// A black-and-white striped page with saturated shapes: the worst case behind translucent glass.
private struct BusyPage: View {
    var body: some View {
        Canvas { context, size in
            var x: CGFloat = 0
            while x < size.width {
                context.fill(Path(CGRect(x: x, y: 0, width: 6, height: size.height)), with: .color(.black))
                x += 12
            }
            let shapes: [(CGRect, Color)] = [(CGRect(x: 40, y: 60, width: 160, height: 160), .red), (CGRect(x: 260, y: 30, width: 120, height: 220), .blue),
                                             (CGRect(x: 420, y: 140, width: 200, height: 120), .yellow), (CGRect(x: 120, y: 300, width: 260, height: 90), .green)]
            for (r, c) in shapes { context.fill(Path(ellipseIn: r), with: .color(c)) }
        }
        .background(Color.white)
    }
}
