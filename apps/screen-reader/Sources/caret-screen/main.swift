// caret-screen: Caret's Accessibility reader.
//
//   caret-screen --auth-fd N [--shadow] [--socket PATH] [--deny-list PATH] [--background-interval S]
//                [--event-pids P,P] [--event-bundles B,B] [--only-pids P,P] [--act-pids P,P]
//                [--record FILE] [--e1-log FILE] [--no-manual-ax]
//   caret-screen --e8 --pids P,P [--title-match REGEX] [--runs N] [--interval S] --out FILE
//   caret-screen --calendar-probe | --calendar-audit TITLE
//
// --calendar-test answers the helper's calendar verbs through EventKit, in calendars the reader creates
// on a local source and deletes when it stops (CalendarAdapter). It never asks for Calendar access.
// --calendar-probe prints the Calendar authorization status and nothing else; --calendar-audit prints,
// through a store of its own, every event calendar with that title and its source. Both only read.
//
// Default mode streams NDJSON to the helper's socket. --shadow tells the helper to log
// opportunities and show nothing. Launch by direct exec so the process inherits Accessibility.
//
// --auth-fd names an inherited descriptor (0, or 3 and above) holding the 32-byte launch secret the launcher also
// gave the helper (helper/src/launch.ts). The reader reads it to the end, closes it, and sends and acts on nothing
// until the helper proves it holds the same secret (Emitter.swift). It is required in socket mode.
import AppKit
import ApplicationServices
import CaretScreenAX
import CaretScreenCalendar
import CaretScreenCore
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let version = "caret-screen 0.1.0"

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("caret-screen: \(msg)\n".utf8))
    exit(2)
}

var args = Array(CommandLine.arguments.dropFirst())
@MainActor func flag(_ name: String) -> Bool {
    guard let i = args.firstIndex(of: name) else { return false }
    args.remove(at: i)
    return true
}
@MainActor func option(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name) else { return nil }
    guard i + 1 < args.count else { fail("\(name) needs a value") }
    let v = args[i + 1]
    args.removeSubrange(i...(i + 1))
    return v
}
func pids(_ s: String?) -> Set<pid_t> {
    guard let s else { return [] }
    return Set(s.split(separator: ",").map { p in
        guard let v = pid_t(p.trimmingCharacters(in: .whitespaces)) else { fail("not a pid: \(p)") }
        return v
    })
}

let home = FileManager.default.homeDirectoryForCurrentUser.path
let shadow = flag("--shadow")
// Sets no AXManualAccessibility in any app: for a read-only audit beside a reader that already did.
let noManualAX = flag("--no-manual-ax")
let e8 = flag("--e8")
let socketPath = option("--socket") ?? "\(home)/.caret-run/sockets/screen.sock"
let denyPath = option("--deny-list") ?? "\(home)/.caret-run/deny-apps.txt"
let background = option("--background-interval").map { TimeInterval($0) ?? 30 } ?? 30
let eventPids = pids(option("--event-pids"))
let onlyPids = pids(option("--only-pids"))
// The executor may act in these processes without a grant, for fixture tests only (checked below). Acting
// needs reading, so they must also be in --only-pids. Every other process needs an act grant from the helper.
let actPidList = pids(option("--act-pids"))
let eventBundles = Set((option("--event-bundles") ?? "").split(separator: ",").map(String.init))
let recordPath = option("--record")
let e1Path = option("--e1-log")
let e8Pids = pids(option("--pids"))
let titleMatch = option("--title-match")
let runs = Int(option("--runs") ?? "100") ?? 100
let interval = TimeInterval(option("--interval") ?? "0.25") ?? 0.25
let outPath = option("--out")
let calendarTest = flag("--calendar-test")
let calendarProbe = flag("--calendar-probe")
let calendarAudit = option("--calendar-audit")
let authFd = option("--auth-fd")
if !args.isEmpty { fail("unknown arguments: \(args.joined(separator: " "))") }
// A recording holds screen text, so it is only allowed for processes named explicitly (fixtures).
if recordPath != nil && onlyPids.isEmpty { fail("--record writes screen text to disk; it needs --only-pids naming fixture processes") }
if !actPidList.isEmpty && !actPidList.isSubset(of: onlyPids) { fail("--act-pids must be a subset of --only-pids: the executor acts without a grant only in fixture processes") }

