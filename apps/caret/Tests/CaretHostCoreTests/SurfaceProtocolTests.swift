import CaretScreenCore
import CoreGraphics
import XCTest
@testable import CaretHostCore

private let finish = "Sheet Fixture Finish the rest: 2 more values"

/// What the screen track's B8 and B9 protocol changes do to the surface: alternatives re-sent under
/// one key, Open re-keyed, expiry, work typed by hand, source apps and counts on the toast, the
/// reoffered swap, and a helper that goes away.
final class SurfaceProtocolTests: XCTestCase {
    func testAlternativesSentAgainUnderOneKeyRedrawInPlace() {
        play([
            Transition("a candidate's source closed: the list shrinks where it stands", [
                .screen { $0.front() }, .offer(Fx.alternatives(candidates: ["Cara Diaz", "Cal Duarte", "Cy Dunn"])),
                .press(Fx.down()), .press(Fx.down()),
                .expect(.custom("on the third") { $0.arbiter.snapshot().ui.candidate == 2 }),
                .did(["alternatives enter Cara Diaz quoted", "alternatives redraw Cal Duarte open quoted", "alternatives redraw Cy Dunn open quoted"]),
                .offer(Fx.alternatives(candidates: ["Cara Diaz", "Cal Duarte"])),
                // No clear and no entry: the same offer, redrawn, the user's place clamped to the last.
                .did(["alternatives redraw Cal Duarte open quoted"]),
                .expect(.shown("offer-4.0")), .expect(.counted("surface.replaced.helper.ghost")),
                .expect(.custom("same offer id, two candidates") { $0.machine.shown?.offerID == 1 && $0.arbiter.snapshot().current?.candidates == ["Cara Diaz", "Cal Duarte"] }),
                .press(Fx.tab()),
                .expect(.custom("Tab takes the alternative the user is on") { $0.arbiter.snapshot().lastClaim?.candidate == 1 }),
            ]),
            Transition("the spelling changed: the top candidate is redrawn, the list stays closed", [
                .screen { $0.front() }, .offer(Fx.alternatives()),
                .offer(Fx.alternatives(candidates: ["Cara Díaz", "Cal Duarte"])),
                .did(["alternatives enter Cara Diaz quoted", "alternatives redraw Cara Díaz quoted"]),
                .expect(.custom("still closed") { !$0.arbiter.snapshot().ui.open }),
            ]),
            Transition("down to one candidate: the list closes", [
                .screen { $0.front() }, .offer(Fx.alternatives()), .press(Fx.down()),
                .offer(Fx.alternatives(candidates: ["Cara Diaz"])),
                .expect(.custom("closed, on the only one") { let ui = $0.arbiter.snapshot().ui; return !ui.open && ui.candidate == 0 }),
            ]),
            Transition("typed text that no longer leads the top candidate: shown afresh", [
                .screen { $0.front() }, .offer(Fx.alternatives()), .press(Fx.type("C")), .press(Fx.type("a")), .press(Fx.type("r")),
                .offer(Fx.alternatives(candidates: ["Cal Duarte"])),
                .expect(.custom("a new offer id") { $0.machine.shown?.offerID == 2 }),
            ]),
            Transition("sent again while the field is not focused: the old one goes", [
                .screen { $0.front() }, .offer(Fx.alternatives()),
                .screen { $0.focused[Fx.app] = Fx.field(.phone) },
                .offer(Fx.alternatives(candidates: ["Cal Duarte"])),
                .expect(.shown(nil)), .expect(.tabTakes(false)), .expect(.held(.fieldNotFocused)),
                .expect(.counted("surface.withdrawn.resentNotShown")),
            ]),
            Transition("headless: the same replacement, nothing drawn", headless: true, [
                .offer(Fx.alternatives(candidates: ["Cara Diaz", "Cal Duarte", "Cy Dunn"])),
                .offer(Fx.alternatives(candidates: ["Cal Duarte"])),
                .expect(.line("Cal Duarte")), .expect(.counted("surface.replaced.helper.ghost")),
                .expect(.custom("same offer id") { $0.machine.shown?.offerID == 1 }),
            ]),
        ])
    }

