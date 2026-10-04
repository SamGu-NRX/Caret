import XCTest
@testable import CaretHostCore

final class OfferArbiterTests: XCTestCase {
    private static let value = "I will send the "

    private func target(pid: Int32 = 4242, value: String = OfferArbiterTests.value) -> TargetIdentity {
        TargetIdentity(
            pid: pid, bundleID: "com.example.Editor", windowID: "w1",
            elementID: "compose", elementRevision: UTF16Text.digest(value)
        )
    }

    private func offer(
        text: String = "summary to the team",
        createdAt: Date = Date(),
        maxAgeSeconds: Double = 30
    ) -> Offer {
        Offer(
            text: text,
            target: target(),
            fieldValue: Self.value,
            caretUTF16: UTF16Text.length(Self.value),
            createdAt: createdAt,
            maxAgeSeconds: maxAgeSeconds
        )
    }

    private func live(_ value: String, caret: Int, pid: Int32 = 4242) -> InsertionGuard.LiveField {
        InsertionGuard.LiveField(
            target: target(pid: pid, value: value),
            value: value,
            selection: .caret(caret)
        )
    }

    private func claim(_ decision: OfferArbiter.Decision, file: StaticString = #filePath, line: UInt = #line) throws -> Claim {
        guard case .consume(let claim) = decision else {
            XCTFail("expected a claim, got \(decision)", file: file, line: line)
            throw XCTSkip("no claim")
        }
        return claim
    }

    // MARK: - Single use

    func testConcurrentDoubleTabYieldsExactlyOneClaim() {
        // Repeat so the two Tabs genuinely race on many runs, not just once.
        for round in 0..<500 {
            let arbiter = OfferArbiter()
            arbiter.publish(offer())
            let lock = NSLock()
            var decisions: [OfferArbiter.Decision] = []
            DispatchQueue.concurrentPerform(iterations: 2) { _ in
                let decision = arbiter.handleKeyDown(.tab(to: 4242))
                lock.lock(); decisions.append(decision); lock.unlock()
            }
            let claims = decisions.filter { if case .consume = $0 { return true } else { return false } }
            XCTAssertEqual(claims.count, 1, "round \(round): \(decisions)")
            XCTAssertTrue(decisions.contains(.pass(.noOffer)), "round \(round): \(decisions)")
        }
    }

    func testManyConcurrentTabsStillYieldOneClaim() {
        let arbiter = OfferArbiter()
        arbiter.publish(offer())
        let lock = NSLock()
        var consumed = 0
        DispatchQueue.concurrentPerform(iterations: 64) { _ in
            if case .consume = arbiter.handleKeyDown(.tab(to: 4242)) {
                lock.lock(); consumed += 1; lock.unlock()
            }
        }
        XCTAssertEqual(consumed, 1)
        XCTAssertEqual(arbiter.snapshot().claimCount, 1)
    }

    func testTabWithNoOfferPassesThrough() {
        XCTAssertEqual(OfferArbiter().handleKeyDown(.tab(to: 4242)), .pass(.noOffer))
    }

    // MARK: - Expiry and invalidation

