import XCTest
@testable import CaretHostCore

/// Codex on #13: the model loaded at launch with Complete words off. It is wanted exactly when the words role is on.
final class ModelNeedTests: XCTestCase {
    /// Every set of roles, each level, paused or not, page inline text on or off: 384 settings.
    private var everySetting: [CaretSettings] {
        let roles = CaretRole.allCases
        var all: [CaretSettings] = []
        for mask in 0..<(1 << roles.count) {
            for level in CaretLevel.allCases {
                for paused in [false, true] {
                    for pageInline in [false, true] {
                        var s = CaretSettings()
                        s.roles = Set(roles.indices.filter { mask & (1 << $0) != 0 }.map { roles[$0] })
                        s.level = level
                        s.paused = paused
                        s.pageInlineText = pageInline
                        all.append(s)
                    }
                }
            }
        }
        return all
    }

    func testTheWordsRoleAloneDecides() {
        let all = everySetting
        XCTAssertEqual(all.count, 384)
        for s in all {
            XCTAssertEqual(ModelNeed.wanted(s), s.roles.contains(.words), "\(s.roles.map(\.rawValue).sorted()) \(s.level) paused=\(s.paused) pageInline=\(s.pageInlineText)")
        }
    }

    /// Ghost text, page inline text and ⌃⌥R rewrites all pass `HostGate.allowsGhostText` first: none of them may be
    /// allowed while the model is released.
    func testNoModelFeatureIsAllowedWithoutTheModel() {
        for s in everySetting where HostGate.allowsGhostText(s) {
            XCTAssertTrue(ModelNeed.wanted(s), "\(s.roles.map(\.rawValue).sorted()) \(s.level) paused=\(s.paused)")
        }
    }

    func testTheDefaultsWantIt() {
        XCTAssertTrue(ModelNeed.wanted(CaretSettings()))
    }

    /// Pause stops every offer but keeps the model, so the next words come at once when it ends.
    func testPauseKeepsIt() {
        var s = CaretSettings()
        s.paused = true
        XCTAssertFalse(HostGate.allowsGhostText(s))
        XCTAssertTrue(ModelNeed.wanted(s))
    }

    /// The other roles never need the model: fill, repeats, watch and calendar run in the helper.
    func testEveryRoleButWordsOnDoesNotWantIt() {
        var s = CaretSettings()
        s.roles = Set(CaretRole.allCases).subtracting([.words])
        XCTAssertFalse(ModelNeed.wanted(s))
    }

    func testPageInlineTextOnWithWordsOffDoesNotWantIt() {
        var s = CaretSettings()
        s.roles = [.fill]
        s.pageInlineText = true
        s.pageInlineContentEditable = true
        XCTAssertFalse(ModelNeed.wanted(s))
    }
}
