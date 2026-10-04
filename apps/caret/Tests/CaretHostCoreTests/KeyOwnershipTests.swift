import CaretScreenCore
import XCTest
@testable import CaretHostCore

/// Walks every row of the keyboard table in `SURFACES.md` section 8 through the arbiter itself:
/// for each surface, every key in `keys` is either owned (swallowed, acted on) or passes through
/// and dismisses what was shown.
final class KeyOwnershipTests: XCTestCase {
    static let pid: Int32 = 4242
    static let value = "I will send the "

    static let keys: [(String, KeyStroke)] = [
        ("tab", .tab(to: pid)),
        ("shift-tab", KeyStroke(keyCode: KeyStroke.tabKeyCode, shift: true, targetPID: pid)),
        ("up", KeyStroke(keyCode: KeyStroke.upKeyCode, targetPID: pid)),
        ("down", KeyStroke(keyCode: KeyStroke.downKeyCode, targetPID: pid)),
        ("left", KeyStroke(keyCode: KeyStroke.leftKeyCode, targetPID: pid)),
        ("right", KeyStroke(keyCode: KeyStroke.rightKeyCode, targetPID: pid)),
        ("opt-right", KeyStroke(keyCode: KeyStroke.rightKeyCode, option: true, targetPID: pid)),
        ("esc", KeyStroke(keyCode: KeyStroke.escapeKeyCode, targetPID: pid)),
        ("return", KeyStroke(keyCode: KeyStroke.returnKeyCode, targetPID: pid)),
        ("delete", KeyStroke(keyCode: KeyStroke.deleteKeyCode, targetPID: pid)),
        ("space", KeyStroke(keyCode: KeyStroke.spaceKeyCode, text: " ", targetPID: pid)),
        ("letter", KeyStroke(keyCode: 12, text: "q", targetPID: pid)),
        ("cmd-1", KeyStroke(keyCode: 18, command: true, targetPID: pid)),
        ("cmd-2", KeyStroke(keyCode: 19, command: true, targetPID: pid)),
        ("cmd-3", KeyStroke(keyCode: 20, command: true, targetPID: pid)),
        ("cmd-z", KeyStroke(keyCode: KeyStroke.zKeyCode, command: true, targetPID: pid)),
    ]

    // MARK: - Fixtures

    static func target(_ value: String = value) -> TargetIdentity {
        TargetIdentity(pid: pid, bundleID: "com.example.Editor", windowID: "w1", elementID: "compose", elementRevision: UTF16Text.digest(value))
    }

    static func ghost(_ candidates: [String] = ["summary to the team"]) -> Offer {
        Offer(text: candidates[0], moreCandidates: Array(candidates.dropFirst()), target: target(), fieldValue: value, caretUTF16: UTF16Text.length(value))
    }

    static let four = ["summary to the team", "notes after lunch", "slides tonight", "deck to Dana"]

    static func spec(_ name: String) -> PopupSpec {
        let data = try! Data(contentsOf: PopupSpecTests.fixtureURL)
        let root = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        let valid = root["valid"] as! [String: Any]
        return try! PopupSpec.decode(JSONSerialization.data(withJSONObject: valid[name]!))
    }

    static func popup(_ name: String) -> Offer {
        Offer(text: "", source: .debug, kind: .popup(PopupOffer(offerKey: name, spec: spec(name))), target: target(), fieldValue: value, caretUTF16: 0)
    }

    static func actionLine(numbered: Bool, variants: Bool) -> Offer {
        var actions = [PopupSpec.Action(id: "add", label: "Add", key: .tab)]
        if numbered { actions.append(PopupSpec.Action(id: "open", label: "Open Calendar", key: .cmd2)) }
        let line = ActionLine(
            offerKey: "line-1", app: "Calendar",
            endState: PopupSpec.Value("Coffee with Dana, Thu 3:00 to 3:30", ref: .node(key: "4242-1/compose/body", quote: nil)),
            actions: actions, variants: variants ? spec("picker") : nil
        )
        return Offer(text: "", source: .debug, kind: .action(line), target: target(), fieldValue: value, caretUTF16: 0)
    }

    static func fill(fillAll: Bool) -> Offer {
        var origin = FillOrigin(
            proposalID: "p1", windowID: "4242-2", fieldKey: "email", sourceAppName: "Mail",
            sourceWindowTitle: "Invoice 2041", sourceBundleID: "com.apple.mail", sourcePID: 77, proposedAtMs: 0
        )
        origin.fillAll = fillAll
        return Offer(text: "dana@northline.example", source: .helper, kind: .fill(origin), target: target(""), fieldValue: "", caretUTF16: 0)
    }

    static func grant() -> UndoGrant {
        UndoGrant(target: target("x"), priorValue: "", writtenValue: "x", insertedStart: 0, insertedLength: 1, origin: nil)
    }

    // MARK: - The table

    /// One row of the table: how to reach the surface, which keys Caret owns there, and how to
    /// tell that a passing key dismissed it.
    struct Row {
        let name: String
        let owned: Set<String>
        let setUp: (OfferArbiter) -> Void
        let isGone: (OfferArbiter.Snapshot) -> Bool
    }

