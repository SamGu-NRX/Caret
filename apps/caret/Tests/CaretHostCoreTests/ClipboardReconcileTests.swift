import XCTest
@testable import CaretHostCore

/// Paste, then reconcile (Sam's decision of 2026-10-04), against a pasteboard that counts changes the
/// way `NSPasteboard` does: each clear moves the count by one. `GeneralPasteboardTests` checks that
/// premise against a real, private named pasteboard.
final class ClipboardReconcileTests: XCTestCase {
    final class FakePasteboard: PasteboardBackend {
        var changeCount = 100
        var items: [PasteboardItemData] = []
        /// Items the pasteboard holds and reports the types of, but that a read of its items does not
        /// list: what Caret's read of the general pasteboard saw in V1b's VM run (check 4).
        var hidden: [PasteboardItemData] = []
        /// File URLs the system's own reader finds.
        var fileURLs = 0
        /// Runs inside `replace`, before the clear: someone else's write in that instant.
        var beforeClear: (() -> Void)?
        /// Runs inside `replace`, between the clear and the write.
        var duringWrite: (() -> Void)?
        /// Runs once `replace` has returned its result: someone else's write right after it.
        var afterReplace: (() -> Void)?
        /// The next `replace` clears but the items are not taken.
        var failWrite = false
        /// Runs in the middle of a read: someone else's write while Caret reads.
        var duringRead: (() -> Void)?
        /// Types a write to this pasteboard keeps differently: dropped, or given other bytes, as an
        /// owner that reads its own type back differently would. `rehearse` keeps them unless
        /// `rehearsalToo`.
        var drops: Set<String> = []
        var changes: Set<String> = []
        var rehearsalToo = false

        /// The older names the system reports beside an item's type, as `NSPasteboard.types` does.
        static let aliases = ["public.utf8-plain-text": ["NSStringPboardType"], "public.rtf": ["NeXT Rich Text Format v1.0 pasteboard type"],
                              "public.file-url": ["NSFilenamesPboardType"]]

        static func reported(_ items: [PasteboardItemData]) -> [String] {
            var seen: [String] = []
            for type in items.flatMap({ $0.types + $0.unreadable }).flatMap({ [$0] + (aliases[$0] ?? []) }) where !seen.contains(type) {
                seen.append(type)
            }
            return seen
        }

        func read() -> PasteboardRead {
            let count = changeCount
            duringRead?()
            duringRead = nil
            return PasteboardRead(changeCount: count, changeCountAfter: changeCount, types: Self.reported(items + hidden), items: items, fileURLs: fileURLs)
        }

        private func kept(_ items: [PasteboardItemData]) -> [PasteboardItemData] {
            items.map { item in
                PasteboardItemData(item.entries.compactMap { e in
                    drops.contains(e.type) ? nil : (changes.contains(e.type) ? (type: e.type, data: Data([9])) : e)
                })
            }
        }

        func rehearse(_ items: [PasteboardItemData]) -> PasteboardRead {
            let back = rehearsalToo ? kept(items) : items
            return PasteboardRead(changeCount: 0, types: Self.reported(back), items: back)
        }

        func replace(with items: [PasteboardItemData]) -> PasteboardWrite {
            beforeClear?()
            beforeClear = nil
            changeCount += 1
            let cleared = changeCount
            self.items = []
            hidden = []
            fileURLs = 0
            duringWrite?()
            duringWrite = nil
            let written = !failWrite
            failWrite = false
            if written { self.items += kept(items) }
            defer {
                afterReplace?()
                afterReplace = nil
            }
            return PasteboardWrite(cleared: cleared, written: written, countAfter: changeCount)
        }

        /// The user copies.
        func copy(_ item: PasteboardItemData) {
            changeCount += 1
            items = [item]
            hidden = []
            fileURLs = 0
        }
    }

    private func item(_ pairs: [(String, String)]) -> PasteboardItemData {
        PasteboardItemData(pairs.map { (type: $0.0, data: Data($0.1.utf8)) })
    }

    private let rich = PasteboardItemData([
        ("public.rtf", Data("{\\rtf1 Hello}".utf8)),
        ("public.html", Data("<b>Hello</b>".utf8)),
        ("public.utf8-plain-text", Data("Hello".utf8)),
    ])

