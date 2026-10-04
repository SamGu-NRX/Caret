import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// The memory window's files (M1) against a manual clock and a recorded socket: Edit reads the file,
/// Save names the revision it read, a conflict keeps the user's text until they choose, and a file's
/// problems are printed by file, line and field.
final class MemoryFilesTests: XCTestCase {
    static let folder = "/Users/example/Library/Application Support/Caret/Memory"

    final class Rig {
        let clock = ManualClock()
        let files: MemoryFiles
        var sent: [MemoryDocumentRequest] = []

        init() {
            files = MemoryFiles(clock: clock)
            files.send = { [unowned self] in self.sent.append($0); return true }
            files.linkChanged(true)
            reply(documents: [doc("about-me", "sha256:a1"), doc("people", nil), doc("preferences", nil)])
        }

        var state: MemoryFiles.State { files.state }

        func doc(_ id: String, _ revision: String?, problems: [MemoryDiagnostic] = []) -> MemoryDocument {
            MemoryDocument(doc: id, file: "\(id).md", path: "\(MemoryFilesTests.folder)/\(id).md", revision: revision, bytes: 0, diagnostics: problems)
        }

        func reply(error: String? = nil, conflict: String?? = nil, documents: [MemoryDocument], text: String? = nil) {
            files.receive(MemoryDocumentReply(requestId: sent.last!.requestId, error: error, conflict: conflict, folder: MemoryFilesTests.folder, documents: documents, text: text))
        }

        /// Opens about-me with `text` at revision a1.
        func open(_ text: String = "# About me\n") {
            files.open("about-me")
            reply(documents: [doc("about-me", "sha256:a1")], text: text)
        }
    }

    func testTheListOnConnectNamesTheFilesAndTheirFolder() {
        let r = Rig()
        XCTAssertEqual(r.sent.first?.op, .list)
        XCTAssertTrue(r.state.loaded)
        XCTAssertEqual(r.state.folder, Self.folder)
        XCTAssertEqual(r.state.documents.map(\.doc), ["about-me", "people", "preferences"])
    }

    func testEditReadsTheFileThenSaveNamesTheRevisionItRead() {
        let r = Rig()
        r.open()
        XCTAssertEqual(r.sent[1].op, .read(doc: "about-me"))
        XCTAssertEqual(r.state.editor?.base, "sha256:a1")
        r.files.updateText("# About me\n\n## Guest\n")
        XCTAssertTrue(r.files.save())
        XCTAssertEqual(r.sent.last?.op, .save(doc: "about-me", base: "sha256:a1", text: "# About me\n\n## Guest\n"))
        XCTAssertEqual(r.state.editor?.saving, true)
        r.reply(documents: [r.doc("about-me", "sha256:a2")])
        XCTAssertNil(r.state.editor, "a save that went through closes the editor")
        XCTAssertEqual(r.state.document("about-me")?.revision, "sha256:a2", "the reply's revision is the file's now")
    }

    func testSaveWithNothingChangedJustCloses() {
        let r = Rig()
        r.open()
        let before = r.sent.count
        XCTAssertFalse(r.files.save())
        XCTAssertNil(r.state.editor)
        XCTAssertEqual(r.sent.count, before)
    }

    /// A file that does not exist yet is saved over no revision: `baseRevision` null.
    func testANewFileIsSavedOverNoRevision() {
        let r = Rig()
        r.files.open("people")
        r.reply(documents: [r.doc("people", nil)], text: "")
        r.files.updateText("# People\n")
        r.files.save()
        XCTAssertEqual(r.sent.last?.op, .save(doc: "people", base: nil, text: "# People\n"))
    }

    /// The conflict: nothing written, the typing kept, and only Reload or Keep my text go on.
    func testAConflictKeepsTheTypingAndAsks() {
        let r = Rig()
        r.open()
        r.files.updateText("mine\n")
        r.files.save()
        r.reply(error: "about-me.md changed outside Caret while it saved; keeping that version", conflict: .some("sha256:b9"), documents: [r.doc("about-me", "sha256:b9")])
        let editor = try! XCTUnwrap(r.state.editor)
        XCTAssertEqual(editor.text, "mine\n")
        XCTAssertEqual(editor.conflict, MemoryFiles.Conflict(revision: "sha256:b9", message: "about-me.md changed outside Caret while it saved; keeping that version."))
        XCTAssertFalse(editor.saving)
        let before = r.sent.count
        XCTAssertFalse(r.files.save(), "Save is not the answer to a conflict")
        XCTAssertEqual(r.sent.count, before)
    }

