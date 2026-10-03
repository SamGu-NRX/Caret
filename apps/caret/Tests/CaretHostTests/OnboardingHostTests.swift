import AppKit
import CaretHostCore
import XCTest
@testable import CaretHost

/// Onboarding's screens rendered off screen and compared with the committed references, the copy
/// rules checked against the source, the window's key mapping, and the hidden flow driven through
/// the debug socket's commands with a settings file of the test's own.
@MainActor
final class OnboardingHostTests: XCTestCase {
    func testEveryOnboardingScreenMatchesItsReference() throws {
        try SnapshotTests.check(Gallery.onboarding())
    }

    func testTheOtherCharactersRenderForReview() throws {
        guard let outDir = SnapshotTests.outDir else { return }
        for character in [FigureCharacter.seed, .wren] {
            for item in Gallery.onboarding(character) where ["onboarding-welcome", "onboarding-try-it"].contains(item.name) {
                for dark in [false, true] {
                    let data = try XCTUnwrap(Gallery.png(item.view, dark: dark))
                    try SnapshotTests.write(data, to: outDir.appendingPathComponent("\(character.rawValue)/\(item.name)-\(dark ? "dark" : "light").png"))
                }
            }
        }
    }

    /// The lead reads the copy line by line; this catches the rules a machine can: no em or en
    /// dashes, no exclamation marks in what is shown, no all-caps labels, and the privacy line says
    /// what is sent instead of claiming nothing leaves (Fable plan, section 5, change 4).
    func testOnboardingCopyFollowsTheRules() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .appendingPathComponent("../../Sources/CaretHost/Onboarding/OnboardingView.swift").standardized
        let text = try String(contentsOf: source, encoding: .utf8)
        XCTAssertFalse(text.contains("\u{2014}"), "em dash")
        XCTAssertFalse(text.contains("\u{2013}"), "en dash")
        XCTAssertFalse(text.contains("Text stays on this Mac"))
        XCTAssertTrue(text.contains("sends short snippets"))
        XCTAssertTrue(text.contains("Never whole windows."))
        let literals = try NSRegularExpression(pattern: #"(?:Text|Button|ScreenTitle\(title:|detail:|SectionLabel\(text:)\(?"([^"\\]*)""#)
        let shown = literals.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
        XCTAssertGreaterThan(shown.count, 12, "the pattern must find the copy")
        for line in shown {
            XCTAssertFalse(line.contains("!"), line)
            let letters = line.filter(\.isLetter)
            XCTAssertFalse(letters.count >= 2 && letters == letters.uppercased(), "all caps: \(line)")
        }
    }

    // MARK: - Keys

