import CaretScreenCore
import XCTest
@testable import CaretHostCore

final class CaretSettingsTests: XCTestCase {
    private func rule(_ gate: GatePolicy, _ family: String) -> GatePolicy.Rule? { gate.rules.first { $0.family == family } }

    func testTheDefaultsHelpWithEverythingAtBalancedWithThePebble() {
        let s = CaretSettings()
        XCTAssertEqual(s.roles, Set(CaretRole.allCases))
        XCTAssertEqual(s.level, .balanced)
        XCTAssertEqual(s.character, .pebble)
        XCTAssertFalse(s.paused)
        XCTAssertFalse(s.onboarded)
    }

    func testSettingsRoundTripThroughJSONWithRolesInAStableOrder() throws {
        var s = CaretSettings()
        s.roles = [.words, .fill]
        s.level = .eager
        s.character = .wren
        s.recordPreferences(source: .onboarding, at: 5)
        let data = try JSONEncoder().encode(s)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains(#""roles":["fill","words"]"#))
        XCTAssertEqual(try JSONDecoder().decode(CaretSettings.self, from: data), s)
    }

    func testAnUnknownRoleOrANewerFileIsAnErrorNotAGuess() {
        let good = #"{"version":2,"roles":["fill"],"level":"quiet","character":"seed","paused":false,"onboarded":true,"memory":[]}"#
        XCTAssertEqual(try JSONDecoder().decode(CaretSettings.self, from: Data(good.utf8)).roles, [.fill], "version 2 reads its roles as written")
        for bad in [
            good.replacingOccurrences(of: #"["fill"]"#, with: #"["fly"]"#),
            good.replacingOccurrences(of: #""version":2"#, with: #""version":3"#),
            good.replacingOccurrences(of: #""version":2"#, with: #""version":0"#),
            good.replacingOccurrences(of: #""quiet""#, with: #""loud""#),
            good.replacingOccurrences(of: #","paused":false"#, with: ""),
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(CaretSettings.self, from: Data(bad.utf8)), bad)
        }
    }

    /// H6: "Caret decides when to help" starts on, a file from before H6 reads with it on, and
    /// "Always suggest as I type" is kept as chosen.
    func testRoutingStartsOnAndAnOlderFileReadsWithItOn() throws {
        XCTAssertTrue(CaretSettings().routing)
        let before = #"{"version":2,"roles":["fill"],"level":"quiet","character":"seed","paused":false,"onboarded":true,"memory":[]}"#
        XCTAssertTrue(try JSONDecoder().decode(CaretSettings.self, from: Data(before.utf8)).routing)
        var s = CaretSettings()
        s.routing = false
        let data = try JSONEncoder().encode(s)
        XCTAssertTrue(String(decoding: data, as: UTF8.self).contains(#""routing":false"#))
        XCTAssertFalse(try JSONDecoder().decode(CaretSettings.self, from: data).routing)
    }

    /// A version 1 file predates the calendar role: it had no way to turn it off, so it reads with
    /// the role on, as a new setup starts, and saves as version 2. Every other choice is kept.
    func testAVersionOneFileGainsTheCalendarRoleAndSavesAsVersionTwo() throws {
        let v1 = #"{"version":1,"roles":["fill","watch"],"level":"quiet","character":"seed","paused":true,"onboarded":true,"memory":[]}"#
        let s = try JSONDecoder().decode(CaretSettings.self, from: Data(v1.utf8))
        XCTAssertEqual(s.roles, [.fill, .watch, .calendar])
        XCTAssertEqual(s.level, .quiet, "the level as written")
        XCTAssertTrue(s.paused, "the pause as written")
        XCTAssertEqual(s.version, 2)
        let saved = try XCTUnwrap(try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: Any])
        XCTAssertEqual(saved["version"] as? Int, 2)
        XCTAssertEqual(saved["roles"] as? [String], ["fill", "watch", "calendar"])
        let off = #"{"version":2,"roles":["fill","watch"],"level":"quiet","character":"seed","paused":true,"onboarded":true,"memory":[]}"#
        XCTAssertFalse(try JSONDecoder().decode(CaretSettings.self, from: Data(off.utf8)).roles.contains(.calendar), "a version 2 file without it turned it off")
    }

    /// B16's helper turns the event card off at Quiet and on at Balanced and Eager; the host's gate
    /// says the same, and the calendar role switches the event family alone.
    func testTheCalendarRoleIsTheEventFamilyOffAtQuiet() {
        var s = CaretSettings()
        XCTAssertEqual(CaretRole.calendar.families, ["event"])
        for (level, on) in [(CaretLevel.quiet, false), (.balanced, true), (.eager, true)] {
            s.level = level
            XCTAssertEqual(s.gate.allows(family: "event"), on, level.rawValue)
        }
        s.roles.remove(.calendar)
        XCTAssertFalse(s.gate.allows(family: "event"), "the role off turns it off at every level")
        XCTAssertTrue(s.gate.allows(family: "fill"))
    }

    func testBalancedShowsGroundedOffersFromDayOneAndNeedsHistoryOnlyForRoutines() {
        let gate = CaretSettings().gate
        XCTAssertEqual(gate.offersPerHour, 4)
        XCTAssertEqual(rule(gate, "fill"), .init(family: "fill", on: true, seenBefore: 0))
        XCTAssertEqual(rule(gate, "pending"), .init(family: "pending", on: true, seenBefore: 0))
        XCTAssertEqual(rule(gate, "loop")?.seenBefore, 2)
        XCTAssertEqual(rule(gate, "routine")?.seenBefore, 3)
        XCTAssertEqual(rule(gate, "rewrite")?.on, false)
    }

    func testEachLevelSetsItsDocumentedBudget() {
        var s = CaretSettings()
        s.level = .quiet
        XCTAssertEqual(s.gate.offersPerHour, 1)
        XCTAssertEqual(s.gate.rules.filter(\.on).map(\.family), ["ghost", "fill", "pending"])
        s.level = .eager
        XCTAssertEqual(s.gate.offersPerHour, 8)
        XCTAssertEqual(s.gate.rules.filter(\.on).map(\.family), ["ghost", "fill", "pending", "loop", "routine", "event", "rewrite"])
        XCTAssertEqual(rule(s.gate, "routine")?.seenBefore, 2)
    }

    func testUntickingARoleSwitchesOffItsFamilies() {
        for role in CaretRole.allCases {
            var s = CaretSettings()
            s.level = .eager
            s.roles.remove(role)
            for family in role.families {
                XCTAssertFalse(s.gate.allows(family: family), "\(role) off leaves \(family) on")
            }
            let others = CaretRole.allCases.filter { $0 != role }.flatMap(\.families)
            for family in others { XCTAssertTrue(s.gate.allows(family: family), "\(role) off took \(family) with it") }
        }
    }

    func testRewritesGoWithTheWordsRole() {
        var s = CaretSettings()
        s.level = .eager
        s.roles.remove(.words)
        XCTAssertFalse(s.gate.allows(family: "rewrite"))
    }

    func testPauseSwitchesEveryFamilyOff() {
        var s = CaretSettings()
        s.paused = true
        XCTAssertTrue(s.gate.paused)
        XCTAssertTrue(s.gate.rules.allSatisfy { !$0.on })
    }

    func testChoicesBecomeOnePreferenceEntryEachAndKeepTheirFirstStamp() {
        var s = CaretSettings()
        s.roles.remove(.watch)
        s.recordPreferences(source: .onboarding, at: 100)
        XCTAssertEqual(s.memory.map(\.key), ["role.fill", "role.repeat", "role.watch", "role.calendar", "role.words", "level"])
        XCTAssertEqual(s.memory.first { $0.key == "role.watch" }?.says, "No help with: Watch agent threads")
        XCTAssertEqual(s.memory.first { $0.key == "level" }?.says, "How often Caret speaks up: Balanced")
        s.level = .quiet
        s.recordPreferences(source: .menu, at: 200)
        XCTAssertEqual(s.memory.first { $0.key == "role.fill" }?.at, 100, "unchanged keeps when it was chosen")
        XCTAssertEqual(s.memory.first { $0.key == "level" }?.at, 200)
        XCTAssertEqual(s.memory.first { $0.key == "level" }?.source, .menu)
        XCTAssertEqual(s.memory.count, 6)
    }

    func testTheHostRefusesWhatTheSettingsSwitchOff() throws {
        let proposal = try HelperInbound.decode(Data(FillFx.proposalLine.utf8))
        let popup = try HelperInbound.decode(Data(#"{"type":"offerWithdrawn","v":1,"id":"x","at":1,"reason":"stale"}"#.utf8))
        var s = CaretSettings()
        XCTAssertTrue(HostGate.allows(proposal, s))
        s.roles.remove(.fill)
        XCTAssertFalse(HostGate.allows(proposal, s))
        XCTAssertTrue(HostGate.allows(popup, s), "withdrawals always get through")
        s = CaretSettings()
        s.paused = true
        XCTAssertFalse(HostGate.allows(proposal, s))
        XCTAssertFalse(HostGate.allowsGhostText(s))
        s.paused = false
        s.roles.remove(.words)
        XCTAssertFalse(HostGate.allowsGhostText(s))
    }

    func testEveryRoleStartsOnWatchIncluded() {
        // Watch is the most used role on a real day (A8 brief), so a new setup has it on.
        XCTAssertEqual(CaretSettings().roles, [.fill, .repeats, .watch, .calendar, .words])
        XCTAssertTrue(CaretSettings().gate.allows(family: "pending"))
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: OnboardingPermissions(accessibility: true, inputMonitoring: true), clock: ManualClock())
        XCTAssertTrue(flow.state.roles.contains(.watch), "the work screen opens with Watch agent threads checked")
    }

    func testRoleCopyHasNoDashesOrShouting() {
        let copy = CaretRole.allCases.flatMap { [$0.title, $0.detail] } + CaretLevel.allCases.flatMap { [$0.title, $0.detail] }
        for line in copy {
            XCTAssertFalse(line.contains("\u{2014}") || line.contains("\u{2013}"), line)
            XCTAssertFalse(line.contains("!"), line)
            XCTAssertNotEqual(line, line.uppercased(), line)
        }
    }
}
