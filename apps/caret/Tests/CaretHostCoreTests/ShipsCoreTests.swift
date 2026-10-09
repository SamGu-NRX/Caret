import CaretScreenCore
import Darwin
import XCTest
@testable import CaretHostCore

/// H12, the parts of "the app works for someone who just installed it" that are pure rules: when onboarding opens, the
/// Jev key step and its check, the release build's debug socket, Helium's manifest folder and the host log.
final class ShipsCoreTests: XCTestCase {
    // MARK: - Onboarding opens on first launch

    func testTheUsersOwnCaretOpensOnboardingByDefaultAndATestRunDoesNot() {
        XCTAssertEqual(OnboardingLaunch.defaultMode(homeOverridden: false, settingsNamed: false), "auto")
        XCTAssertEqual(OnboardingLaunch.defaultMode(homeOverridden: true, settingsNamed: false), "off")
        XCTAssertEqual(OnboardingLaunch.defaultMode(homeOverridden: false, settingsNamed: true), "off")
    }

    func testAutoOpensUntilFinishedThenOnlyForAMissingAccessibilityGrant() {
        let both = OnboardingPermissions(accessibility: true, inputMonitoring: true)
        let none = OnboardingPermissions(accessibility: false, inputMonitoring: false)
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: false, permissions: none, progress: nil), .init(step: .hello), "first launch")
        XCTAssertNil(OnboardingLaunch.auto(onboarded: true, permissions: both, progress: nil), "finished, nothing missing: nothing opens")
        XCTAssertEqual(OnboardingLaunch.auto(onboarded: true, permissions: .init(accessibility: false, inputMonitoring: true), progress: nil),
                       .init(step: .access, alone: true))
        XCTAssertNil(OnboardingLaunch.auto(onboarded: true, permissions: .init(accessibility: true, inputMonitoring: false), progress: nil),
                     "Input Monitoring is never asked in onboarding, so its absence opens nothing")
    }

    func testTheSwitchAloneFinishesWhenTheGrantArrives() {
        let clock = ManualClock()
        let flow = OnboardingFlow(settings: CaretSettings(), permissions: .init(accessibility: false, inputMonitoring: true), clock: clock,
                                  opening: .init(step: .access, alone: true))
        var commands: [OnboardingFlow.Command] = []
        flow.output = { if $0 != .changed { commands.append($0) } }
        flow.start()
        XCTAssertEqual(flow.state.steps, [.access])
        flow.send(.permissions(.init(accessibility: true, inputMonitoring: true)))
        clock.advance(by: OnboardingFlow.grantLanding)
        XCTAssertTrue(flow.state.finished)
        XCTAssertEqual(commands.last, .close)
    }

    // MARK: - The login item actually starts

    /// D1's VM run 4: registered and enabled, but launchd never ran it (2eea5cf). The lines are from that run's
    /// `launchctl print` and from a run where it started (H12 vm-diag).
    static let failingPrint = """
    gui/501/dev.caret.host = {
    \tactive count = 0
    \tpath = (submitted by smd.83)
    \ttype = Submitted
    \tstate = spawn scheduled
    \tprogram identifier = Contents/MacOS/Caret (mode: 2)
    \truns = 6
    \tlast exit code = 78: EX_CONFIG
    }
    """
    static let runningPrint = """
    gui/501/dev.caret.host = {
    \tstate = running
    \tprogram identifier = Contents/MacOS/Caret (mode: 2)
    \truns = 1
    \tpid = 778
    \tlast exit code = (never exited)
    \tendpoints = {
    \t\t"dev.caret.host.page-bridge" = {
    \t\t\tstate = active
    \t\t}
    \t}
    }
    """

    func testAJobLaunchdKeepsFailingToStartIsAFailureNotAHandOff() {
        let job = AgentStart.parse(Self.failingPrint)
        XCTAssertEqual(job, AgentStart.Job(state: "spawn scheduled", runs: 6, lastExit: "78: EX_CONFIG"))
        guard case .failed(let why) = AgentStart.verdict(job, elapsed: 3) else { return XCTFail("handed off to a job that never ran") }
        XCTAssertTrue(why.contains("78: EX_CONFIG"), why)
    }

    func testARunningJobIsAHandOffAndAnEndpointsStateDoesNotConfuseIt() {
        let job = AgentStart.parse(Self.runningPrint)
        XCTAssertEqual(job, AgentStart.Job(state: "running", runs: 1, lastExit: nil))
        XCTAssertEqual(AgentStart.verdict(job, elapsed: 0.5), .running)
    }

    func testANewJobGetsTheDeadlineBeforeItCountsAsFailed() {
        let pending = AgentStart.Job(state: "spawn scheduled", runs: 0, lastExit: nil)
        XCTAssertEqual(AgentStart.verdict(pending, elapsed: 2), .wait)
        XCTAssertEqual(AgentStart.verdict(AgentStart.Job(state: "spawn scheduled", runs: 1, lastExit: "1"), elapsed: 2), .wait,
                       "one exit: launchd restarts a crash")
        XCTAssertEqual(AgentStart.verdict(nil, elapsed: 2), .wait)
        guard case .failed = AgentStart.verdict(pending, elapsed: AgentStart.deadline) else { return XCTFail() }
        guard case .failed = AgentStart.verdict(nil, elapsed: AgentStart.deadline) else { return XCTFail() }
        XCTAssertNil(AgentStart.parse(""))
    }

    // MARK: - The Jev key, on the `on` step

    final class KeyRig {
        let clock = ManualClock()
        let flow: OnboardingFlow
        private(set) var commands: [OnboardingFlow.Command] = []

        /// On `on` with a ready preview; `alone` is the menu's "Jev is off".
        init(available: Bool = false, stored: Bool = false, alone: Bool = false) {
            flow = OnboardingFlow(settings: CaretSettings(), permissions: .init(accessibility: true, inputMonitoring: true), clock: clock,
                                  opening: .init(step: .on, alone: alone), jevKeyAvailable: available, jevKeyStored: stored)
            flow.output = { [unowned self] in if $0 != .changed { self.commands.append($0) } }
            flow.start()
            guard case .building(let id) = flow.state.on.preview else { return }
            flow.send(.previewReady(requestId: id, OnboardingPreview(previewId: "pv", windows: [.init(bundleId: "com.apple.mail", appName: "Mail",
                title: "Thursday?", lines: [.init(text: "Thursday at 3")], chars: 13)], chars: 13)))
        }

        var step: OnboardingStep { flow.state.step }
        var key: OnboardingFlow.JevKeyDraft { flow.state.on.jevKey }
        func send(_ events: OnboardingFlow.Event...) { for e in events { flow.send(e) } }
        var checks: [String] { commands.compactMap { if case .checkJevKey(let k) = $0 { return k.reveal } else { return nil } } }
        var looks: Int { commands.filter { if case .askFirstLook = $0 { return true } else { return false } }.count }
    }

    func testTheKeyFieldShowsOnlyWhenCaretHasNoKey() {
        XCTAssertTrue(KeyRig(available: false).flow.state.on.needsKey)
        let with = KeyRig(available: true)
        XCTAssertFalse(with.flow.state.on.needsKey)
        with.send(.next)
        XCTAssertEqual(with.looks, 1, "with a key, Send sends")
        XCTAssertEqual(with.flow.state.steps.count, 4)
    }

    func testSendWaitsForAKeyAndKeepGoesOnWithoutOne() {
        let rig = KeyRig()
        XCTAssertFalse(rig.flow.state.canContinue)
        rig.send(.next)
        XCTAssertTrue(rig.checks.isEmpty)
        XCTAssertEqual(rig.looks, 0)
        rig.send(.setJevKey("ts-something"), .keep)
        XCTAssertEqual(rig.flow.state.on.decision, .kept)
        XCTAssertTrue(rig.checks.isEmpty, "keeping everything on the Mac sends nothing, whatever the field holds")
    }

    func testAKeyThatWorksIsCheckedOnceSavedClearedAndTheLookGoes() {
        let rig = KeyRig()
        rig.send(.setJevKey("  ts-live-123\n"), .next)
        XCTAssertEqual(rig.checks, ["ts-live-123"], "surrounding spaces and newlines from a paste go")
        XCTAssertEqual(rig.key.phase, .checking)
        XCTAssertFalse(rig.flow.state.canContinue)
        rig.send(.next, .setJevKey("other"))
        XCTAssertEqual(rig.checks.count, 1, "Send and typing wait for the answer")
        rig.send(.jevKeyChecked(.works, saved: true))
        XCTAssertTrue(rig.key.stored)
        XCTAssertTrue(rig.key.text.isEmpty, "the flow does not hold a saved key")
        XCTAssertEqual(rig.looks, 1)
    }

    /// The coordinator's rule (2026-10-05): a 402 means the key is good and the account has no credits. It is kept,
    /// and the step stays so its line can be read.
    func testAKeyWithNoCreditsIsKeptAndNothingIsSent() {
        let rig = KeyRig()
        rig.send(.setJevKey("ts-live-123"), .next, .jevKeyChecked(.noCredits, saved: true))
        XCTAssertEqual(rig.key.phase.name, "noCredits")
        XCTAssertTrue(rig.key.stored)
        rig.clock.advance(by: 5)
        XCTAssertEqual(rig.looks, 0)
        XCTAssertEqual(rig.step, .on)
    }

    func testARejectedOrUncheckedKeyStaysAndSendChecksAgain() {
        for outcome in [JevKeyCheck.Outcome.rejected, .unreachable, .unclear(status: 503)] {
            let rig = KeyRig()
            rig.send(.setJevKey("ts-bad"), .next, .jevKeyChecked(outcome, saved: false))
            XCTAssertFalse(rig.key.stored)
            XCTAssertEqual(rig.key.text.reveal, "ts-bad", "kept in the field to correct")
            rig.send(.next)
            XCTAssertEqual(rig.checks, ["ts-bad", "ts-bad"], "\(outcome)")
            XCTAssertEqual(rig.looks, 0)
        }
    }

    func testAnAnswerThatKeepsTheKeyButAKeychainThatRefusedItIsNotSaved() {
        let rig = KeyRig()
        rig.send(.setJevKey("ts-live"), .next, .jevKeyChecked(.works, saved: false))
        XCTAssertEqual(rig.key.phase.name, "notSaved")
        XCTAssertFalse(rig.key.stored)
        XCTAssertEqual(rig.looks, 0, "nothing was saved, so nothing goes")
    }

    func testTextWithSpacesInsideIsNotAKeyAndIsNeverSent() {
        let rig = KeyRig()
        rig.send(.setJevKey("my key is ts-123"), .next)
        XCTAssertEqual(rig.key.phase, .malformed)
        XCTAssertTrue(rig.checks.isEmpty)
    }

    func testTheKeyAloneFinishesWhenAKeyWorks() {
        let rig = KeyRig(alone: true)
        XCTAssertEqual(rig.flow.state.steps, [.on])
        rig.send(.setJevKey("ts-new"), .next, .jevKeyChecked(.works, saved: true))
        XCTAssertTrue(rig.flow.state.finished)
        XCTAssertEqual(rig.looks, 0, "the menu's key item checks the key; it does not look")
    }

    func testTheKeyNeverReachesTheDebugReplyOrADescription() throws {
        let seed = "ts-SEEDKEY-4711"
        let rig = KeyRig()
        rig.send(.setJevKey(seed))
        let info = String(decoding: try JSONEncoder().encode(rig.flow.debugInfo()), as: UTF8.self)
        XCTAssertFalse(info.contains("SEEDKEY"), info)
        XCTAssertTrue(info.contains(#""jevKeyLength":15"#), info)
        XCTAssertFalse(String(describing: rig.flow.state).contains("SEEDKEY"))
        XCTAssertFalse(String(reflecting: rig.key).contains("SEEDKEY"))
        rig.send(.next)
        XCTAssertFalse("\(rig.commands)".contains("SEEDKEY"), "a command that carries the key prints its length only")
        XCTAssertEqual(rig.checks, [seed])
    }

    // MARK: - The check's one request

    func testEachAnswerMeansWhatTheCoordinatorSaid() {
        XCTAssertEqual(JevKeyCheck.outcome(status: 200), .works)
        XCTAssertEqual(JevKeyCheck.outcome(status: 402), .noCredits)
        XCTAssertEqual(JevKeyCheck.outcome(status: 401), .rejected)
        XCTAssertEqual(JevKeyCheck.outcome(status: 403), .rejected)
        XCTAssertEqual(JevKeyCheck.outcome(status: nil), .unreachable)
        XCTAssertEqual(JevKeyCheck.outcome(status: 503), .unclear(status: 503))
        XCTAssertEqual(JevKeyCheck.outcome(status: 429), .unclear(status: 429))
        XCTAssertTrue(JevKeyCheck.Outcome.works.keepsKey)
        XCTAssertTrue(JevKeyCheck.Outcome.noCredits.keepsKey)
        for o in [JevKeyCheck.Outcome.rejected, .unreachable, .unclear(status: 500)] { XCTAssertFalse(o.keepsKey, "\(o)") }
    }

    func testTheRequestCarriesTheKeyInItsHeaderAndNothingOfTheUsers() throws {
        let r = JevKeyCheck.request(key: "ts-abc")
        XCTAssertEqual(r.url, JevKeyCheck.url)
        XCTAssertEqual(r.httpMethod, "POST")
        XCTAssertEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer ts-abc")
        let body = try XCTUnwrap(r.httpBody)
        XCTAssertFalse(String(decoding: body, as: UTF8.self).contains("ts-abc"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["state", "model", "questions"])
        XCTAssertEqual(json["state"] as? String, "Caret is checking that this API key works.")
        XCTAssertEqual(json["model"] as? String, "jev-latest")
        XCTAssertNil(JevKeyCheck.cleaned("   "))
        XCTAssertNil(JevKeyCheck.cleaned("two words"))
        XCTAssertEqual(JevKeyCheck.cleaned("\tts-x \n"), "ts-x")
    }

    // MARK: - The release build's debug socket

    func testTheBuildDecidesWhatTheSocketAnswersAndTheOptInOpensIt() throws {
        XCTAssertEqual(try DebugSocketAccess.resolve(developmentBuild: true, environment: [:]), .full)
        XCTAssertEqual(try DebugSocketAccess.resolve(developmentBuild: false, environment: [:]), .release)
        XCTAssertEqual(try DebugSocketAccess.resolve(developmentBuild: false, environment: ["CARET_DEBUG_SOCKET": "full"]), .full)
        XCTAssertEqual(try DebugSocketAccess.resolve(developmentBuild: true, environment: ["CARET_DEBUG_SOCKET": "release"]), .release)
        XCTAssertEqual(try DebugSocketAccess.resolve(developmentBuild: false, environment: ["CARET_DEBUG_SOCKET": ""]), .release)
        XCTAssertThrowsError(try DebugSocketAccess.resolve(developmentBuild: false, environment: ["CARET_DEBUG_SOCKET": "yes"]))
    }

    func testAReleaseSocketAnswersStateAndSpendAndRefusesEverythingElse() {
        let release = DebugSocketAccess.release
        XCTAssertNil(release.refusal([]))
        XCTAssertNil(release.refusal(["state"]))
        XCTAssertNil(release.refusal(["spend"]))
        for command in ["click 123", "settings set paused on", "settings", "ask submit", "ask type hello", "inject {}", "key tab 1",
                        "control t1 undo", "services", "services restart", "onboarding next", "memory", "perch", "ping", "state x", "spend now"] {
            XCTAssertNotNil(release.refusal(command.split(separator: " ").map(String.init)), command)
        }
        XCTAssertNil(DebugSocketAccess.full.refusal(["click", "123"]))
    }

    /// Seeds every place `DebugState` holds the user's text, and checks the release reply holds none of it, while the
    /// full reply does (so the seeds really are where a leak would come from).
    func testTheReleaseStateHoldsNoFieldValueTypedTextOrOfferText() throws {
        let state = Self.seededState()
        let full = String(decoding: try JSONEncoder().encode(state), as: UTF8.self)
        for seed in Self.seeds { XCTAssertTrue(full.contains(seed), "the seed \(seed) is in the full state") }
        let release = String(decoding: try JSONEncoder().encode(ReleaseState(state)), as: UTF8.self)
        for seed in Self.seeds { XCTAssertFalse(release.contains(seed), "\(seed) leaked: \(release)") }
        let back = try JSONDecoder().decode(ReleaseState.self, from: Data(release.utf8))
        XCTAssertEqual(back.offer?.kind, "fill")
        XCTAssertEqual(back.offer?.pid, 4242)
        XCTAssertEqual(back.focus?.bundleID, "com.apple.TextEdit")
        XCTAssertEqual(back.lastClaim?.outcome, "insertFailed")
        XCTAssertEqual(back.engine, "unavailable")
        XCTAssertEqual(back.counters["offers.published"], 3)
        XCTAssertNil(back.counters["gate.SEEDCOUNTER value"])
        XCTAssertNil(back.counters["suppressed.SEEDCOUNTER"], "a well-formed name is no proof: only listed counters stay")
        XCTAssertEqual(back.focus?.role, "AXTextField")
        XCTAssertEqual(back.build, "release")
    }

    /// An app can name its element's role anything; the release state maps it.
    func testAnUnknownAccessibilityRoleIsReportedAsOther() throws {
        var state = Self.seededState()
        state.focus?.role = "SEEDROLE"
        let release = String(decoding: try JSONEncoder().encode(ReleaseState(state)), as: UTF8.self)
        XCTAssertFalse(release.contains("SEEDROLE"))
        XCTAssertTrue(release.contains(#""role":"other""#), release)
    }

    static let seeds = ["SEEDVALUE", "SEEDTYPED", "SEEDOFFER", "SEEDINSERT", "SEEDCAPTION", "SEEDERROR", "SEEDPATH", "SEEDCOUNTER", "SEEDREJECT"]

    static func seededState() -> DebugState {
        var state = DebugState(
            pid: 77, uptimeSeconds: 12,
            trust: .init(accessibility: true, listenEvents: true, postEvents: true, eventTap: true),
            engine: .init(state: "unavailable", detail: "no file at /Users/x/SEEDPATH.gguf", modelFile: "SEEDPATH.gguf"),
            focus: .init(pid: 4242, bundleID: "com.apple.TextEdit", role: "AXTextField", caretUTF16: 4, valueLength: 9, valueDigest: "SEEDVALUE-digest"),
            offer: nil, lastClaim: nil, lastInsertion: nil,
            tap: .init(running: true, enabled: true, keyDowns: 1, consumed: 0, timeoutRecoveries: 0, maxCallbackMicros: 1, p99CallbackMicros: nil),
            latency: .init(count: 0, p50Ms: nil, p95Ms: nil, maxMs: nil, samplesMs: []),
            counters: ["offers.published": 3, "gate.SEEDCOUNTER value": 1, "suppressed.SEEDCOUNTER": 1]
        )
        var offer = DebugState.OfferInfo(id: 9, text: "SEEDOFFER words", typedSinceOffer: "SEEDTYPED", ageMs: 5, pid: 4242, bundleID: "com.apple.TextEdit",
                                         caretUTF16: 4, elementRevision: "r1", presentation: "fill")
        offer.kind = "fill"
        offer.fill = DebugState.FillInfo(proposalId: "p1", windowId: "w1", fieldKey: "k1", source: "from Mail, SEEDCAPTION")
        state.offer = offer
        state.lastClaim = OfferArbiter.ClaimRecord(claimID: 1, offerID: 9, claimedAt: Date(timeIntervalSince1970: 0), insertionLength: 4, outcome: .insertFailed("SEEDREJECT"))
        state.lastInsertion = DebugState.Insertion(claimID: 1, ok: false, error: "SEEDERROR", text: "SEEDINSERT", durationMs: 3, verified: false)
        var helper = DebugState.HelperLink()
        helper.connected = true
        helper.lastError = "SEEDERROR from the helper"
        helper.skipped = ["SEEDCOUNTER": 1]
        state.helper = helper
        return state
    }

    // MARK: - Helium

    func testHeliumReadsManifestsFromItsOwnFolder() {
        XCTAssertTrue(BridgeBrowser.allCases.contains(.helium))
        XCTAssertEqual(BridgeBrowser.helium.bundleIdentifier, "net.imput.helium")
        XCTAssertEqual(BridgeBrowser.helium.nativeMessagingDirectory(userHome: "/Users/robin"),
                       "/Users/robin/Library/Application Support/net.imput.helium/NativeMessagingHosts")
    }

    // MARK: - The host log

    private func temporaryDirectory() throws -> String {
        var template = Array("/tmp/caret-h12-XXXXXX".utf8CString)
        guard let made = mkdtemp(&template) else { throw XCTSkip("mkdtemp failed") }
        return String(cString: made)
    }

    func testOnlyTheUsersOwnCaretWritesTheLogAndOnlyWhenNotOnATerminal() {
        XCTAssertTrue(HostLog.redirects(homeOverridden: false, stderrIsTerminal: false, environment: [:]))
        XCTAssertFalse(HostLog.redirects(homeOverridden: true, stderrIsTerminal: false, environment: [:]), "a test run keeps its standard error")
        XCTAssertFalse(HostLog.redirects(homeOverridden: false, stderrIsTerminal: true, environment: [:]))
        XCTAssertFalse(HostLog.redirects(homeOverridden: false, stderrIsTerminal: false, environment: ["CARET_HOST_LOG": "off"]))
        XCTAssertEqual(HostLog.default(userHome: "/Users/robin").path, "/Users/robin/Library/Logs/Caret/host.log")
    }

    func testTheLogRotatesOnceKeepingOneOlderFileAndWritersCarryOn() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let log = HostLog(path: dir + "/Logs/Caret/host.log", cap: 1000)
        let fd = try log.open()
        defer { close(fd) }
        func write(_ s: String) { _ = s.withCString { Darwin.write(fd, $0, strlen($0)) } }
        let attrs = try FileManager.default.attributesOfItem(atPath: log.path)
        XCTAssertEqual(attrs[.posixPermissions] as? Int, 0o600)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: dir + "/Logs/Caret")[.posixPermissions] as? Int, 0o700)
        write(String(repeating: "a", count: 999) + "\n")
        XCTAssertFalse(log.rotateIfNeeded(), "at the cap, not past it")
        write("first\n")
        XCTAssertTrue(log.rotateIfNeeded())
        XCTAssertTrue(try String(contentsOfFile: log.rotatedPath, encoding: .utf8).hasSuffix("first\n"))
        XCTAssertEqual(try String(contentsOfFile: log.path, encoding: .utf8), "")
        // The same descriptor goes on writing at the new end (O_APPEND), as the children's do.
        write("second\n")
        XCTAssertEqual(try String(contentsOfFile: log.path, encoding: .utf8), "second\n")
        write(String(repeating: "b", count: 1200) + "\n")
        XCTAssertTrue(log.rotateIfNeeded())
        let older = try String(contentsOfFile: log.rotatedPath, encoding: .utf8)
        XCTAssertTrue(older.hasPrefix("second\n"), "one older file: the second rotation replaced the first")
        XCTAssertFalse(older.contains("first"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: log.path + ".2"))
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: log.rotatedPath)[.posixPermissions] as? Int, 0o600)
    }

    /// Content seeded through a fill proposal the host refuses, which is the fill path that writes a log line, goes into
    /// a log that then rotates; neither file holds any of it.
    func testFieldValuesAndCaptionsInAProposalNeverReachTheLog() throws {
        let dir = try temporaryDirectory()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let log = HostLog(path: dir + "/host.log", cap: 200)
        let fd = try log.open()
        defer { close(fd) }
        let rig = FillRig()
        // A proposal whose window belongs to another process than the one it names: refused, and logged.
        let line = FillFx.line(id: "fill-seeded", email: "SEEDVALUE@example.com", phone: "SEEDPHONE 555")
            .replacingOccurrences(of: #""windowId":"5150-1""#, with: #""windowId":"9999-1""#)
        guard case .fillProposal(let proposal) = try HelperInbound.decode(Data(line.utf8)) else { return XCTFail("not a proposal") }
        rig.propose(proposal)
        let lines = rig.takeLog().filter { $0.hasPrefix("log ") }.map { String($0.dropFirst(4)) }
        XCTAssertFalse(lines.isEmpty, "the refusal is logged")
        for line in lines + [String(repeating: "x", count: 300)] {
            _ = ("caret: " + line + "\n").withCString { Darwin.write(fd, $0, strlen($0)) }
        }
        XCTAssertTrue(log.rotateIfNeeded())
        let all = try String(contentsOfFile: log.path, encoding: .utf8) + String(contentsOfFile: log.rotatedPath, encoding: .utf8)
        XCTAssertTrue(all.contains("fill-seeded"), "the line itself is there")
        for seed in ["SEEDVALUE", "SEEDPHONE", "Reference"] { XCTAssertFalse(all.contains(seed), "\(seed) in \(all)") }
    }
}
