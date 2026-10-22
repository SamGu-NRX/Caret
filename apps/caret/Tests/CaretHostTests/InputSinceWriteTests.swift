import XCTest
@testable import CaretHost

/// ⌘Z on an unconfirmed insert asks whether the user's input reached the app from the Tab that asked for the write
/// on. The mark at ⌘Z is taken after the tap counted the ⌘Z, so a quiet user's mark is the write's plus exactly that key.
final class InputSinceWriteTests: XCTestCase {
    private let ended = HostStatus.InputMark(keys: 40, clicks: 2)

    private func since(_ undoKey: HostStatus.InputMark, heldKeys: Int = 0, atKey: HostStatus.InputMark? = nil) -> Bool {
        InsertionExecutor.inputSinceWrite(InsertionExecutor.WriteEnd(atKey: atKey ?? ended, mark: ended, heldKeys: heldKeys), atUndoKey: undoKey)
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

    /// The hold expired (3.5 s) while "Seattle" was typed key by key, so the person's "t" after "Sea" went to the app
    /// and the tap counted it, which stopped the write. It is inside the write-end mark, not after it.
    func testAKeyCountedDuringTheWriteCounts() {
        XCTAssertTrue(since(HostStatus.InputMark(keys: 41, clicks: 2), atKey: HostStatus.InputMark(keys: 39, clicks: 2)))
    }

    /// A click during the write dropped the hold (#61); the keys typed after it were counted, not held.
    func testAClickThatDroppedTheHoldDuringTheWriteCounts() {
        XCTAssertTrue(since(HostStatus.InputMark(keys: 41, clicks: 2), atKey: HostStatus.InputMark(keys: 38, clicks: 1)))
        XCTAssertTrue(since(HostStatus.InputMark(keys: 41, clicks: 2), atKey: HostStatus.InputMark(keys: 40, clicks: 1)), "the click alone")
    }

    func testNoRecordOfTheWriteEndRefuses() {
        XCTAssertTrue(InsertionExecutor.inputSinceWrite(nil, atUndoKey: HostStatus.InputMark(keys: 41, clicks: 2)))
    }
}
