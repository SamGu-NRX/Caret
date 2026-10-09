import CaretHostCore
import XCTest
@testable import CaretHost

/// The rewrite key, ⌃⌥R, is Caret's own: the tap takes it and asks for rewrites in the app it went to.
final class RewriteKeyTests: XCTestCase {
    final class Pids: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [Int32] = []
        func add(_ pid: Int32) { lock.lock(); list.append(pid); lock.unlock() }
        var value: [Int32] { lock.lock(); defer { lock.unlock() }; return list }
    }

    func testOnlyControlOptionRIsTheRewriteKey() {
        XCTAssertTrue(KeyStroke(keyCode: 15, control: true, option: true).isRewriteRequest)
        XCTAssertFalse(KeyStroke(keyCode: 15, option: true).isRewriteRequest, "⌥R types ®")
        XCTAssertFalse(KeyStroke(keyCode: 15, control: true).isRewriteRequest)
        XCTAssertFalse(KeyStroke(keyCode: 15, command: true, control: true, option: true).isRewriteRequest)
        XCTAssertFalse(KeyStroke(keyCode: 15, control: true, option: true, shift: true).isRewriteRequest)
    }

    func testTheTapTakesItAndNamesTheApp() {
        let asked = Pids()
        let tap = TapThread(arbiter: OfferArbiter(), callbacks: .init(
            claimed: { _ in }, offerChanged: { _, _ in }, undo: { _ in }, keyDown: { _ in }, rewrite: { asked.add($0) }
        ))
        XCTAssertTrue(tap.route(KeyStroke(keyCode: 15, control: true, option: true, targetPID: 7)), "consumed: it never reaches the app")
        XCTAssertFalse(tap.route(KeyStroke(keyCode: 15, option: true, text: "®", targetPID: 7)), "⌥R still types")
        XCTAssertEqual(asked.value, [7])
    }
}
