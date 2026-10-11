// activation-proof: can CaretFixture.app take the foreground when asked? A4 and A5 could not bring
// the bare caret-fixture executable to the front; B8 wrapped it in CaretFixture.app. Each attempt
// launches the bundle's executable with --foreground, sends `activate legacy|cooperative` on stdin,
// reads NSWorkspace.frontmostApplication every 100 ms for 3 s, then sends `quit PID` and checks that
// the app that was frontmost before is frontmost again within 2 s, activating it if not.
//
// Run only through run-activation-proof.sh, which holds the gui lease and gui.lock and waits for an
// idle Mac. This program rechecks: it stops at once when HID idle drops under 5 s or a quiet window
// starts, quits the fixture and hands the foreground back.
//
//   activation-proof FIXTURE_EXE OUT_NDJSON ATTEMPTS FIRST_INDEX
//   exit 0: every attempt ran; 3: stopped because the user came back or a quiet window began
import AppKit
import IOKit

setvbuf(stdout, nil, _IOLBF, 0)
let args = CommandLine.arguments
guard args.count == 5, let attempts = Int(args[3]), let firstIndex = Int(args[4]) else {
    FileHandle.standardError.write(Data("usage: activation-proof FIXTURE_EXE OUT_NDJSON ATTEMPTS FIRST_INDEX\n".utf8))
    exit(2)
}
let fixtureExe = args[1]
let outPath = args[2]
// A process that reads NSWorkspace needs the shared application; prohibited keeps it out of the Dock and never active.
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)

/// Seconds since the last hardware input, or -1 when the registry cannot be read.
func hidIdle() -> Double {
    let svc = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("IOHIDSystem"))
    defer { IOObjectRelease(svc) }
    guard svc != 0, let v = IORegistryEntryCreateCFProperty(svc, "HIDIdleTime" as CFString, kCFAllocatorDefault, 0)?.takeRetainedValue() as? NSNumber else { return -1 }
    return v.doubleValue / 1_000_000_000
}

/// `~/.long-run/QUIET-UNTIL` holds epoch seconds in its first field; a time in the future means hands off.
func quietNow() -> Bool {
    let path = NSHomeDirectory() + "/.long-run/QUIET-UNTIL"
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return false }
    guard let first = text.split(whereSeparator: { $0 == " " || $0 == "\n" || $0 == "\t" }).first, let until = Double(first) else { return true }
    return until > Date().timeIntervalSince1970
}

struct Front: Equatable { let pid: pid_t; let bundle: String; let name: String }
func front() -> Front? {
    guard let a = NSWorkspace.shared.frontmostApplication else { return nil }
    return Front(pid: a.processIdentifier, bundle: a.bundleIdentifier ?? "", name: a.localizedName ?? "")
}
func json(_ f: Front?) -> Any { f.map { ["pid": Int($0.pid), "bundle": $0.bundle, "name": $0.name] as [String: Any] } ?? NSNull() }
/// Lets NSWorkspace deliver its notifications, so frontmostApplication is current.
func pump(_ seconds: Double) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }
func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }
func lsappinfo(_ args: [String]) -> String {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/lsappinfo")
    p.arguments = args
    let o = Pipe()
    p.standardOutput = o
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return "error: \(error)" }
    p.waitUntilExit()
    return String(decoding: o.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
}
/// LaunchServices' own answer, as a cross-check on NSWorkspace: the front app's pid.
func lsappinfoFront() -> String { lsappinfo(["info", "-only", "pid", lsappinfo(["front"])]) }

/// Why to stop now, or nil.
func userBack() -> String? {
    let idle = hidIdle()
    if idle >= 0 && idle < 5 { return "user active (HID idle \(String(format: "%.1f", idle)) s)" }
    if idle < 0 { return "HID idle unreadable" }
    if quietNow() { return "quiet window" }
    return nil
}