    func testAnExpiredOfferPassesTabThroughAndIsRemoved() {
        let arbiter = OfferArbiter()
        arbiter.publish(offer(createdAt: Date(timeIntervalSinceNow: -31), maxAgeSeconds: 30))
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: 4242)), .pass(.expired))
        XCTAssertNil(arbiter.snapshot().current)
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: 4242)), .pass(.noOffer))
    }

    func testAnInvalidatedOfferPassesTabThrough() {
        let arbiter = OfferArbiter()
        arbiter.publish(offer())
        arbiter.invalidate()
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: 4242)), .pass(.noOffer))
    }

    func testInvalidatingAnOlderOfferKeepsTheNewerOne() throws {
        let arbiter = OfferArbiter()
        let first = try XCTUnwrap(arbiter.publish(offer(text: "first")))
        arbiter.publish(offer(text: "second"))
        arbiter.invalidate(offerID: first)
        let claim = try claim(arbiter.handleKeyDown(.tab(to: 4242)))
        XCTAssertEqual(claim.insertionText, "second")
    }

    func testADivergentKeyDismissesSoTheNextTabPassesThrough() {
        let arbiter = OfferArbiter()
        arbiter.publish(offer(text: "summary"))
        XCTAssertEqual(arbiter.handleKeyDown(.typing("x", to: 4242)), .pass(.dismissed))
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: 4242)), .pass(.noOffer))
    }

    func testModifiedTabIsNotAnAccept() {
        // ⌥→ takes one word (KeyOwnershipTests); every modified Tab keeps its meaning.
        for key in [
            KeyStroke(keyCode: KeyStroke.tabKeyCode, command: true, targetPID: 4242),
            KeyStroke(keyCode: KeyStroke.tabKeyCode, control: true, targetPID: 4242),
            KeyStroke(keyCode: KeyStroke.tabKeyCode, option: true, targetPID: 4242),
            KeyStroke(keyCode: KeyStroke.tabKeyCode, shift: true, targetPID: 4242),
        ] {
            let arbiter = OfferArbiter()
            arbiter.publish(offer())
            XCTAssertEqual(arbiter.handleKeyDown(key), .pass(.dismissed), "\(key)")
        }
    }

    func testCommandChordWithTextDismissesInsteadOfTypingThrough() {
        let arbiter = OfferArbiter()
        arbiter.publish(offer(text: "summary"))
        XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: 1, command: true, text: "s", targetPID: 4242)), .pass(.dismissed))
    }

    // MARK: - Type-through

    func testTypingTheOffersHeadKeepsItAndShortensTheInsertion() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(offer(text: "summary"))
        XCTAssertEqual(arbiter.handleKeyDown(.typing("s", to: 4242)), .pass(.typedThrough))
        XCTAssertEqual(arbiter.handleKeyDown(.typing("u", to: 4242)), .pass(.typedThrough))
        let claim = try claim(arbiter.handleKeyDown(.tab(to: 4242)))
        XCTAssertEqual(claim.insertionText, "mmary")

        let edit = try XCTUnwrap(claim.edit())
        let expectedValue = Self.value + "su"
        XCTAssertEqual(edit.replaceStart, UTF16Text.length(expectedValue))
        XCTAssertEqual(edit.target.elementRevision, UTF16Text.digest(expectedValue))
        let result = arbiter.confirm(claim, live: live(expectedValue, caret: UTF16Text.length(expectedValue)))
        guard case .success(let approved) = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertEqual(approved.resultingValue, Self.value + "summary")
    }

    func testTypingTheWholeOfferEndsIt() {
        let arbiter = OfferArbiter()
        arbiter.publish(offer(text: "ok"))
        XCTAssertEqual(arbiter.handleKeyDown(.typing("o", to: 4242)), .pass(.typedThrough))
        XCTAssertEqual(arbiter.handleKeyDown(.typing("k", to: 4242)), .pass(.dismissed))
        XCTAssertEqual(arbiter.handleKeyDown(.tab(to: 4242)), .pass(.noOffer))
    }

    // MARK: - Confirmation against the live field

    func testAFingerprintMismatchAbortsTheClaim() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(offer())
        let claim = try claim(arbiter.handleKeyDown(.tab(to: 4242)))
        let changed = "X" + Self.value
        let result = arbiter.confirm(claim, live: live(changed, caret: UTF16Text.length(changed)))
        guard case .failure(.fieldContentChanged) = result else {
            return XCTFail("expected fieldContentChanged, got \(result)")
        }
        let snapshot = arbiter.snapshot()
        XCTAssertEqual(snapshot.lastClaim?.outcome, .rejected("fieldContentChanged"))
        XCTAssertNil(snapshot.insertingClaimID, "a rejected claim must not block later offers")
        XCTAssertNotNil(arbiter.publish(offer()))
    }

    func testADifferentProcessAbortsTheClaim() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(offer())
        let claim = try claim(arbiter.handleKeyDown(.tab(to: 4242)))
        let result = arbiter.confirm(claim, live: live(Self.value, caret: UTF16Text.length(Self.value), pid: 5150))
        guard case .failure(.targetMoved) = result else { return XCTFail("expected targetMoved, got \(result)") }
    }

    func testAMovedCaretAbortsTheClaim() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(offer())
        let claim = try claim(arbiter.handleKeyDown(.tab(to: 4242)))
        let result = arbiter.confirm(claim, live: live(Self.value, caret: 3))
        guard case .failure(.selectionMoved) = result else { return XCTFail("expected selectionMoved, got \(result)") }
    }

    func testOffersAreRefusedWhileAClaimIsInsertedAndForTheConsumedRevision() throws {
        let arbiter = OfferArbiter()
        arbiter.publish(offer())
        let claim = try claim(arbiter.handleKeyDown(.tab(to: 4242)))
        XCTAssertNil(arbiter.publish(offer()), "no new offer while the claim is pending")

        let result = arbiter.confirm(claim, live: live(Self.value, caret: UTF16Text.length(Self.value)))
        guard case .success = result else { return XCTFail("expected approval, got \(result)") }
        XCTAssertNil(arbiter.publish(offer()), "no new offer while the approved edit is being inserted")

        arbiter.finishInsertion(claimID: claim.claimID, error: nil)
        XCTAssertEqual(arbiter.snapshot().lastClaim?.outcome, .inserted)
        XCTAssertNil(arbiter.publish(offer()), "the revision the insertion consumed is stale")

        let after = Self.value + "summary to the team"
        let fresh = Offer(
            text: ".", target: target(value: after), fieldValue: after, caretUTF16: UTF16Text.length(after)
        )
        XCTAssertNotNil(arbiter.publish(fresh))
        XCTAssertEqual(arbiter.snapshot().refusedPublishCount, 3)
    }
}