    func testKeepMyTextSavesOverTheRevisionNow() {
        let r = Rig()
        r.open()
        r.files.updateText("mine\n")
        r.files.save()
        r.reply(error: "changed", conflict: .some("sha256:b9"), documents: [r.doc("about-me", "sha256:b9")])
        XCTAssertTrue(r.files.keepMine())
        XCTAssertEqual(r.sent.last?.op, .save(doc: "about-me", base: "sha256:b9", text: "mine\n"))
        r.reply(documents: [r.doc("about-me", "sha256:c3")])
        XCTAssertNil(r.state.editor)
    }

    /// A file removed meanwhile is saved again as new, over no revision.
    func testKeepMyTextOverARemovedFileSavesItAsNew() {
        let r = Rig()
        r.open()
        r.files.updateText("mine\n")
        r.files.save()
        r.reply(error: "about-me.md was removed", conflict: .some(nil), documents: [])
        XCTAssertEqual(r.state.editor?.conflict?.revision, nil)
        r.files.keepMine()
        XCTAssertEqual(r.sent.last?.op, .save(doc: "about-me", base: nil, text: "mine\n"))
    }

    func testReloadTakesTheFileAsItIsNowAndDropsTheTyping() {
        let r = Rig()
        r.open()
        r.files.updateText("mine\n")
        r.files.save()
        r.reply(error: "changed", conflict: .some("sha256:b9"), documents: [r.doc("about-me", "sha256:b9")])
        XCTAssertTrue(r.files.reload())
        XCTAssertEqual(r.sent.last?.op, .read(doc: "about-me"))
        r.reply(documents: [r.doc("about-me", "sha256:b9")], text: "theirs\n")
        XCTAssertEqual(r.state.editor?.text, "theirs\n")
        XCTAssertEqual(r.state.editor?.base, "sha256:b9")
        XCTAssertNil(r.state.editor?.conflict)
    }

    /// A refusal names the line (a password, say): the editor stays open with the helper's words.
    func testARefusedSaveKeepsTheEditorWithTheReason() {
        let r = Rig()
        r.open()
        r.files.updateText("- Password: hunter2\n")
        r.files.save()
        r.reply(error: "line 1: Caret never keeps a password", documents: [r.doc("about-me", "sha256:a1")])
        XCTAssertEqual(r.state.editor?.problem, "Line 1: Caret never keeps a password.")
        XCTAssertNil(r.state.editor?.conflict)
    }

    /// Opening another file while this one has typing in it would lose the typing: refused, said.
    func testAnotherFileWaitsWhileThisOneHasTyping() {
        let r = Rig()
        r.open()
        r.files.updateText("mine\n")
        XCTAssertFalse(r.files.open("people"))
        XCTAssertEqual(r.state.editor?.problem, "Save or close about-me.md first.")
    }

    func testNoAnswerFreesTheEditorWithAProblem() {
        let r = Rig()
        r.open()
        r.files.updateText("mine\n")
        r.files.save()
        r.clock.advance(by: MemoryFiles.answerTimeout + 0.1)
        XCTAssertEqual(r.state.editor?.saving, false)
        XCTAssertEqual(r.state.editor?.problem, "Caret didn't answer. Try again.")
    }

    func testAProblemLineNamesTheFileTheLineAndTheField() {
        let d = MemoryDocument(doc: "about-me", file: "about-me.md", path: "/x", revision: "r", bytes: 1, diagnostics: [
            MemoryDiagnostic(line: 14, field: "On its own", severity: .warning, message: "not a field Caret reads in an about record; it changes nothing"),
            MemoryDiagnostic(line: 9, field: nil, severity: .error, message: "a heading needs a value"),
        ])
        XCTAssertEqual(MemoryFiles.problemLines(d), [
            "about-me.md, line 14, \u{201C}On its own\u{201D}: Not a field Caret reads in an about record; it changes nothing.",
            "about-me.md, line 9: A heading needs a value. Caret skips this entry until it's fixed.",
        ])
    }

    func testOnlyTheThreeFilesHaveEdit() {
        XCTAssertEqual(MemoryFiles.doc(for: .about), "about-me")
        XCTAssertEqual(MemoryFiles.doc(for: .people), "people")
        XCTAssertEqual(MemoryFiles.doc(for: .preference), "preferences")
        for kind in [HelperMemory.Kind.routine, .skill, .permission, .unrecognized] { XCTAssertNil(MemoryFiles.doc(for: kind)) }
    }

