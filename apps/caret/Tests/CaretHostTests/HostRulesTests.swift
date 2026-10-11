import AutocompleteCore
import CaretHostCore
import CoreGraphics
import XCTest
@testable import CaretHost

final class KeyStrokeFromEventTests: XCTestCase {
    private func event(_ keyCode: CGKeyCode, text: String? = nil, flags: CGEventFlags = []) throws -> CGEvent {
        let event = try XCTUnwrap(CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true))
        event.flags = flags
        if let text {
            let units = Array(text.utf16)
            event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
        }
        return event
    }

    func testPlainTabIsTheAcceptKey() throws {
        XCTAssertTrue(KeyStroke(event: try event(48, text: "\t")).isPlainTab)
    }

    func testShiftTabIsNotTheAcceptKey() throws {
        let key = KeyStroke(event: try event(48, text: "\t", flags: .maskShift))
        XCTAssertFalse(key.isPlainTab)
        XCTAssertNil(key.text, "a tab character is a control, not typed text")
    }

    func testALetterCarriesItsText() throws {
        XCTAssertEqual(KeyStroke(event: try event(0, text: "a")).text, "a")
    }

    func testCommandAndControlChordsCarryNoText() throws {
        XCTAssertNil(KeyStroke(event: try event(1, text: "s", flags: .maskCommand)).text)
        XCTAssertNil(KeyStroke(event: try event(1, text: "s", flags: .maskControl)).text)
    }

    func testNavigationAndControlKeysCarryNoText() throws {
        XCTAssertNil(KeyStroke(event: try event(123, text: "\u{F702}")).text, "left arrow")
        XCTAssertNil(KeyStroke(event: try event(36, text: "\r")).text, "return")
        XCTAssertNil(KeyStroke(event: try event(51, text: "\u{7F}")).text, "delete")
    }
}

final class HostRulesTests: XCTestCase {
    private func field(_ value: String, caret: Int) -> FieldState {
        FieldState(
            identity: TargetIdentity(pid: 1, bundleID: "b", windowID: "w", elementID: "e", elementRevision: UTF16Text.digest(value)),
            value: value,
            selection: .caret(caret),
            role: "AXTextArea",
            secure: false
        )
    }

    private func context(before: String, after: String = "", endOfLine: Bool = true) -> TextFieldContext {
        TextFieldContext(
            beforeCursor: before,
            afterCursor: after,
            geometry: TextFieldGeometry(isAtEndOfLine: endOfLine),
            target: AppTarget(bundleIdentifier: "b", appName: "B")
        )
    }

    func testTheFieldAgreesWithAMatchingSnapshot() {
        XCTAssertTrue(HostCoordinator.fieldAgrees(field("Hello 👋 world", caret: 8), with: context(before: "Hello 👋", after: " world")))
    }

    func testTheFieldDisagreesWhenTheCaretDiffers() {
        XCTAssertFalse(HostCoordinator.fieldAgrees(field("Hello world", caret: 3), with: context(before: "Hello", after: " world")))
    }

    func testTheFieldDisagreesWhenTheCaretSplitsASurrogatePair() {
        XCTAssertFalse(HostCoordinator.fieldAgrees(field("👋", caret: 1), with: context(before: "")))
    }

    func testPresentationGateTiersMatchKeyType() {
        XCTAssertEqual(HostCoordinator.presentationGateNanos(lastGenerationMs: nil), 25_000_000)
        XCTAssertEqual(HostCoordinator.presentationGateNanos(lastGenerationMs: 70), 15_000_000)
        XCTAssertEqual(HostCoordinator.presentationGateNanos(lastGenerationMs: 140), 25_000_000)
        XCTAssertEqual(HostCoordinator.presentationGateNanos(lastGenerationMs: 141), 55_000_000)
    }

    func testCapsuleOnlyWhenTextFollowsOnTheSameLine() {
        XCTAssertFalse(GhostTextEngine.shouldUseCapsule(for: context(before: "Hi")))
        XCTAssertTrue(GhostTextEngine.shouldUseCapsule(for: context(before: "Hi", after: " there", endOfLine: false)))
        XCTAssertFalse(GhostTextEngine.shouldUseCapsule(for: context(before: "Hi", after: "\nNext", endOfLine: false)))
        XCTAssertFalse(GhostTextEngine.shouldUseCapsule(for: context(before: "Hi", after: " there", endOfLine: true)))
    }

    func testMidSentenceAnchorDropsASentenceTerminator() {
        let candidate = CompletionCandidate(text: " week.", mode: .prose)
        let continues = CompletionRequest(context: context(before: "call for next", after: " to go over it.", endOfLine: false), prompt: "")
        XCTAssertEqual(GhostTextEngine.anchorText(for: candidate, request: continues), " week")
        let newSentence = CompletionRequest(context: context(before: "call for next", after: " See you.", endOfLine: false), prompt: "")
        XCTAssertEqual(GhostTextEngine.anchorText(for: candidate, request: newSentence), " week.", "a capital may start a new sentence")
        let punctuation = CompletionRequest(context: context(before: "call for next", after: ", then", endOfLine: false), prompt: "")
        XCTAssertEqual(GhostTextEngine.anchorText(for: candidate, request: punctuation), " week.")
        let nextLine = CompletionRequest(context: context(before: "call for next", after: "\nNew line", endOfLine: false), prompt: "")
        XCTAssertEqual(GhostTextEngine.anchorText(for: candidate, request: nextLine), " week.")
    }

    func testAnchorTextDropsTrailingWhitespaceOnlyAtEndOfLine() {
        let candidate = CompletionCandidate(text: " there ", mode: .prose)
        let eol = CompletionRequest(context: context(before: "Hi"), prompt: "")
        XCTAssertEqual(GhostTextEngine.anchorText(for: candidate, request: eol), " there")
        let mid = CompletionRequest(context: context(before: "Hi", after: "friend", endOfLine: false), prompt: "")
        XCTAssertEqual(GhostTextEngine.anchorText(for: candidate, request: mid), " there ")
    }
}

final class DebugStateSocketTests: XCTestCase {
    func testOneRequestPerConnectionAndRefusesASecondServer() throws {
        let path = NSTemporaryDirectory() + "caret-test-\(UUID().uuidString.prefix(8)).sock"
        let socket = DebugStateSocket(path: path) { command in Data("{\"echo\":\"\(command)\"}".utf8) }
        try socket.start()
        defer { socket.stop() }

        XCTAssertEqual(try request("ping", path: path), "{\"echo\":\"ping\"}")
        XCTAssertEqual(try request("", path: path), "{\"echo\":\"state\"}", "an empty request means state")
        XCTAssertThrowsError(try DebugStateSocket(path: path) { _ in Data() }.start())
    }

    private func request(_ command: String, path: String) throws -> String {
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            let bytes = Array(path.utf8)
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(connected, 0)
        _ = command.withCString { write(fd, $0, strlen($0)) }
        Darwin.shutdown(fd, SHUT_WR)
        var reply = [UInt8]()
        var buffer = [UInt8](repeating: 0, count: 256)
        while true {
            let count = read(fd, &buffer, buffer.count)
            if count <= 0 { break }
            reply.append(contentsOf: buffer[0..<count])
        }
        return String(decoding: reply, as: UTF8.self)
    }
}
