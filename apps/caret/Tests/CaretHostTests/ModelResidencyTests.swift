import AppCompatibility
import AutocompleteCore
import CaretHostCore
import ModelRuntime
import XCTest
@testable import CaretHost

/// Codex on #13: the model loads only while Complete words is on, and is released when it goes off. A release waits
/// for every call inside the model before llama is freed.
@MainActor
final class ModelResidencyTests: XCTestCase {
    private var dir: URL!

    override func setUp() async throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("caret-residency-\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: dir)
    }

    /// A store on a temporary file, so no test touches the user's settings.
    private func store(words: Bool) -> SettingsStore {
        let store = SettingsStore(path: dir.appendingPathComponent("settings.json").path)
        if !words { store.update(source: .socket) { $0.roles.remove(.words) } }
        return store
    }

    // MARK: - Switch state, through the settings store

    func testWordsOnAtLaunchLoads() async {
        let model = FakeModel()
        model.residency.follow(store(words: true))
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load"])
    }

    func testWordsOffAtLaunchNeverLoads() async {
        let model = FakeModel()
        model.residency.follow(store(words: false))
        await model.residency.settled()
        XCTAssertEqual(model.log, [])
    }

    func testWordsOffReleasesAndOnLoadsAgain() async {
        let model = FakeModel()
        let store = store(words: true)
        model.residency.follow(store)
        await model.residency.settled()
        XCTAssertNil(store.set(["role", "words", "off"]))
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load", "release"])
        XCTAssertFalse(model.residency.loaded)
        XCTAssertNil(store.set(["role", "words", "on"]))
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load", "release", "load"])
        XCTAssertTrue(model.residency.loaded)
    }

    func testWordsOnFromOffLoads() async {
        let model = FakeModel()
        let store = store(words: false)
        model.residency.follow(store)
        XCTAssertNil(store.set(["role", "words", "on"]))
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load"])
    }

    /// Pause, the level, the other roles, routing and page inline text change no model.
    func testSwitchesOtherThanWordsLeaveTheModelAsItIs() async {
        for words in [true, false] {
            let model = FakeModel()
            let store = store(words: words)
            model.residency.follow(store)
            await model.residency.settled()
            let before = model.log
            for change in [
                ["paused", "on"], ["paused", "off"], ["level", "quiet"], ["level", "eager"],
                ["role", "fill", "off"], ["role", "repeat", "off"], ["role", "watch", "off"], ["role", "calendar", "off"],
                ["role", "fill", "on"], ["routing", "on"], ["pageInlineText", "off"], ["pageInlineContentEditable", "off"],
            ] {
                XCTAssertNil(store.set(change), "\(change)")
                await model.residency.settled()
                XCTAssertEqual(model.log, before, "words \(words): \(change)")
            }
            XCTAssertEqual(model.residency.loaded, words)
        }
    }

    func testTheLastRoleOnBeingWordsStillKeepsIt() async {
        let model = FakeModel()
        let store = store(words: true)
        store.update(source: .socket) { $0.roles = [.words] }
        model.residency.follow(store)
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load"])
        XCTAssertNil(store.set(["role", "words", "off"]))
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load", "release"], "no role on: nothing needs the model")
    }

    // MARK: - Flips while a load or a release runs

    func testOffDuringALoadReleasesAfterIt() async {
        let model = FakeModel(holding: true)
        model.residency.want(true)
        await model.untilHeld()
        model.residency.want(false)
        model.holding = false
        model.finish()
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load", "release"])
        XCTAssertFalse(model.residency.loaded)
    }

    func testOffAndOnAgainDuringALoadCostsNothingMore() async {
        let model = FakeModel(holding: true)
        model.residency.want(true)
        await model.untilHeld()
        model.residency.want(false)
        model.residency.want(true)
        model.finish()
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load"])
        XCTAssertTrue(model.residency.loaded)
    }

    func testOnDuringAReleaseLoadsAfterIt() async {
        let model = FakeModel()
        model.residency.want(true)
        await model.residency.settled()
        model.holding = true
        model.residency.want(false)
        await model.untilHeld()
        model.residency.want(true)
        model.holding = false
        model.finish()
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load", "release", "load"])
        XCTAssertTrue(model.residency.loaded)
    }

    func testTheSameAnswerTwiceDoesNothingTwice() async {
        let model = FakeModel()
        model.residency.want(false)
        model.residency.want(true)
        model.residency.want(true)
        await model.residency.settled()
        model.residency.want(true)
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load"])
    }

    func testStopFinishesTheRunningStepAndStartsNoOther() async {
        let model = FakeModel(holding: true)
        model.residency.want(true)
        await model.untilHeld()
        model.residency.want(false)
        let stopping = Task { await model.residency.stop() }
        await until { model.residency.stopped }
        model.finish()
        await stopping.value
        XCTAssertEqual(model.log, ["load"], "quit frees through the engine's shutdown, not a second step")
        model.residency.want(false)
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load"], "ignored after stop")
    }

    func testAFinishedLoadTellsTheFields() async {
        let model = FakeModel()
        model.residency.want(true)
        await model.residency.settled()
        XCTAssertEqual(model.told, 1)
        model.residency.want(false)
        await model.residency.settled()
        XCTAssertEqual(model.told, 1, "a release tells nothing")
    }

    /// Codex on #30: quit closes the residency before it tears the fields down, so a load ending then wakes none.
    func testALoadEndingAfterCloseTellsNoField() async {
        let model = FakeModel(holding: true)
        model.residency.want(true)
        await model.untilHeld()
        model.residency.close()
        model.finish()
        await model.residency.settled()
        XCTAssertEqual(model.log, ["load"])
        XCTAssertEqual(model.told, 0)
    }