    /// Review finding 1: a save's late reply must not close an editor opened since. Save A, close,
    /// open A again and type; then the first save's reply arrives.
    func testALateSaveReplyLeavesANewerEditorAlone() {
        let r = Rig()
        r.open()
        r.files.updateText("first\n")
        r.files.save()
        let firstSave = r.sent.last!.requestId
        r.files.close()
        r.open()
        r.files.updateText("second\n")
        r.files.receive(MemoryDocumentReply(requestId: firstSave, error: nil, conflict: nil, folder: Self.folder, documents: [r.doc("about-me", "sha256:a2")], text: nil))
        XCTAssertEqual(r.state.editor?.text, "second\n", "the newer typing stays")
        XCTAssertEqual(r.state.document("about-me")?.revision, "sha256:a2", "the file's revision is still recorded")
    }

    /// Review finding 1: opening another file closes an untouched one at once, so nothing can be
    /// typed into it while the other is read, and a late read of the first changes nothing.
    func testOpeningAnotherFileClosesTheUntouchedOneFirst() {
        let r = Rig()
        r.open()
        XCTAssertTrue(r.files.open("people"))
        XCTAssertNil(r.state.editor)
        XCTAssertEqual(r.state.opening, "people")
    }

    func testASuccessfulSaveAsksForTheFactsAgain() {
        let r = Rig()
        var saved = 0
        r.files.onSaved = { saved += 1 }
        r.open()
        r.files.updateText("x\n")
        r.files.save()
        r.reply(documents: [r.doc("about-me", "sha256:a2")])
        XCTAssertEqual(saved, 1)
    }

    /// Review finding 7: a file that could not be opened says so on its section.
    func testAFileThatWontOpenSaysWhy() {
        let r = Rig()
        r.files.open("people")
        r.clock.advance(by: MemoryFiles.answerTimeout + 0.1)
        XCTAssertEqual(r.state.openProblems["people"], "Caret didn't answer. Try again.")
        XCTAssertNil(r.state.opening)
    }

    func testOfflineNothingIsSentAndNothingWaits() {
        let r = Rig()
        r.files.linkChanged(false)
        XCTAssertFalse(r.files.open("about-me"))
        XCTAssertFalse(r.state.loaded)
    }
}

/// M1's answers on a noticed fact's row: Keep is an edit with the fact's own values; Not right
/// forgets it or sends what the user typed; an offer's Not right goes through the same book.
final class NoticedFactTests: XCTestCase {
    final class Rig {
        let clock = ManualClock()
        let book: MemoryBook
        var sent: [HelperMemory.Request] = []
        var notRight: [MemoryNotRight] = []
        var changed: [String] = []

        init() throws {
            book = MemoryBook(clock: clock)
            book.send = { [unowned self] in self.sent.append($0); return true }
            book.sendNotRight = { [unowned self] in self.notRight.append($0); return true }
            book.onEntryChanged = { [unowned self] in self.changed.append($0) }
            book.linkChanged(true)
            var reply = try HelperMemory.Reply.decode(MemoryDocumentsTests.line(2))
            reply.requestId = sent.last!.requestId
            book.receive(reply)
        }

        func answer(_ requestId: String, _ entries: [HelperMemory.Entry], error: String? = nil) {
            book.receive(HelperMemory.Reply(requestId: requestId, error: error, entries: entries))
        }
    }

    func testANoticedRowOffersKeepAndNotRightAndSaysWhereItWasSeen() throws {
        let r = try Rig()
        let row = try XCTUnwrap(MemoryPage.sections(r.book.state, now: Date(timeIntervalSince1970: 1_790_000_000), calendar: Self.chicago, locale: Locale(identifier: "en_US"))
            .first { $0.kind == .about }?.rows.first { $0.id == "about-5e6f7a8b" })
        XCTAssertEqual(row.status, .noticed)
        XCTAssertEqual(row.controls, [.keep, .notRight])
        // 1789827200000 ms is Saturday 2026-09-19 in Chicago; 2 days before "now".
        XCTAssertEqual(row.noticedLine, "Noticed in Mail Fixture, Sat")
    }

