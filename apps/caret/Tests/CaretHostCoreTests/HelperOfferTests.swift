import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// helper/fixtures/golden/protocol.ndjson, the lines both sides decode.
private let goldenURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("helper/fixtures/golden/protocol.ndjson")

private func golden(_ type: String) throws -> HelperInbound {
    let lines = try String(contentsOf: goldenURL, encoding: .utf8).split(separator: "\n")
    let line = try XCTUnwrap(lines.first { $0.contains("\"type\":\"\(type)\"") }, "no golden \(type) line")
    return try HelperInbound.decode(Data(line.utf8))
}

private func goldenOffer(_ type: String) throws -> HelperOffer {
    try XCTUnwrap(HelperOffer(try golden(type)), "\(type) is not an offer")
}

/// The host fixture's pop-ups (the same file the helper's schema tests run).
private func fixtureSpec(_ name: String) throws -> PopupSpec {
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/popup-specs.json")
    let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let valid = try XCTUnwrap(root["valid"] as? [String: Any])
    return try PopupSpec.decode(JSONSerialization.data(withJSONObject: try XCTUnwrap(valid[name])))
}

private let field = OfferField(
    pid: 7170, windowId: "7170-1", key: "dev.caret.sheet/standard/textfield:guest~0", frame: Frame(x: 120, y: 288, width: 180, height: 22),
    window: OfferWindow(number: 4421, title: "Seating")
)

/// Routing: each offer message becomes the offer the arbiter holds, bound to its field.
final class HelperOfferRoutingTests: XCTestCase {
    func testAlternativesBecomeGhostTextWithTheRestBehindTheDownArrow() throws {
        let offer = try goldenOffer("alternatives")
        XCTAssertEqual(offer.offerKey, "offer-4.0")
        XCTAssertEqual(offer.pid, 7170)
        XCTAssertEqual(offer.kindName, "ghost")
        XCTAssertTrue(offer.quoted)
        let held = offer.offer(target: offer.declaredTarget, fieldValue: "", caretUTF16: 0)
        XCTAssertEqual(held.kind, .ghost)
        XCTAssertEqual(held.source, .helper)
        XCTAssertEqual(held.text, "Cara Diaz")
        XCTAssertEqual(held.moreCandidates, ["Cal Duarte"])
        XCTAssertEqual(held.maxAgeSeconds, .infinity, "the helper ends its own offers")
        XCTAssertFalse(held.isExpired(at: Date().addingTimeInterval(10 * 60 + 1)), "a routine is offered for 10 min (lifetimes.ts)")
    }

    func testTheFieldsWindowIsTheReaders() throws {
        XCTAssertEqual(try goldenOffer("alternatives").window, WindowIdentity(number: 4421, title: "Seating"))
        XCTAssertEqual(try goldenOffer("popup").window, WindowIdentity(number: nil, title: "Checkout"), "the reader read no number")
        XCTAssertEqual(WindowIdentity(OfferWindow(number: nil, title: "")), WindowIdentity(), "an empty title is no title")
    }

    func testAnActionBecomesItsLineWithVariants() throws {
        let offer = try goldenOffer("action")
        let held = offer.offer(target: offer.declaredTarget, fieldValue: "", caretUTF16: 0)
        let line = try XCTUnwrap(held.kind.actionLine)
        XCTAssertEqual(line.offerKey, "offer-5")
        XCTAssertEqual(line.app, "Sheet Fixture")
        XCTAssertEqual(line.endState.text, "Finish the rest: 2 more values from Caret Fixture")
        XCTAssertEqual(line.actions.map(\.id), ["finish"])
        XCTAssertEqual(line.primary?.id, "finish")
        XCTAssertEqual(line.variants?.choices?.rows.count, 2)
        XCTAssertEqual(held.text, "", "an action line inserts nothing")
        XCTAssertEqual(held.source, .helper)
    }