    func testAReplacementKeepsTheFieldAsTheOfferFirstReadIt() throws {
        let arbiter = OfferArbiter()
        let first = Offer(text: "Cara Diaz", moreCandidates: ["Cal Duarte"], source: .helper, target: Fx.identity(.email), fieldValue: "", caretUTF16: 0)
        let id = try XCTUnwrap(arbiter.publish(first))
        XCTAssertEqual(arbiter.handleKeyDown(Fx.type("C")), .pass(.typedThrough))
        // The re-send is built from a field read after the typing: "C", caret 1.
        let resent = Offer(text: "Cara Díaz", moreCandidates: ["Cal Duarte"], source: .helper, target: Fx.identity(.email, value: "C"), fieldValue: "C", caretUTF16: 1)
        XCTAssertNotNil(arbiter.replace(offerID: id, with: resent))
        guard case .consume(let claim) = arbiter.handleKeyDown(Fx.tab()) else { return XCTFail("Tab did not take it") }
        let edit = try XCTUnwrap(claim.edit())
        XCTAssertEqual(claim.insertionText, "ara Díaz", "the rest of the new spelling after what was typed")
        XCTAssertEqual(edit.replaceStart, 1, "the typed C counted once")
        XCTAssertEqual(edit.target.elementRevision, UTF16Text.digest("C"), "the field the guard expects holds C, not CC")
    }

    func testOpenReKeyedWhenItsFieldsWindowCloses() {
        play([
            Transition("the old key is withdrawn as stale and the new one takes Tab", [
                .screen { $0.front() }, .offer(Fx.action(key: "open-w1.1", text: "Waiting for you")),
                .withdraw("open-w1.1", .stale),
                .expect(.shown(nil)), .expect(.counted("surface.withdrawn.helper.stale")),
                .screen { $0.front(.phone) },
                .offer(Fx.action(key: "open-w1.2", at: .phone, text: "Waiting for you")),
                .expect(.shown("open-w1.2")),
                .press(Fx.tab()), .sent(["accept open-w1.2 finish"]),
            ]),
            Transition("a late Tab on the old key after its withdrawal takes nothing", [
                .screen { $0.front() }, .offer(Fx.action(key: "open-w1.1")),
                .pressLate(Fx.tab()), .withdraw("open-w1.1", .stale), .deliver,
                .sent([]),
            ]),
        ])
    }

    func testExpiredIsAWithdrawalLikeAnyOther() {
        play([
            Transition("shown: taken down", [
                .screen { $0.front() }, .offer(Fx.action()), .withdraw("offer-5", .expired),
                .expect(.shown(nil)), .expect(.tabTakes(false)), .expect(.counted("surface.withdrawn.helper.expired")),
            ]),
            Transition("held: forgotten, never retried", [
                .screen { $0.behind() }, .offer(Fx.action()), .expect(.held(.appNotFront)),
                .withdraw("offer-5", .expired), .expect(.held(nil)),
                .screen { $0.front() }, .wait(1), .expect(.shown(nil)),
            ]),
            Transition("the host sets no clock of its own: a routine still offered at 10 min takes Tab", [
                .screen { $0.front() }, .offer(Fx.action()), .wait(10 * 60 + 5),
                .press(Fx.tab()), .sent(["accept offer-5 finish"]),
            ]),
        ])
    }

    func testALoopFinishTypedByHandEndsWithoutAToast() {
        play([
            Transition("withdrawn as taken while shown: the line goes, nothing replaces it", [
                .screen { $0.front() }, .offer(Fx.action()), .forgetLog,
                .withdraw("offer-5", .taken),
                .did(["clear caret", "hide 0.1"]),
                .expect(.toast(nil)), .expect(.line(nil)), .expect(.undoOwned(false)), .expect(.escOwned(false)),
                .wait(10), .did([]),
            ]),
        ])
    }

