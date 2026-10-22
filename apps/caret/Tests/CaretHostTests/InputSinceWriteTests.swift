import XCTest
@testable import CaretHost

/// ⌘Z on an unconfirmed insert asks whether the user's input reached the app after the write ended. The mark at ⌘Z is
/// taken after the tap counted the ⌘Z, so a quiet user's mark is the write's plus exactly that key.
final class InputSinceWriteTests: XCTestCase {
    private let ended = HostStatus.InputMark(keys: 40, clicks: 2)

    private func since(_ undoKey: HostStatus.InputMark, heldKeys: Int = 0) -> Bool {
        InsertionExecutor.inputSinceWrite(InsertionExecutor.WriteEnd(mark: ended, heldKeys: heldKeys), atUndoKey: undoKey)
    }

    func testOnlyTheUndoKeyItselfIsQuiet() {
        XCTAssertFalse(since(HostStatus.InputMark(keys: 41, clicks: 2)))
    }

    func testAKeyTypedAfterTheWriteCounts() {
        XCTAssertTrue(since(HostStatus.InputMark(keys: 42, clicks: 2)), "\"t\" after \"Sea\", then ⌘Z")
    }

    func testAClickAfterTheWriteCounts() {
        XCTAssertTrue(since(HostStatus.InputMark(keys: 41, clicks: 3)))
    }

    /// Keys typed during the write were held and sent to the app as it ended; the tap never counted them.
    func testHeldKeysSentAsTheWriteEndedCount() {
        XCTAssertTrue(since(HostStatus.InputMark(keys: 41, clicks: 2), heldKeys: 1))
    }

    func testNoRecordOfTheWriteEndRefuses() {
        XCTAssertTrue(InsertionExecutor.inputSinceWrite(nil, atUndoKey: HostStatus.InputMark(keys: 41, clicks: 2)))
    }
}