    private func key(_ code: UInt16, _ chars: String = "", mods: NSEvent.ModifierFlags = []) -> NSEvent {
        NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: 0, windowNumber: 0, context: nil,
                         characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code)!
    }

    func testTheWindowsKeysMapToTheFlowsEvents() {
        func map(_ e: NSEvent, _ step: OnboardingStep, offer: Bool = true) -> OnboardingFlow.Event? {
            OnboardingController.event(for: e, step: step, offerVisible: offer)
        }
        XCTAssertEqual(map(key(36, "\r"), .work), .next)
        XCTAssertEqual(map(key(53, "\u{1b}"), .permissions), .back)
        XCTAssertEqual(map(key(48, "\t"), .tryIt), .key(.tab))
        XCTAssertNil(map(key(48, "\t"), .tryIt, offer: false), "with no offer showing, Tab moves focus as usual")
        XCTAssertNil(map(key(48, "\t"), .work), "Tab moves focus on the other screens")
        XCTAssertNil(map(key(48, "\t", mods: .shift), .tryIt), "Shift-Tab is not the offer's key")
        XCTAssertNil(map(key(48, "\t", mods: .command), .tryIt))
        XCTAssertEqual(map(key(51, "\u{7f}"), .tryIt), .key(.delete))
        XCTAssertEqual(map(key(18, "1"), .tryIt), .key(.character("1")))
        XCTAssertNil(map(key(18, "1"), .work))
        XCTAssertEqual(map(key(123, "\u{F702}"), .tryIt), .key(.other), "an arrow is not typing")
    }

    func testClosingAnUnfinishedFlowLetsTheNextOpenStartAgain() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-onboarding-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let controller = OnboardingController(mode: .hidden, testHooks: true, store: SettingsStore(path: dir.appendingPathComponent("s.json").path))
        _ = controller.command(["onboarding", "open"])
        _ = controller.command(["onboarding", "next"])
        XCTAssertEqual(controller.debugInfo()?.step, "work")
        _ = controller.command(["onboarding", "close"])
        XCTAssertNil(controller.debugInfo())
        _ = controller.command(["onboarding", "open"])
        XCTAssertEqual(controller.debugInfo()?.step, "welcome")
        XCTAssertEqual(controller.debugInfo()?.windowShown, false)
    }

    // MARK: - The hidden flow over the socket's commands

    func testAHiddenFlowWalksOverTheSocketAndWritesTheChoices() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-onboarding-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = SettingsStore(path: dir.appendingPathComponent("settings.json").path)
        let controller = OnboardingController(mode: .hidden, testHooks: true, store: store)
        var asked: [FirstLookRequest] = []
        controller.sendFirstLook = { asked.append($0); return true }
        XCTAssertEqual(controller.command(["onboarding"]), #"{"open":false}"#)
        func run(_ line: String) throws -> DebugState.OnboardingInfo {
            let words = line.split(separator: " ", maxSplits: line.hasPrefix("onboarding reply") ? 2 : Int.max).map(String.init)
            let reply = controller.command(words)
            XCTAssertFalse(reply.contains("\"error\""), "\(line): \(reply)")
            return try JSONDecoder().decode(DebugState.OnboardingInfo.self, from: Data(reply.utf8))
        }
        XCTAssertEqual(try run("onboarding open").step, "welcome")
        _ = try run("onboarding permissions on off")
        _ = try run("onboarding next")
        _ = try run("onboarding role repeat off")
        XCTAssertEqual(try run("onboarding level quiet").level, "quiet")
        XCTAssertEqual(try run("onboarding next").step, "permissions")
        XCTAssertEqual(store.settings.roles, [.fill, .watch, .words], "the choices are saved on leaving the screen")
        XCTAssertEqual(store.settings.level, .quiet)
        XCTAssertEqual(try run("onboarding next").step, "tryIt")
        XCTAssertFalse(try run("onboarding key return").tryIt!.completed)
        XCTAssertTrue(try run("onboarding key tab").tryIt!.completed)
        let looking = try run("onboarding next")
        XCTAssertEqual(looking.firstLook, "asking")
        XCTAssertEqual(asked.map(\.families), [["fill", "pending"]])
        let reply = #"{"type":"firstLookReply","v":1,"requestId":"\#(asked[0].requestId)","at":1,"outcome":"nothing","found":null,"scanned":null,"error":null}"#
        XCTAssertEqual(try run("onboarding reply \(reply)").firstLook, "nothing")
        let done = try run("onboarding next")
        XCTAssertTrue(done.finished)
        XCTAssertEqual(done.windowShown, false)
        XCTAssertTrue(store.settings.onboarded)
        XCTAssertEqual(store.settings.memory.first { $0.key == "role.repeat" }?.value, "off")
        XCTAssertEqual(store.settings.memory.first?.source, .onboarding)
    }

    func testWithoutTestHooksTheSocketOnlyReads() {
        let controller = OnboardingController(mode: .hidden, testHooks: false, store: SettingsStore(path: "/nonexistent/caret-settings.json"))
        XCTAssertTrue(controller.command(["onboarding", "open"]).contains("test hooks"))
    }
}