    /// Check, arm and write, as the executor and KeyType's inserter do before a ⌘V. Fails the test
    /// when the check refuses.
    @discardableResult
    private func paste(_ clipboard: ReconcilingClipboard, _ text: String = "Lumen Labs", file: StaticString = #filePath, line: UInt = #line) -> Int? {
        guard case .pasteable(let snapshot) = clipboard.check() else {
            XCTFail("the check refused: \(clipboard.check())", file: file, line: line)
            return nil
        }
        clipboard.arm(snapshot)
        return clipboard.writeOwn(text)
    }

    private func refusals(_ clipboard: ReconcilingClipboard) -> [String] {
        if case .refused(let reasons, _) = clipboard.check() { return reasons }
        return []
    }

    func testCaretsItemIsMarkedSoClipboardManagersSkipIt() {
        let pb = FakePasteboard()
        let clipboard = ReconcilingClipboard(backend: pb)
        let own = paste(clipboard)
        XCTAssertEqual(own, pb.changeCount)
        XCTAssertEqual(pb.items.count, 1)
        XCTAssertEqual(pb.items[0].types, ["public.utf8-plain-text", "org.nspasteboard.TransientType", "org.nspasteboard.ConcealedType", "org.nspasteboard.AutoGeneratedType"])
        XCTAssertEqual(pb.items[0].entries[0].data, Data("Lumen Labs".utf8))
    }

    func testEveryTypeOfEveryPriorItemComesBack() {
        let pb = FakePasteboard()
        let second = PasteboardItemData([("public.png", Data([0x89, 0x50, 0x4E, 0x47])), ("public.utf8-plain-text", Data("a.png".utf8))])
        pb.items = [rich, second]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertNotNil(paste(clipboard))
        XCTAssertEqual(clipboard.restore(), .restored)
        XCTAssertEqual(pb.items, [rich, second], "rich text, HTML, an image and a second item, in order")
    }