/// The value of CARET_SCREEN_FIXTURE_ACTS that lets --act-pids through. Nothing in the product sets it.
let fixtureActsValue = "fixture-only"

/// --act-pids, checked (S1 audit #10): before B22 it let any process the command line named be acted in without a
/// grant. Now it needs a test environment variable a product launch does not set, a reader that is not running
/// from inside an app bundle (the product ships it in one), and every pid to be a caret-fixture process, the
/// synthetic windows tests drive. Each is bound to its process's start time, so a later process that reuses the
/// pid gets no bypass. A press there still goes through the reader's risk table.
@MainActor func checkedActPids() -> [pid_t: Int64] {
    guard !actPidList.isEmpty else { return [:] }
    guard ProcessInfo.processInfo.environment["CARET_SCREEN_FIXTURE_ACTS"] == fixtureActsValue else {
        fail("--act-pids is for fixture tests: set CARET_SCREEN_FIXTURE_ACTS=\(fixtureActsValue) in the test that starts the reader")
    }
    guard Bundle.main.bundleURL.pathExtension != "app" else { fail("--act-pids is refused in a reader inside an app bundle") }
    var out: [pid_t: Int64] = [:]
    for pid in actPidList {
        guard let path = ProcessFacts.executablePath(pid), (path as NSString).lastPathComponent == "caret-fixture" else {
            fail("--act-pids \(pid) is not a caret-fixture process")
        }
        guard let start = ProcessFacts.startMicros(pid) else { fail("--act-pids \(pid): no such process") }
        out[pid] = start
    }
    return out
}
let actPids = checkedActPids()

