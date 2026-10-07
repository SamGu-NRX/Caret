import XCTest
@testable import CaretHostCore

/// S2: S1's ruling for the host's own inserts. The write itself runs in `InsertionExecutor`
/// against Accessibility and posted keys; these tests drive the decisions it delegates here: what a
/// read after an unconfirmed write is, which grant the write leaves, and what ⌘Z may do with the
/// field as it reads at the key.
final class UnconfirmedInsertTests: XCTestCase {
    // MARK: - Rig

    private static func identity(_ value: String, element: String = "body") -> TargetIdentity {
        TargetIdentity(pid: 5150, bundleID: "dev.caret.fixture", windowID: "w41", elementID: element, elementRevision: UTF16Text.digest(value))
    }

    private static func live(_ value: String, element: String = "body") -> InsertionGuard.LiveField {
        InsertionGuard.LiveField(target: identity(value, element: element), value: value)
    }

    /// The approved edit for `intent`, as `InsertionGuard.approve` builds it.
    private static func edit(_ intent: UnconfirmedInsert.Intent) -> InsertionGuard.ApprovedEdit {
        let head = UTF16Text.slice(intent.before, start: 0, end: intent.start)!
        let tail = UTF16Text.slice(intent.before, start: intent.end, end: UTF16Text.length(intent.before))!
        return InsertionGuard.ApprovedEdit(
            target: identity(intent.before), replaceStart: intent.start, replaceEnd: intent.end, replacement: intent.replacement,
            resultingValue: head + intent.replacement + tail
        )
    }

    /// The grant `InsertionExecutor.run` arms before it writes.
    private static func armed(_ intent: UnconfirmedInsert.Intent) -> UndoGrant {
        UndoGrant.armed(target: identity(intent.before), priorValue: intent.before, edit: edit(intent), origin: nil, writeID: 1)
    }

    /// The grant a write leaves once a read after it found `held`.
    private static func left(_ intent: UnconfirmedInsert.Intent, held: String) -> UndoGrant? {
        UnconfirmedInsert.grant(armed: armed(intent), verified: false, report: UnconfirmedInsert.read(intent, held: held))
    }

    /// What the field holds after `runUndo` writes the revert: the span replaced by `restore`.
    private static func apply(_ revert: UndoGuard.Revert, to held: String) -> String {
        UTF16Text.slice(held, start: 0, end: revert.start)! + revert.restore
            + UTF16Text.slice(held, start: revert.start + revert.length, end: UTF16Text.length(held))!
    }

    /// The first `units` UTF-16 units of `text`, or nil inside a surrogate pair.
    private static func prefix(_ text: String, _ units: Int) -> String? { UTF16Text.slice(text, start: 0, end: units) }

    // MARK: - The shared table

    private struct Table: Decodable {
        struct Case: Decodable {
            var name: String
            var before: String
            var start: Int
            var end: Int
            var replacement: String
            var held: String
            var state: String
            var inserted: Int?
        }
        var cases: [Case]
    }

    private static let table: Table = {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/unconfirmed-inserts.json")
        return try! JSONDecoder().decode(Table.self, from: Data(contentsOf: url))
    }()

    func testTheSharedTableClassifiesAsTheExtensionDoes() {
        XCTAssertGreaterThan(Self.table.cases.count, 15)
        for c in Self.table.cases {
            let intent = UnconfirmedInsert.Intent(before: c.before, start: c.start, end: c.end, replacement: c.replacement)
            let expected: UnconfirmedInsert.State
            switch c.state {
            case "original": expected = .original
            case "whole": expected = .whole
            case "partial": expected = .partial(inserted: c.inserted!)
            default: expected = .unrecognized
            }
            XCTAssertEqual(UnconfirmedInsert.classify(intent, held: c.held), expected, c.name)
        }
    }