    static let chicago: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "America/Chicago")!
        return c
    }()

    func testKeepSendsTheFactsOwnValuesAsAnEdit() throws {
        let r = try Rig()
        XCTAssertTrue(r.book.keepNoticed("about-5e6f7a8b"))
        XCTAssertEqual(r.sent.last?.op, .edit)
        XCTAssertEqual(r.sent.last?.id, "about-5e6f7a8b")
        XCTAssertEqual(r.sent.last?.fields, ["label": .text("Guest"), "value": .text("Marcus Lowe (ops)")])
        XCTAssertFalse(r.book.keepNoticed("people-0a1b2c3d"), "an active fact has nothing to keep")
    }

    func testNotRightWithACorrectionSendsItAndTheReplyMakesItActive() throws {
        let r = try Rig()
        r.book.beginNotRight("about-5e6f7a8b")
        r.book.updateCorrection("  Marcus Lowe, Ops lead ")
        XCTAssertTrue(r.book.sendCorrection(forget: false))
        XCTAssertEqual(r.notRight.last, MemoryNotRight(requestId: r.notRight.last!.requestId, memoryId: "about-5e6f7a8b", offerKey: nil, correction: "Marcus Lowe, Ops lead"))
        XCTAssertEqual(r.book.state.correcting?.sending, true)
        let corrected = try HelperMemory.Reply.decode(MemoryDocumentsTests.line(5)).entries
        r.answer(r.notRight.last!.requestId, corrected)
        XCTAssertNil(r.book.state.correcting)
        XCTAssertEqual(r.book.state.entries.first { $0.id == "about-5e6f7a8b" }?.status, .active)
        XCTAssertEqual(r.changed, ["about-5e6f7a8b"], "a fill held with the old value must not offer it")
    }

    func testNotRightForgetRemovesTheFact() throws {
        let r = try Rig()
        r.book.beginNotRight("about-5e6f7a8b")
        XCTAssertTrue(r.book.sendCorrection(forget: true))
        XCTAssertNil(r.notRight.last?.correction)
        r.answer(r.notRight.last!.requestId, [])
        XCTAssertNil(r.book.state.entries.first { $0.id == "about-5e6f7a8b" })
    }

    func testAnEmptyCorrectionIsRefusedBeforeSending() throws {
        let r = try Rig()
        r.book.beginNotRight("about-5e6f7a8b")
        XCTAssertFalse(r.book.sendCorrection(forget: false))
        XCTAssertEqual(r.book.state.correcting?.problem, "Type what's right, or choose Forget.")
        XCTAssertTrue(r.notRight.isEmpty)
    }

    func testAHelperRefusalStaysOnTheRow() throws {
        let r = try Rig()
        r.book.beginNotRight("about-5e6f7a8b")
        r.book.updateCorrection("x")
        r.book.sendCorrection(forget: false)
        r.answer(r.notRight.last!.requestId, [], error: "that value is a card number, which Caret never keeps")
        XCTAssertEqual(r.book.state.correcting?.problem, "That value is a card number, which Caret never keeps.")
        XCTAssertEqual(r.book.state.correcting?.sending, false)
    }

    /// The offer's Not right: the fact need not be listed; the caller hears how it went.
    func testAnOffersNotRightReportsItsAnswer() throws {
        let r = try Rig()
        var heard: [String?] = []
        XCTAssertTrue(r.book.notRight(memoryId: "about-new", offerKey: "offer-7", correction: nil) { heard.append($0) })
        XCTAssertEqual(r.notRight.last?.offerKey, "offer-7")
        r.answer(r.notRight.last!.requestId, [])
        XCTAssertEqual(heard, [nil])
        XCTAssertTrue(r.book.notRight(memoryId: "about-new2", offerKey: "offer-8", correction: "x") { heard.append($0) })
        r.clock.advance(by: MemoryBook.answerTimeout + 0.1)
        XCTAssertEqual(heard.last, "Caret didn't answer. Try again.")
    }

    func testAPreferenceCanOnlyBeForgotten() {
        XCTAssertEqual(MemoryCheck.correctionProblem("x", correctable: false), "Caret can only forget this one.")
        XCTAssertNil(MemoryCheck.correctionProblem("x", correctable: true))
        XCTAssertNotNil(MemoryCheck.correctionProblem(String(repeating: "x", count: 501), correctable: true))
    }
}

/// The surface machine keeps where an offer's noticed facts came from, by offer key, and names it
/// only while that offer is on the panel.
final class SurfaceProvenanceTests: XCTestCase {
    func testProvenanceIsKeptBoundedAndNewestWins() throws {
        let fact = MemoryProvenance.Fact(memoryId: "m", kind: .about, label: "Guest", says: "from what Caret noticed in Mail, Tue",
                                         noticed: HelperMemory.Noticed(app: "Mail", windowTitle: nil, at: 1))
        let rig = SurfaceRig()
        for i in 0..<12 { rig.machine.provenance(MemoryProvenance(at: Int64(i), offerKey: "k\(i)", facts: [fact])) }
        XCTAssertEqual(rig.machine.provenances.count, SurfaceMachine.provenanceKept)
        XCTAssertEqual(rig.machine.provenances.first?.key, "k4")
        XCTAssertNil(rig.machine.shownProvenance, "nothing on screen, nothing to name")
    }
}