    /// The rule since H5 (lead decision after A17's private type came back byte for byte): a file
    /// URL (lost 5 of 5 in A17's VM probe while the restore said `restored`) refuses the paste
    /// route, and a private type no longer does. Nothing is written, so the user's clipboard is
    /// never touched.
    func testAFileURLRefusesThePasteAndAPrivateTypeDoesNot() {
        let pb = FakePasteboard()
        let files = item([("public.file-url", "file:///tmp/a.txt"), ("public.utf8-plain-text", "a.txt")])
        let app = item([("com.example.private", "\u{0}\u{1}"), ("public.utf8-plain-text", "Hello")])
        pb.items = [files, app]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard), ["pasteboard: public.file-url", "pasteboard: NSFilenamesPboardType", "item 1: public.file-url"])
        XCTAssertEqual(WriteFallback.firstRoute(appPastes: true, clipboardRestorable: false), .axWrite, "an app that pastes gets the AX write instead")
        XCTAssertEqual(WriteFallback.afterAXRefused(clipboardRestorable: false), .failed(WriteFallback.clipboardUnrestorable), "and no paste if that is refused")

        let count = pb.changeCount
        XCTAssertNil(clipboard.writeOwn("Lumen Labs"), "nothing armed, nothing written")
        XCTAssertEqual(pb.changeCount, count)
        XCTAssertEqual(pb.items, [files, app])
        XCTAssertEqual(clipboard.restore(), .notWritten)
        XCTAssertEqual(pb.items, [files, app])

        pb.items = [rich, app]
        XCTAssertNotNil(paste(clipboard), "a private type alone may be pasted over")
        XCTAssertEqual(clipboard.restore(), .restored)
        XCTAssertEqual(pb.items, [rich, app], "and comes back byte for byte")
    }

    /// File promises and URL types that hold a file URL name a file as surely as a file URL does.
    func testFilePromisesAndFileURLsInURLTypesRefuseThePaste() {
        let pb = FakePasteboard()
        let clipboard = ReconcilingClipboard(backend: pb)
        for type in ["com.apple.NSFilePromiseItemMetaData", "com.apple.pasteboard.promised-file-url", "com.apple.pasteboard.promised-file-content-type", "NSFilenamesPboardType"] {
            pb.items = [item([(type, "x"), ("public.utf8-plain-text", "a")])]
            XCTAssertEqual(refusals(clipboard), ["pasteboard: \(type)", "item 1: \(type)"], type)
        }
        pb.items = [item([("public.url", "file:///Users/dana/a.pdf")])]
        XCTAssertEqual(refusals(clipboard), ["item 1: public.url"])
        pb.items = [item([("public.url", "https://example.com/a.pdf"), ("public.utf8-plain-text", "https://example.com/a.pdf")])]
        XCTAssertEqual(refusals(clipboard), [], "a web link is bytes like any other text")
    }

    // MARK: - V1b: what Caret's read does not list

    /// V1b's check 4: the pasteboard held a second item with only `public.file-url`, Caret's read
    /// listed one item, and Caret pasted, put back the one, and said `restored`. The pasteboard's own
    /// list of types still names the file URL, so the check refuses and nothing is written.
    func testAFileURLItemCaretsReadDoesNotListRefusesThePaste() {
        let pb = FakePasteboard()
        let file = item([("public.file-url", "file:///private/tmp/a17-prior.txt")])
        pb.items = [rich]
        pb.hidden = [file]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard), ["pasteboard: public.file-url", "pasteboard: NSFilenamesPboardType"])
        assertUntouched(pb, clipboard, items: [rich], hidden: [file])
    }

    /// The same for a file promise.
    func testAFilePromiseCaretsReadDoesNotListRefusesThePaste() {
        let pb = FakePasteboard()
        let promise = item([("com.apple.NSFilePromiseItemMetaData", "meta"), ("com.apple.pasteboard.promised-file-content-type", "public.plain-text")])
        pb.items = [rich]
        pb.hidden = [promise]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard), ["pasteboard: com.apple.NSFilePromiseItemMetaData", "pasteboard: com.apple.pasteboard.promised-file-content-type"])
        assertUntouched(pb, clipboard, items: [rich], hidden: [promise])
    }

    /// The same for a type whose data reads as nil, in an item Caret's read does not list. No type
    /// names a file here, so it is the pasteboard's list of types, set against what a restore of the
    /// items Caret read reports, that refuses.
    func testAnUnreadableTypeCaretsReadDoesNotListRefusesThePaste() {
        let pb = FakePasteboard()
        let lazy = PasteboardItemData([], unreadable: ["dev.caret.test.lazy"])
        pb.items = [rich]
        pb.hidden = [lazy]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard), ["pasteboard: dev.caret.test.lazy: in no item Caret read"])
        assertUntouched(pb, clipboard, items: [rich], hidden: [lazy])
    }

    /// File URLs the system's own reader finds refuse the paste even when no type Caret read names one.
    func testFileURLsTheSystemFindsRefuseThePaste() {
        let pb = FakePasteboard()
        pb.items = [rich]
        pb.fileURLs = 1
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard), ["pasteboard: 1 file URL(s)"])
    }

    /// After a refusal nothing can be written, so a ⌘V posted anyway would paste the user's own
    /// contents, and the pasteboard keeps everything it held.
    private func assertUntouched(_ pb: FakePasteboard, _ clipboard: ReconcilingClipboard, items: [PasteboardItemData], hidden: [PasteboardItemData], line: UInt = #line) {
        let count = pb.changeCount
        XCTAssertNil(clipboard.writeOwn("Lumen Labs"), line: line)
        XCTAssertEqual(clipboard.restore(), .notWritten, line: line)
        XCTAssertEqual(pb.changeCount, count, "nothing written", line: line)
        XCTAssertEqual(pb.items, items, line: line)
        XCTAssertEqual(pb.hidden, hidden, line: line)
    }

    // MARK: - Restored means a fresh read matched

    /// A pasteboard that keeps only some of what is written to it, as an owner that reads its own
    /// type back differently would. Until H7b the restore said `restored` by count and listed the
    /// differences beside it; a restore that does not come back exactly is `notRestored`.
    func testARestoreThatComesBackDifferentIsNotRestoredAndSaysWhatWasLost() {
        let pb = FakePasteboard()
        pb.drops = ["com.example.gone"]
        pb.changes = ["com.example.changed"]
        pb.items = [PasteboardItemData([
            ("public.utf8-plain-text", Data("Hello".utf8)), ("com.example.gone", Data([1, 2])), ("com.example.changed", Data([1, 2, 3])),
        ])]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertNotNil(paste(clipboard))
        XCTAssertEqual(clipboard.restore(), .notRestored(lost: [
            "item 1: com.example.gone: missing",
            "item 1: com.example.changed: 3 bytes came back as 1 different bytes",
            "pasteboard: com.example.gone: missing",
        ]))
        XCTAssertEqual(clipboard.restore(), .notWritten, "a later restore has nothing to do")
    }

    /// When a write to Caret's private pasteboard already does not bring the contents back, nothing
    /// of the user's is touched.
    func testContentsTheRehearsalDoesNotBringBackRefuseThePaste() {
        let pb = FakePasteboard()
        pb.drops = ["com.example.gone"]
        pb.rehearsalToo = true
        pb.items = [PasteboardItemData([("public.utf8-plain-text", Data("Hello".utf8)), ("com.example.gone", Data([1, 2]))])]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard), ["rehearsal: item 1: com.example.gone: missing", "rehearsal: pasteboard: com.example.gone: missing"])
    }

    func testTextRichTextHTMLImagesAndCaretsMarkersMayBePasted() {
        let pb = FakePasteboard()
        let types = ["public.utf8-plain-text", "public.utf16-external-plain-text", "public.rtf", "com.apple.flat-rtfd", "public.html", "public.png", "public.tiff"]
            + ReconcilingClipboard.markerTypes
        pb.items = [PasteboardItemData(types.map { (type: $0, data: Data("x".utf8)) })]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard), [])
        XCTAssertEqual(WriteFallback.firstRoute(appPastes: true, clipboardRestorable: true), .paste)
        XCTAssertEqual(WriteFallback.firstRoute(appPastes: false, clipboardRestorable: true), .axWrite, "the AX write stays first")
        XCTAssertEqual(WriteFallback.afterAXRefused(clipboardRestorable: true), .fallBackToPaste)
        pb.items = []
        XCTAssertEqual(refusals(clipboard), [], "an empty clipboard is restored as empty")
    }

    func testAnEmptyPasteboardIsLeftEmpty() {
        let pb = FakePasteboard()
        let clipboard = ReconcilingClipboard(backend: pb)
        paste(clipboard)
        XCTAssertEqual(clipboard.restore(), .restored)
        XCTAssertEqual(pb.items, [], "Caret's text does not stay behind")
    }

    // MARK: - Someone else's copy

    /// The user copies between Caret's write and the restore: their copy stays, and Caret's
    /// snapshot of the older contents is dropped.
    func testACopyMadeDuringThePasteIsNeverOverwritten() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        paste(clipboard)
        let theirs = item([("public.utf8-plain-text", "copied mid-paste")])
        pb.copy(theirs)
        let count = pb.changeCount
        XCTAssertEqual(clipboard.restore(), .skippedUserCopied)
        XCTAssertEqual(pb.items, [theirs])
        XCTAssertEqual(pb.changeCount, count, "nothing was written after their copy")
        XCTAssertEqual(clipboard.restore(), .notWritten, "a second restore has nothing to do")
    }

    /// The user copies after the check and before Caret's write. Until H7b the write cleared their
    /// copy and the restore put back the older contents, reporting `restored`.
    func testACopyMadeBetweenTheCheckAndCaretsWriteSurvives() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        guard case .pasteable(let snapshot) = clipboard.check() else { return XCTFail("refused") }
        clipboard.arm(snapshot)
        let theirs = item([("public.utf8-plain-text", "copied before the write")])
        pb.copy(theirs)
        let count = pb.changeCount
        XCTAssertNil(clipboard.writeOwn("Lumen Labs"))
        XCTAssertEqual(clipboard.refused, ["the pasteboard changed after Caret checked it (count 100 to 101)"])
        XCTAssertEqual(clipboard.restore(), .notWritten)
        XCTAssertEqual(pb.items, [theirs])
        XCTAssertEqual(pb.changeCount, count)
    }

    /// The same copy before the arming: the arming refuses, and nothing is posted.
    func testArmingASnapshotThePasteboardHasMovedPastRefuses() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        guard case .pasteable(let snapshot) = clipboard.check() else { return XCTFail("refused") }
        pb.copy(item([("public.utf8-plain-text", "copied")]))
        clipboard.arm(snapshot)
        XCTAssertEqual(clipboard.refused, ["the pasteboard changed after Caret checked it (count 100 to 101)"])
        XCTAssertNil(clipboard.writeOwn("Lumen Labs"))
    }

    /// A copy in the instant between the write's count check and its clear is overwritten by the
    /// clear. The snapshot goes back, nothing is pasted, and the restore says the copy was lost.
    func testACopyInTheInstantBeforeCaretsWriteIsReportedLost() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        guard case .pasteable(let snapshot) = clipboard.check() else { return XCTFail("refused") }
        clipboard.arm(snapshot)
        pb.beforeClear = { pb.copy(self.item([("public.utf8-plain-text", "too late")])) }
        XCTAssertNil(clipboard.writeOwn("Lumen Labs"), "no paste may be posted")
        XCTAssertFalse(clipboard.refused.isEmpty)
        XCTAssertEqual(clipboard.restore(), .notRestored(lost: ["a copy made as Caret wrote its own item was overwritten (count 100 to 101)"]))
        XCTAssertEqual(pb.items, [rich], "the snapshot is back")
    }

    func testACopyInTheInstantBeforeTheRestoresClearIsReportedLost() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        paste(clipboard)
        pb.beforeClear = { pb.copy(self.item([("public.utf8-plain-text", "too late")])) }
        XCTAssertEqual(clipboard.restore(), .notRestored(lost: ["a copy made as Caret restored the clipboard was overwritten (count 101 to 102)"]),
                       "nothing can bring it back; the debug state and the log say so")
    }

    // MARK: - What a read cannot vouch for

    func testAReadDuringWhichThePasteboardChangedRefuses() {
        let pb = FakePasteboard()
        pb.items = [rich]
        pb.duringRead = { pb.copy(self.item([("public.utf8-plain-text", "mid-read")])) }
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard).first, "the pasteboard changed while Caret read it (count 100 to 101)")
    }

    /// A type the pasteboard lists but will not give data for cannot be restored: the check says
    /// which and refuses rather than restoring less and calling it whole.
    func testATypeThatCannotBeReadIsRefused() {
        let pb = FakePasteboard()
        pb.items = [rich, PasteboardItemData([], unreadable: ["public.utf8-plain-text"])]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertEqual(refusals(clipboard), ["item 2: public.utf8-plain-text: no data"], "even a type that is otherwise restorable")
        assertUntouched(pb, clipboard, items: pb.items, hidden: [])
    }

    func testAnItemWithNoTypeRefuses() {
        let pb = FakePasteboard()
        pb.items = [item([("public.utf8-plain-text", "Prior")]), PasteboardItemData([])]
        XCTAssertEqual(refusals(ReconcilingClipboard(backend: pb)), ["item 2: no type"])
    }

    func testAWriteWithNoArmedSnapshotWritesNothing() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertNil(clipboard.writeOwn("Lumen Labs"))
        XCTAssertEqual(clipboard.refused, ["no checked snapshot was armed"])
        XCTAssertEqual(pb.items, [rich])
        XCTAssertEqual(clipboard.restore(), .notWritten)
    }

    // MARK: - H7b review: ownership after the write, and pending writes

    /// The user copies after Caret's write and before KeyType posts ⌘V: the ⌘V would paste their
    /// copy into the field. `mayPost` says no from then on, and their copy stays.
    func testNoKeyIsPostedOnceSomeoneElseWroteAfterCaret() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertNotNil(paste(clipboard))
        XCTAssertTrue(clipboard.mayPost())
        let theirs = item([("public.utf8-plain-text", "copied before the paste")])
        pb.copy(theirs)
        XCTAssertFalse(clipboard.mayPost())
        XCTAssertEqual(clipboard.refused, ["the pasteboard changed after Caret wrote its own item (count 101 to 102); nothing more is posted"])
        XCTAssertEqual(clipboard.restore(), .skippedUserCopied)
        XCTAssertEqual(pb.items, [theirs])
    }

    /// Before Caret writes, keys (a backspace KeyType sends first) may be posted only with an armed
    /// snapshot.
    func testKeysBeforeTheWriteNeedAnArmedSnapshot() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertFalse(clipboard.mayPost(), "nothing armed")
        guard case .pasteable(let snapshot) = clipboard.check() else { return XCTFail("refused") }
        clipboard.arm(snapshot)
        XCTAssertTrue(clipboard.mayPost())
    }

    /// The pasteboard clears but does not take Caret's item: nothing is pasted, and the snapshot goes
    /// back over the emptied pasteboard.
    func testAWriteThePasteboardDoesNotTakePostsNothingAndPutsTheSnapshotBack() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        guard case .pasteable(let snapshot) = clipboard.check() else { return XCTFail("refused") }
        clipboard.arm(snapshot)
        pb.failWrite = true
        XCTAssertNil(clipboard.writeOwn("Lumen Labs"))
        XCTAssertEqual(clipboard.refused, ["the pasteboard did not take Caret's own item"])
        XCTAssertFalse(clipboard.mayPost())
        XCTAssertEqual(clipboard.restore(), .restored)
        XCTAssertEqual(pb.items, [rich])
    }

    /// Someone copies between Caret's clear and the end of its write: their copy may hold Caret's
    /// item as well, so nothing is pasted and Caret does not call their copy intact.
    func testACopyBetweenCaretsClearAndWriteIsNotCalledIntact() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        guard case .pasteable(let snapshot) = clipboard.check() else { return XCTFail("refused") }
        clipboard.arm(snapshot)
        pb.duringWrite = { pb.copy(self.item([("public.utf8-plain-text", "copied mid-write")])) }
        XCTAssertNil(clipboard.writeOwn("Lumen Labs"))
        XCTAssertFalse(clipboard.mayPost())
        XCTAssertEqual(clipboard.restore(), .notRestored(lost: ["a copy made while Caret wrote its own item may hold Caret's text (count 101 to 102)"]))
    }

    /// A second write, or an arming or disarming, while a write waits for its restore keeps that
    /// write's snapshot: the restore still puts it back.
    func testAPendingWritesSnapshotCannotBeDropped() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        XCTAssertNotNil(paste(clipboard))
        XCTAssertNil(clipboard.writeOwn("again"))
        guard case .pasteable(let other) = clipboard.check() else { return XCTFail("refused") }
        clipboard.arm(other)
        clipboard.disarm("stopped")
        XCTAssertEqual(clipboard.refused, ["a write is still waiting for its restore"])
        XCTAssertFalse(clipboard.mayPost())
        XCTAssertEqual(clipboard.restore(), .restored)
        XCTAssertEqual(pb.items, [rich], "the first snapshot is back")
    }

    /// Someone copies right after the restore and before its check: the check cannot vouch for the
    /// restore, so it is not called `restored`.
    func testACopyBeforeTheRestoreIsCheckedIsNotCalledRestored() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        paste(clipboard)
        pb.afterReplace = { pb.copy(self.item([("public.utf8-plain-text", "copied after the restore")])) }
        XCTAssertEqual(clipboard.restore(), .notRestored(lost: ["the pasteboard changed before the restore could be checked (count 102 to 103)"]))
    }

    /// The pasteboard's own list of types is compared as a set; an item's types in order.
    func testTypeOrderMattersWithinAnItemOnly() {
        let a = PasteboardItemData([("public.rtf", Data([1])), ("public.utf8-plain-text", Data([2]))])
        let b = PasteboardItemData([("public.utf8-plain-text", Data([2])), ("public.rtf", Data([1]))])
        let read = { (items: [PasteboardItemData], types: [String]) in PasteboardRead(changeCount: 1, types: types, items: items) }
        XCTAssertEqual(ReconcilingClipboard.differences(expected: read([a], ["public.rtf", "x"]), now: read([a], ["x", "public.rtf"])), [])
        XCTAssertEqual(ReconcilingClipboard.differences(expected: read([a], []), now: read([b], [])), ["item 1: types came back in another order"])
    }

    func testNothingIsRestoredWhenCaretNeverWrote() {
        let pb = FakePasteboard()
        pb.items = [rich]
        let clipboard = ReconcilingClipboard(backend: pb)
        guard case .pasteable(let snapshot) = clipboard.check() else { return XCTFail("refused") }
        clipboard.arm(snapshot)
        let count = pb.changeCount
        XCTAssertEqual(clipboard.restore(), .notWritten)
        XCTAssertEqual(pb.changeCount, count)
        XCTAssertEqual(pb.items, [rich])
    }
}