    func testAPopupBecomesItsSpecAndAFillPopupKnowsItsRows() throws {
        let offer = try goldenOffer("popup")
        let held = offer.offer(target: offer.declaredTarget, fieldValue: "", caretUTF16: 0)
        guard case .popup(let popup) = held.kind else { return XCTFail("not a popup: \(held.kind)") }
        XCTAssertEqual(popup.offerKey, "fill-2")
        XCTAssertEqual(popup.spec.header?.title.text, "Fill 2 fields")
        XCTAssertEqual(popup.spec.fillRows, 2)
        XCTAssertEqual(popup.spec.sourceText, "Mail Fixture, Order ORD-2026-48213")
        XCTAssertEqual(popup.sourceApps, ["Mail Fixture"], "the toast names the apps, not the source block")
        XCTAssertEqual(popup.spec.actions.map(\.id), ["fillAll"])
        XCTAssertNil(try fixtureSpec("eventCard").fillRows, "a pop-up without a fields block is not a fill")
    }

    func testOtherMessagesAreNotOffers() throws {
        for type in ["fillProposal", "offerWithdrawn", "taskProgress", "activity", "error"] {
            XCTAssertNil(HelperOffer(try golden(type)), type)
        }
    }

    func testTheFieldMatchesByFrameWithinAPoint() throws {
        let offer = try goldenOffer("popup")
        XCTAssertTrue(offer.isFor(focusedFrame: CGRect(x: 200, y: 140, width: 260, height: 22)))
        XCTAssertTrue(offer.isFor(focusedFrame: CGRect(x: 200.6, y: 139.4, width: 260, height: 22)), "rounding between readers")
        XCTAssertFalse(offer.isFor(focusedFrame: CGRect(x: 202, y: 140, width: 260, height: 22)), "another field")
        XCTAssertFalse(offer.isFor(focusedFrame: nil))
        var frameless = OfferPopup(offerKey: "k", at: 1, field: field, spec: try fixtureSpec("picker"))
        frameless.field.frame = nil
        XCTAssertFalse(HelperOffer.popup(frameless).isFor(focusedFrame: CGRect(x: 120, y: 288, width: 180, height: 22)),
                       "a field with no frame matches nothing on screen")
    }

    func testTheDeclaredTargetIsTheHelpersFieldAndNoPidMeansNoOffer() throws {
        let offer = try goldenOffer("popup")
        XCTAssertEqual(offer.declaredTarget.pid, 5150)
        XCTAssertEqual(offer.declaredTarget.windowID, "5150-1")
        XCTAssertEqual(offer.declaredTarget.elementID, "dev.caret.fixture/standard/group:contact details/textfield:email~0")
        var bad = field
        bad.pid = 0
        XCTAssertNil(HelperOffer.popup(OfferPopup(offerKey: "k", at: 1, field: bad, spec: try fixtureSpec("picker"))).pid)
        bad.pid = Int(Int32.max) + 1
        XCTAssertNil(HelperOffer.popup(OfferPopup(offerKey: "k", at: 1, field: bad, spec: try fixtureSpec("picker"))).pid)
    }
}

/// `offerAccept` as each key builds it, through the arbiter itself.
final class OfferAcceptFromKeysTests: XCTestCase {
    let pid: Int32 = 7170

    private func key(_ code: Int64, command: Bool = false) -> KeyStroke { KeyStroke(keyCode: code, command: command, targetPID: pid) }
    private var tab: KeyStroke { .tab(to: pid) }
    private var down: KeyStroke { key(KeyStroke.downKeyCode) }
    private var up: KeyStroke { key(KeyStroke.upKeyCode) }
    private func cmd(_ n: Int) -> KeyStroke { key(Int64(17 + n), command: true) }

    private func arbiter(_ offer: HelperOffer) -> OfferArbiter {
        let arbiter = OfferArbiter()
        XCTAssertNotNil(arbiter.publish(offer.offer(target: offer.declaredTarget, fieldValue: "", caretUTF16: 0)))
        return arbiter
    }

    private func popup(_ spec: PopupSpec) -> HelperOffer {
        .popup(OfferPopup(offerKey: "pop-1", at: 1, field: field, spec: spec))
    }

    private func accept(_ decision: OfferArbiter.Decision, file: StaticString = #filePath, line: UInt = #line) throws -> OfferAccept {
        guard case .consume(let claim) = decision else {
            XCTFail("expected a claim, got \(decision)", file: file, line: line)
            throw XCTSkip("no claim")
        }
        XCTAssertFalse(claim.insertsText, "an action is the helper's to run", file: file, line: line)
        return try XCTUnwrap(OfferAccept.from(claim, at: 42), file: file, line: line)
    }

