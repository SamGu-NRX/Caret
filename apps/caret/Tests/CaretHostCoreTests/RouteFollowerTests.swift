import CaretHostCore
import CaretScreenCore
import XCTest

/// H6: the host following the helper's route decisions (`RouteFollower`). Times are milliseconds
/// passed in; nothing waits.
final class RouteFollowerTests: XCTestCase {
    private let notes = TargetIdentity(pid: 4242, bundleID: "dev.caret.notes", windowID: "w1", elementID: "body", elementRevision: "")
    private let subject = TargetIdentity(pid: 4242, bundleID: "dev.caret.notes", windowID: "w1", elementID: "subject", elementRevision: "")
    private let doc = "4242-1"
    private let bodyKey = "dev.caret.notes/standard/textarea:body~0"
    private let subjectKey = "dev.caret.notes/standard/textfield:subject~0"
    private let t0: Int64 = 1_790_000_000_000

    private func read(_ value: String, _ target: TargetIdentity? = nil, caret: Int? = nil, selection: UTF16Selection? = nil, composing: Bool = false) -> RouteFollower.Read {
        let at = caret ?? UTF16Text.length(value)
        return RouteFollower.Read(target: target ?? notes, value: value, selection: selection ?? .caret(at), composing: composing)
    }

    private func decision(_ outcome: RouteDecision.Outcome?, context: Int, at: Int64, key: String? = nil, windowId: String? = nil,
                          revision: String, route: String? = nil, expires: Int64? = nil) -> RouteDecision {
        RouteDecision(at: at, context: context, windowId: windowId ?? doc, key: key ?? bodyKey, textRevision: revision,
                      outcome: outcome, route: outcome == .act ? (route ?? "fillAll") : nil, expires: expires ?? at + 1_800_000)
    }

    /// A follower linked to a routing helper, in the notes body, bound by a write decision.
    private func written(_ value: String = "Plans for the week") -> RouteFollower {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        XCTAssertNil(f.observe(read(value), nowMs: t0 + 10))
        let (r, follow) = f.receive(decision(.write, context: 3, at: t0 + 20, revision: RouteFollower.helperDigest(value)), nowMs: t0 + 25)
        XCTAssertEqual(r, .applied)
        XCTAssertNil(follow)
        XCTAssertEqual(f.gate(nowMs: t0 + 30), .allow(.write))
        return f
    }

    // MARK: - Binding the helper's ids

    func testADecisionWhoseDigestIsTheFieldsTextNamesItAndContextsGoUnderItsIds() throws {
        let f = written()
        XCTAssertEqual(f.boundField?.windowId, doc)
        XCTAssertEqual(f.boundField?.key, bodyKey)
        // A finished sentence is a breakpoint: one context, under the helper's ids, with the host's revision.
        let ctx = try XCTUnwrap(f.observe(read("Plans for the week. "), nowMs: t0 + 1000))
        XCTAssertEqual(ctx.windowId, doc)
        XCTAssertEqual(ctx.key, bodyKey)
        XCTAssertEqual(ctx.selection, .caret)
        XCTAssertFalse(ctx.composing)
        XCTAssertEqual(ctx.breakpoint, .sentence)
        XCTAssertEqual(ctx.textRevision, "h1")
    }

    /// The helper's digest (routing/context.ts): sha256 of text, NUL, "unknown"; first 16 hex digits.
    func testTheHelperDigestIsContextTsDigestOfTheTextWithUnknownSelection() {
        XCTAssertEqual(RouteFollower.helperDigest(""), "b1b6b391498fb13c", "node: createHash(\"sha256\").update(\"\\u0000unknown\")")
        XCTAssertEqual(RouteFollower.helperDigest("Plans for the week"), UTF16Text.digest("Plans for the week\u{0}unknown"))
    }