    /// Every row through the grant and ⌘Z: a recognized partial or whole field goes back to exactly
    /// what it held; any other state leaves no grant, and an unconfirmed grant refuses it at the key.
    func testTheSharedTableThroughTheGrantAndUndo() {
        for c in Self.table.cases {
            let intent = UnconfirmedInsert.Intent(before: c.before, start: c.start, end: c.end, replacement: c.replacement)
            let grant = Self.left(intent, held: c.held)
            var probe = Self.armed(intent)
            probe.unconfirmed = true
            let atKey = UndoGuard.approve(probe, live: Self.live(c.held))
            switch c.state {
            case "partial", "whole":
                XCTAssertNotNil(grant, c.name)
                XCTAssertEqual(grant?.partialWrite, c.state == "partial", c.name)
                guard case .success(let revert)? = grant.map({ UndoGuard.approve($0, live: Self.live(c.held)) }) else { return XCTFail(c.name) }
                XCTAssertEqual(Self.apply(revert, to: c.held), c.before, c.name)
                XCTAssertEqual(revert.expectedValue, c.before, c.name)
            case "original":
                XCTAssertNil(grant, c.name)
                XCTAssertEqual(atKey, .failure(.nothingWritten), c.name)
            default:
                XCTAssertNil(grant, c.name)
                XCTAssertEqual(atKey, .failure(.fieldChanged), c.name)
            }
        }
    }

    // MARK: - Character injection stopped after k characters

    /// KeyType's character injection types one character per posted key; a stop or a lost grant
    /// ends it after k of them. Every k: none is nothing to undo, all is ordinary undo, and any
    /// other is a partial write ⌘Z takes out, back to the exact original, text after the caret included.
    func testAnInjectionStoppedAfterKCharactersIsRecognizedAndUndoneForEveryK() {
        let intent = UnconfirmedInsert.Intent(before: "Thanks,  for the notes.", start: 8, end: 8, replacement: "Dana")
        let n = UTF16Text.length(intent.replacement)
        for k in 0...n {
            let held = "Thanks, " + Self.prefix(intent.replacement, k)! + " for the notes."
            let report = UnconfirmedInsert.read(intent, held: held)
            let grant = UnconfirmedInsert.grant(armed: Self.armed(intent), verified: false, report: report)
            switch k {
            case 0:
                XCTAssertEqual(report.state, .original)
                XCTAssertNil(grant, "k = 0: nothing landed")
            case n:
                XCTAssertEqual(report.state, .whole)
                XCTAssertEqual(grant?.unconfirmed, false, "the whole text read back: ordinary undo")
            default:
                XCTAssertEqual(report.state, .partial(inserted: k))
                XCTAssertEqual(grant?.partialWrite, true)
                XCTAssertEqual(grant?.unconfirmed, true)
            }
            guard let grant else { continue }
            guard case .success(let revert) = UndoGuard.approve(grant, live: Self.live(held)) else { return XCTFail("k = \(k)") }
            XCTAssertEqual(revert.start, 8)
            XCTAssertEqual(revert.length, k)
            XCTAssertEqual(revert.partialWrite, k < n)
            XCTAssertEqual(Self.apply(revert, to: held), intent.before, "k = \(k)")
        }
    }

    /// A report names no field text, so the debug socket can carry it.
    func testTheReportNamesItsStateWithoutText() {
        let intent = UnconfirmedInsert.Intent(before: "", start: 0, end: 0, replacement: "Dana")
        XCTAssertEqual(UnconfirmedInsert.read(intent, held: "").name, "original")
        XCTAssertEqual(UnconfirmedInsert.read(intent, held: "Dana").name, "whole")
        XCTAssertEqual(UnconfirmedInsert.read(intent, held: "Da").name, "partial")
        XCTAssertEqual(UnconfirmedInsert.read(intent, held: "Dx").name, "unrecognized")
        XCTAssertEqual(UnconfirmedInsert.read(intent, held: nil).name, "unreadable")
    }

    // MARK: - Chunked injection revoked between chunks

    /// Chunked string injection posts the text in pieces; a revoke between chunks leaves whole
    /// chunks. Keys already posted can still land after Caret's read, so ⌘Z judges the field as it
    /// reads at the key: one more chunk, or all of them, still goes back to the original.
    func testARevokeBetweenChunksIsUndoneEvenIfMoreChunksLandAfterTheRead() {
        let intent = UnconfirmedInsert.Intent(before: "Re: ", start: 4, end: 4, replacement: "the quarterly report")
        let chunk = 4
        for landed in 1 ..< 5 {
            let held = "Re: " + Self.prefix(intent.replacement, landed * chunk)!
            guard let grant = Self.left(intent, held: held) else { return XCTFail("chunk \(landed)") }
            XCTAssertTrue(grant.partialWrite)
            for later in [landed * chunk + chunk, UTF16Text.length(intent.replacement)] {
                let atKey = "Re: " + Self.prefix(intent.replacement, later)!
                guard case .success(let revert) = UndoGuard.approve(grant, live: Self.live(atKey)) else { return XCTFail("chunk \(landed), \(later) at the key") }
                XCTAssertEqual(revert.length, later)
                XCTAssertEqual(Self.apply(revert, to: atKey), "Re: ")
            }
            // Fewer characters at the key than Caret read is still a prefix of its own text.
            let shorter = "Re: " + Self.prefix(intent.replacement, landed * chunk - 1)!
            if case .success(let revert) = UndoGuard.approve(grant, live: Self.live(shorter)) {
                XCTAssertEqual(Self.apply(revert, to: shorter), "Re: ")
            } else {
                XCTFail("a shorter prefix is still only Caret's characters")
            }
        }
    }

