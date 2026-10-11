@testable import CaretHostCore
import Darwin
import Security
import ServiceManagement
import XCTest
@testable import CaretHost

/// H12 against the system pieces, each behind a seam or in a place of the test's own: the login item through a stand-in
/// SMAppService, the Jev key through a keychain file the test creates and deletes, its check through a stand-in
/// transport, the helper's environment through shell scripts, the browsers' manifests in a temporary home, and the
/// release socket on a socket in /tmp.
@MainActor
final class ShipsHostTests: XCTestCase {
    private var dir = ""

    override func setUpWithError() throws {
        // /tmp, not NSTemporaryDirectory: socket paths must fit in 103 bytes.
        var template = Array("/tmp/caret-h12-XXXXXX".utf8CString)
        guard let made = mkdtemp(&template) else { throw XCTSkip("mkdtemp failed") }
        dir = String(cString: made)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: dir)
    }

    // MARK: - Removable: --unregister

    final class FakeService: LoginAgent.Service {
        var status: SMAppService.Status
        var unregisters = 0
        var fails: Error?
        init(_ status: SMAppService.Status) { self.status = status }
        func unregister() throws {
            unregisters += 1
            if let fails { throw fails }
            status = .notRegistered
        }
    }

    func testUnregisterCallsTheSystemsUnregisterAndReportsIt() {
        let service = FakeService(.enabled)
        let result = LoginAgent.unregister(service)
        XCTAssertEqual(service.unregisters, 1)
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.message, "unregistered dev.caret.host: Caret no longer opens at login")
        let waiting = FakeService(.requiresApproval)
        XCTAssertTrue(LoginAgent.unregister(waiting).ok)
        XCTAssertEqual(waiting.unregisters, 1, "a login item the user turned off is still registered, and goes too")
    }

    /// The uninstaller finds out whether a build takes --unregister from Info.plist (the flag's text is too short to
    /// land in the binary's string table), so the list there and the flag main.swift handles must agree.
    func testInfoPlistListsTheCommandsMainHandles() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../..").standardized
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: root.appendingPathComponent("Bundle/Info.plist")), format: nil) as? [String: Any])
        XCTAssertEqual(plist["CaretCommands"] as? [String], ["--unregister"])
        let main = try String(contentsOf: root.appendingPathComponent("Sources/Caret/main.swift"), encoding: .utf8)
        XCTAssertTrue(main.contains(#"CommandLine.arguments.dropFirst().first == "--unregister""#))
    }

    func testUnregisteringWhatIsNotRegisteredIsDoneAlready() {
        for status in [SMAppService.Status.notRegistered, .notFound] {
            let service = FakeService(status)
            let result = LoginAgent.unregister(service)
            XCTAssertEqual(service.unregisters, 0, "kSMErrorJobNotFound is not called for")
            XCTAssertTrue(result.ok)
        }
    }

    func testAFailedUnregisterSaysSoAndFails() {
        let service = FakeService(.enabled)
        service.fails = NSError(domain: "SMAppServiceErrorDomain", code: 1, userInfo: [NSLocalizedDescriptionKey: "Operation not permitted"])
        let result = LoginAgent.unregister(service)
        XCTAssertFalse(result.ok)
        XCTAssertEqual(result.message, "could not unregister dev.caret.host: Operation not permitted")
    }

    // MARK: - Onboarding opens on first launch

    func testOnboardingOpensOnFirstLaunchAndNotAfterItIsFinished() throws {
        let store = SettingsStore(path: dir + "/settings.json")
        let controller = OnboardingController(mode: .auto, testHooks: false, store: store)
        controller.permissionsOverride = OnboardingPermissions(accessibility: true, inputMonitoring: true)
        XCTAssertEqual(controller.launchOpening(), .all)
        store.update(source: .onboarding) { $0.onboarded = true }
        XCTAssertNil(controller.launchOpening())
        // Read back from the file, as the next launch reads it.
        let next = OnboardingController(mode: .auto, testHooks: false, store: SettingsStore(path: dir + "/settings.json"))
        next.permissionsOverride = OnboardingPermissions(accessibility: true, inputMonitoring: true)
        XCTAssertNil(next.launchOpening())
        next.permissionsOverride = OnboardingPermissions(accessibility: false, inputMonitoring: true)
        XCTAssertEqual(next.launchOpening(), .only(.permissions), "Accessibility taken away after onboarding: its step alone")
        XCTAssertNil(OnboardingController(mode: .off, testHooks: false, store: store).launchOpening())
    }

    // MARK: - The key goes only into the helper's environment

    private let seedKey = "ts-SEEDKEY-0123456789abcdef"

    private func script(_ name: String, _ body: String) throws -> String {
        let path = "\(dir)/\(name)"
        try ("#!/bin/sh\n" + body).write(toFile: path, atomically: true, encoding: .utf8)
        chmod(path, 0o755)
        return path
    }

    func testAKeptKeyGoesIntoTheHelpersEnvironmentAndNowhereElse() throws {
        let home = try CaretHome.resolve(override: "\(dir)/home", userHome: "/nonexistent")
        let programs = CaretServices.Programs(node: "/usr/local/bin/node", helperEntry: "/x/main.mjs", reader: "/x/caret-screen")
        let launch = ServiceLauncher.helperLaunch(programs: programs, home: home, hostEnvironment: ["HOME": "/Users/robin"], storedKey: { self.seedKey })
        XCTAssertEqual(launch.jev, .keychain)
        XCTAssertEqual(launch.env["TYPESAFE_API_KEY"], seedKey)
        XCTAssertFalse(launch.args.contains { $0.contains("SEEDKEY") }, "not on argv")
        XCTAssertFalse(launch.args.contains("--no-jev"))
        XCTAssertFalse(launch.logLine.contains("SEEDKEY"))
        // The reader gets none of it, even when Caret's own environment holds a key.
        let reader = ServiceLauncher.childEnvironment(["HOME": "/Users/robin", "TYPESAFE_API_KEY": seedKey, "CARET_ENV_FILE": "/x/.env"], passesJevKey: false)
        XCTAssertNil(reader["TYPESAFE_API_KEY"])
        XCTAssertNil(reader["CARET_ENV_FILE"])
    }

    /// J1's daily Jev spend cap reaches the helper when set, and neither the reader nor the key rule.
    func testTheDailyJevCapReachesTheHelperOnly() throws {
        let home = try CaretHome.resolve(override: "\(dir)/home", userHome: "/nonexistent")
        let programs = CaretServices.Programs(node: "/n", helperEntry: "/m", reader: "/r")
        let launch = ServiceLauncher.helperLaunch(programs: programs, home: home, hostEnvironment: ["CARET_JEV_DAILY_CAP": "1.25"], storedKey: { nil })
        XCTAssertEqual(launch.env["CARET_JEV_DAILY_CAP"], "1.25")
        XCTAssertEqual(launch.jev, .off, "a cap is not a key")
        XCTAssertNil(ServiceLauncher.childEnvironment(["CARET_JEV_DAILY_CAP": "1.25"], passesJevKey: false)["CARET_JEV_DAILY_CAP"])
        XCTAssertNil(ServiceLauncher.helperLaunch(programs: programs, home: home, hostEnvironment: [:], storedKey: { nil }).env["CARET_JEV_DAILY_CAP"])
    }

    func testTheEnvironmentWinsOverTheKeychainAndNoKeyMeansNoJev() throws {
        let home = try CaretHome.resolve(override: "\(dir)/home", userHome: "/nonexistent")
        let programs = CaretServices.Programs(node: "/n", helperEntry: "/m", reader: "/r")
        var asked = 0
        let dev = ServiceLauncher.helperLaunch(programs: programs, home: home, hostEnvironment: ["CARET_ENV_FILE": "/x/.env"], storedKey: { asked += 1; return self.seedKey })
        XCTAssertEqual(dev.jev, .environment)
        XCTAssertEqual(dev.env["CARET_ENV_FILE"], "/x/.env")
        XCTAssertNil(dev.env["TYPESAFE_API_KEY"])
        XCTAssertEqual(asked, 0, "the keychain is not read when the environment has a key")
        let none = ServiceLauncher.helperLaunch(programs: programs, home: home, hostEnvironment: [:], storedKey: { nil })
        XCTAssertEqual(none.jev, .off)
        XCTAssertEqual(none.args.last, "--no-jev")
    }

    func testTheAgentPlistCarriesNoKey() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Bundle/dev.caret.host.plist").standardized
        let plist = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        let env = try XCTUnwrap(plist["EnvironmentVariables"] as? [String: String])
        XCTAssertEqual(env, ["CARET_LAUNCHD_AGENT": "1"])
        XCTAssertNil(plist["ProgramArguments"], "nothing on the agent's argv either")
    }

    /// End to end with real children: the launcher starts a stand-in helper that records its argv and environment,
    /// first with no key (`--no-jev`), then, after a key is kept, started again by `reloadJevKey` with it. The key is
    /// in the second environment only, and in no line the launcher logged; the deliberate restart costs no budget.
    func testAKeySavedLaterReachesTheRunningHelperByARestartAndNeverTheLog() async throws {
        let out = "\(dir)/seen"
        let helper = try script("helper.sh", """
        n=$(ls \(out).* 2>/dev/null | wc -l | tr -d ' ')
        printf '%s\\n' "$@" > \(out).$n.argv
        env > \(out).$n.env
        cat > /dev/null
        exec sleep 30
        """)
        let reader = try script("reader.sh", "cat > /dev/null\nexec sleep 30\n")
        let home = try CaretHome.resolve(override: "\(dir)/home", userHome: "/nonexistent")
        var kept: String?
        var logged: [String] = []
        let launcher = try ServiceLauncher(programs: .init(node: "/bin/sh", helperEntry: helper, reader: reader), home: home,
                                           log: { logged.append($0) }, storedKey: { kept })
        launcher.start()
        func wait(for file: String) async throws {
            let deadline = Date().addingTimeInterval(10)
            while !FileManager.default.fileExists(atPath: file), Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
            XCTAssertTrue(FileManager.default.fileExists(atPath: file), file)
        }
        try await wait(for: "\(out).0.env")
        XCTAssertEqual(launcher.jevSource, .off)
        XCTAssertTrue(try String(contentsOfFile: "\(out).0.argv", encoding: .utf8).contains("--no-jev"))
        kept = seedKey
        launcher.reloadJevKey()
        // Two files a run (argv and env); the second run's are .2.
        try await wait(for: "\(out).2.env")
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(launcher.jevSource, .keychain)
        XCTAssertTrue(try String(contentsOfFile: "\(out).2.env", encoding: .utf8).contains("TYPESAFE_API_KEY=\(seedKey)"))
        let argv = try String(contentsOfFile: "\(out).2.argv", encoding: .utf8)
        XCTAssertFalse(argv.contains("SEEDKEY"))
        XCTAssertFalse(argv.contains("--no-jev"))
        XCTAssertEqual(launcher.helper.starts, 2)
        XCTAssertEqual(launcher.helper.budget.restarts, [], "a deliberate restart is not a crash")
        XCTAssertNil(launcher.stopped)
        XCTAssertFalse(logged.contains { $0.contains("SEEDKEY") }, logged.joined(separator: "\n"))
        XCTAssertTrue(logged.contains("the helper has Jev: its key comes from the login keychain"), logged.joined(separator: "\n"))
        await launcher.stop()
    }

    // MARK: - The login keychain, as a keychain file of the test's own

    /// A keychain file in the test's folder, made and deleted here. SecKeychainCreate does not add it to the user's
    /// search list (checked below), so nothing outside the file changes.
    private func withTestKeychain(_ body: (SecKeychain) throws -> Void) throws {
        let before = Self.searchList()
        var keychain: SecKeychain?
        let password = "caret-h12-test"
        let made = SecKeychainCreate("\(dir)/test.keychain-db", UInt32(password.utf8.count), password, false, nil, &keychain)
        guard made == errSecSuccess, let keychain else { throw XCTSkip("SecKeychainCreate: \(made)") }
        defer {
            SecKeychainDelete(keychain)
            XCTAssertEqual(Self.searchList(), before, "the user's keychain search list is as it was")
        }
        try body(keychain)
    }

    private static func searchList() -> [String] {
        var list: CFArray?
        SecKeychainCopySearchList(&list)
        return ((list as? [SecKeychain]) ?? []).map { k in
            var length: UInt32 = 1024
            var path = [CChar](repeating: 0, count: 1024)
            SecKeychainGetPath(k, &length, &path)
            return String(cString: path)
        }
    }

    func testTheKeyIsSavedReadReplacedAndRemovedUnderCaretsServiceName() throws {
        try withTestKeychain { keychain in
            let store = JevKeyStore(keychain: keychain)
            XCTAssertFalse(store.exists())
            XCTAssertNil(store.read())
            try store.save("ts-first")
            XCTAssertTrue(store.exists())
            XCTAssertEqual(store.read(), "ts-first")
            try store.save("ts-second")
            XCTAssertEqual(store.read(), "ts-second", "a new key replaces the old one")
            // Exactly one item, under Caret's own service and account.
            var items: CFTypeRef?
            let q: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecMatchSearchList: [keychain], kSecMatchLimit: kSecMatchLimitAll, kSecReturnAttributes: true]
            XCTAssertEqual(SecItemCopyMatching(q as CFDictionary, &items), errSecSuccess)
            let all = try XCTUnwrap(items as? [[String: Any]])
            XCTAssertEqual(all.count, 1)
            XCTAssertEqual(all.first?[kSecAttrService as String] as? String, "dev.caret.host.jev")
            XCTAssertEqual(all.first?[kSecAttrAccount as String] as? String, "TYPESAFE_API_KEY")
            try store.delete()
            XCTAssertFalse(store.exists())
            XCTAssertNoThrow(try store.delete(), "removing a key that is not there is fine")
        }
    }

    // MARK: - The check's one request

    final class FakeTransport: JevKeyTransport, @unchecked Sendable {
        let answer: Int?
        var requests: [URLRequest] = []
        init(_ answer: Int?) { self.answer = answer }
        func status(for request: URLRequest) async -> Int? {
            requests.append(request)
            return answer
        }
    }

    func testTheCheckSendsOneRequestAndReadsItsStatus() async {
        for (status, outcome) in [(200, JevKeyCheck.Outcome.works), (402, .noCredits), (401, .rejected), (403, .rejected), (nil, .unreachable), (500, .unclear(status: 500))] as [(Int?, JevKeyCheck.Outcome)] {
            let transport = FakeTransport(status)
            let result = await JevKeyCheck.check("ts-k", transport: transport)
            XCTAssertEqual(result, outcome, "\(String(describing: status))")
            XCTAssertEqual(transport.requests.count, 1)
            XCTAssertEqual(transport.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer ts-k")
        }
    }

    /// A redirect is not followed: a 302 to a page that answers 200 is the 302, and only one request goes out.
    func testTheCheckDoesNotFollowARedirect() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RedirectingProtocol.self]
        RedirectingProtocol.requests = 0
        let status = await URLSessionJevKeyTransport(configuration: config).status(for: JevKeyCheck.request(key: "ts-k"))
        XCTAssertEqual(status, 302)
        XCTAssertEqual(RedirectingProtocol.requests, 1)
        XCTAssertEqual(JevKeyCheck.outcome(status: status), .unclear(status: 302))
    }

    final class RedirectingProtocol: URLProtocol {
        nonisolated(unsafe) static var requests = 0
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {
            Self.requests += 1
            if request.url?.host == "api.typesafe.ai" {
                let moved = HTTPURLResponse(url: request.url!, statusCode: 302, httpVersion: nil, headerFields: ["Location": "https://example.com/ok"])!
                client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: URL(string: "https://example.com/ok")!), redirectResponse: moved)
                client?.urlProtocol(self, didReceive: moved, cacheStoragePolicy: .notAllowed)
            } else {
                client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            }
            client?.urlProtocolDidFinishLoading(self)
        }
        override func stopLoading() {}
    }

    /// A check from a flow that was closed must not write over a key a newer check saved.
    func testAnOlderCheckNeverOverwritesANewerSavedKey() async throws {
        let controller = OnboardingController(mode: .hidden, testHooks: true, store: SettingsStore(path: dir + "/s-stale.json"))
        var saved: [String] = []
        var gates: [String: CheckedContinuation<Void, Never>] = [:]
        controller.jevKey = OnboardingController.JevKeyHooks(
            available: { false }, stored: { false },
            check: { key in
                await withCheckedContinuation { gates[key] = $0 }
                return .works
            },
            save: { saved.append($0); return true }, saved: {}
        )
        func submit(_ key: String) {
            _ = controller.command(["onboarding", "open"])
            _ = controller.command(["onboarding", "permissions", "on", "on"])
            for _ in 0..<3 { _ = controller.command(["onboarding", "next"]) }
            _ = controller.command(["onboarding", "jev-key", key])
            _ = controller.command(["onboarding", "next"])
        }
        submit("ts-older")
        try await Task.sleep(nanoseconds: 50_000_000)
        controller.close()
        submit("ts-newer")
        try await Task.sleep(nanoseconds: 50_000_000)
        gates["ts-newer"]?.resume()
        try await Task.sleep(nanoseconds: 50_000_000)
        gates["ts-older"]?.resume()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(saved, ["ts-newer"])
        controller.close()
    }

    /// A helper that ignores SIGTERM is killed after the grace, and the new one starts with the key.
    func testAHelperThatIgnoresSIGTERMIsReplacedAnyway() async throws {
        let out = "\(dir)/seen-hung"
        let helper = try script("hung.sh", """
        n=$(ls \(out).* 2>/dev/null | wc -l | tr -d ' ')
        env > \(out).$n
        trap '' TERM
        cat > /dev/null
        while :; do sleep 1; done
        """)
        let reader = try script("reader2.sh", "cat > /dev/null\nexec sleep 30\n")
        let home = try CaretHome.resolve(override: "\(dir)/home2", userHome: "/nonexistent")
        var kept: String?
        let launcher = try ServiceLauncher(programs: .init(node: "/bin/sh", helperEntry: helper, reader: reader), home: home, log: { _ in }, storedKey: { kept })
        launcher.start()
        let deadline = Date().addingTimeInterval(10)
        while !FileManager.default.fileExists(atPath: "\(out).0"), Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        kept = seedKey
        launcher.reloadJevKey(grace: 0.5)
        while !FileManager.default.fileExists(atPath: "\(out).1"), Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertTrue(try String(contentsOfFile: "\(out).1", encoding: .utf8).contains("TYPESAFE_API_KEY=\(seedKey)"))
        XCTAssertEqual(launcher.helper.budget.restarts, [])
        await launcher.stop(grace: 0.5)
    }

    /// The controller's side: a key Jev answers 402 for is saved and the helper started again; a 401 saves nothing.
    func testTheControllerSavesOnlyAKeyJevAuthenticated() async throws {
        for (status, saves) in [(402, true), (200, true), (401, false), (nil, false)] as [(Int?, Bool)] {
            let controller = OnboardingController(mode: .hidden, testHooks: true, store: SettingsStore(path: dir + "/s-\(UUID().uuidString).json"))
            var saved: [String] = []
            var restarts = 0
            let transport = FakeTransport(status)
            controller.jevKey = OnboardingController.JevKeyHooks(
                available: { false }, stored: { false }, check: { await JevKeyCheck.check($0, transport: transport) },
                save: { saved.append($0); return true }, saved: { restarts += 1 }
            )
            _ = controller.command(["onboarding", "open"])
            _ = controller.command(["onboarding", "permissions", "on", "on"])
            for _ in 0..<3 { _ = controller.command(["onboarding", "next"]) }
            XCTAssertEqual(controller.debugInfo()?.step, "jevKey")
            _ = controller.command(["onboarding", "jev-key", seedKey])
            _ = controller.command(["onboarding", "next"])
            let deadline = Date().addingTimeInterval(5)
            while controller.debugInfo()?.jevKey == "checking", Date() < deadline { try await Task.sleep(nanoseconds: 20_000_000) }
            XCTAssertEqual(saved, saves ? [seedKey] : [], "\(String(describing: status))")
            XCTAssertEqual(restarts, saves ? 1 : 0)
            XCTAssertEqual(controller.debugInfo()?.jevKeyStored, saves)
            controller.close()
        }
    }

    // MARK: - Add to your browser

    func testManifestsGoToEachInstalledBrowserInATemporaryHome() throws {
        let user = try CaretHome.resolve(override: nil, userHome: dir)
        let bridge = "/Applications/Caret.app/Contents/Helpers/caret-bridge"
        guard case .targets(let both) = ChromeBridgeInstaller.destination(home: user, override: nil, userHome: dir, installed: { _ in true }) else {
            return XCTFail("refused")
        }
        let results = ChromeBridgeInstaller.install(bridgePath: bridge, targets: both)
        XCTAssertEqual(results.map(\.0.browser), [.chrome, .helium])
        let expected = NativeMessagingManifest(bridgePath: bridge).encoded()
        for path in ["Google/Chrome", "net.imput.helium"] {
            XCTAssertEqual(FileManager.default.contents(atPath: "\(dir)/Library/Application Support/\(path)/NativeMessagingHosts/ai.caret.bridge.json"), expected, path)
        }
        // Helium alone: Chrome's folder is never made.
        let other = "\(dir)/other"
        guard case .targets(let one) = ChromeBridgeInstaller.destination(home: user, override: nil, userHome: other, installed: { $0 == .helium }) else {
            return XCTFail("refused")
        }
        _ = ChromeBridgeInstaller.install(bridgePath: bridge, targets: one)
        XCTAssertEqual(one.map(\.browser), [.helium])
        XCTAssertFalse(FileManager.default.fileExists(atPath: "\(other)/Library/Application Support/Google"))
        XCTAssertTrue(FileManager.default.fileExists(atPath: "\(other)/Library/Application Support/net.imput.helium/NativeMessagingHosts/ai.caret.bridge.json"))
        guard case .refused(let why) = ChromeBridgeInstaller.destination(home: user, override: nil, userHome: other, installed: { _ in false }) else {
            return XCTFail("wrote with no browser installed")
        }
        XCTAssertEqual(why, "Caret works with Google Chrome and Helium. Neither is installed on this Mac.")
    }

    func testTheBrowserWhosePageOpensIsTheDefaultOneWhenSupported() {
        XCTAssertEqual(ChromeBridgeInstaller.pageBrowser(among: [.chrome, .helium], defaultBundleID: "net.imput.helium"), .helium)
        XCTAssertEqual(ChromeBridgeInstaller.pageBrowser(among: [.chrome, .helium], defaultBundleID: "com.apple.Safari"), .chrome)
        XCTAssertEqual(ChromeBridgeInstaller.names([.chrome, .helium]), "Google Chrome and Helium")
    }

    // MARK: - The release socket

    func testAReleaseSocketInCaretsFolderRefusesClickAndAnswersARedactedState() throws {
        let sockets = "\(dir)/home/sockets"
        try FileManager.default.createDirectory(atPath: sockets, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
        let seeded = ShipsHostTests.seededState()
        let socket = DebugStateSocket(path: sockets + "/host.sock", privateDirectory: true) { command in
            HostRuntime.releaseReply(to: command.split(separator: " ").map(String.init), state: { seeded }, spend: { nil })
        }
        try socket.start()
        defer { socket.stop() }
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: sockets)[.posixPermissions] as? Int, 0o700, "a looser folder is tightened")
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: sockets + "/host.sock")[.posixPermissions] as? Int, 0o600)
        let click = try Self.ask(sockets + "/host.sock", "click 123")
        XCTAssertTrue(click.contains("answers only state and spend"), click)
        XCTAssertTrue(try Self.ask(sockets + "/host.sock", "settings set paused on").contains("error"))
        XCTAssertTrue(try Self.ask(sockets + "/host.sock", "ask submit").contains("error"))
        let state = try Self.ask(sockets + "/host.sock", "state")
        for seed in ["SEEDVALUE", "SEEDTYPED", "SEEDOFFER", "SEEDINSERT", "SEEDCAPTION"] { XCTAssertFalse(state.contains(seed), "\(seed): \(state)") }
        XCTAssertTrue(state.contains(#""bundleID":"com.apple.TextEdit""#), state)
        XCTAssertEqual(try Self.ask(sockets + "/host.sock", "spend"), "{}\n")
    }

    /// A folder above the sockets folder that others can write could have it swapped after the check.
    func testAFolderOthersCanChangeAboveTheSocketsIsRefused() throws {
        try FileManager.default.createDirectory(atPath: "\(dir)/open/sockets", withIntermediateDirectories: true)
        chmod("\(dir)/open", 0o777)
        let socket = DebugStateSocket(path: "\(dir)/open/sockets/host.sock", privateDirectory: true) { _ in Data() }
        XCTAssertThrowsError(try socket.start()) { XCTAssertTrue("\($0)".contains("others can change"), "\($0)") }
        chmod("\(dir)/open", 0o1777)
        XCTAssertNoThrow(try socket.start(), "a sticky folder, as /private/tmp is, is fine")
        socket.stop()
    }

    func testAFolderThatIsALinkIsNotCaretsOwn() throws {
        try FileManager.default.createDirectory(atPath: "\(dir)/elsewhere", withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: "\(dir)/sockets", withDestinationPath: "\(dir)/elsewhere")
        let socket = DebugStateSocket(path: "\(dir)/sockets/host.sock", privateDirectory: true) { _ in Data() }
        XCTAssertThrowsError(try socket.start()) { XCTAssertTrue("\($0)".contains("is not Caret's own"), "\($0)") }
    }

    static func seededState() -> DebugState {
        var state = DebugState(
            pid: 77, uptimeSeconds: 12, trust: .init(accessibility: true, listenEvents: true, postEvents: true, eventTap: true),
            engine: .init(state: "ready"),
            focus: .init(pid: 4242, bundleID: "com.apple.TextEdit", role: "AXTextField", caretUTF16: 4, valueLength: 9, valueDigest: "SEEDVALUE"),
            offer: nil, lastClaim: nil, lastInsertion: DebugState.Insertion(claimID: 1, ok: true, error: nil, text: "SEEDINSERT", durationMs: 2, verified: true),
            tap: .init(running: true, enabled: true, keyDowns: 1, consumed: 0, timeoutRecoveries: 0, maxCallbackMicros: 1, p99CallbackMicros: nil),
            latency: .init(count: 0, p50Ms: nil, p95Ms: nil, maxMs: nil, samplesMs: []), counters: [:]
        )
        var offer = DebugState.OfferInfo(id: 9, text: "SEEDOFFER", typedSinceOffer: "SEEDTYPED", ageMs: 5, pid: 4242, bundleID: "com.apple.TextEdit",
                                         caretUTF16: 4, elementRevision: "r", presentation: "fill")
        offer.fill = DebugState.FillInfo(proposalId: "p", windowId: "w", fieldKey: "k", source: "from Mail, SEEDCAPTION")
        state.offer = offer
        return state
    }

    static func ask(_ path: String, _ command: String) throws -> String {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        defer { close(fd) }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            let bytes = Array(path.utf8)
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        _ = (command + "\n").withCString { write(fd, $0, strlen($0)) }
        var reply = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            reply.append(contentsOf: buf[0..<n])
        }
        return String(decoding: reply, as: UTF8.self)
    }
}