final class Fixture {
    let process = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    var lines: [String] = []
    private var buffer = Data()

    init(exe: String, stderrPath: String) throws {
        process.executableURL = URL(fileURLWithPath: exe)
        process.arguments = ["--foreground", "--windows", "reference", "--duration", "40"]
        process.standardInput = stdin
        process.standardOutput = stdout
        FileManager.default.createFile(atPath: stderrPath, contents: nil)
        process.standardError = FileHandle(forWritingAtPath: stderrPath)
        stdout.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            DispatchQueue.main.async { self?.take(d) }
        }
        try process.run()
    }

    private func take(_ d: Data) {
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 0x0A) {
            lines.append(String(decoding: buffer[buffer.startIndex..<nl], as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...nl)
        }
    }

    func send(_ line: String) { try? stdin.fileHandleForWriting.write(contentsOf: Data((line + "\n").utf8)) }

    /// Pumps the run loop until a line matching `match` arrives, for at most `seconds`.
    func wait(for match: (String) -> Bool, seconds: Double) -> String? {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            if let l = lines.first(where: match) { return l }
            pump(0.02)
        }
        return lines.first(where: match)
    }

    /// Ends the fixture: waits for it to exit after `quit`, then terminates the pid this program started.
    func end(within seconds: Double) -> String {
        let deadline = Date().addingTimeInterval(seconds)
        while process.isRunning && Date() < deadline { pump(0.05) }
        if process.isRunning { process.terminate(); pump(0.3) }
        return process.isRunning ? "still running" : "exited \(process.terminationStatus)"
    }
}

func append(_ record: [String: Any]) {
    let d = (try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])) ?? Data()
    if let h = FileHandle(forWritingAtPath: outPath) {
        h.seekToEndOfFile(); h.write(d); h.write(Data("\n".utf8)); try? h.close()
    } else {
        FileManager.default.createFile(atPath: outPath, contents: d + Data("\n".utf8))
    }
}

/// Polls frontmostApplication every 100 ms for the whole `seconds`, recording each change relative to
/// `t0` and the first poll at which `hit` held. Stops early only when the user comes back.
func watch(seconds: Double, t0: Int64, timeline: inout [[String: Any]], last: inout Front?, hit: (Front?) -> Bool) -> (stoppedBy: String?, hitAt: Int64?) {
    let end = Date().addingTimeInterval(seconds)
    var hitAt: Int64? = nil
    while Date() < end {
        pump(0.1)
        let f = front()
        if f != last {
            timeline.append(["t": nowMs() - t0, "front": json(f)])
            last = f
        }
        if hitAt == nil && hit(f) { hitAt = nowMs() - t0 }
        if let why = userBack() { return (why, hitAt) }
    }
    return (nil, hitAt)
}