    /// Once the field reads as before (the app dropped what was posted), ⌘Z has nothing to do and
    /// says so instead of writing.
    func testAPartialGrantWhoseFieldIsBackToTheOriginalWritesNothing() {
        let intent = UnconfirmedInsert.Intent(before: "Re: ", start: 4, end: 4, replacement: "report")
        let grant = Self.left(intent, held: "Re: rep")!
        XCTAssertEqual(UndoGuard.approve(grant, live: Self.live("Re: ")), .failure(.nothingWritten))
        XCTAssertEqual(UndoGuard.Rejection.nothingWritten.code, "nothingWritten")
    }

    // MARK: - The user types elsewhere in the field during a stop

    /// The user typed while Caret's injection was stopped: before the insert, after it, or inside
    /// Caret's own characters. None is S1's recognized state, so no grant is left, the result says
    /// exactly what the field holds and held, and an unconfirmed grant refuses it at the key.
    func testTypingElsewhereInTheFieldDuringAStopLeavesItAlone() {
        let intent = UnconfirmedInsert.Intent(before: "Hi ,\nsee you", start: 3, end: 3, replacement: "Dana")
        for held in ["Hi! Da,\nsee you", "Hi Da,\nsee you!", "Hi Dxa,\nsee you", "Hi Da,\nsee yo"] {
            let report = UnconfirmedInsert.read(intent, held: held)
            XCTAssertEqual(report.state, .unrecognized, held)
            XCTAssertNil(UnconfirmedInsert.grant(armed: Self.armed(intent), verified: false, report: report), held)
            var probe = Self.armed(intent)
            probe.unconfirmed = true
            XCTAssertEqual(UndoGuard.approve(probe, live: Self.live(held)), .failure(.fieldChanged), held)
        }
        let report = UnconfirmedInsert.read(intent, held: "Hi! Da,\nsee you")
        XCTAssertEqual(report.says, #"the field now holds "Hi! Da,\nsee you"; before the write it held "Hi ,\nsee you"; Caret left it as it is"#)
        XCTAssertEqual(
            UnconfirmedInsert.read(intent, held: nil).says,
            #"Caret could not read the field after writing it; before the write it held "Hi ,\nsee you""#
        )
        XCTAssertNil(UnconfirmedInsert.read(intent, held: "Hi Da,\nsee you").says, "a recognized state needs no words")
    }

    /// The user typed after the read, into a field Caret had read as partial: the grant refuses it
    /// at the key, and nothing of theirs is written over.
    func testTypingAfterAPartialReadIsRefusedAtTheKey() {
        let intent = UnconfirmedInsert.Intent(before: "", start: 0, end: 0, replacement: "Dana")
        let grant = Self.left(intent, held: "Da")!
        for typed in ["Dax", "xDa", "D a", ""] {
            XCTAssertEqual(UndoGuard.approve(grant, live: Self.live(typed)), typed.isEmpty ? .failure(.nothingWritten) : .failure(.fieldChanged), typed)
        }
    }

    // MARK: - A selection replaced partway

    /// An AX replacement of a selection, or typing over it, that stopped partway: the selection's
    /// text is gone and a prefix of the new text stands in its place. ⌘Z takes the prefix out and
    /// puts the selection's text back.
    func testASelectionReplacedPartwayIsPutBack() {
        let intent = UnconfirmedInsert.Intent(before: "Hello world, again", start: 6, end: 11, replacement: "there")
        for k in 1 ..< 5 {
            let held = "Hello " + Self.prefix("there", k)! + ", again"
            guard let grant = Self.left(intent, held: held) else { return XCTFail("k = \(k)") }
            XCTAssertEqual(grant.replacedText, "world")
            guard case .success(let revert) = UndoGuard.approve(grant, live: Self.live(held)) else { return XCTFail("k = \(k)") }
            XCTAssertEqual(revert, UndoGuard.Revert(start: 6, length: k, expectedValue: intent.before, restore: "world", partialWrite: true))
            XCTAssertEqual(Self.apply(revert, to: held), intent.before)
        }
        XCTAssertNil(Self.left(intent, held: "Hello , again"), "the selection gone and nothing typed may be the user's Delete")
    }

    /// A verified fill over a selection is undone with the selection's text put back; before S2 the
    /// span check refused it (spanInvalid), since it compared against an insert at the caret only.
    func testAVerifiedReplacementOfASelectionIsUndoneWithTheSelectionsText() {
        let intent = UnconfirmedInsert.Intent(before: "Hello world", start: 6, end: 11, replacement: "there")
        let grant = UnconfirmedInsert.grant(armed: Self.armed(intent), verified: true, report: nil)!
        guard case .success(let revert) = UndoGuard.approve(grant, live: Self.live("Hello there")) else { return XCTFail("refused") }
        XCTAssertEqual(Self.apply(revert, to: "Hello there"), "Hello world")
        XCTAssertFalse(revert.partialWrite)
    }

    // MARK: - Which grant a write leaves

    func testAVerifiedOrWholeWriteKeepsOrdinaryUndoThatAShorteningUserDefeats() {
        let intent = UnconfirmedInsert.Intent(before: "", start: 0, end: 0, replacement: "Dana")
        for grant in [
            UnconfirmedInsert.grant(armed: Self.armed(intent), verified: true, report: nil),
            Self.left(intent, held: "Dana"),
        ] {
            XCTAssertEqual(grant?.unconfirmed, false)
            XCTAssertEqual(grant?.partialWrite, false)
            // S1 review: an exact read-back the user then shortened is the user's edit, not a partial write.
            XCTAssertEqual(grant.map { UndoGuard.approve($0, live: Self.live("Da")) }, .failure(.fieldChanged))
        }
    }

    /// The armed grant carries the field as approved: the written element's revision, the prior
    /// value and the replaced text, so it is complete before the write starts.
    func testTheArmedGrantRecordsTheFieldBeforeTheWrite() {
        let intent = UnconfirmedInsert.Intent(before: "Hello world", start: 6, end: 11, replacement: "there")
        let grant = Self.armed(intent)
        XCTAssertEqual(grant.priorValue, "Hello world")
        XCTAssertEqual(grant.writtenValue, "Hello there")
        XCTAssertEqual(grant.target.elementRevision, UTF16Text.digest("Hello there"))
        XCTAssertEqual(grant.insertedStart, 6)
        XCTAssertEqual(grant.insertedLength, 5)
        XCTAssertEqual(grant.replacedText, "world")
        XCTAssertEqual(grant.intent, intent)
        XCTAssertEqual(grant.writeID, 1)
    }

    /// A grant whose recorded fields disagree is a bug, never something ⌘Z acts on.
    func testAnUnconfirmedGrantWithAnInconsistentSpanIsRefused() {
        let intent = UnconfirmedInsert.Intent(before: "ab", start: 1, end: 1, replacement: "XY")
        var grant = Self.left(intent, held: "aXb")!
        grant.replacedText = "q"
        XCTAssertNil(grant.intent)
        XCTAssertEqual(UndoGuard.approve(grant, live: Self.live("aXb")), .failure(.spanInvalid))
        let moved = Self.left(intent, held: "aXb")!
        XCTAssertEqual(UndoGuard.approve(moved, live: Self.live("aXb", element: "other")), .failure(.targetMoved))
        var secure = Self.live("aXb")
        secure.secure = true
        XCTAssertEqual(UndoGuard.approve(moved, live: secure), .failure(.secureField))
    }

    func testQuotingMatchesJSONStringify() {
        XCTAssertEqual(UnconfirmedInsert.quoted(""), #""""#)
        XCTAssertEqual(UnconfirmedInsert.quoted("a \"b\" \\ c/d"), #""a \"b\" \\ c/d""#)
        XCTAssertEqual(UnconfirmedInsert.quoted("line\nnext\ttab\r\u{08}\u{0C}\u{01}"), #""line\nnext\ttab\r\b\f\u0001""#)
        XCTAssertEqual(UnconfirmedInsert.quoted("é 😀"), "\"é 😀\"")
    }

    // MARK: - Property: no unrecognized state is ever changed

    /// SplitMix64, seeded, so a failure names a reproducible case.
    private struct Seeded: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// The ruling written out by brute force, over every prefix length, as an oracle.
    private static func oracle(_ intent: UnconfirmedInsert.Intent, held: String) -> UnconfirmedInsert.State {
        if held == intent.before { return .original }
        let head = UTF16Text.slice(intent.before, start: 0, end: intent.start)!
        let tail = UTF16Text.slice(intent.before, start: intent.end, end: UTF16Text.length(intent.before))!
        let n = UTF16Text.length(intent.replacement)
        if Array(held.utf16) == Array((head + intent.replacement + tail).utf16) { return .whole }
        for k in stride(from: n - 1, through: 1, by: -1) {
            guard let p = prefix(intent.replacement, k) else { continue }
            if Array(held.utf16) == Array((head + p + tail).utf16) { return .partial(inserted: k) }
        }
        return .unrecognized
    }

    /// Thousands of random fields, edits and reads: recognized reads, the user's edits on top of
    /// them, and unrelated text. The classifier agrees with the oracle; whatever it does not
    /// recognize leaves no grant and is refused at the key, so it is never changed; whatever it
    /// recognizes goes back to exactly the recorded original.
    func testPropertyNoUnrecognizedFieldIsEverChanged() {
        var rng = Seeded(state: 0x5_2026_1007)
        let alphabet: [String] = ["a", "b", " ", "é", "\n", "😀", "ab"]
        let single = alphabet.filter { $0.count == 1 }
        func text(_ max: Int) -> String { (0 ..< Int.random(in: 0 ... max, using: &rng)).map { _ in alphabet.randomElement(using: &rng)! }.joined() }
        func mutate(_ s: String) -> String {
            var chars = Array(s)
            switch Int.random(in: 0 ..< 3, using: &rng) {
            case 0: chars.insert(Character(single.randomElement(using: &rng)!), at: Int.random(in: 0 ... chars.count, using: &rng))
            case 1 where !chars.isEmpty: chars.remove(at: Int.random(in: 0 ..< chars.count, using: &rng))
            default: if !chars.isEmpty { chars[Int.random(in: 0 ..< chars.count, using: &rng)] = "z" }
            }
            return String(chars)
        }
        var counts: [String: Int] = [:]
        for _ in 0 ..< 4000 {
            let before = text(6)
            let chars = Array(before)
            let a = Int.random(in: 0 ... chars.count, using: &rng)
            let b = Int.random(in: a ... chars.count, using: &rng)
            let start = UTF16Text.length(String(chars[..<a]))
            let end = UTF16Text.length(String(chars[..<b]))
            let intent = UnconfirmedInsert.Intent(before: before, start: start, end: end, replacement: text(5))
            let head = String(chars[..<a]), tail = String(chars[b...])
            let r = Array(intent.replacement)
            let k = Int.random(in: 0 ... r.count, using: &rng)
            let recognized = head + String(r[..<k]) + tail
            let candidates = [recognized, mutate(recognized), mutate(before), text(8), before]
            for held in candidates {
                let state = UnconfirmedInsert.classify(intent, held: held)
                XCTAssertEqual(state, Self.oracle(intent, held: held), "\(intent) held \(held.debugDescription)")
                let grant = Self.left(intent, held: held)
                var probe = Self.armed(intent)
                probe.unconfirmed = true
                switch state {
                case .original, .unrecognized:
                    counts[state == .original ? "original" : "unrecognized", default: 0] += 1
                    XCTAssertNil(grant)
                    guard case .failure = UndoGuard.approve(probe, live: Self.live(held)) else {
                        return XCTFail("an unrecognized field was approved for a write: \(intent) held \(held.debugDescription)")
                    }
                case .whole, .partial:
                    counts[state == .whole ? "whole" : "partial", default: 0] += 1
                    guard let grant, case .success(let revert) = UndoGuard.approve(grant, live: Self.live(held)) else {
                        return XCTFail("a recognized field was not undone: \(intent) held \(held.debugDescription)")
                    }
                    XCTAssertEqual(Self.apply(revert, to: held), before)
                }
            }
        }
        // Each state is exercised, or the property says nothing about it.
        for state in ["original", "whole", "partial", "unrecognized"] { XCTAssertGreaterThan(counts[state] ?? 0, 100, state) }
    }
}