    func testADecisionAboutAnotherFieldDoesNotBindOrApply() {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("Plans"), nowMs: t0 + 10)
        let (r, _) = f.receive(decision(.write, context: 3, at: t0 + 20, key: subjectKey, revision: RouteFollower.helperDigest("Lunch")), nowMs: t0 + 25)
        XCTAssertEqual(r, .dropped(.otherField))
        XCTAssertNil(f.boundField)
        XCTAssertEqual(f.gate(nowMs: t0 + 30), .wait(untilMs: t0 + 10 + RouteFollower.decisionBudgetMs))
    }

    /// The reader can see focus move before the host's own read does: a decision that arrived first
    /// applies when the host gets to the field.
    func testADecisionThatArrivedBeforeTheHostSawTheFieldAppliesWhenItDoes() {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("Re: lunch", subject), nowMs: t0 + 5)
        let early = decision(.abstain, context: 4, at: t0 + 100, revision: RouteFollower.helperDigest("Plans"))
        XCTAssertEqual(f.receive(early, nowMs: t0 + 101).0, .dropped(.otherField))
        XCTAssertNil(f.observe(read("Plans"), nowMs: t0 + 140))
        XCTAssertEqual(f.boundField?.key, bodyKey)
        XCTAssertEqual(f.gate(nowMs: t0 + 150), .quiet(.abstain))
    }

    /// Two empty fields share a digest. A decision made before the host saw focus move, naming the field
    /// the user just left, does not bind the new one. One made after can (the reader may lag), but only
    /// tentatively, and the new field's own decision replaces it.
    func testTheFieldJustLeftsIdsDoNotBindTheNextFieldWithTheSameText() {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("", subject), nowMs: t0)
        let empty = RouteFollower.helperDigest("")
        XCTAssertEqual(f.receive(decision(.abstain, context: 2, at: t0 + 5, key: subjectKey, revision: empty), nowMs: t0 + 6).0, .applied)
        _ = f.observe(read(""), nowMs: t0 + 50)
        XCTAssertNil(f.boundField, "the kept decision was made before the host saw the body focused")
        XCTAssertEqual(f.receive(decision(.abstain, context: 2, at: t0 + 55, key: subjectKey, revision: empty), nowMs: t0 + 56).0, .applied)
        XCTAssertEqual(f.boundField?.key, subjectKey, "tentatively")
        XCTAssertEqual(f.receive(decision(.write, context: 3, at: t0 + 60, revision: empty), nowMs: t0 + 61).0, .applied)
        XCTAssertEqual(f.boundField?.key, bodyKey)
    }

    /// A firmly bound field's ids never bind another field, even with the same text.
    func testAFirmlyBoundFieldsIdsNeverBindAnother() {
        let f = written()
        _ = f.observe(read("Plans for the week", subject), nowMs: t0 + 100)
        XCTAssertEqual(f.receive(decision(.write, context: 4, at: t0 + 200, revision: RouteFollower.helperDigest("Plans for the week")), nowMs: t0 + 201).0, .dropped(.otherField))
        XCTAssertNil(f.boundField)
    }

    /// Review finding 1: the user moves from one empty field to another before the first's decision
    /// arrives. That late decision names the new field's text too, so it binds only tentatively, and the
    /// new field's own decision, numbered after it, replaces it.
    func testALateDecisionForTheEmptyFieldJustLeftIsReplacedByTheNewFieldsOwn() {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("", subject), nowMs: t0)
        _ = f.observe(read(""), nowMs: t0 + 40)
        let empty = RouteFollower.helperDigest("")
        XCTAssertEqual(f.receive(decision(.abstain, context: 2, at: t0 + 30, key: subjectKey, revision: empty), nowMs: t0 + 45).0, .applied)
        XCTAssertEqual(f.boundField?.key, subjectKey, "tentatively: the evidence fits either field")
        XCTAssertEqual(f.receive(decision(.write, context: 3, at: t0 + 60, revision: empty), nowMs: t0 + 61).0, .applied)
        XCTAssertEqual(f.boundField?.key, bodyKey)
        XCTAssertEqual(f.gate(nowMs: t0 + 62), .allow(.write))
        // Both fields still empty: the binding stays tentative until the host's own context is echoed.
        _ = f.observe(read("H"), nowMs: t0 + 100)
        _ = f.observe(read("Hi. "), nowMs: t0 + 200)
        XCTAssertEqual(f.receive(decision(.write, context: 5, at: t0 + 300, revision: "h1"), nowMs: t0 + 301).0, .applied)
        XCTAssertEqual(f.receive(decision(.abstain, context: 6, at: t0 + 310, key: subjectKey, revision: empty), nowMs: t0 + 311).0, .dropped(.otherField),
                       "echoed: the binding is firm now")
    }

    /// Review finding 1: while the host still reads a firmly bound field, a decision about the field
    /// the reader already sees focused does not take its ids; it applies when the host gets there.
    func testAFirmBindingKeepsItsIdsAndTheOtherFieldsDecisionWaitsForIt() {
        let f = written()
        XCTAssertEqual(f.receive(decision(.abstain, context: 5, at: t0 + 200, key: subjectKey, revision: RouteFollower.helperDigest("Plans for the week")), nowMs: t0 + 201).0,
                       .dropped(.otherField))
        XCTAssertEqual(f.boundField?.key, bodyKey)
        XCTAssertEqual(f.gate(nowMs: t0 + 202), .allow(.write))
        XCTAssertNil(f.observe(read("", subject), nowMs: t0 + 230))
        XCTAssertEqual(f.receive(decision(.write, context: 6, at: t0 + 240, key: subjectKey, revision: RouteFollower.helperDigest("")), nowMs: t0 + 241).0, .applied)
        XCTAssertEqual(f.boundField?.key, subjectKey)
    }

    /// A reader that restarted numbers windows anew: decisions keep naming this field's text under new
    /// ids. One is not enough to move a firm binding; two in a row are.
    func testAFirmBindingGivesWayWhenDecisionsKeepNamingItsTextUnderNewIds() {
        let f = written()
        let text = RouteFollower.helperDigest("Plans for the week")
        let renumbered = "4242-9"
        XCTAssertEqual(f.receive(decision(.abstain, context: 7, at: t0 + 500, windowId: renumbered, revision: text), nowMs: t0 + 501).0, .dropped(.otherField))
        XCTAssertEqual(f.boundField?.windowId, doc)
        XCTAssertEqual(f.receive(decision(.write, context: 8, at: t0 + 600, windowId: renumbered, revision: text), nowMs: t0 + 601).0, .applied)
        XCTAssertEqual(f.boundField?.windowId, renumbered)
    }

    /// Review finding 3: back in a field it bound, the host has its ids at once; a decision for them
    /// applies whichever revision it carries, and the next breakpoint sends a new one.
    func testComingBackToABoundFieldBindsItAtOnce() throws {
        let f = written()
        let first = try XCTUnwrap(f.observe(read("Plans for the week. "), nowMs: t0 + 100))
        _ = f.receive(decision(.write, context: 4, at: t0 + 300, revision: first.textRevision), nowMs: t0 + 301)
        XCTAssertNil(f.observe(nil, nowMs: t0 + 1000))
        XCTAssertNil(f.observe(read("Plans for the week. "), nowMs: t0 + 2000))
        XCTAssertEqual(f.boundField?.key, bodyKey)
        XCTAssertEqual(f.receive(decision(.write, context: 6, at: t0 + 2010, revision: RouteFollower.helperDigest("Plans for the week. ")), nowMs: t0 + 2011).0, .applied)
        let next = try XCTUnwrap(f.observe(read("Plans for the week. Lunch. "), nowMs: t0 + 3000))
        XCTAssertEqual(next.key, bodyKey)
        XCTAssertNotEqual(next.textRevision, first.textRevision)
    }

    /// Binding found a range selection the helper took as unknown: one context tells it.
    func testBindingAFieldWithARangeSelectedSendsOneContext() throws {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("Plans for the week", selection: UTF16Selection(start: 0, end: 5)), nowMs: t0)
        let (r, follow) = f.receive(decision(.write, context: 3, at: t0 + 20, revision: RouteFollower.helperDigest("Plans for the week")), nowMs: t0 + 21)
        XCTAssertEqual(r, .applied)
        let ctx = try XCTUnwrap(follow)
        XCTAssertEqual(ctx.selection, .range)
        XCTAssertNil(ctx.breakpoint)
        XCTAssertEqual(f.gate(nowMs: t0 + 22), .wait(untilMs: t0 + 21 + RouteFollower.decisionBudgetMs))
    }

    // MARK: - Stale decisions

    func testStaleDecisionsAreDropped() throws {
        let f = written()
        let ctx = try XCTUnwrap(f.observe(read("Plans for the week. "), nowMs: t0 + 1000))
        // The helper's digest is no longer the revision: the host sent its own.
        XCTAssertEqual(f.receive(decision(.write, context: 5, at: t0 + 1100, revision: RouteFollower.helperDigest("Plans for the week. ")), nowMs: t0 + 1101).0, .dropped(.revision))
        // An older revision of the host's own.
        _ = try XCTUnwrap(f.observe(read("Plans for the week. Then lunch. "), nowMs: t0 + 2000))
        XCTAssertEqual(f.receive(decision(.write, context: 6, at: t0 + 2100, revision: ctx.textRevision), nowMs: t0 + 2101).0, .dropped(.revision))
        // A lower context number than one already applied.
        XCTAssertEqual(f.receive(decision(.abstain, context: 7, at: t0 + 2200, revision: "h2"), nowMs: t0 + 2201).0, .applied)
        XCTAssertEqual(f.receive(decision(.write, context: 6, at: t0 + 2300, revision: "h2"), nowMs: t0 + 2301).0, .dropped(.older))
        // Expired on arrival.
        XCTAssertEqual(f.receive(decision(.write, context: 8, at: t0 + 2400, revision: "h2", expires: t0 + 2401), nowMs: t0 + 2500).0, .dropped(.expired))
        // Another key.
        XCTAssertEqual(f.receive(decision(.write, context: 9, at: t0 + 2600, key: subjectKey, revision: "h2"), nowMs: t0 + 2601).0, .dropped(.otherField))
        XCTAssertEqual(f.gate(nowMs: t0 + 2700), .quiet(.abstain), "none of the dropped decisions changed the answer")
        XCTAssertEqual(f.stats.dropped, ["revision": 2, "older": 1, "expired": 1, "otherField": 1])
    }

    // MARK: - Following decisions

    func testAbstainKeepsAmbientHelpQuietUntilTheNextDecision() {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("Dear Sam"), nowMs: t0)
        XCTAssertEqual(f.receive(decision(.abstain, context: 2, at: t0 + 10, revision: RouteFollower.helperDigest("Dear Sam")), nowMs: t0 + 11).0, .applied)
        for (i, text) in ["Dear Sam,", "Dear Sam, t", "Dear Sam, th", "Dear Sam, tha"].enumerated() {
            XCTAssertNil(f.observe(read(text), nowMs: t0 + 100 + Int64(i) * 100), "typing is no breakpoint")
            XCTAssertEqual(f.gate(nowMs: t0 + 150 + Int64(i) * 100), .quiet(.abstain))
        }
        XCTAssertEqual(f.gate(nowMs: t0 + 10 * 60_000), .quiet(.abstain), "long after, with no breakpoint, still quiet")
    }

    func testActAndAskAreQuietForGhostTextTheirOffersAreTheHelpers() {
        for outcome in [RouteDecision.Outcome.act, .ask] {
            let f = RouteFollower(enabled: true)
            f.linkChanged(up: true, routing: true, nowMs: t0)
            _ = f.observe(read(""), nowMs: t0)
            _ = f.receive(decision(outcome, context: 2, at: t0 + 10, revision: RouteFollower.helperDigest("")), nowMs: t0 + 11)
            XCTAssertEqual(f.gate(nowMs: t0 + 20), outcome == .act ? .quiet(.act) : .quiet(.ask))
        }
    }

    func testAWriteSessionSurvivesTypingAndEndsAtABreakpoint() throws {
        let f = written()
        var text = "Plans for the week"
        for (i, ch) in " and the weekend".enumerated() {
            text.append(ch)
            XCTAssertNil(f.observe(read(text), nowMs: t0 + 100 + Int64(i) * 80), "no context while typing")
            XCTAssertEqual(f.gate(nowMs: t0 + 101 + Int64(i) * 80), .allow(.write))
        }
        XCTAssertEqual(f.stats.contextsSent, 0)
        // The sentence ends: one context, and the session holds no more until the next decision.
        let end = t0 + 5000
        let ctx = try XCTUnwrap(f.observe(read(text + ". "), nowMs: end))
        XCTAssertEqual(ctx.breakpoint, .sentence)
        XCTAssertEqual(f.gate(nowMs: end + 1), .wait(untilMs: end + RouteFollower.decisionBudgetMs))
        XCTAssertNil(f.observe(read(text + ". T"), nowMs: end + 50), "typing after the breakpoint sends nothing more")
        XCTAssertEqual(f.stats.contextsSent, 1)
        XCTAssertEqual(f.receive(decision(.write, context: 9, at: end + 300, revision: ctx.textRevision), nowMs: end + 302).0, .applied)
        XCTAssertEqual(f.gate(nowMs: end + 303), .allow(.write))
    }

    func testAParagraphASelectionAndACompositionAreEachOneBreakpoint() throws {
        let f = written("Plans.")
        let para = try XCTUnwrap(f.observe(read("Plans.\n"), nowMs: t0 + 100))
        XCTAssertEqual(para.breakpoint, .paragraph)
        let range = try XCTUnwrap(f.observe(read("Plans.\n", selection: UTF16Selection(start: 0, end: 5)), nowMs: t0 + 200))
        XCTAssertEqual(range.selection, .range)
        XCTAssertNil(range.breakpoint)
        XCTAssertNil(f.observe(read("Plans.\n", selection: UTF16Selection(start: 0, end: 6)), nowMs: t0 + 250), "a wider range is the same mode")
        let caret = try XCTUnwrap(f.observe(read("Plans.\n"), nowMs: t0 + 300))
        XCTAssertEqual(caret.selection, .caret)
        let ime = try XCTUnwrap(f.observe(read("Plans.\n", composing: true), nowMs: t0 + 400))
        XCTAssertTrue(ime.composing)
        XCTAssertEqual(f.stats.breakpoints, ["focus": 1, "paragraph": 1, "selection": 2, "composing": 1])
    }

    /// A null outcome: the helper saw a breakpoint itself, so the last decision ended.
    func testANullOutcomeEndsTheWriteSessionUntilTheNextDecision() {
        let f = written()
        let digest = RouteFollower.helperDigest("Plans for the week")
        XCTAssertEqual(f.receive(decision(nil, context: 4, at: t0 + 1000, revision: digest), nowMs: t0 + 1001).0, .applied)
        XCTAssertEqual(f.gate(nowMs: t0 + 1002), .wait(untilMs: t0 + 1001 + RouteFollower.decisionBudgetMs))
        XCTAssertEqual(f.receive(decision(.abstain, context: 4, at: t0 + 1200, revision: digest), nowMs: t0 + 1201).0, .applied)
        XCTAssertEqual(f.gate(nowMs: t0 + 1202), .quiet(.abstain))
    }

    func testAnExpiredDecisionLeavesTheHostAsBeforeTheRouter() {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("x"), nowMs: t0)
        _ = f.receive(decision(.abstain, context: 2, at: t0 + 1, revision: RouteFollower.helperDigest("x"), expires: t0 + 1000), nowMs: t0 + 2)
        XCTAssertEqual(f.gate(nowMs: t0 + 999), .quiet(.abstain))
        XCTAssertEqual(f.gate(nowMs: t0 + 1000), .allow(.expired))
    }

    // MARK: - When routing is unavailable

    func testWithTheSettingOffOrNoRoutingHelperTheHostBehavesAsBefore() {
        let off = RouteFollower(enabled: false)
        off.linkChanged(up: true, routing: false, nowMs: t0)
        XCTAssertNil(off.observe(read("Plans"), nowMs: t0))
        XCTAssertNil(off.observe(read("Plans. "), nowMs: t0 + 100), "no context with the setting off")
        XCTAssertEqual(off.gate(nowMs: t0 + 101), .allow(.off))
        XCTAssertEqual(off.receive(decision(.abstain, context: 2, at: t0, revision: "x"), nowMs: t0).0, .dropped(.off))

        let old = RouteFollower(enabled: true)
        old.linkChanged(up: true, routing: false, nowMs: t0)
        _ = old.observe(read("Plans"), nowMs: t0)
        XCTAssertEqual(old.gate(nowMs: t0 + 1), .allow(.noHelper), "a connection that did not declare routing")
        old.linkChanged(up: false, routing: false, nowMs: t0 + 2)
        XCTAssertEqual(old.gate(nowMs: t0 + 3), .allow(.noHelper), "no helper")
    }

    /// A helper without Jev, or from before D2-02, takes the capability and never decides: the
    /// first budget it misses makes routing unavailable, and the host shows help at once after that.
    func testAHelperThatNeverDecidesCostsOneBudgetThenNothing() {
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("Plans"), nowMs: t0)
        XCTAssertEqual(f.gate(nowMs: t0 + 100), .wait(untilMs: t0 + RouteFollower.decisionBudgetMs))
        XCTAssertEqual(f.gate(nowMs: t0 + RouteFollower.decisionBudgetMs), .allow(.unavailable))
        _ = f.observe(read("Plans. "), nowMs: t0 + 5000)
        XCTAssertEqual(f.gate(nowMs: t0 + 5001), .allow(.unavailable), "no wait at the next breakpoint")
        _ = f.observe(read("Lunch", subject), nowMs: t0 + 6000)
        XCTAssertEqual(f.gate(nowMs: t0 + 6001), .allow(.unavailable), "nor in the next field")
        // A decision that applies brings routing back.
        _ = f.receive(decision(.abstain, context: 2, at: t0 + 6100, key: subjectKey, revision: RouteFollower.helperDigest("Lunch")), nowMs: t0 + 6101)
        XCTAssertEqual(f.gate(nowMs: t0 + 6102), .quiet(.abstain))
    }

    /// A helper that routes may still miss one budget (Router 1's cooldown): that context shows help
    /// as before, and a late decision still applies when it comes. Only three misses in a row with no
    /// decision applied between them make routing unavailable.
    func testALateDecisionFallsBackForItsContextAndStillApplies() throws {
        let f = written()
        var at = t0 + 1000
        var text = "Plans for the week"
        func sentence() throws -> RoutingContext {
            text += ". Then"
            _ = f.observe(read(text), nowMs: at)
            text += ". "
            return try XCTUnwrap(f.observe(read(text), nowMs: at + 10))
        }
        let late = try sentence()
        XCTAssertEqual(f.gate(nowMs: at + 10 + RouteFollower.decisionBudgetMs), .allow(.budget))
        XCTAssertEqual(f.receive(decision(.abstain, context: 10, at: at + 2000, revision: late.textRevision), nowMs: at + 2001).0, .applied)
        XCTAssertEqual(f.gate(nowMs: at + 2002), .quiet(.abstain), "a late decision applies when it comes")
        for n in 1...RouteFollower.missesBeforeUnavailable {
            at += 5000
            _ = try sentence()
            let expected: RouteFollower.Gate = n < RouteFollower.missesBeforeUnavailable ? .allow(.budget) : .allow(.unavailable)
            XCTAssertEqual(f.gate(nowMs: at + 10 + RouteFollower.decisionBudgetMs), expected, "miss \(n) after the late decision")
        }
        XCTAssertEqual(f.stats.misses, 4)
        XCTAssertTrue(f.isUnavailable)
    }

    func testTurningTheSettingOffAnswersAllowAtOnceAndSendsNothing() {
        let f = written()
        f.setEnabled(false, nowMs: t0 + 100)
        XCTAssertEqual(f.gate(nowMs: t0 + 101), .allow(.off))
        XCTAssertNil(f.observe(read("Plans for the week. "), nowMs: t0 + 200))
    }

    // MARK: - Tab and visibility

    /// Routing grants nothing: while a decision is awaited or abstains, the host publishes no ghost
    /// offer, so Tab passes to the app; a ghost offer the host draws still needs reveal before Tab takes it.
    func testTabTakesOnlyAVisibleOfferWhateverTheDecision() throws {
        let arbiter = OfferArbiter()
        let f = RouteFollower(enabled: true)
        f.linkChanged(up: true, routing: true, nowMs: t0)
        _ = f.observe(read("Plans"), nowMs: t0)
        let tab = KeyStroke.tab(to: notes.pid)
        // Waiting: the host holds its suggestion, so nothing is published.
        XCTAssertFalse(f.gate(nowMs: t0 + 1).allows)
        if case .consume = arbiter.handleKeyDown(tab) { XCTFail("Tab took something while the decision was awaited") }
        // Write: published hidden until drawn; Tab before the reveal passes.
        _ = f.receive(decision(.write, context: 2, at: t0 + 10, revision: RouteFollower.helperDigest("Plans")), nowMs: t0 + 11)
        XCTAssertTrue(f.gate(nowMs: t0 + 12).allows)
        let offer = Offer(text: " for the week", target: notes, fieldValue: "Plans", caretUTF16: 5)
        let hidden = try XCTUnwrap(arbiter.publish(offer, shown: false))
        XCTAssertEqual(arbiter.handleKeyDown(tab), .pass(.dismissed), "Tab took an offer that was not drawn")
        XCTAssertFalse(arbiter.reveal(offerID: hidden))
        let drawn = try XCTUnwrap(arbiter.publish(offer, shown: false))
        XCTAssertTrue(arbiter.reveal(offerID: drawn))
        guard case .consume = arbiter.handleKeyDown(tab) else { return XCTFail("Tab must take the drawn offer") }
    }
}