let methods = ["legacy", "cooperative", "legacy"]
var stopped = false
for i in 0..<attempts {
    let index = firstIndex + i
    let method = methods[index % methods.count]
    var record: [String: Any] = ["attempt": index + 1, "method": method, "startedAt": nowMs(), "hidIdleAtStart": hidIdle()]
    guard userBack() == nil else { record["result"] = "not started: \(userBack() ?? "")"; append(record); stopped = true; break }
    pump(0.1)
    guard let before = front() else { record["result"] = "not started: no frontmost app"; append(record); break }
    record["before"] = json(before)
    record["lsappinfoBefore"] = lsappinfoFront()
    let fixture: Fixture
    do {
        fixture = try Fixture(exe: fixtureExe, stderrPath: (outPath as NSString).deletingLastPathComponent + "/fixture-\(index + 1).stderr")
    } catch {
        record["result"] = "launch failed: \(error)"; append(record); break
    }
    let fixturePid = fixture.process.processIdentifier
    record["fixturePid"] = Int(fixturePid)
    let launchedAt = nowMs()
    var timeline: [[String: Any]] = [["t": 0, "front": json(before), "phase": "launch"]]
    var last: Front? = before
    // Launch: until the fixture prints its ready line, watching whether the launch alone moved the foreground.
    let ready = fixture.wait(for: { $0.hasPrefix("caret-fixture pid") }, seconds: 5)
    record["readyAfterMs"] = nowMs() - launchedAt
    _ = watch(seconds: 0.5, t0: launchedAt, timeline: &timeline, last: &last, hit: { _ in false })
    record["launchTimeline"] = timeline
    record["frontAfterLaunch"] = json(front())

    var outcome: String
    if ready == nil {
        outcome = "fixture not ready within 5 s"
    } else if let why = userBack() {
        outcome = "stopped before activate: \(why)"
        stopped = true
    } else {
        let t0 = nowMs()
        var t: [[String: Any]] = [["t": 0, "front": json(front()), "phase": "activate"]]
        last = front()
        fixture.send("activate \(method)")
        let w = watch(seconds: 3, t0: t0, timeline: &t, last: &last, hit: { $0?.pid == fixturePid })
        record["activateReply"] = fixture.wait(for: { $0.contains("\"how\"") || $0.contains("\"error\"") }, seconds: 0.5) ?? NSNull()
        record["frontmostAt3s"] = json(last)
        record["activateTimeline"] = t
        record["becameFrontmost"] = w.hitAt != nil
        record["msToFrontmost"] = w.hitAt.map { Int($0) } ?? NSNull()
        record["lsappinfoDuring"] = lsappinfoFront()
        if let why = w.stoppedBy { outcome = "stopped during activate: \(why)"; stopped = true }
        else { outcome = w.hitAt != nil ? "frontmost" : "not frontmost within 3 s" }
    }
    record["result"] = outcome

    // Quit, and give the foreground back to the app that had it.
    let q0 = nowMs()
    var qt: [[String: Any]] = [["t": 0, "front": json(front()), "phase": "quit"]]
    last = front()
    fixture.send("quit \(before.pid)")
    record["quitReply"] = fixture.wait(for: { $0.contains("handedBack") }, seconds: 0.5) ?? NSNull()
    record["fixtureEnd"] = fixture.end(within: 1.5)
    var restoredAt: Int64? = nil
    if front() == before {
        restoredAt = nowMs() - q0
        qt.append(["t": restoredAt!, "front": json(before)])
        last = before
    }
    if restoredAt == nil {
        let end = Date().addingTimeInterval(max(0, 2 - Double(nowMs() - q0) / 1000))
        while Date() < end {
            pump(0.1)
            let f = front()
            if f != last { qt.append(["t": nowMs() - q0, "front": json(f)]); last = f }
            if f == before { restoredAt = nowMs() - q0; break }
        }
    }
    record["restoredWithin2s"] = restoredAt != nil
    record["msToRestored"] = restoredAt.map { Int($0) } ?? NSNull()
    if restoredAt == nil {
        let ok = NSRunningApplication(processIdentifier: before.pid)?.activate(options: []) ?? false
        record["reactivateRequested"] = ok
        let r0 = nowMs()
        let end = Date().addingTimeInterval(2)
        var after: Int64? = nil
        while Date() < end {
            pump(0.1)
            let f = front()
            if f != last { qt.append(["t": nowMs() - q0, "front": json(f)]); last = f }
            if f == before { after = nowMs() - r0; break }
        }
        record["restoredAfterReactivate"] = after != nil
        record["msToRestoredAfterReactivate"] = after.map { Int($0) } ?? NSNull()
    }
    record["quitTimeline"] = qt
    record["frontAtEnd"] = json(front())
    record["lsappinfoAtEnd"] = lsappinfoFront()
    append(record)
    print("attempt \(index + 1) \(method): \(outcome); restored \(restoredAt.map { "\($0) ms" } ?? "no")")
    if stopped { break }
    pump(1)
}
exit(stopped ? 3 : 0)