    // MARK: - Onboarding's hello field

    func testTheHelloFieldReadsOffTheMomentWordsGoesOff() {
        var off = CaretSettings()
        off.roles.remove(.words)
        let states: [GhostTextEngine.State] = [.ready, .loading, .unavailable("missing"), .off]
        for state in states {
            XCTAssertEqual(HostRuntime.onboardingReadiness(state, off), .off, "\(state)")
        }
        let on = CaretSettings()
        XCTAssertEqual(HostRuntime.onboardingReadiness(.ready, on), .ready)
        XCTAssertEqual(HostRuntime.onboardingReadiness(.loading, on), .loading(nil))
        XCTAssertEqual(HostRuntime.onboardingReadiness(.unavailable("missing"), on), .unavailable)
        XCTAssertEqual(HostRuntime.onboardingReadiness(.off, on), .off, "on, before the load starts")
    }

    // MARK: - Calls inside the model

    func testDrainedReturnsAtOnceWithNoCallInside() async {
        let calls = InFlight()
        await calls.drained()
        XCTAssertEqual(calls.count, 0)
    }

    func testDrainedWaitsForTheLastCallToLeave() async {
        let calls = InFlight()
        calls.enter()
        calls.enter()
        let done = Flag()
        let waiting = Task { await calls.drained(); done.on = true }
        await until { calls.waiting == 1 }
        calls.leave()
        XCTAssertEqual(calls.waiting, 1, "one call is still inside")
        XCTAssertFalse(done.on)
        calls.leave()
        await waiting.value
        XCTAssertTrue(done.on)
    }

    // MARK: - The engine's release

    func testReleaseFreesOnlyAfterTheCallInsideLeaves() async {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        let runtime = CountingRuntime()
        engine.adoptForTesting(runtime: runtime)
        engine.calls.enter()
        let releasing = Task { await engine.release() }
        await until { engine.calls.waiting == 1 }
        XCTAssertEqual(engine.state, .off, "a call that starts now finds no model")
        XCTAssertEqual(runtime.shutdowns, 0, "llama is not freed under a call inside it")
        engine.calls.leave()
        await releasing.value
        XCTAssertEqual(runtime.shutdowns, 1)
    }

    func testAfterReleaseNoCallReachesTheModelAndNothingHoldsIt() async throws {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        weak var held: CountingRuntime?
        do {
            let runtime = CountingRuntime()
            held = runtime
            engine.adoptForTesting(runtime: runtime)
        }
        await engine.release()
        XCTAssertNil(held, "the engine keeps no reference, so the memory goes")
        let rewrites = try await engine.rewrites(of: "The plan is set.", mode: .list)
        XCTAssertNil(rewrites)
        let context = TextFieldContext(beforeCursor: "The plan is", target: AppTarget(bundleIdentifier: "com.apple.TextEdit", appName: "TextEdit"))
        let outcome = try await engine.suggest(for: context)
        XCTAssertEqual(outcome, .suppressed("engineNotReady"))
        XCTAssertEqual(engine.calls.count, 0)
    }

    func testStayOffAndReleaseWithNothingLoadedReadOff() async {
        let engine = GhostTextEngine(compatibilityStore: AppCompatibilityStore())
        engine.stayOff()
        XCTAssertEqual(engine.state, .off)
        await engine.release()
        XCTAssertEqual(engine.state, .off)
        await engine.shutdown()
        XCTAssertEqual(engine.state, .unavailable("shut down"))
    }

    /// Returns once `condition` holds; fails the test if it doesn't within 1,000 yields.
    private func until(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        var tries = 0
        while !condition(), tries < 1_000 {
            await Task.yield()
            tries += 1
        }
        if !condition() { XCTFail("condition never held", file: file, line: line) }
    }
}

@MainActor
private final class Flag {
    var on = false
}

/// Loads and releases as a log, each step held open on request.
@MainActor
private final class FakeModel {
    var log: [String] = []
    /// Times the fields were told a load finished.
    var told = 0
    var holding: Bool
    private var held: [CheckedContinuation<Void, Never>] = []
    private(set) var residency: ModelResidency!

    init(holding: Bool = false) {
        self.holding = holding
        residency = ModelResidency(load: { [unowned self] in await self.step("load") },
                                   loaded: { [unowned self] in self.told += 1 },
                                   release: { [unowned self] in await self.step("release") })
    }

    private func step(_ name: String) async {
        log.append(name)
        if holding { await withCheckedContinuation { held.append($0) } }
    }

    func finish() {
        let ready = held
        held = []
        for step in ready { step.resume() }
    }

    /// Returns once a step is held open; fails the test if none is within 1,000 yields.
    func untilHeld(file: StaticString = #filePath, line: UInt = #line) async {
        var tries = 0
        while held.isEmpty, tries < 1_000 {
            await Task.yield()
            tries += 1
        }
        if held.isEmpty { XCTFail("no step held", file: file, line: line) }
    }
}

/// KeyType's stub runtime, counting the shutdowns that would free llama.
private final class CountingRuntime: LocalModelRuntime {
    private let base = StubModelRuntime()
    private(set) var shutdowns = 0
    var metadata: ModelMetadata { base.metadata }
    var tokenizer: ModelTokenizing { base.tokenizer }
    func prepare(promptTokens: [TokenID]) async throws { try await base.prepare(promptTokens: promptTokens) }
    func logitsForNextToken() async throws -> [TokenLogit] { try await base.logitsForNextToken() }
    func decodeNext(tokenID: TokenID) async throws { try await base.decodeNext(tokenID: tokenID) }
    func resetKVCache() async { await base.resetKVCache() }
    func shutdown() async { shutdowns += 1 }
}
