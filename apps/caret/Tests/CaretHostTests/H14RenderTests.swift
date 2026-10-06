import AppKit
import CaretHostCore
import SwiftUI
import XCTest
@testable import CaretHost

/// H14's states against their references, light and dark: the attach rows, the save line, the Files group and the
/// Sites switches. Contrast is measured from rendered pixels for every text token each one draws, as
/// `ContrastRenderTests` measures them.
@MainActor
final class H14RenderTests: XCTestCase {
    func testH14StatesMatchTheirReferences() throws {
        try SnapshotTests.check(Gallery.h14())
    }

    func testTheirTextMeetsItsContrastInBothThemes() throws {
        let text = 4.5
        let views = Dictionary(uniqueKeysWithValues: Gallery.h14().map { ($0.name, $0.view) })
        let surfaces: [(String, AnyView, [ContrastRenderTests.Probe])] = [
            // L1: the page task panel draws in v41's tokens (`CaretColor`); a user's own step is Ink in Medium, not Carrot.
            ("Attach, choose", views["page-task-attach-choose"]!, [
                .init(name: "Ink, title and values", token: CaretColor.ink, minimum: text),
                .init(name: "Ink 2, labels and keys", token: CaretColor.ink2, minimum: text),
                .init(name: "Carrot text, Choose a file…", token: CaretColor.carrotText, minimum: text),
            ]),
            ("Attach, saved offered", views["page-task-attach-saved"]!, [.init(name: "Ink, file name and date", token: CaretColor.ink, minimum: text)]),
            ("Attach, confirmed", views["page-task-attach-confirmed"]!, [.init(name: "Ink 2, paperclip and ⌘2 Change", token: CaretColor.ink2, minimum: text)]),
            ("Attach, refused", views["page-task-attach-refused"]!, [.init(name: "Ink, why the file was not taken", token: CaretColor.ink, minimum: text)]),
            ("Attach, running", views["page-task-attach-running"]!, [.init(name: "Ink, attach yourself", token: CaretColor.ink, minimum: text)]),
            ("Save line", views["file-save-offer"]!, [.init(name: "Ink, the question", token: Tokens.ink, minimum: text),
                                                      .init(name: "Ink 2, ⌘1 Save and Esc", token: Tokens.ink2, minimum: text)]),
            ("Save line, kept", views["file-save-saved"]!, [.init(name: "Ink, the helper's sentence", token: Tokens.ink, minimum: text)]),
            ("Files", views["memory-files"]!, [.init(name: "Ink, file names", token: Tokens.ink, minimum: text),
                                               .init(name: "Ink 2, what it was kept for, missing file", token: Tokens.ink2, minimum: text)]),
            // The two rows alone on the window's ground: the Sites tab around them also draws H5's disabled "Not on this
            // site" button in Ink at reduced opacity, which a disabled control may (WCAG 1.4.3 exempts it).
            ("Switches", Self.switchRows, [.init(name: "Ink, switch names", token: Tokens.ink, minimum: text),
                                           .init(name: "Ink 2, what each does", token: Tokens.ink2, minimum: text)]),
        ]
        var table = ["| Surface | Token | Light, white page | Light, dark editor | Dark, white page | Dark, dark editor | Needs |", "|---|---|---|---|---|---|---|"]
        var failures: [String] = []
        for (surface, view, probes) in surfaces {
            for probe in probes {
                var cells: [String] = []
                for dark in [false, true] {
                    for (ground, hex) in ContrastRenderTests.grounds {
                        let ratio = try ContrastRenderTests.measure(view, token: probe.token, dark: dark, canvas: hex)
                        cells.append(ratio.map { String(format: "%.2f", $0) } ?? "none drawn")
                        if let ratio, ratio < probe.minimum {
                            failures.append("\(surface), \(probe.name), \(dark ? "dark" : "light") over \(ground): \(String(format: "%.2f", ratio))")
                        }
                        if ratio == nil { failures.append("\(surface), \(probe.name): nothing drawn in that token") }
                    }
                }
                table.append("| \(surface) | \(probe.name) | " + cells.joined(separator: " | ") + " | 4.5 text |")
            }
        }
        if let out = SnapshotTests.outDir {
            try SnapshotTests.write(Data((table.joined(separator: "\n") + "\n").utf8), to: out.appendingPathComponent("contrast-h14.md"))
        }
        XCTAssertEqual(failures, [], table.joined(separator: "\n"))
    }

    static var switchRows: AnyView {
        AnyView(VStack(alignment: .leading, spacing: 0) {
            SwitchRow(title: PageInlineCopy.webPages, detail: PageInlineCopy.webPagesDetail, isOn: true) { _ in }
            SwitchRow(title: PageInlineCopy.richEditors, detail: PageInlineCopy.richEditorsDetail, isOn: false) { _ in }
        }
        .padding(.horizontal, 32)
        .frame(width: MemoryView.size.width)
        .background(Color(token: Tokens.window)))
    }

    func testTheWordsUseNoDashesAndNameTheFileWhole() {
        for s in [PageTaskCopy.choose, PageTaskCopy.chooseFirst, SavedFilesCopy.intro, SavedFilesCopy.empty, SavedFilesCopy.forgetQuestion,
                  PageInlineCopy.webPagesDetail, PageInlineCopy.richEditorsDetail, FileSaveCopy.saving.text, FileSaveCopy.unanswered.text] {
            XCTAssertFalse(s.contains("—"), s)
            XCTAssertFalse(s.contains(" - "), s)
        }
        let panels = Dictionary(uniqueKeysWithValues: Gallery.h14Panels())
        let saved = panels["page-task-attach-saved"]!.sections[0].lines.first { $0.attach?.step == 2 }
        XCTAssertEqual(saved?.text, "Robin Vale Resume.pdf, edited Tue")
    }

    func testTheOpenPanelTakesTheControlsTypes() throws {
        let pdfs = try XCTUnwrap(PageTaskCoordinator.contentTypes(AcceptTypes([".pdf", ".doc", ".docx"])))
        XCTAssertEqual(pdfs.map(\.preferredFilenameExtension), ["pdf", "doc", "docx"])
        XCTAssertEqual(PageTaskCoordinator.contentTypes(AcceptTypes(["image/*", "application/pdf"])), [.image, .pdf])
        // Any file: the control names none, or names one the Mac has no type for.
        XCTAssertNil(PageTaskCoordinator.contentTypes(AcceptTypes([])))
        XCTAssertNil(PageTaskCoordinator.contentTypes(AcceptTypes(["application/x-caret-unknown"])))
    }

    func testAPickedFileIsNamedWholeWithItsDate() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-h14-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("Robin Vale Resume (final, 2026).pdf")
        try Data("%PDF-1.4\n".utf8).write(to: url)
        let when = Date(timeIntervalSince1970: 1_789_481_760)
        try FileManager.default.setAttributes([.modificationDate: when], ofItemAtPath: url.path)
        let file = try XCTUnwrap(PageTaskCoordinator.attachFile(url))
        XCTAssertEqual(file.name, "Robin Vale Resume (final, 2026).pdf")
        XCTAssertEqual(file.path, url.path)
        XCTAssertEqual(file.edited, 1_789_481_760_000)
    }
}
