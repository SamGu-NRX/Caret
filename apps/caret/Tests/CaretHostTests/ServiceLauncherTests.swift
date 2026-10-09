import CaretHostCore
import Darwin
import XCTest
@testable import CaretHost

/// The launcher with real child processes (shell scripts standing in for the helper and the reader): how the launch
/// secret reaches a child, what a child inherits, and the crash rule. Everything lives in a /tmp directory of the
/// test's own; nothing is started outside it.
@MainActor
final class ServiceLauncherTests: XCTestCase {
    private var dir = ""

    override func setUpWithError() throws {
        // /tmp, not NSTemporaryDirectory: the socket paths below the Caret home must fit in 103 bytes.
        var template = Array("/tmp/caret-h4-XXXXXX".utf8CString)
        guard let made = mkdtemp(&template) else { throw XCTSkip("mkdtemp failed") }
        dir = String(cString: made)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: dir)
    }

    private func script(_ name: String, _ body: String) throws -> String {
        let path = "\(dir)/\(name)"
        try ("#!/bin/sh\n" + body).write(toFile: path, atomically: true, encoding: .utf8)
        chmod(path, 0o755)
        return path
    }

    private func waitForExit(_ pid: pid_t, seconds: Double = 10) -> Int32? {
        let deadline = Date().addingTimeInterval(seconds)
        var status: Int32 = 0
        while Date() < deadline {
            if waitpid(pid, &status, WNOHANG) == pid { return status }
            usleep(20_000)
        }
        kill(pid, SIGKILL)
        return nil
    }

    func testTheSecretArrivesOnStdinAndNowhereElse() throws {
        let out = "\(dir)/seen"
        let child = try script("child.sh", """
        head -c 64 | od -An -tx1 | tr -d ' \\n' > \(out).stdin
        printf '%s\\n' "$@" > \(out).argv
        env > \(out).env
        """)
        let secret = Data((0..<32).map { UInt8($0 * 7 % 256) })
        guard case .success(let pid) = ServiceLauncher.spawnWithSecret(path: child, args: ["--auth-fd", "0"], env: ["PATH": "/usr/bin:/bin"], secret: secret) else {
            return XCTFail("spawn failed")
        }
        XCTAssertEqual(waitForExit(pid), 0)
        let hex = secret.map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(try String(contentsOfFile: out + ".stdin", encoding: .utf8), hex, "exactly the 32 bytes, then end of file")
        XCTAssertEqual(try String(contentsOfFile: out + ".argv", encoding: .utf8), "--auth-fd\n0\n")
        let env = try String(contentsOfFile: out + ".env", encoding: .utf8)
        XCTAssertFalse(env.contains(hex), "the secret is not in the environment")
        XCTAssertFalse(env.contains("DYLD_"), env)
    }

    func testAChildInheritsOnlyItsThreeStandardDescriptors() throws {
        // A descriptor of the parent's that is not close-on-exec, as a listening socket would be.
        // Numbered high, so it cannot be mistaken for one the child opens itself.
        let opened = open("/dev/null", O_RDONLY)
        let leak: Int32 = 77
        XCTAssertEqual(dup2(opened, leak), leak)
        close(opened)
        defer { close(leak) }
        let out = "\(dir)/fds"
        let child = try script("fds.sh", "ls /dev/fd > \(out)\n")
        guard case .success(let pid) = ServiceLauncher.spawnWithSecret(path: child, args: [], env: ["PATH": "/usr/bin:/bin"], secret: Data(count: 32)) else {
            return XCTFail("spawn failed")
        }
        XCTAssertEqual(waitForExit(pid), 0)
        // ls opens descriptors of its own to read /dev/fd; the parent's 77 must not be among them.
        let fds = try String(contentsOfFile: out, encoding: .utf8).split(separator: "\n").compactMap { Int32($0) }
        XCTAssertFalse(fds.contains(leak), "descriptors \(fds) include the parent's \(leak)")
        XCTAssertEqual(Array(fds.prefix(3)), [0, 1, 2])
    }

    func testAChildStopsOnSIGTERMEvenThoughCaretIgnoresIt() throws {
        let previous = signal(SIGTERM, SIG_IGN)
        defer { signal(SIGTERM, previous) }
        let child = try script("sleeper.sh", "cat > /dev/null\nexec sleep 30\n")
        guard case .success(let pid) = ServiceLauncher.spawnWithSecret(path: child, args: [], env: ["PATH": "/usr/bin:/bin"], secret: Data(count: 32)) else {
            return XCTFail("spawn failed")
        }
        usleep(300_000)
        kill(pid, SIGTERM)
        let status = try XCTUnwrap(waitForExit(pid, seconds: 5), "the child ignored SIGTERM")
        XCTAssertEqual(ServiceLauncher.describe(status), "signal \(SIGTERM)")
    }

    func testTheChildEnvironmentIsBuiltNotInherited() throws {
        let env = try ServiceLauncher.childEnvironment([
            "HOME": "/Users/robin", "PATH": "/opt/homebrew/bin:/usr/bin", "NODE_OPTIONS": "--require /tmp/x.js",
            "DYLD_INSERT_LIBRARIES": "/tmp/x.dylib", "CARET_ENV_FILE": "/Users/robin/.env", "TYPESAFE_API_KEY": "",
        ], passesJevKey: true)
        XCTAssertEqual(env, ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/Users/robin", "CARET_ENV_FILE": "/Users/robin/.env"])
        XCTAssertTrue(ServiceLauncher.hasJevKey(env))
        XCTAssertFalse(ServiceLauncher.hasJevKey(try ServiceLauncher.childEnvironment(["HOME": "/Users/robin"], passesJevKey: true)))
    }

    /// The crash rule end to end: a helper that exits at once is started five more times with the same secret, then
    /// both services stop and say why. About 5 s: the restart delay is 1 s.
    func testACrashingHelperRestartsFiveTimesWithTheSameSecretThenStops() async throws {
        let seen = "\(dir)/secrets"
        let helper = try script("helper.sh", "head -c 64 | shasum -a 256 >> \(seen)\nexit 3\n")
        let reader = try script("reader.sh", "cat > /dev/null\nexec sleep 60\n")
        let home = try CaretHome.resolve(override: "\(dir)/home", userHome: "/nonexistent")
        let launcher = try ServiceLauncher(
            programs: .init(node: "/bin/sh", helperEntry: helper, reader: reader), home: home, log: { _ in }
        )
        launcher.start()
        let deadline = Date().addingTimeInterval(15)
        while launcher.stopped == nil, Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
        let stopped = try XCTUnwrap(launcher.stopped, "still running after 15 s")
        XCTAssertEqual(stopped, "the helper exited 6 times within 60 s (last: exit 3)")
        XCTAssertEqual(launcher.helper.starts, 6)
        let digests = try String(contentsOfFile: seen, encoding: .utf8).split(separator: "\n")
        XCTAssertEqual(digests.count, 6)
        XCTAssertEqual(Set(digests).count, 1, "every start got the same secret")
        // The empty input's digest would mean no secret was written.
        XCTAssertNotEqual(digests.first.map(String.init), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  -")
        // Stopping took the reader down too, when it had started (it waits instead without the Accessibility grant).
        func readerRuns() -> Bool { if case .running = launcher.reader.status { return true } else { return false } }
        while readerRuns(), Date() < deadline { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertFalse(readerRuns(), "the reader still runs after the stop")
        // The home's socket directory was made the user's own and closed to others.
        let mode = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: home.socketsDirectory)[.posixPermissions] as? Int)
        XCTAssertEqual(mode, 0o700)
    }

    /// A host killed outside launchd leaves its children running; the next launcher in the same home stops them, and
    /// only them: a record whose start time no longer matches is someone else's process now.
    func testTheNextLauncherStopsChildrenAKilledOneLeftAndNothingElse() throws {
        let sleeper = try script("orphan.sh", "cat > /dev/null\nexec sleep 30\n")
        guard case .success(let left) = ServiceLauncher.spawnWithSecret(path: sleeper, args: [], env: ["PATH": "/usr/bin:/bin"], secret: Data(count: 32)),
              case .success(let other) = ServiceLauncher.spawnWithSecret(path: sleeper, args: [], env: ["PATH": "/usr/bin:/bin"], secret: Data(count: 32)) else {
            return XCTFail("spawn failed")
        }
        defer { kill(other, SIGKILL); _ = waitForExit(other) }
        usleep(300_000)
        let leftRecord = try XCTUnwrap(ServiceLauncher.childRecord(left))
        let otherRecord = try XCTUnwrap(ServiceLauncher.childRecord(other))
        XCTAssertTrue(leftRecord.path.hasSuffix("/sleep"), leftRecord.path)
        let reused = ServiceLauncher.ChildRecord(pid: other, startMicros: otherRecord.startMicros + 1, path: otherRecord.path)
        let file = "\(dir)/children.json"
        try JSONEncoder().encode([leftRecord, reused]).write(to: URL(fileURLWithPath: file))
        XCTAssertEqual(ServiceLauncher.stopStale(file: file, log: { _ in }), [left])
        let status = try XCTUnwrap(waitForExit(left, seconds: 5))
        XCTAssertEqual(ServiceLauncher.describe(status), "signal \(SIGTERM)")
        XCTAssertEqual(ServiceLauncher.childRecord(other), otherRecord, "a process that only shares a pid was touched")
        XCTAssertEqual(ServiceLauncher.stopStale(file: "\(dir)/missing.json", log: { _ in }), [])
    }

    func testRestartAfterAStopStartsAgainWithFreshBudgets() async throws {
        let helper = try script("helper.sh", "cat > /dev/null\nexit 1\n")
        let reader = try script("reader.sh", "cat > /dev/null\nexec sleep 60\n")
        let home = try CaretHome.resolve(override: "\(dir)/home", userHome: "/nonexistent")
        let launcher = try ServiceLauncher(programs: .init(node: "/bin/sh", helperEntry: helper, reader: reader), home: home, log: { _ in })
        launcher.start()
        let deadline = Date().addingTimeInterval(15)
        while launcher.stopped == nil, Date() < deadline { try await Task.sleep(nanoseconds: 100_000_000) }
        XCTAssertNotNil(launcher.stopped)
        XCTAssertEqual(launcher.helper.starts, 6)
        // Restart at once, before the stop has finished, twice: one new helper starts, once.
        launcher.restart()
        launcher.restart()
        let again = Date().addingTimeInterval(5)
        while launcher.helper.starts < 7, Date() < again { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertNil(launcher.stopped)
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(launcher.helper.starts, 7, "a second Restart started another helper")
        await launcher.stop()
    }

    /// H8: the shipped reader answers calendar verbs in the user's calendars, reading the choice from
    /// the host's settings file; never the test scope.
    func testTheReaderAddsToTheUsersCalendarsByTheHostsSettingsFile() throws {
        let home = try CaretHome.resolve(override: dir, userHome: NSHomeDirectory())
        let args = ServiceLauncher.readerArguments(home: home, settingsPath: "\(dir)/host-settings.json")
        let at = try XCTUnwrap(args.firstIndex(of: "--calendar-user"))
        XCTAssertEqual(args[at + 1], "\(dir)/host-settings.json")
        XCTAssertFalse(args.contains("--calendar-test"))
    }
}