    static let offerGone: (OfferArbiter.Snapshot) -> Bool = { $0.current == nil }

    static let rows: [Row] = [
        Row(name: "nothing", owned: [], setUp: { _ in }, isGone: { _ in true }),
        Row(name: "ghost text, one candidate", owned: ["tab", "opt-right", "esc"],
            setUp: { $0.publish(ghost()) }, isGone: offerGone),
        Row(name: "ghost text, four candidates", owned: ["tab", "opt-right", "esc", "down"],
            setUp: { $0.publish(ghost(four)) }, isGone: offerGone),
        Row(name: "alternatives open", owned: ["tab", "opt-right", "up", "down", "esc", "cmd-1", "cmd-2", "cmd-3"],
            setUp: { $0.publish(ghost(four)); _ = $0.handleKeyDown(KeyStroke(keyCode: KeyStroke.downKeyCode, targetPID: pid)) },
            isGone: offerGone),
        Row(name: "action line with a numbered action and variants", owned: ["tab", "esc", "cmd-2", "down"],
            setUp: { $0.publish(actionLine(numbered: true, variants: true)) }, isGone: offerGone),
        Row(name: "action line, Tab only", owned: ["tab", "esc"],
            setUp: { $0.publish(actionLine(numbered: false, variants: false)) }, isGone: offerGone),
        Row(name: "pop-up with rows (picker)", owned: ["tab", "esc", "cmd-1", "cmd-2", "cmd-3", "up", "down"],
            setUp: { $0.publish(popup("picker")) }, isGone: offerGone),
        Row(name: "pop-up without rows (event card)", owned: ["tab", "esc", "cmd-2"],
            setUp: { $0.publish(popup("eventCard")) }, isGone: offerGone),
        Row(name: "pop-up with a down action (fill preview)", owned: ["tab", "esc", "down"],
            setUp: { $0.publish(popup("fillPreview")) }, isGone: offerGone),
        Row(name: "ghost fill", owned: ["tab", "esc"],
            setUp: { $0.publish(fill(fillAll: false)) }, isGone: offerGone),
        Row(name: "ghost fill with fill-all", owned: ["tab", "esc", "cmd-1"],
            setUp: { $0.publish(fill(fillAll: true)) }, isGone: offerGone),
        Row(name: "working line, under 3 s", owned: [],
            setUp: { $0.showStatus(StatusLine(pid: pid, kind: .working(startedAt: Date()))) },
            isGone: { $0.statusLine == nil }),
        Row(name: "working line, after 3 s", owned: ["esc"],
            setUp: { $0.showStatus(StatusLine(pid: pid, kind: .working(startedAt: Date(timeIntervalSinceNow: -4)))) },
            isGone: { $0.statusLine == nil }),
        Row(name: "toast", owned: ["cmd-z", "esc"],
            setUp: { $0.showToast(grant()) }, isGone: { $0.toast == nil }),
        Row(name: "error line", owned: ["esc"],
            setUp: { $0.showStatus(StatusLine(pid: pid, kind: .error)) }, isGone: { $0.statusLine == nil }),
    ]

    static func consumed(_ decision: OfferArbiter.Decision) -> Bool {
        if case .pass = decision { return false }
        return true
    }

    func testEveryRowOfTheKeyboardTable() {
        for row in Self.rows {
            for (name, key) in Self.keys {
                let arbiter = OfferArbiter()
                row.setUp(arbiter)
                let decision = arbiter.handleKeyDown(key)
                let owned = row.owned.contains(name)
                XCTAssertEqual(Self.consumed(decision), owned, "\(row.name): \(name) -> \(decision)")
                if !owned {
                    XCTAssertTrue(row.isGone(arbiter.snapshot()), "\(row.name): \(name) passed but did not dismiss")
                }
            }
        }
    }

    func testCaretNeverOwnsTheCaretKeysOrTyping() {
        for row in Self.rows {
            for name in ["left", "right", "return", "delete", "space", "letter"] {
                XCTAssertFalse(row.owned.contains(name), "\(row.name) owns \(name)")
            }
        }
    }

    func testAModifierAloneNeverDismissesAnything() {
        let arbiter = OfferArbiter()
        arbiter.publish(Self.ghost(Self.four))
        arbiter.showToast(Self.grant())
        for code in KeyStroke.modifierKeyCodes {
            XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: code, shift: true, targetPID: Self.pid)), .pass(.modifierOnly))
        }
        XCTAssertNotNil(arbiter.snapshot().current)
        XCTAssertNotNil(arbiter.snapshot().toast)
    }

    func testOwnershipIsPerApp() {
        let arbiter = OfferArbiter()
        arbiter.publish(Self.ghost(Self.four))
        XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: KeyStroke.downKeyCode, targetPID: 9)), .pass(.otherApp))
        XCTAssertEqual(arbiter.handleKeyDown(KeyStroke(keyCode: KeyStroke.downKeyCode)), .pass(.otherApp))
        XCTAssertNotNil(arbiter.snapshot().current)
    }
}