/// The host's live write authorization (S1 audit #2).
final class HostAuthorityTests: XCTestCase {
    func testARevokeEndsEveryEarlierGrantAndNoLaterOne() {
        let authority = HostAuthority()
        let a = authority.grant()
        let b = authority.grant()
        XCTAssertTrue(authority.isLive(a))
        XCTAssertTrue(authority.isLive(b))
        authority.revokeAll("stop")
        XCTAssertFalse(authority.isLive(a))
        XCTAssertFalse(authority.isLive(b))
        let c = authority.grant()
        XCTAssertTrue(authority.isLive(c), "a Tab after the stop is a new decision")
        authority.revokeAll("helperDisconnected")
        XCTAssertFalse(authority.isLive(c))
        XCTAssertEqual(authority.debugInfo.revokes, 2)
        XCTAssertEqual(authority.debugInfo.lastReason, "helperDisconnected")
    }

    /// A revoke from another thread is seen by the next check on the insertion queue.
    func testARevokeFromAnotherThreadIsSeenAtTheNextCheck() {
        let authority = HostAuthority()
        let grant = authority.grant()
        let revoked = expectation(description: "revoked")
        DispatchQueue.global().async {
            authority.revokeAll("paused")
            revoked.fulfill()
        }
        wait(for: [revoked], timeout: 2)
        XCTAssertFalse(authority.isLive(grant))
    }
}