    func testTheFillToastNamesTheSourceAppsAndCountsWhatWasWritten() {
        func run(_ name: String, apps: [String]?, verified: Int, written: Int?, _ expect: [Step]) -> Transition {
            Transition(name, [
                .screen { $0.front() }, .offer(Fx.fillPopup(sourceApps: apps)), .press(Fx.tab()),
            ] + Array(repeating: Step.progress("fill-2", .verified), count: verified) + [
                .progress("fill-2", .done, written: written),
            ] + expect)
        }
        play([
            run("one app", apps: ["Mail Fixture"], verified: 2, written: 2, [.expect(.toast("Filled 2 fields from Mail Fixture"))]),
            run("two apps", apps: ["Mail Fixture", "Notes"], verified: 2, written: 2, [.expect(.toast("Filled 2 fields from Mail Fixture and Notes"))]),
            run("no apps named: no source, never the source block", apps: nil, verified: 2, written: 2, [.expect(.toast("Filled 2 fields"))]),
            run("written counts each field once, not each verified step", apps: ["Mail Fixture"], verified: 3, written: 2,
                [.expect(.toast("Filled 2 fields from Mail Fixture"))]),
            run("an older helper sends no count: the verified steps stand in", apps: ["Mail Fixture"], verified: 1, written: nil,
                [.expect(.toast("Filled 1 field from Mail Fixture"))]),
            run("nothing written: no toast, nothing to undo", apps: ["Mail Fixture"], verified: 0, written: 0,
                [.expect(.toast(nil)), .expect(.undoOwned(false)), .expect(.line("Added to Caret Fixture"))]),
        ])
    }

    func testTheUndoCaptionReadsTheCounts() {
        let toastUp: [Step] = [
            .screen { $0.front() }, .offer(Fx.fillPopup()), .press(Fx.tab()),
            .progress("fill-2", .verified), .progress("fill-2", .verified), .progress("fill-2", .done, written: 2),
            .press(Fx.cmdZ()), .sent(["accept fill-2 fillAll", "undo fill-2"]),
        ]
        play([
            Transition("all restored", toastUp + [
                .progress("fill-2", .undone, detail: "anything at all", restored: 2, notRestored: 0),
                .expect(.toast("Cleared 2 fields")),
            ]),
            Transition("one left as it is", toastUp + [
                .progress("fill-2", .undone, detail: "restored 2; not restored 0; presses not undoable 0", restored: 1, notRestored: 1),
                .expect(.toast("1 field changed after the fill, so it was left as it is.")),
            ]),
            Transition("no counts: the text is not parsed", toastUp + [
                .progress("fill-2", .undone, detail: "restored 2; not restored 0; presses not undoable 0"),
                .expect(.toast("Undone")),
            ]),
        ])
    }