    func testTabOnTheFillPopupFillsAll() throws {
        let offer = try goldenOffer("popup")
        let arbiter = OfferArbiter()
        arbiter.publish(offer.offer(target: offer.declaredTarget, fieldValue: "", caretUTF16: 0))
        let message = try accept(arbiter.handleKeyDown(.tab(to: 5150)))
        XCTAssertEqual(message, OfferAccept(offerId: "fill-2", actionId: "fillAll", overrides: [:], at: 42))
        XCTAssertNil(arbiter.snapshot().current, "taken once")
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: 5150)), .pass(.noOffer), "a second Tab is the app's")
    }

    func testTabOnAClosedActionLineTakesItsPrimary() throws {
        let arbiter = arbiter(try goldenOffer("action"))
        XCTAssertEqual(try accept(arbiter.handleKeyDown(tab)), OfferAccept(offerId: "offer-5", actionId: "finish", overrides: [:], at: 42))
    }

    func testDownOpensTheVariantsAndTheRowGoesAsVariants() throws {
        let arbiter = arbiter(try goldenOffer("action"))
        guard case .navigate(_, let opened) = arbiter.handleKeyDown(down) else { return XCTFail("down did not open the variants") }
        XCTAssertTrue(opened.expanded)
        XCTAssertEqual(opened.highlight, 0)
        _ = arbiter.handleKeyDown(down)
        XCTAssertEqual(try accept(arbiter.handleKeyDown(tab)), OfferAccept(offerId: "offer-5", actionId: "choose", overrides: ["variants": 1], at: 42))
    }

    func testCommandDigitTakesTheActionBoundToIt() throws {
        let golden = try goldenOffer("action")
        guard case .action(var line) = golden else { return XCTFail() }
        line.actions = [
            PopupSpec.Action(id: "add", label: "Add", key: .tab),
            PopupSpec.Action(id: "addAll", label: "Add all", key: .cmd2),
        ]
        line.variants = nil
        XCTAssertEqual(try accept(arbiter(.action(line)).handleKeyDown(cmd(2))), OfferAccept(offerId: "offer-5", actionId: "addAll", overrides: [:], at: 42))
        let unbound = arbiter(.action(line))
        XCTAssertEqual(unbound.handleKeyDown(cmd(3)), .pass(.dismissed), "nothing is bound to Command-3: the app keeps it and the line goes")
        XCTAssertNil(unbound.snapshot().current)
    }

    func testCommandDigitPicksAPickerRowAndTabSendsIt() throws {
        let arbiter = arbiter(popup(try fixtureSpec("picker")))
        guard case .navigate(_, let ui) = arbiter.handleKeyDown(cmd(3)) else { return XCTFail("Command-3 did not pick a row") }
        XCTAssertEqual(ui.highlight, 2)
        XCTAssertEqual(try accept(arbiter.handleKeyDown(tab)), OfferAccept(offerId: "pop-1", actionId: "choose", overrides: ["choices": 2], at: 42))
    }

    func testTheArrowsMoveThePickerRowAndWrap() throws {
        let arbiter = arbiter(popup(try fixtureSpec("picker")))
        _ = arbiter.handleKeyDown(up)
        XCTAssertEqual(try accept(arbiter.handleKeyDown(tab)).overrides, ["choices": 2], "up from the first row wraps to the last")
    }

    func testARevealedChoicesBlockIsNamedByItsID() throws {
        let arbiter = arbiter(popup(try fixtureSpec("eventCard")))
        guard case .navigate(_, let revealed) = arbiter.handleKeyDown(cmd(2)) else { return XCTFail("Command-2 did not reveal") }
        XCTAssertEqual(revealed.revealed, "changeTime")
        XCTAssertEqual(revealed.highlight, 1, "the revealed block's own selection")
        _ = arbiter.handleKeyDown(down)
        XCTAssertEqual(try accept(arbiter.handleKeyDown(tab)), OfferAccept(offerId: "pop-1", actionId: "add", overrides: ["time": 2], at: 42))
    }

    func testAlternativesNeedNoAccept() throws {
        let arbiter = arbiter(try goldenOffer("alternatives"))
        _ = arbiter.handleKeyDown(down)
        guard case .consume(let claim) = arbiter.handleKeyDown(tab) else { return XCTFail("Tab did not take the alternative") }
        XCTAssertTrue(claim.insertsText, "the host inserts alternatives itself")
        XCTAssertEqual(claim.insertionText, "Cal Duarte")
        XCTAssertNil(OfferAccept.from(claim, at: 42))
    }

    func testTheMessageEncodesAsTheGoldenLineDoes() throws {
        let built = OfferAccept(offerId: "offer-5", actionId: "finish", overrides: ["variants": 1], at: 1_790_000_002_300)
        guard case .notForConsumer("offerAccept") = try golden("offerAccept") else { return XCTFail("offerAccept is the host's own message") }
        let lines = try String(contentsOf: goldenURL, encoding: .utf8).split(separator: "\n")
        let line = try XCTUnwrap(lines.first { $0.contains(#""type":"offerAccept""#) })
        XCTAssertEqual(try JSONDecoder().decode(OfferAccept.self, from: Data(line.utf8)), built)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: NDJSON.encoder().encode(built)) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["type", "v", "offerId", "actionId", "overrides", "at"])
        XCTAssertEqual(object["type"] as? String, "offerAccept")
        XCTAssertEqual(object["v"] as? Int, 1)
    }

    func testStopEncodesAsTheGoldenLineDoes() throws {
        let lines = try String(contentsOf: goldenURL, encoding: .utf8).split(separator: "\n")
        let line = try XCTUnwrap(lines.first { $0.contains(#""type":"offerStop""#) })
        XCTAssertEqual(try JSONDecoder().decode(OfferStop.self, from: Data(line.utf8)), OfferStop(offerId: "offer-5", at: 1_790_000_002_400))
    }
}

/// Withdrawal and the end of the working line.
final class OfferLifecycleTests: XCTestCase {
    func testAWithdrawalRemovesTheShownOfferWithThatKeyOnly() {
        XCTAssertEqual(OfferLifecycle.withdrawal(of: "offer-4.0", shownKey: "offer-4.0", heldKey: nil), .init(removeShown: true, dropHeld: false))
        XCTAssertEqual(OfferLifecycle.withdrawal(of: "offer-4.0", shownKey: "offer-5", heldKey: nil), .init(), "another offer stays")
        XCTAssertEqual(OfferLifecycle.withdrawal(of: "offer-4.0", shownKey: nil, heldKey: "offer-4.0"), .init(removeShown: false, dropHeld: true))
        XCTAssertEqual(OfferLifecycle.withdrawal(of: "offer-4", shownKey: "offer-4.0", heldKey: nil), .init(), "keys match exactly, not by prefix")
    }

    func testTheGoldenWithdrawalDecodes() throws {
        guard case .offerWithdrawn(let w) = try golden("offerWithdrawn") else { return XCTFail() }
        XCTAssertEqual(w, OfferWithdrawn(at: 1_790_000_002_500, id: "offer-4.0", reason: .taken))
    }

    private func progress(_ phase: TaskProgress.Phase, task: String = "fill-2", detail: String? = nil, reason: TaskProgress.StopReason = .mismatch) throws -> TaskProgress {
        let why = phase == .stopped ? ",\"stopReason\":\"\(reason.rawValue)\"" : ""
        let json = """
        {"type":"taskProgress","v":1,"at":1,"taskId":"\(task)","planId":"p","phase":"\(phase.rawValue)","step":null,"steps":2,"says":null,"detail":\(detail.map { "\"\($0)\"" } ?? "null")\(why)}
        """
        return try JSONDecoder().decode(TaskProgress.self, from: Data(json.utf8))
    }

    func testTheLastPhasesEndTheLineAndTheOthersDoNot() throws {
        XCTAssertEqual(OfferLifecycle.ending(of: try progress(.done), workKey: "fill-2"), .done)
        XCTAssertEqual(OfferLifecycle.ending(of: try progress(.stopped, detail: "why"), workKey: "fill-2"), .stopped(reason: .mismatch, step: nil, steps: 2, detail: "why"))
        XCTAssertEqual(OfferLifecycle.ending(of: try progress(.handoff), workKey: "fill-2"), .handoff(blocked: nil))
        XCTAssertEqual(OfferLifecycle.ending(of: try progress(.paused), workKey: "fill-2"), .paused)
        for phase: TaskProgress.Phase in [.started, .skipped, .acting, .verified, .undone] {
            XCTAssertNil(OfferLifecycle.ending(of: try progress(phase), workKey: "fill-2"), phase.rawValue)
        }
    }

    func testOnlyTheWorksOwnTaskEndsIt() throws {
        XCTAssertNil(OfferLifecycle.ending(of: try progress(.done, task: "other"), workKey: "fill-2"))
        XCTAssertNil(OfferLifecycle.ending(of: try progress(.done), workKey: nil), "no work, nothing to end")
        guard case .taskProgress(let golden) = try golden("taskProgress") else { return XCTFail("taskProgress is for the host now") }
        let reason = try XCTUnwrap(golden.stopReason, "a stopped progress says why")
        XCTAssertEqual(OfferLifecycle.ending(of: golden, workKey: "task-1"), .stopped(reason: reason, step: golden.step, steps: golden.steps, detail: golden.detail))
    }

    func testTheUndoCountComesFromTheCountsNeverTheText() throws {
        let lines = try String(contentsOf: goldenURL, encoding: .utf8).split(separator: "\n")
        let line = try XCTUnwrap(lines.first { $0.contains(#""phase":"undone""#) })
        guard case .taskProgress(let undone) = try HelperInbound.decode(Data(line.utf8)) else { return XCTFail() }
        XCTAssertEqual(OfferLifecycle.undoCount(undone), .init(restored: 2, notRestored: 1))
        var textOnly = undone
        textOnly.restored = nil
        textOnly.notRestored = nil
        XCTAssertNil(OfferLifecycle.undoCount(textOnly), "the detail says the same in words and is not parsed")
        var done = undone
        done.phase = .done
        XCTAssertNil(OfferLifecycle.undoCount(done), "only an undone progress counts an undo")
    }

    func testTheToastNamesTheSourceApps() {
        XCTAssertNil(OfferLifecycle.sourcePhrase(nil))
        XCTAssertNil(OfferLifecycle.sourcePhrase([]))
        XCTAssertEqual(OfferLifecycle.sourcePhrase(["Mail"]), "Mail")
        XCTAssertEqual(OfferLifecycle.sourcePhrase(["Mail", "Notes"]), "Mail and Notes")
        XCTAssertEqual(OfferLifecycle.sourcePhrase(["Mail", "Notes", "Safari"]), "Mail, Notes and Safari")
    }

    func testAReofferedWithdrawalNamesItsReplacement() throws {
        // The golden line itself is read from the file in HelperProtocolGoldenTests; these are the
        // lines CaretScreenCore must refuse, so the host never swaps toward an empty key.
        let missing = Data(#"{"type":"offerWithdrawn","v":1,"at":1,"id":"offer-5","reason":"reoffered"}"#.utf8)
        XCTAssertThrowsError(try HelperInbound.decode(missing), "reoffered needs replacedBy")
        let empty = Data(#"{"type":"offerWithdrawn","v":1,"at":1,"id":"offer-5","reason":"reoffered","replacedBy":""}"#.utf8)
        XCTAssertThrowsError(try HelperInbound.decode(empty))
        let expired = Data(#"{"type":"offerWithdrawn","v":1,"at":1,"id":"offer-4","reason":"expired"}"#.utf8)
        XCTAssertEqual(try HelperInbound.decode(expired), .offerWithdrawn(OfferWithdrawn(at: 1, id: "offer-4", reason: .expired)))
    }

    func testATaskGrantTakesCommandZOnlyInItsApp() {
        let target = TargetIdentity(pid: 5150, bundleID: "", windowID: "5150-1", elementID: "k", elementRevision: "")
        let arbiter = OfferArbiter()
        let id = arbiter.showToast(.task("fill-2", target: target))
        let other = KeyStroke(keyCode: KeyStroke.zKeyCode, command: true, targetPID: 7170)
        XCTAssertEqual(arbiter.handleKeyDown(other), .pass(.noOffer), "⌘Z for another app is that app's")
        let undo = KeyStroke(keyCode: KeyStroke.zKeyCode, command: true, targetPID: 5150)
        guard case .undo(let grant) = arbiter.handleKeyDown(undo) else { return XCTFail("⌘Z did not take the toast") }
        XCTAssertEqual(grant.id, id)
        XCTAssertEqual(grant.taskID, "fill-2")
        XCTAssertNil(arbiter.snapshot().toast, "one undo per toast")
    }
}