// The calendar probes only read, and need no Accessibility, so they run before that check.
if calendarProbe {
    print(#"{"calendar":"\#(EventKitBackend.statusName())"}"#)
    exit(0)
}
if let title = calendarAudit {
    do {
        let found = try EventKitBackend.audit(title: title)
        let data = try JSONSerialization.data(withJSONObject: ["title": title, "calendars": found], options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
        exit(0)
    } catch {
        print(#"{"error":"\#(error)"}"#)
        exit(3)
    }
}

guard AXIsProcessTrusted() else {
    fail("not trusted for Accessibility. Launch the binary directly from a process that has the grant.")
}

let deny: DenyList
do { deny = try DenyList.load(path: denyPath) } catch { fail("cannot read deny list \(denyPath): \(error)") }

func openForWriting(_ path: String) -> FileHandle {
    FileManager.default.createFile(atPath: path, contents: nil)
    guard let h = FileHandle(forWritingAtPath: path) else { fail("cannot write \(path)") }
    return h
}

if e8 {
    guard let out = outPath, !e8Pids.isEmpty else { fail("--e8 needs --pids and --out") }
    let re = titleMatch.map { try! NSRegularExpression(pattern: $0) }
    let ctx = ReaderContext(emitter: FileEmitter(handle: FileHandle.nullDevice))
    var workers: [AppWorker] = []
    for pid in e8Pids {
        guard let app = NSRunningApplication(processIdentifier: pid) else { fail("no process \(pid)") }
        if deny.denies(app.bundleIdentifier ?? "") { fail("\(pid) is on the deny list") }
        guard let start = ProcessFacts.startMicros(pid) else { fail("no process \(pid)") }
        workers.append(AppWorker(pid: pid, app: AppRef(pid: Int(pid), bundleId: app.bundleIdentifier ?? "", name: app.localizedName ?? ""), ctx: ctx,
                                 incarnation: ProcessIncarnation(pid: pid, startMicros: start, generation: workers.count + 1)))
    }
    let reports = MainActor.assumeIsolated { KeyStability.run(workers: workers, titleMatch: re, runs: runs, interval: interval) }
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try! enc.encode(reports).write(to: URL(fileURLWithPath: out))
    for r in reports {
        print("\(r.app) | \(r.window) | runs \(r.runs) | nodes \(Int(r.meanNodes)) | walk \(Int(r.meanWalkMs)) ms | stable \(r.stableKey)/\(r.presentInAll) present-in-all of \(r.tracked) | keys in all \(r.keysInAll)/\(r.keysFirst)")
    }
    exit(0)
}

/// The launch secret from the inherited descriptor, read to its end, then the descriptor is closed.
func launchSecret(_ arg: String?) -> Data {
    guard let arg else { fail("--auth-fd N is required: the launch secret the helper proves itself with (start both with helper/src/launch.ts)") }
    guard let fd = Int32(arg), fd == 0 || fd >= 3 else { fail("--auth-fd \(arg) is not an inherited input descriptor (0, or 3 and above)") }
    var out = Data()
    var buf = [UInt8](repeating: 0, count: 64)
    while true {
        let n = read(fd, &buf, buf.count)
        if n < 0 {
            if errno == EINTR { continue }
            fail("cannot read the launch secret from descriptor \(fd): \(String(cString: strerror(errno)))")
        }
        if n == 0 { break }
        out.append(contentsOf: buf[0..<n])
        if out.count > 4096 { fail("descriptor \(fd) holds more than a launch secret") }
    }
    close(fd)
    guard out.count == HelperProof.bytes else { fail("the launch secret on descriptor \(fd) is \(out.count) bytes, expected \(HelperProof.bytes)") }
    return out
}
let secret = launchSecret(authFd)

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)

// The launch id stays the same on every reconnect of this process: the helper keeps undo for what it wrote through it.
let socket = SocketEmitter(path: socketPath,
                           hello: Hello(role: .reader, mode: shadow ? .shadow : .live, pid: Int(getpid()), version: version, session: HelperProof.launchId()),
                           secret: secret)
var emitter: Emitter = socket
if let p = recordPath { emitter = TeeEmitter([socket, FileEmitter(handle: openForWriting(p))]) }
let ctx = ReaderContext(emitter: emitter)
var recorder: NotificationRecorder?
if let p = e1Path {
    let r = NotificationRecorder(handle: openForWriting(p))
    recorder = r
    ctx.notificationTap = { t, pid, name, el in r.tap(t, pid, name, el) }
}

var options = ReaderOptions(denyList: deny)
options.backgroundInterval = background
options.eventPids = eventPids
options.onlyPids = onlyPids
options.eventBundles = eventBundles
options.actPids = actPids
let calendarAdapter = calendarTest ? CalendarAdapter(backend: EventKitBackend()) : nil
options.calendar = calendarAdapter
socket.grants = options.grants
options.setManualAccessibility = !noManualAX
let reader = MainActor.assumeIsolated { ScreenReader(ctx: ctx, options: options) }
var connectedOnce = false
socket.onConnect = { lost in
    DispatchQueue.main.async {
        MainActor.assumeIsolated {
            // A new helper knows nothing; the first one may have missed snapshots dropped from the backlog before it came.
            if connectedOnce { reader.resync(newHelper: true) } else if lost { reader.resync(newHelper: false) }
            connectedOnce = true
        }
    }
}
socket.onResync = {
    DispatchQueue.main.async { MainActor.assumeIsolated { reader.resync(newHelper: false) } }
}
socket.onCommand = { cmd in
    DispatchQueue.main.async { MainActor.assumeIsolated { reader.perform(cmd) } }
}
socket.start()
MainActor.assumeIsolated { reader.start() }

for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler {
        ctx.log("stopping; sent \(socket.sent) messages, dropped \(socket.dropped), e1 lines \(recorder?.count ?? 0)")
        // The calendars it created go with it.
        if let cal = calendarAdapter {
            let left = cal.ownedCalendars
            let errors = cal.disposeAll()
            ctx.log("calendar: deleted \(left.count - errors.count) of \(left.count) calendars it created\(errors.isEmpty ? "" : "; \(errors.joined(separator: "; "))")")
        }
        exit(0)
    }
    src.resume()
    _ = Unmanaged.passRetained(src)
}
app.run()