    func testAReofferedLineIsSwappedInPlace() {
        let rest = "Sheet Fixture Finish the rest: 1 more value"
        play([
            Transition("the new offer is drawn over the old one, with no exit and entry", [
                .screen { $0.front() }, .offer(Fx.action()), .did(["panel enter \(finish)"]),
                .reoffer("offer-5", by: "offer-6"),
                .expect(.tabTakes(false)), .expect(.panelUp(true)), .expect(.counted("surface.withdrawn.helper.reoffered")),
                .offer(Fx.action(key: "offer-6", text: "Finish the rest: 1 more value")),
                .did(["clear caret", "panel redraw \(rest)"]),
                .expect(.shown("offer-6")), .expect(.counted("surface.reoffer.swapped")),
                .press(Fx.tab()), .sent(["accept offer-6 finish"]),
            ]),
            Transition("no replacement within a second: the old line goes", [
                .screen { $0.front() }, .offer(Fx.action()), .forgetLog,
                .reoffer("offer-5", by: "offer-6"), .wait(1),
                .did(["clear caret", "hide 0.1"]), .expect(.panelUp(false)), .expect(.counted("surface.reoffer.notReplaced")),
            ]),
            Transition("the replacement must wait (its app went behind): the old line goes at once", [
                .screen { $0.front() }, .offer(Fx.action()), .forgetLog,
                .reoffer("offer-5", by: "offer-6"),
                .screen { $0.behind() },
                .offer(Fx.action(key: "offer-6")),
                .did(["clear caret", "hide 0.1"]), .expect(.held(.appNotFront)),
            ]),
            Transition("another offer arrives first: it takes the panel as usual", [
                .screen { $0.front() }, .offer(Fx.action()), .forgetLog,
                .reoffer("offer-5", by: "offer-6"),
                .offer(Fx.fillPopup()),
                .did(["clear caret", "hide 0.0", "panel enter Fill 2 fields"]),
                .wait(2), .expect(.shown("fill-2")),
            ]),
            Transition("headless: the swap reports the new line", headless: true, [
                .offer(Fx.action()), .reoffer("offer-5", by: "offer-6"),
                .offer(Fx.action(key: "offer-6", text: "Finish the rest: 1 more value")),
                .expect(.line(rest)), .expect(.counted("surface.reoffer.swapped")),
            ]),
        ])
    }

    func testOffersGoWhenTheHelperGoesAway() {
        play([
            Transition("shown and held helper offers go; work goes on", [
                .screen { $0.front() }, .offer(Fx.action()), .linkLost,
                .expect(.shown(nil)), .expect(.tabTakes(false)), .expect(.counted("surface.withdrawn.helperGone")),
            ]),
            Transition("a held one is not retried", [
                .screen { $0.behind() }, .offer(Fx.action()), .linkLost,
                .expect(.held(nil)), .screen { $0.front() }, .wait(1), .expect(.shown(nil)),
            ]),
            Transition("accepted work that had done nothing says the helper isn't running", [
                .screen { $0.front() }, .offer(Fx.action()), .press(Fx.tab()), .linkLost,
                .expect(.workingOn(nil)), .expect(.line(unsent)), .expect(.counted("surface.work.helperGone")),
                .wait(6), .expect(.panelUp(false)),
            ]),
            Transition("accepted work that had done something says the rest wasn't done", [
                .screen { $0.front() }, .offer(Fx.fillPopup()), .press(Fx.tab()), .progress("fill-2", .verified), .linkLost,
                .expect(.workingOn(nil)), .expect(.line("Caret's helper stopped, so the rest wasn't done.")),
            ]),
        ])
    }

    /// A9: Tab on a helper's offer while the helper is down never leaves a working line waiting
    /// for progress that cannot come. It says what onboarding's first look says.
    func testTabWithTheHelperDownSaysSoAndNeverWorks() {
        play([
            Transition("drawn: the line becomes the helper-down line, then goes", [
                .screen { $0.front() }, .offer(Fx.action()), .helperDown, .press(Fx.tab()),
                .sent(["accept offer-5 finish"]),
                .expect(.workingOn(nil)), .expect(.line(unsent)), .expect(.counted("surface.accept.unsent")),
                .expect(.escOwned(true)),
                .wait(6), .expect(.panelUp(false)), .expect(.escOwned(false)),
            ]),
            Transition("a fill pop-up: no toast, nothing to undo", [
                .screen { $0.front() }, .offer(Fx.fillPopup()), .helperDown, .press(Fx.tab()),
                .expect(.line(unsent)), .expect(.toast(nil)), .expect(.undoOwned(false)),
            ]),
            Transition("headless: the same line", headless: true, [
                .offer(Fx.action()), .helperDown, .press(Fx.tab()),
                .expect(.workingOn(nil)), .expect(.line(unsent)),
            ]),
        ])
    }
}

/// Onboarding's line for an accept that could not be written (`FirstLookRun.Phase.unsent`).
private let unsent = WorkLines.acceptUnsent.text
